import {createRoute, z, type OpenAPIHono} from "@hono/zod-openapi";
import type {Context} from "hono";
import {formatUnits, type PublicClient} from "viem";
import {deltaNeutralVaultAbi, erc20Abi, marketHoursAbi, mockPerpVenueAbi, navOracleAbi, perpAdapterAbi, strategyManagerAbi, lendoraOracleAbi, type ChainDeployment} from "@lendora/sdk";
import type {IndexerDb, Row} from "./db.js";
import {envelope, iso, type Envelope} from "./model.js";
import {HttpError} from "./errors.js";
import * as S from "./schemas.js";

/**
 * `/v1/vault/*` (DN-R11, Phase 4 task 16) and `/v1/receipt-markets` (A3). History comes from the indexer (NAV reports,
 * requests, daily funding/costs/fees); the live state (sleeves, delta, margin, freshness, caps) is read from chain,
 * cached for 3 s. Every rate is variable and historical (CP-R7); nothing here is a forecast.
 */

const UNIT = 10n ** 18n;
const WAD = 10n ** 18n;
const DAY = 86_400n;
const big = (v: unknown) => BigInt(String(v ?? 0));
const usdg = (v: bigint) => formatUnits(v, 6);
const frac = (v: number) => (Number.isFinite(v) ? v.toFixed(6) : "0");

export interface DnLive {
  block: bigint;
  timestamp: bigint;
  tvl: bigint;
  supply: bigint;
  sharePriceWad: bigint;
  cap: bigint;
  idle: bigint;
  instant: bigint;
  depositsPaused: boolean;
  open: boolean;
  fresh: boolean;
  reportAge: bigint;
  maxAgeClosed: bigint;
  perp: bigint;
  stratUsdg: bigint;
  queue: {head: bigint; tail: bigint; escrowed: bigint};
  marginRatioWad: bigint | null;
  venueHalted: boolean;
  sleeves: {id: number; symbol: string; active: boolean; capUsdg: bigint; spot: bigint; lent: bigint; short: bigint; unitValue: bigint}[];
}

/** Live vault state from chain (cached per head block). */
export class DnReader {
  private cache?: {at: number; v: DnLive};
  private inflight?: {block: bigint; p: Promise<DnLive>};
  /**
   * `minAgeMs` (DN_LIVE_CACHE_MS): reuse a read for at least this long even when the head moved. On 46630 (~4 blocks/s)
   * a per-block cache re-read ~30 values per request and throttled the shared RPC (T37). 0 (tests on anvil): per block.
   */
  constructor(
    private readonly client: PublicClient,
    private readonly d: ChainDeployment,
    private readonly minAgeMs = 0,
  ) {}

  private rd<T>(address: `0x${string}`, abi: readonly unknown[], functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
    return (this.client.readContract as (p: unknown) => Promise<T>)({address, abi, functionName, args, blockNumber});
  }

  async live(): Promise<DnLive> {
    // Cached per head block (a chain that jumps in time, like anvil in tests, never serves a stale timestamp).
    if (this.cache && this.minAgeMs > 0 && Date.now() - this.cache.at < this.minAgeMs) return this.cache.v;
    const head = await this.client.getBlockNumber({cacheTime: 0});
    if (this.cache && this.cache.v.block === head) return this.cache.v;
    // OFF-22: concurrent requests at a new block share one set of chain reads (no RPC fan-out per request).
    if (this.inflight?.block === head) return this.inflight.p;
    const p = this.read(head).finally(() => {
      if (this.inflight?.p === p) this.inflight = undefined;
    });
    this.inflight = {block: head, p};
    return p;
  }

  private async read(head: bigint): Promise<DnLive> {
    const dn = this.d.dnVault!;
    const b = await this.client.getBlock({blockNumber: head});
    const bn = b.number;
    const r = <T>(a: `0x${string}`, abi: readonly unknown[], f: string, args: readonly unknown[] = []) => this.rd<T>(a, abi, f, args, bn);
    const hasAdapter = !/^0x0{40}$/i.test(dn.perpAdapter);
    const [tvl, supply, sharePriceWad, cap, idle, instant, depositsPaused, open, fresh, reportAge, maxAgeClosed, perp, stratUsdg, bounds, escrowed, n] = await Promise.all([
      r<bigint>(dn.vault, deltaNeutralVaultAbi, "totalAssets"),
      r<bigint>(dn.vault, deltaNeutralVaultAbi, "totalSupply"),
      r<bigint>(dn.vault, deltaNeutralVaultAbi, "sharePrice"),
      r<bigint>(dn.vault, deltaNeutralVaultAbi, "totalCap"),
      r<bigint>(dn.vault, deltaNeutralVaultAbi, "idleAssets"),
      r<bigint>(dn.vault, deltaNeutralVaultAbi, "instantCapacity"),
      r<boolean>(dn.vault, deltaNeutralVaultAbi, "depositsPaused"),
      r<boolean>(this.d.marketHours, marketHoursAbi, "isOpen", [b.timestamp]),
      r<boolean>(dn.navOracle, navOracleAbi, "fresh"),
      r<bigint>(dn.navOracle, navOracleAbi, "reportAge"),
      r<bigint>(dn.navOracle, navOracleAbi, "maxAgeClosed"),
      r<bigint>(dn.navOracle, navOracleAbi, "perpValue"),
      r<bigint>(this.d.usdg, erc20Abi, "balanceOf", [dn.strategy]),
      r<readonly [bigint, bigint]>(dn.vault, deltaNeutralVaultAbi, "queueBounds"),
      r<bigint>(dn.vault, deltaNeutralVaultAbi, "escrowedShares"),
      r<bigint>(dn.strategy, strategyManagerAbi, "sleeveCount"),
    ]);
    let marginRatioWad: bigint | null = null;
    let venueHalted = false;
    if (hasAdapter) {
      // The mock venue exposes both; a venue without them reports null / not halted (the rebalancer reads the report).
      marginRatioWad = await r<bigint>(dn.perpAdapter, mockPerpVenueAbi, "marginRatio").catch(() => null);
      venueHalted = await r<boolean>(dn.perpAdapter, mockPerpVenueAbi, "withdrawalsHalted").catch(() => false);
    }
    const last = await r<{shortSizes: readonly bigint[]}>(dn.navOracle, navOracleAbi, "lastReport");
    const bySymbolToken = new Map(Object.entries(this.d.stocks).map(([t, s]) => [s.stockToken.toLowerCase(), t]));
    const sleeves = await Promise.all(
      Array.from({length: Number(n)}, async (_, i) => {
        const sl = await r<{stockToken: `0x${string}`; perpMarket: `0x${string}`; capUsdg: bigint; active: boolean}>(dn.strategy, strategyManagerAbi, "sleeve", [BigInt(i)]);
        const [spot, lent, unitValue] = await Promise.all([
          r<bigint>(dn.strategy, strategyManagerAbi, "spotUnits", [BigInt(i)]),
          r<bigint>(dn.strategy, strategyManagerAbi, "lentUnits", [BigInt(i)]),
          r<bigint>(dn.strategy, strategyManagerAbi, "quote", [BigInt(i), UNIT]),
        ]);
        let short = last.shortSizes[i] ?? 0n;
        if (hasAdapter) {
          const [readable, size] = await r<readonly [boolean, bigint]>(dn.perpAdapter, perpAdapterAbi, "shortSize", [sl.perpMarket]);
          if (readable) short = size;
        }
        return {id: i, symbol: bySymbolToken.get(sl.stockToken.toLowerCase()) ?? `#${i}`, active: sl.active, capUsdg: sl.capUsdg, spot, lent, short, unitValue};
      }),
    );
    const v: DnLive = {block: bn, timestamp: b.timestamp, tvl, supply, sharePriceWad, cap, idle, instant, depositsPaused, open, fresh, reportAge, maxAgeClosed, perp, stratUsdg, queue: {head: bounds[0], tail: bounds[1], escrowed}, marginRatioWad, venueHalted, sleeves};
    this.cache = {at: Date.now(), v};
    return v;
  }
}

/** Share price growth between two NAV points, annualized (compounded). */
export function annualized(p0: bigint, p1: bigint, seconds: bigint): number | null {
  if (p0 <= 0n || seconds <= 0n) return null;
  const r = Number(p1) / Number(p0);
  return Math.pow(r, (365 * 86_400) / Number(seconds)) - 1;
}

/** The overview body (numbers as decimal strings; fractions 0–1). Exported for the unit tests. */
export async function vaultOverview(db: IndexerDb, reader: DnReader, d: ChainDeployment) {
  const live = await reader.live();
  const now = live.timestamp;
  const windows = [
    {window: "7d" as const, days: 7n},
    {window: "30d" as const, days: 30n},
    {window: "90d" as const, days: 90n},
  ];
  const apy: Record<string, number | null> = {};
  const split = [];
  for (const w of windows) {
    const from = now - w.days * DAY;
    const start = await db.dnNavAt(from);
    const first = start ?? (await db.dnNavSince(from, 1))[0];
    const seconds = first ? now - big(first.timestamp) : 0n;
    const net = first && seconds >= DAY ? annualized(big(first.share_price_wad), live.sharePriceWad, seconds) : null;
    apy[w.window] = net;
    const sums = await db.dnDaysSum((from / DAY) * DAY, now + DAY);
    const avgNav = Number(live.tvl > 0n ? live.tvl : 1n);
    const years = Number(seconds > 0n ? seconds : w.days * DAY) / (365 * 86_400);
    const funding = Number(big(sums.funding)) / avgNav / years;
    const costs = -(Number(big(sums.costs)) + Number(big(sums.fee))) / avgNav / years;
    // Lending is the rest of the net return (lending income plus the hedge's residual), so the parts add up.
    const lending = net === null ? 0 : net - funding - costs;
    split.push({window: w.window, lending: frac(lending), funding: frac(net === null ? 0 : funding), buffer: frac(0), costs: frac(net === null ? 0 : costs)});
  }
  const historySince = now - 365n * DAY;
  const points = await db.dnNavSince(historySince);
  const daily = new Map<bigint, Row>();
  for (const p of points) daily.set((big(p.timestamp) / DAY) * DAY, p);
  const days = [...daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const sharePriceSeries = days.map(([t, p]) => ({t: Number(t), v: formatUnits(big(p.share_price_wad), 18)}));
  const apySeries = days.slice(1).map(([t, p], i) => ({t: Number(t), v: frac(annualized(big(days[i][1].share_price_wad), big(p.share_price_wad), t - days[i][0]) ?? 0)}));

  const spotValue = (s: DnLive["sleeves"][number]) => (s.spot * s.unitValue) / UNIT;
  const totalSpot = live.sleeves.reduce((a, s) => a + spotValue(s), 0n);
  const lentValue = live.sleeves.reduce((a, s) => a + (s.lent * s.unitValue) / UNIT, 0n);
  const nav = live.tvl > 0n ? live.tvl : 1n;
  const f = (x: bigint) => frac(Number(x) / Number(nav));
  const kills = new Map((await db.dnSleeves()).map((r) => [Number(r.id), r]));
  const lastTrade = [...kills.values()].reduce((a, r) => (r.last_trade_at && big(r.last_trade_at) > a ? big(r.last_trade_at) : a), 0n);
  const stale = !live.fresh;
  const pauseReason = live.cap === 0n ? "cap_zero" : live.tvl >= live.cap ? "cap_full" : stale ? "nav_stale" : live.depositsPaused ? "paused" : undefined;
  const hasAdapter = !/^0x0{40}$/i.test(d.dnVault!.perpAdapter);
  return {
    live,
    body: {
      sharePrice: formatUnits(live.sharePriceWad, 18),
      tvl: usdg(live.tvl),
      cap: usdg(live.cap),
      instantCapacity: usdg(live.instant),
      apy: {d7: apy["7d"] === null ? null : frac(apy["7d"]!), d30: apy["30d"] === null ? null : frac(apy["30d"]!), d90: apy["90d"] === null ? null : frac(apy["90d"]!)},
      apySeries,
      sharePriceSeries,
      split,
      sleeves: live.sleeves.map((s) => {
        const v = spotValue(s);
        return {
          symbol: s.symbol,
          weight: frac(totalSpot > 0n ? Number(v) / Number(totalSpot) : 0),
          cap: usdg(s.capUsdg),
          delta: frac(s.spot > 0n ? (Number(s.spot) - Number(s.short)) / Number(s.spot) : 0),
          marginRatio: live.marginRatioWad === null ? null : formatUnits(live.marginRatioWad > 10n ** 30n ? 10n ** 30n : live.marginRatioWad, 18),
          status: s.active ? ("active" as const) : ("unwound" as const),
          spotUsdg: usdg(v),
          lentUnits: formatUnits(s.lent, 18),
          shortUnits: formatUnits(s.short, 18),
        };
      }),
      allocation: {lent: f(lentValue), held: f(totalSpot - lentValue), perpMargin: f(live.perp), cash: f(live.idle + live.stratUsdg)},
      nav: {ageSec: live.reportAge > 10n ** 12n ? null : Number(live.reportAge), stale, maxAgeClosedSec: Number(live.maxAgeClosed)},
      venue: {name: hasAdapter ? (d.mocks ? "Mock perp venue (test)" : "Lighter") : "none (no venue wired)", status: live.venueHalted ? ("halted" as const) : ("ok" as const)},
      killSwitch: [...kills.entries()].filter(([, r]) => r.killed_at).map(([id, r]) => ({symbol: live.sleeves[id]?.symbol ?? `#${id}`, since: iso(r.killed_at)})),
      lastRebalance: lastTrade > 0n ? iso(lastTrade) : null,
      bandPct: "0.02",
      marginTarget: "2",
      marginTargetClosed: "3",
      marketClosed: !live.open,
      depositsOpen: pauseReason === undefined && live.open,
      pauseReason: pauseReason ?? null,
      queue: {length: Number(live.queue.tail - live.queue.head), escrowedShares: formatUnits(live.queue.escrowed, 18)},
      contracts: {vault: d.dnVault!.vault, strategy: d.dnVault!.strategy, navOracle: d.dnVault!.navOracle, perpAdapter: d.dnVault!.perpAdapter},
      rateKind: "variable" as const,
    },
  };
}

type Helpers = {
  json: <T extends z.ZodTypeAny>(schema: T, description: string) => {content: {"application/json": {schema: T}}; description: string};
  errors: Record<number, unknown>;
  asOfHeaders: (c: Context, e: Envelope) => void;
};

/** Registers the vault and receipt-market routes. */
export function registerVaultRoutes(app: OpenAPIHono<never>, db: IndexerDb, client: PublicClient, d: ChainDeployment, h: Helpers, liveCacheMs = 0) {
  const reader = d.dnVault ? new DnReader(client, d, liveCacheMs) : undefined;
  const need = () => {
    if (!reader) throw new HttpError(404, "no delta-neutral vault on this network");
    return reader;
  };
  const env = async (live?: DnLive) => {
    const head = await db.head();
    return live ? envelope(head, live.block, live.timestamp) : envelope(head);
  };

  app.openapi(
    createRoute({method: "get", path: "/v1/vault/overview", tags: ["vault"], summary: "USDG Earn: share price, net APY (7/30/90d, historical, variable), yield split, sleeves, delta, margin, venue, queue (DN-R11)", responses: {200: h.json(S.VaultOverviewResponse, "Overview"), ...(h.errors as object)}}),
    async (c) => {
      const {live, body} = await vaultOverview(db, need(), d);
      const e = await env(live);
      h.asOfHeaders(c as never, e);
      return c.json({...e, data: body} as never, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/vault/account/{address}",
      tags: ["vault"],
      summary: "USDG Earn position of an address: shares, value at the current share price, net deposits, withdrawal requests",
      request: {params: z.object({address: S.Address})},
      responses: {200: h.json(S.VaultAccountResponse, "Account"), ...(h.errors as object)},
    }),
    async (c) => {
      const {address} = c.req.valid("param" as never) as {address: string};
      const live = await need().live();
      const [acct, reqs] = await Promise.all([db.dnAccount(address), db.dnRequests(address)]);
      const shares = big(acct?.shares);
      const value = (shares * live.sharePriceWad) / WAD / 10n ** 12n;
      const e = await env(live);
      h.asOfHeaders(c as never, e);
      return c.json(
        {
          ...e,
          data: {
            address,
            shares: formatUnits(shares, 18),
            value: usdg(value),
            netDeposits: usdg(big(acct?.deposited) - big(acct?.withdrawn)),
            requests: reqs.map((r) => ({
              id: String(r.id),
              owner: String(r.owner),
              receiver: String(r.receiver),
              shares: formatUnits(big(r.shares), 18),
              assets: r.assets === null ? null : usdg(big(r.assets)),
              requestedAt: iso(r.requested_at),
              settlesAt: iso(r.settle_by),
              status: String(r.status) === "claimable" ? "ready" : String(r.status),
              position: Number(r.position),
            })),
          },
        } as never,
        200,
      );
    },
  );

  app.openapi(
    createRoute({method: "get", path: "/v1/receipt-markets", tags: ["markets"], summary: "G5 receipt markets (rSTOCK collateral, USDG loans): totals, utilization, LLTV (A3)", responses: {200: h.json(S.ReceiptMarketsResponse, "Receipt markets"), ...(h.errors as object)}}),
    async (c) => {
      const rows = await db.receiptMarkets();
      const e = await env();
      h.asOfHeaders(c as never, e);
      const data = await Promise.all(
        Object.entries(d.stocks)
          .filter(([, s]) => s.receipt)
          .map(async ([t, s]) => {
            const r = rows.find((x) => x.ticker === t);
            const supply = big(r?.total_supply_assets);
            const borrow = big(r?.total_borrow_assets);
            const cap = await (client.readContract as (p: unknown) => Promise<bigint>)({
              address: s.receipt!.usdgVault,
              abi: [{type: "function", name: "absoluteCap", stateMutability: "view", inputs: [{type: "bytes32"}], outputs: [{type: "uint256"}]}],
              functionName: "absoluteCap",
              args: [s.receipt!.adapterMarketCapId],
            }).catch(() => 0n);
            const [answer] = await (client.readContract as (p: unknown) => Promise<readonly [bigint, bigint]>)({address: s.oracle, abi: lendoraOracleAbi, functionName: "stockAnswer"});
            return {
              symbol: t,
              marketId: s.receipt!.marketId,
              usdgVault: s.receipt!.usdgVault,
              oracle: s.receipt!.oracle,
              lltv: formatUnits(BigInt(s.receipt!.lltv), 18),
              listed: cap > 0n,
              capUsdg: usdg(cap),
              supplied: usdg(supply),
              borrowed: usdg(borrow),
              utilization: frac(supply > 0n ? Number(borrow) / Number(supply) : 0),
              collateralShares: formatUnits(big(r?.collateral), 18),
              stockPriceUsd: formatUnits(answer, 8),
              rateKind: "variable" as const,
            };
          }),
      );
      return c.json({...e, data} as never, 200);
    },
  );
}
