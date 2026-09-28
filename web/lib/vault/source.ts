import {fxVault, VAULT_T_OPEN, VAULT_T_WEEKEND, type VaultState} from "@/lib/fixtures";
import {settleTime, splitWithdraw} from "./math";
import type {Attestation, DepositPreview, TxResult, VaultOverview, VaultUser, WithdrawPreview, WithdrawRequest} from "./types";

type Addr = `0x${string}`;

/**
 * Everything the USDG Earn screens read or send. One implementation today (`fixtureSource`); task 16 adds
 * `apiSource` (reads from `/v1/vault/*`, the user's balances and the calls on `DeltaNeutralVault` from the chain).
 * Amounts are USDG; `requestRedeem` takes shares (ERC-7540).
 */
export interface VaultSource {
  /** Scopes the query keys (["vault", id, …]) so two sources never share a cache entry. */
  id: string;
  kind: "fixture" | "api";
  overview(): Promise<VaultOverview>;
  user(address: Addr): Promise<VaultUser>;
  previewDeposit(assets: number): Promise<DepositPreview>;
  previewWithdraw(assets: number): Promise<WithdrawPreview>;
  /** Entry gate (APP-R10, CP-R3): terms accepted once per wallet, then a compliance attestation per deposit. */
  terms(address: Addr): Promise<{accepted: boolean; version: string; message?: string}>;
  acceptTerms(address: Addr, signature: `0x${string}`, version: string): Promise<void>;
  attest(address: Addr): Promise<Attestation>;
  approve(address: Addr, assets: number): Promise<TxResult>;
  deposit(address: Addr, assets: number, attestation: Attestation): Promise<TxResult>;
  /** Instant withdrawal, up to the cash buffer. */
  withdraw(address: Addr, assets: number): Promise<TxResult>;
  requestRedeem(address: Addr, shares: number): Promise<TxResult & {id: string}>;
  claim(address: Addr, id: string): Promise<TxResult>;
}

/** Fixture-only controls: move the fixture clock (queued requests become claimable) and reset the ledger. */
export interface FixtureControls {
  now(): number;
  advance(seconds: number): void;
  reset(): void;
}

/** Other depositors ahead of this wallet in the fixture queue. */
const OTHERS_AHEAD = 2;
const TERMS_VERSION = "fixture-1";
const TERMS_MESSAGE = "Lendora USDG Earn (preview)\n\nI accept the Lendora terms and the risk disclosure: the vault's yield is variable and not guaranteed, withdrawals above the cash buffer are queued, and I may lose money.";

interface Ledger {
  users: Record<string, VaultUser>;
  terms: Record<string, boolean>;
  tvl: number;
  instant: number;
  offset: number;
  seq: number;
}

class FixtureError extends Error {}

/**
 * In-memory vault seeded from the state's fixtures, so the flows change balances in dev, previews and tests. The
 * ledger and the clock offset live in sessionStorage (when there is one), so a queued request survives a page load.
 * Calls fail the way the contract will: no mint or burn on a stale NAV (DN-R5), deposits only while open (DN-R6).
 */
export function createFixtureSource(state: VaultState, o: {delayMs?: number; persist?: boolean} = {}): VaultSource & FixtureControls {
  const seed = fxVault(state);
  const base = seed.overview ?? fxVault("open").overview!;
  const baseTs = Date.parse(base.asOf.time) / 1000 || (base.marketClosed ? VAULT_T_WEEKEND : VAULT_T_OPEN);
  const started = Date.now() / 1000;
  const key = `vault-fixture:${state}`;
  const delay = o.delayMs ?? 350;
  const store = o.persist === false ? undefined : storage();
  const fresh = (): Ledger => ({users: {}, terms: {}, tvl: base.tvl, instant: base.instantCapacity, offset: 0, seq: 0});
  let L: Ledger = load() ?? fresh();

  function load(): Ledger | undefined {
    try {
      const s = store?.getItem(key);
      return s ? (JSON.parse(s) as Ledger) : undefined;
    } catch {
      return undefined;
    }
  }
  function save() {
    try {
      store?.setItem(key, JSON.stringify(L));
    } catch {
      /* storage full or blocked: the ledger stays in memory */
    }
  }
  const wait = () => (delay ? new Promise((r) => setTimeout(r, delay)) : Promise.resolve());
  const now = () => Math.floor(baseTs + (Date.now() / 1000 - started) + L.offset);

  function overviewNow(): VaultOverview {
    const full = L.tvl >= base.cap - 1e-6 && base.cap > 0;
    const pauseReason = base.pauseReason ?? (full ? "cap_full" : undefined);
    return {...base, asOf: {block: String(Number(base.asOf.block) + Math.floor(now() - baseTs)), time: new Date(now() * 1000).toISOString()}, tvl: L.tvl, instantCapacity: L.instant, depositsOpen: base.depositsOpen && !full, pauseReason};
  }

  function userOf(address: Addr): VaultUser {
    const k = address.toLowerCase();
    if (!L.users[k]) L.users[k] = structuredClone(seed.user ?? {shares: 0, value: 0, netDeposits: 0, usdgBalance: 50_000, usdgAllowance: 0, requests: []});
    const u = L.users[k];
    const t = now();
    let rank = 0;
    for (const r of u.requests) {
      if (r.status === "queued" && Date.parse(r.settlesAt) / 1000 <= t) r.status = "ready";
      r.position = r.status === "queued" ? OTHERS_AHEAD + ++rank : 0;
    }
    u.value = Math.round(u.shares * base.sharePrice * 100) / 100;
    return u;
  }

  const hash = (): TxResult => ({hash: undefined});

  return {
    id: `fixture:${state}`,
    kind: "fixture",
    async overview() {
      if (seed.error) throw new FixtureError("Vault data didn't load (fixture error state).");
      if (!seed.overview) return new Promise<VaultOverview>(() => {}); // loading: never resolves
      return overviewNow();
    },
    async user(address) {
      return structuredClone(userOf(address));
    },
    async previewDeposit(assets) {
      return {shares: Math.round((assets / base.sharePrice) * 1e4) / 1e4, sharePrice: base.sharePrice};
    },
    async previewWithdraw(assets) {
      return splitWithdraw(assets, L.instant, now(), base.nav.stale);
    },
    async terms(address) {
      const accepted = Boolean(L.terms[address.toLowerCase()]);
      return {accepted, version: TERMS_VERSION, message: accepted ? undefined : TERMS_MESSAGE};
    },
    async acceptTerms(address, signature) {
      await wait();
      if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new FixtureError("The terms signature is missing.");
      L.terms[address.toLowerCase()] = true;
      save();
    },
    async attest() {
      await wait();
      return {expiry: String(now() + 86_400), signature: "0x"};
    },
    async approve(address, assets) {
      await wait();
      userOf(address).usdgAllowance = Math.max(assets, 1e15);
      save();
      return hash();
    },
    async deposit(address, assets) {
      await wait();
      const u = userOf(address);
      const ov = overviewNow();
      if (base.nav.stale) throw new FixtureError("The vault's price data is stale, so it can't mint shares right now.");
      if (!ov.depositsOpen) throw new FixtureError("Deposits are closed.");
      if (assets > u.usdgBalance + 1e-6) throw new FixtureError("That's more USDG than you hold.");
      if (assets > u.usdgAllowance + 1e-6) throw new FixtureError("USDG isn't approved for the vault.");
      if (L.tvl + assets > base.cap + 1e-6) throw new FixtureError("That would go over the vault's cap.");
      u.usdgBalance -= assets;
      u.usdgAllowance -= assets;
      u.shares = Math.round((u.shares + assets / base.sharePrice) * 1e4) / 1e4;
      u.netDeposits += assets;
      L.tvl += assets;
      L.instant += assets;
      save();
      return hash();
    },
    async withdraw(address, assets) {
      await wait();
      const u = userOf(address);
      if (base.nav.stale) throw new FixtureError("The vault's price data is stale, so instant withdrawals wait for the next report.");
      if (assets > L.instant + 1e-6) throw new FixtureError("That's more than the vault's cash buffer holds right now.");
      const shares = Math.min(u.shares, assets / base.sharePrice);
      if (shares <= 0 || assets > u.value + 0.01) throw new FixtureError("That's more than your balance in the vault.");
      u.shares = Math.max(0, Math.round((u.shares - shares) * 1e4) / 1e4);
      u.usdgBalance += assets;
      u.netDeposits = Math.max(0, u.netDeposits - assets);
      L.tvl -= assets;
      L.instant -= assets;
      save();
      return hash();
    },
    async requestRedeem(address, shares) {
      await wait();
      const u = userOf(address);
      if (shares <= 0 || shares > u.shares + 1e-4) throw new FixtureError("That's more than your shares in the vault.");
      const t = now();
      const assets = Math.round(shares * base.sharePrice * 100) / 100;
      const r: WithdrawRequest = {id: `r-${++L.seq}-${t}`, assets, shares, requestedAt: new Date(t * 1000).toISOString(), settlesAt: new Date(settleTime(t) * 1000).toISOString(), status: "queued", position: 0};
      u.requests.unshift(r);
      u.shares = Math.max(0, Math.round((u.shares - shares) * 1e4) / 1e4);
      u.netDeposits = Math.max(0, u.netDeposits - assets);
      save();
      return {...hash(), id: r.id};
    },
    async claim(address, id) {
      await wait();
      const u = userOf(address);
      const r = u.requests.find((x) => x.id === id);
      if (!r) throw new FixtureError("That withdrawal request doesn't exist.");
      if (r.status !== "ready") throw new FixtureError("That request isn't ready to claim yet.");
      r.status = "claimed";
      u.usdgBalance += r.assets;
      L.tvl -= r.assets;
      save();
      return hash();
    },
    now,
    advance(seconds) {
      L.offset += seconds;
      save();
    },
    reset() {
      L = fresh();
      save();
    },
  };
}

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
