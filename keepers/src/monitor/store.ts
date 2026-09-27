import type pg from "pg";
import type {Severity} from "./pager.js";

/**
 * Monitor state in Postgres, so the monitor is restart-safe and several instances never double-page:
 * - `incident`: one open row per `(rule, subject)` (partial unique index); notifications are claimed with a conditional
 *   UPDATE before they are sent, and released if delivery fails, so a page is retried, never duplicated;
 * - `watch`: when a duration rule's condition was first seen (e.g. HF < 1 since block N, MON-R2);
 * - `cursor`: the last block scanned for events (MON-R1, R6, R7, R10);
 * - `weekend_log`: closure milestones and guard events per market (the "2 clean testnet weekends" evidence).
 */
const ident = (s: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s)) throw new Error(`bad schema ${s}`);
  return `"${s}"`;
};

export interface Incident {
  id: number;
  rule: string;
  subject: string;
  severity: Severity;
  status: "open" | "resolved";
  title: string;
  details: Record<string, unknown>;
  openedAt: Date;
  openedBlock: bigint;
  lastNotifiedAt: Date | null;
  notifyCount: number;
  resolvedAt: Date | null;
  resolvedBlock: bigint | null;
  resolveNotified: boolean;
  autoResolveAt: Date | null;
}

export interface WeekendEntry {
  ticker: string;
  closeTs: bigint;
  reopenTs: bigint;
  kind: string;
  /** Distinguishes repeated kinds (guard events: `tx:logIndex`); "" for milestones, which are logged once. */
  seq: string;
  block: bigint;
  ts: bigint;
  detail: Record<string, unknown>;
}

const row = (r: Record<string, unknown>): Incident => ({
  id: Number(r.id),
  rule: String(r.rule),
  subject: String(r.subject),
  severity: r.severity as Severity,
  status: r.status as Incident["status"],
  title: String(r.title),
  details: (r.details ?? {}) as Record<string, unknown>,
  openedAt: r.opened_at as Date,
  openedBlock: BigInt(r.opened_block as string),
  lastNotifiedAt: (r.last_notified_at as Date | null) ?? null,
  notifyCount: Number(r.notify_count),
  resolvedAt: (r.resolved_at as Date | null) ?? null,
  resolvedBlock: r.resolved_block == null ? null : BigInt(r.resolved_block as string),
  resolveNotified: Boolean(r.resolve_notified),
  autoResolveAt: (r.auto_resolve_at as Date | null) ?? null,
});

const jsonb = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export class MonitorStore {
  private readonly s: string;
  constructor(
    readonly pool: pg.Pool,
    schema: string,
  ) {
    this.s = ident(schema);
  }

  async migrate(): Promise<void> {
    await this.pool.query(`create schema if not exists ${this.s}`);
    await this.pool.query(`create table if not exists ${this.s}.incident (
      id bigserial primary key,
      rule text not null,
      subject text not null,
      severity text not null,
      status text not null default 'open',
      title text not null,
      details jsonb not null default '{}',
      opened_at timestamptz not null default now(),
      opened_block numeric not null,
      last_notified_at timestamptz,
      notify_count integer not null default 0,
      resolved_at timestamptz,
      resolved_block numeric,
      resolve_notified boolean not null default false,
      auto_resolve_at timestamptz
    )`);
    await this.pool.query(`create unique index if not exists incident_open on ${this.s}.incident (rule, subject) where status = 'open'`);
    await this.pool.query(`create table if not exists ${this.s}.watch (
      rule text not null, subject text not null, since_block numeric not null, since_ts numeric not null,
      primary key (rule, subject))`);
    await this.pool.query(`create table if not exists ${this.s}.cursor (name text primary key, block numeric not null)`);
    await this.pool.query(`create table if not exists ${this.s}.weekend_log (
      ticker text not null, close_ts numeric not null, reopen_ts numeric not null, kind text not null, seq text not null,
      block numeric not null, ts numeric not null, detail jsonb not null default '{}',
      primary key (ticker, close_ts, kind, seq))`);
  }

  // ------------------------------------------------------------------ incidents

  /** Opens an incident unless one is open for `(rule, subject)`. Returns the new row, or undefined if it existed. */
  async open(i: {rule: string; subject: string; severity: Severity; title: string; details: Record<string, unknown>; block: bigint; autoResolveAt?: Date}): Promise<Incident | undefined> {
    const {rows} = await this.pool.query(
      `insert into ${this.s}.incident (rule, subject, severity, title, details, opened_block, auto_resolve_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (rule, subject) where status = 'open' do nothing returning *`,
      [i.rule, i.subject, i.severity, i.title, jsonb(i.details), i.block.toString(), i.autoResolveAt ?? null],
    );
    return rows[0] ? row(rows[0]) : undefined;
  }

  async getOpen(rule: string, subject: string): Promise<Incident | undefined> {
    const {rows} = await this.pool.query(`select * from ${this.s}.incident where rule = $1 and subject = $2 and status = 'open'`, [rule, subject]);
    return rows[0] ? row(rows[0]) : undefined;
  }

  async openIncidents(rule?: string): Promise<Incident[]> {
    const {rows} = rule
      ? await this.pool.query(`select * from ${this.s}.incident where status = 'open' and rule = $1 order by id`, [rule])
      : await this.pool.query(`select * from ${this.s}.incident where status = 'open' order by id`);
    return rows.map(row);
  }

  async recent(limit = 200): Promise<Incident[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.incident order by id desc limit $1`, [limit]);
    return rows.map(row);
  }

  /** Updates the details of an open incident (latest observation), without touching notification state. */
  async touch(id: number, details: Record<string, unknown>): Promise<void> {
    await this.pool.query(`update ${this.s}.incident set details = $2 where id = $1 and status = 'open'`, [id, jsonb(details)]);
  }

  /** Claims a notification: succeeds only if never notified or last notified before `cutoff`. */
  async claimNotify(id: number, now: Date, cutoff: Date): Promise<boolean> {
    const r = await this.pool.query(
      `update ${this.s}.incident set last_notified_at = $2, notify_count = notify_count + 1
       where id = $1 and status = 'open' and (last_notified_at is null or last_notified_at <= $3)`,
      [id, now, cutoff],
    );
    return r.rowCount === 1;
  }

  /** Releases a claim after a failed delivery so the next tick retries. */
  async releaseNotify(id: number): Promise<void> {
    await this.pool.query(`update ${this.s}.incident set last_notified_at = null, notify_count = greatest(notify_count - 1, 0) where id = $1`, [id]);
  }

  /** Resolves the open incident of `(rule, subject)`; returns it if this call resolved it. */
  async resolve(rule: string, subject: string, block: bigint): Promise<Incident | undefined> {
    const {rows} = await this.pool.query(
      `update ${this.s}.incident set status = 'resolved', resolved_at = now(), resolved_block = $3
       where rule = $1 and subject = $2 and status = 'open' returning *`,
      [rule, subject, block.toString()],
    );
    return rows[0] ? row(rows[0]) : undefined;
  }

  /** Resolved incidents whose resolve notification is still owed (including ones resolved before their trigger went
   * out, e.g. a guard tripped and cleared within one tick: those get the trigger and the resolve). */
  async pendingResolves(): Promise<Incident[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.incident where status = 'resolved' and not resolve_notified order by id`);
    return rows.map(row);
  }

  async markResolveNotified(id: number): Promise<boolean> {
    const r = await this.pool.query(`update ${this.s}.incident set resolve_notified = true where id = $1 and not resolve_notified`, [id]);
    return r.rowCount === 1;
  }

  async unmarkResolveNotified(id: number): Promise<void> {
    await this.pool.query(`update ${this.s}.incident set resolve_notified = false where id = $1`, [id]);
  }

  /** Open incidents whose auto-resolve time passed (event rules, MON-R1 and MON-R10). */
  async dueAutoResolve(now: Date): Promise<Incident[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.incident where status = 'open' and auto_resolve_at is not null and auto_resolve_at <= $1`, [now]);
    return rows.map(row);
  }

  /** Incidents opened between two chain blocks (weekend cleanliness). */
  async openedBetween(fromBlock: bigint, toBlock: bigint): Promise<Incident[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.incident where opened_block >= $1 and opened_block <= $2 order by id`, [fromBlock.toString(), toBlock.toString()]);
    return rows.map(row);
  }

  // ------------------------------------------------------------------ watches (duration rules)

  /** Records the first observation of a condition (kept if it already exists); returns when it was first seen. */
  async watch(rule: string, subject: string, block: bigint, ts: bigint): Promise<{sinceBlock: bigint; sinceTs: bigint}> {
    const {rows} = await this.pool.query(
      `insert into ${this.s}.watch (rule, subject, since_block, since_ts) values ($1, $2, $3, $4)
       on conflict (rule, subject) do update set rule = excluded.rule returning since_block, since_ts`,
      [rule, subject, block.toString(), ts.toString()],
    );
    return {sinceBlock: BigInt(rows[0].since_block), sinceTs: BigInt(rows[0].since_ts)};
  }

  async unwatch(rule: string, subject: string): Promise<void> {
    await this.pool.query(`delete from ${this.s}.watch where rule = $1 and subject = $2`, [rule, subject]);
  }

  async watched(rule: string): Promise<string[]> {
    const {rows} = await this.pool.query(`select subject from ${this.s}.watch where rule = $1`, [rule]);
    return rows.map((r) => String(r.subject));
  }

  // ------------------------------------------------------------------ event cursor

  async cursor(name: string): Promise<bigint | undefined> {
    const {rows} = await this.pool.query(`select block from ${this.s}.cursor where name = $1`, [name]);
    return rows[0] ? BigInt(rows[0].block) : undefined;
  }

  async setCursor(name: string, block: bigint): Promise<void> {
    await this.pool.query(`insert into ${this.s}.cursor (name, block) values ($1, $2) on conflict (name) do update set block = excluded.block`, [name, block.toString()]);
  }

  // ------------------------------------------------------------------ weekend log

  /** Logs an entry once (milestones are idempotent by `(ticker, closeTs, kind, seq)`). Returns true if new. */
  async logWeekend(e: WeekendEntry): Promise<boolean> {
    const r = await this.pool.query(
      `insert into ${this.s}.weekend_log (ticker, close_ts, reopen_ts, kind, seq, block, ts, detail) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict do nothing`,
      [e.ticker, e.closeTs.toString(), e.reopenTs.toString(), e.kind, e.seq, e.block.toString(), e.ts.toString(), jsonb(e.detail)],
    );
    return r.rowCount === 1;
  }

  async weekendEntries(limitClosures = 20): Promise<WeekendEntry[]> {
    const {rows} = await this.pool.query(
      `select * from ${this.s}.weekend_log where close_ts in (select distinct close_ts from ${this.s}.weekend_log order by close_ts desc limit $1)
       order by close_ts desc, ticker, ts, kind`,
      [limitClosures],
    );
    return rows.map((r) => ({
      ticker: String(r.ticker),
      closeTs: BigInt(r.close_ts),
      reopenTs: BigInt(r.reopen_ts),
      kind: String(r.kind),
      seq: String(r.seq),
      block: BigInt(r.block),
      ts: BigInt(r.ts),
      detail: r.detail as Record<string, unknown>,
    }));
  }
}
