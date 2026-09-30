import type pg from "pg";
import type {PublicClient} from "viem";
import {alertSettingsMessage, canonicalSettings, type AlertSettings, type Address} from "@lendora/sdk";

/**
 * APP-R8 settings, saved from the app's `/alerts` page with an EIP-191 signature over `alertSettingsMessage` (SDK).
 * Stored per wallet: threshold, weekend warning, channels and the signed `issuedAt` (replay guard). No IP.
 */
export class SettingsError extends Error {
  constructor(
    readonly status: 400 | 401 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface StoredSettings {
  address: Address;
  settings: AlertSettings;
  issuedAt: string;
}

const ident = (s: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s)) throw new Error(`bad schema ${s}`);
  return `"${s}"`;
};

export function validateSettings(s: AlertSettings, allowHttpWebhooks: boolean): AlertSettings {
  const hf = Number(s.hfThreshold);
  if (!(hf > 1 && hf <= 5)) throw new SettingsError(400, "hfThreshold must be between 1 and 5");
  const ch = s.channels ?? {};
  const email = ch.email?.trim() || undefined;
  const telegramChatId = ch.telegramChatId?.trim() || undefined;
  const webhookUrl = ch.webhookUrl?.trim() || undefined;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SettingsError(400, "invalid email");
  if (telegramChatId && !/^-?\d{1,20}$/.test(telegramChatId)) throw new SettingsError(400, "invalid Telegram chat id");
  if (webhookUrl) {
    let u: URL;
    try {
      u = new URL(webhookUrl);
    } catch {
      throw new SettingsError(400, "invalid webhook URL");
    }
    if (u.protocol !== "https:" && !(allowHttpWebhooks && u.protocol === "http:")) throw new SettingsError(400, "webhook must use https");
  }
  if (!email && !telegramChatId && !webhookUrl) throw new SettingsError(400, "set at least one channel");
  return {hfThreshold: hf, weekendWarning: Boolean(s.weekendWarning), channels: {email, telegramChatId, webhookUrl}};
}

export class SettingsStore {
  private readonly s: string;
  constructor(
    readonly pool: pg.Pool,
    schema: string,
  ) {
    this.s = ident(schema);
  }

  async migrate(): Promise<void> {
    await this.pool.query(`create schema if not exists ${this.s}`);
    await this.pool.query(`create table if not exists ${this.s}.settings (
      address text primary key,
      settings jsonb not null,
      issued_at timestamptz not null,
      updated_at timestamptz not null default now()
    )`);
    // Idempotency: one row per alert instance; claimed before sending (restart-safe, no duplicates).
    await this.pool.query(`create table if not exists ${this.s}.sent (
      address text not null,
      ticker text not null,
      kind text not null,
      window_key text not null,
      block bigint,
      sent_at timestamptz not null default now(),
      primary key (address, ticker, kind, window_key)
    )`);
  }

  async save(address: Address, settings: AlertSettings, issuedAt: string): Promise<void> {
    const r = await this.pool.query(
      `insert into ${this.s}.settings (address, settings, issued_at) values (lower($1), $2, $3)
       on conflict (address) do update set settings = excluded.settings, issued_at = excluded.issued_at, updated_at = now()
       where ${this.s}.settings.issued_at < excluded.issued_at`,
      [address, JSON.parse(canonicalSettings(settings)), issuedAt],
    );
    if ((r.rowCount ?? 0) === 0) throw new SettingsError(409, "a newer signed setting exists (replay rejected)");
  }

  async get(address: Address): Promise<StoredSettings | undefined> {
    const {rows} = await this.pool.query(`select * from ${this.s}.settings where address = lower($1)`, [address]);
    return rows[0] ? toStored(rows[0]) : undefined;
  }

  async all(): Promise<StoredSettings[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.settings`);
    return rows.map(toStored);
  }

  /** Claim an alert instance. False if it was already sent (or is being sent). */
  async claim(address: string, ticker: string, kind: string, windowKey: string, block: bigint): Promise<boolean> {
    const r = await this.pool.query(`insert into ${this.s}.sent (address, ticker, kind, window_key, block) values (lower($1), $2, $3, $4, $5) on conflict do nothing`, [
      address,
      ticker,
      kind,
      windowKey,
      block.toString(),
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async release(address: string, ticker: string, kind: string, windowKey: string): Promise<void> {
    await this.pool.query(`delete from ${this.s}.sent where address = lower($1) and ticker = $2 and kind = $3 and window_key = $4`, [address, ticker, kind, windowKey]);
  }

  /** Clear a latched "HF below" alert once the position is back above the threshold (so the next crossing alerts). */
  async resetBelow(address: string, ticker: string): Promise<void> {
    await this.pool.query(`delete from ${this.s}.sent where address = lower($1) and ticker = $2 and kind = 'hf_below'`, [address, ticker]);
  }
}

function toStored(r: {address: string; settings: AlertSettings; issued_at: Date}): StoredSettings {
  return {address: r.address as Address, settings: r.settings, issuedAt: r.issued_at.toISOString()};
}

/** Verify a signed save request (EOA or ERC-1271) and its freshness (±10 min). */
export async function verifySave(client: PublicClient, address: Address, settings: AlertSettings, issuedAt: string, signature: `0x${string}`, now = Date.now()): Promise<void> {
  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t) || Math.abs(now - t) > 10 * 60_000) throw new SettingsError(401, "issuedAt must be within 10 minutes");
  const ok = await client.verifyMessage({address, message: alertSettingsMessage(address, settings, issuedAt), signature});
  if (!ok) throw new SettingsError(401, "signature does not match the settings for this wallet");
}

/** What `GET` shows: channels masked (the page is public by address). */
export function masked(s: AlertSettings): AlertSettings {
  const m = (x?: string) => (x ? `${x.slice(0, 2)}…${x.slice(-2)}` : undefined);
  const wh = s.channels.webhookUrl ? `${new URL(s.channels.webhookUrl).origin}/…` : undefined;
  return {hfThreshold: s.hfThreshold, weekendWarning: s.weekendWarning, channels: {email: m(s.channels.email), telegramChatId: m(s.channels.telegramChatId), webhookUrl: wh}};
}
