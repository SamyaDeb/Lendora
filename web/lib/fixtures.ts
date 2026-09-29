import type {VaultOverview, VaultPoint, VaultUser} from "./vault/types";
import type {HistoryPoint, Market, MarketDetail} from "./api";
import type {MarketChainState} from "./chain";

/**
 * Mock data for /dev previews and view tests. Shapes match the public API exactly; values are illustrative.
 * Never imported by a production page.
 */
type Status = Market["marketStatus"];

function market(symbol: string, o: {price: number; supplied: number; borrowed: number; apr: number; apy: number; status?: Status; borrowers?: number; buffer?: number; newShorts?: number; covered?: number}): Market {
  const u = o.borrowed / o.supplied;
  return {
    symbol,
    stockToken: "0x0000000000000000000000000000000000000001",
    marketId: "0x" + "ab".repeat(32),
    blockNumber: "10181",
    time: "2026-10-06T20:19:12.000Z",
    supplied: String(o.supplied),
    borrowed: String(o.borrowed),
    borrowedUsd: String(o.borrowed * o.price),
    utilization: String(u),
    utilizationVault: String(u * 0.96),
    borrowApr: String(o.apr),
    borrowApy: Math.expm1(o.apr),
    supplyApy: o.apy,
    rateKind: "variable",
    siPctFloat: String(o.borrowed / 24_400_000_000),
    daysToCover: 0.4,
    borrowers: o.borrowers ?? 12,
    newShorts24h: String(o.newShorts ?? 42),
    covered24h: String(o.covered ?? 18),
    marketStatus: o.status ?? "open",
    price: {usdPerShare: String(o.price), usdPerToken: String(o.price), feedUpdatedAt: "2026-10-06T20:19:00.000Z", multiplier: "1"},
    buffer: String(o.buffer ?? 0),
    guard: {tripped: false, reasons: []},
    raw: {
      suppliedShares: "0",
      borrowedShares: "0",
      utilizationWad: "0",
      borrowRatePerSecWad: "0",
      bufferWad: "0",
      marketOpen: (o.status ?? "open") !== "closed",
      guardReasons: "0",
      totalSupplyAssets: "0",
      totalBorrowAssets: "0",
      vaultIdle: "0",
      stockAnswer: "0",
      usdgAnswer: "100000000",
      multiplier: "1000000000000000000",
    },
  } as Market;
}

export const FX_MARKETS: Market[] = [
  market("NVDA", {price: 182.41, supplied: 4_820, borrowed: 3_612, apr: 0.0842, apy: 0.0568, borrowers: 31, newShorts: 212, covered: 64}),
  market("AAPL", {price: 231.07, supplied: 6_140, borrowed: 2_210, apr: 0.0381, apy: 0.0132, borrowers: 14, newShorts: 40, covered: 55}),
  market("SPY", {price: 588.9, supplied: 2_310, borrowed: 2_101, apr: 0.1473, apy: 0.1206, borrowers: 22, newShorts: 96, covered: 12}),
];

export const FX_MARKETS_WEEKEND: Market[] = FX_MARKETS.map((m) => ({...m, marketStatus: "closed", buffer: "0.101"}) as Market);
export const FX_MARKETS_PAUSED: Market[] = FX_MARKETS.map((m, i) => (i === 0 ? ({...m, marketStatus: "guard_tripped", guard: {tripped: true, reasons: ["stale price feed"]}} as Market) : m));

/** Hourly history over `hours` with a seeded random walk. */
export function fxHistory(m: Market, hours = 24 * 7, seed = 1): HistoryPoint[] {
  let s = seed * 9301;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280 - 0.5) * 2;
  const end = Date.parse("2026-10-06T20:00:00Z");
  let u = Number(m.utilization) * 0.82;
  let b = Number(m.borrowed) * 0.78;
  return Array.from({length: hours}, (_, i) => {
    u = Math.max(0.05, Math.min(0.97, u + rnd() * 0.012 + 0.0012));
    b = Math.max(1, b * (1 + rnd() * 0.01 + 0.0016));
    const apr = 0.02 + u * u * 0.12;
    return {
      bucket: new Date(end - (hours - 1 - i) * 3600_000).toISOString(),
      blockNumber: String(9000 + i),
      supplied: m.supplied,
      borrowed: String(b),
      borrowedUsd: String(b * Number(m.price.usdPerShare)),
      utilization: String(u),
      utilizationVault: String(u * 0.96),
      borrowApr: String(apr),
      supplyApy: apr * u * 0.9,
      siPctFloat: String(b / 24_400_000_000),
      borrowers: m.borrowers,
      marketStatus: "open",
      buffer: "0",
      priceUsdPerShare: m.price.usdPerShare,
    } as HistoryPoint;
  });
}

/** Market detail (06 `/stock/[ticker]`) for a fixture market. */
export function fxDetail(m: Market, weekend = false): MarketDetail {
  return {
    ...m,
    params: {
      lltv: "0.77",
      uMax: "0.9",
      hfMinOpen: "1.1",
      supplyCapShares: "20000",
      supplyCapUsd: String(20000 * Number(m.price.usdPerShare)),
      perAddressCapUsd: 250000,
      oracle: {z: "2.33", sigma: "0.45", bMin: "0.02", bMax: "0.25", rampInSec: 4 * 3600, heartbeatSec: 86400, staleGraceSec: 3600},
    },
    schedule: {
      sessionOpen: !weekend,
      bufferNow: weekend ? "0.101" : "0",
      bufferAtClose: "0.101",
      rampStart: "2026-10-09T20:00:00.000Z",
      nextClose: "2026-10-10T00:00:00.000Z",
      reopen: "2026-10-12T00:00:00.000Z",
      nextEvent: m.symbol === "NVDA" ? {buffer: "0.08", fullBy: "2026-11-19T21:00:00.000Z"} : null,
    },
    contracts: {morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", router: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955", oracle: "0x2deDA519dFBDaDf6Fc4c8f24140939DE6E101658", vault: "0x3DB7e7694921aE4f4D1fB367cC77Ac1eA6954F1F"},
  } as unknown as MarketDetail;
}

/** Chain state for the action panel (`useChainMarket`), with a funded wallet. `weekend` moves chain time to a Saturday. */
export function fxChain(ticker: string, price: number, o: {weekend?: boolean; debt?: number; collateral?: number; lent?: number} = {}): MarketChainState {
  const E18 = 10n ** 18n;
  const now = o.weekend ? 1_791_663_552n : 1_791_317_952n;
  const supply = 4_820n * E18;
  const borrow = 3_612n * E18;
  const debt = BigInt(Math.round((o.debt ?? 0) * 1e6)) * 10n ** 12n;
  const lent = BigInt(Math.round((o.lent ?? 12.3) * 1e6)) * 10n ** 12n;
  return {
    ticker,
    now,
    block: 10_181n,
    stockAnswer: BigInt(Math.round(price * 1e8)),
    stockUpdatedAt: now - 30n,
    usdgAnswer: 100_000_000n,
    params: {z: 2_330_000_000_000_000_000n, sigma: 450_000_000_000_000_000n, bMin: 20_000_000_000_000_000n, bMax: 250_000_000_000_000_000n, rampIn: 14_400n},
    bufferFloor: 0n,
    bufferNow: o.weekend ? 101_000_000_000_000_000n : 0n,
    guardReasons: 0n,
    multiplier: E18,
    lltv: 770_000_000_000_000_000n,
    market: {totalSupplyAssets: supply, totalSupplyShares: supply * 1_000_000n, totalBorrowAssets: borrow + debt, totalBorrowShares: (borrow + debt) * 1_000_000n, lastUpdate: now, fee: 100_000_000_000_000_000n},
    rateAtTarget: 1_268_391_679n,
    vaultIdle: 40n * E18,
    adapterAssets: supply,
    perAddressCapUsd: 250_000n * E18,
    user: {
      address: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
      collateral: BigInt(Math.round((o.collateral ?? 0) * 1e6)),
      borrowShares: debt * 1_000_000n,
      stockBalance: 40n * E18,
      usdgBalance: 50_000n * 1_000_000n,
      vaultShares: lent,
      vaultAssets: lent,
      stockAllowance: 0n,
      usdgAllowance: 0n,
      vaultAllowance: 0n,
      authorized: false,
    },
  };
}

/**
 * USDG Earn (08, Phase 4): overview and user per preview state until the contracts (task 14) and `/v1/vault/*`
 * (task 16) exist. `lib/vault/source.ts` seeds its in-memory ledger from these; views and tests read them directly.
 */
export const VAULT_STATES = ["preview", "open", "cap_full", "weekend", "nav_stale", "kill_switch", "venue_halted", "has_requests", "loading", "error", "disconnected", "empty"] as const;
export type VaultState = (typeof VAULT_STATES)[number];

/** Tue 6 Oct 2026 16:19 ET (market open), the markets fixtures' time; weekend states use Sat 10 Oct. */
export const VAULT_T_OPEN = Date.parse("2026-10-06T20:19:12.000Z") / 1000;
export const VAULT_T_WEEKEND = Date.parse("2026-10-10T16:00:00.000Z") / 1000;
const DAY = 86_400;
const iso = (t: number) => new Date(t * 1000).toISOString();

/** Daily net APY and share price since launch (160 days), seeded; the share price compounds the APY. */
function vaultSeries(end: number, days = 160, level = 0.093, seed = 7) {
  let s = seed * 9301;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280 - 0.5) * 2;
  const apy: VaultPoint[] = [];
  let a = level;
  for (let i = 0; i < days; i++) {
    a = Math.max(0.035, Math.min(0.16, a + rnd() * 0.006 + (level - a) * 0.08));
    apy.push({t: end - (days - 1 - i) * DAY, v: Math.round(a * 1e5) / 1e5});
  }
  let p = 1;
  const price = apy.map((x) => ({t: x.t, v: Math.round((p *= 1 + x.v / 365) * 1e6) / 1e6}));
  return {apy, price};
}

const OPEN_SERIES = vaultSeries(VAULT_T_OPEN);

export const FX_VAULT_OVERVIEW: VaultOverview = {
  asOf: {block: "10181", time: iso(VAULT_T_OPEN)},
  apy: {d7: 0.1012, d30: 0.0934, d90: 0.0871},
  apySeries: OPEN_SERIES.apy,
  sharePriceSeries: OPEN_SERIES.price,
  split: [
    {window: "7d", lending: 0.0488, funding: 0.0571, buffer: 0.0021, costs: -0.0068},
    {window: "30d", lending: 0.0461, funding: 0.0512, buffer: 0.0021, costs: -0.006},
    {window: "90d", lending: 0.0442, funding: 0.0463, buffer: 0.0022, costs: -0.0056},
  ],
  sharePrice: OPEN_SERIES.price[OPEN_SERIES.price.length - 1].v,
  tvl: 1_284_000,
  cap: 2_000_000,
  sleeves: [
    {symbol: "SPY", weight: 0.5, cap: 1_000_000, delta: 0.004, marginRatio: 3.1, status: "active"},
    {symbol: "NVDA", weight: 0.25, cap: 500_000, delta: -0.012, marginRatio: 2.6, status: "active"},
    {symbol: "AAPL", weight: 0.25, cap: 500_000, delta: 0.007, marginRatio: 2.9, status: "active"},
  ],
  allocation: {lent: 0.6589, held: 0.0534, perpMargin: 0.2377, cash: 0.05},
  instantCapacity: 64_200,
  nav: {ageSec: 42, stale: false},
  venue: {name: "Perp venue (to be selected)", status: "ok"},
  killSwitch: [],
  lastRebalance: iso(VAULT_T_OPEN - 49 * 60),
  bandPct: 0.02,
  marginTarget: 2,
  marginTargetClosed: 3,
  marketClosed: false,
  depositsOpen: true,
  contracts: {
    vault: "0x5f1C5e6a0b3E0cC9a1D1A0a4B7c6D2e8F3a9b0c1",
    strategy: "0x7a2B9c0D1e2F3a4B5c6D7e8F9a0B1c2D3e4F5a6b",
    navOracle: "0x3c4D5e6F7a8B9c0D1e2F3a4B5c6D7e8F9a0B1c2d",
    perpAdapter: "0x9e8F7a6B5c4D3e2F1a0B9c8D7e6F5a4B3c2D1e0f",
  },
};

/** A wallet with 4,802.1 shares (≈ 5,000 USDG), 50,000 USDG to deposit, no approval yet. */
export const FX_VAULT_USER: VaultUser = {
  shares: 4_802.1,
  value: Math.round(4_802.1 * FX_VAULT_OVERVIEW.sharePrice * 100) / 100,
  netDeposits: 4_850,
  usdgBalance: 50_000,
  usdgAllowance: 0,
  requests: [],
};

const WEEKEND_SERIES = vaultSeries(VAULT_T_WEEKEND);
const req = (id: string, assets: number, requestedAt: number, settlesAt: number, status: "queued" | "ready", position: number) => ({
  id,
  assets,
  shares: Math.round((assets / FX_VAULT_OVERVIEW.sharePrice) * 1e4) / 1e4,
  requestedAt: iso(requestedAt),
  settlesAt: iso(settlesAt),
  status,
  position,
});

/** Overview and user for each state (loading / error / disconnected render without one or the other). */
export function fxVault(state: VaultState): {overview?: VaultOverview; user?: VaultUser; error?: boolean} {
  const o = FX_VAULT_OVERVIEW;
  const u = FX_VAULT_USER;
  switch (state) {
    case "preview":
      return {overview: {...o, tvl: 0, cap: 0, instantCapacity: 0, depositsOpen: false, pauseReason: "cap_zero"}, user: {...u, shares: 0, value: 0, netDeposits: 0}};
    case "cap_full":
      return {overview: {...o, tvl: 2_000_000, instantCapacity: 100_000, depositsOpen: false, pauseReason: "cap_full"}, user: u};
    case "weekend":
      return {
        overview: {...o, asOf: {block: "10420", time: iso(VAULT_T_WEEKEND)}, apySeries: WEEKEND_SERIES.apy, sharePriceSeries: WEEKEND_SERIES.price, marketClosed: true, lastRebalance: iso(VAULT_T_WEEKEND - 44 * 3600), nav: {ageSec: 180, stale: false}, sleeves: o.sleeves.map((s) => ({...s, marginRatio: (s.marginRatio ?? 0) + 0.5}))},
        user: u,
      };
    case "nav_stale":
      return {
        overview: {...o, asOf: {block: "10420", time: iso(VAULT_T_WEEKEND)}, marketClosed: true, nav: {ageSec: 21 * 60, stale: true}, depositsOpen: false, pauseReason: "nav_stale"},
        user: {...u, requests: [req("r-3", 1_200, VAULT_T_WEEKEND - 5 * DAY, VAULT_T_WEEKEND - 2 * DAY, "ready", 0)]},
      };
    case "kill_switch":
      return {
        overview: {
          ...o,
          apy: {d7: 0.0712, d30: 0.0788, d90: 0.0823},
          split: [
            {window: "7d", lending: 0.0402, funding: 0.0347, buffer: 0.0024, costs: -0.0061},
            {window: "30d", lending: 0.0423, funding: 0.0399, buffer: 0.0023, costs: -0.0057},
            {window: "90d", lending: 0.0431, funding: 0.0425, buffer: 0.0022, costs: -0.0055},
          ],
          sleeves: o.sleeves.map((s) => (s.symbol === "NVDA" ? {...s, delta: 0, marginRatio: 0, status: "unwound" as const} : s)),
          allocation: {lent: 0.4944, held: 0.04, perpMargin: 0.1781, cash: 0.2875},
          instantCapacity: 369_150,
          killSwitch: [{symbol: "NVDA", since: iso(VAULT_T_OPEN - 2 * DAY)}],
        },
        user: u,
      };
    case "venue_halted":
      return {overview: {...o, venue: {...o.venue, status: "halted"}}, user: u};
    case "has_requests":
      return {
        overview: o,
        user: {...u, requests: [req("r-2", 2_000, VAULT_T_OPEN - 3600, VAULT_T_OPEN + 2 * DAY + 4 * 3600 + 20 * 60, "queued", 3), req("r-1", 1_200, VAULT_T_OPEN - 4 * DAY, VAULT_T_OPEN - DAY, "ready", 0)]},
      };
    case "loading":
      return {};
    case "error":
      return {error: true};
    case "disconnected":
      return {overview: o};
    case "empty":
      return {overview: o, user: {...u, shares: 0, value: 0, netDeposits: 0}};
    default:
      return {overview: o, user: u};
  }
}

/** Backstop pool (09 §2, Phase 5): preview data. */
export interface BackstopData {
  apy: number;
  poolAssets: number;
  borrowedUsd: number;
  targetRatio: number;
  coverCap: number;
  cooldownDays: number;
  user?: {staked: number; earned: number; cooldownEndsAt?: string};
  payouts: {time: string; symbol: string; amount: number; tx: string}[];
}
export const FX_BACKSTOP: BackstopData = {
  apy: 0.071,
  poolAssets: 184_000,
  borrowedUsd: 2_406_809,
  targetRatio: 0.05,
  coverCap: 0.3,
  cooldownDays: 14,
  user: {staked: 10_000, earned: 132.4, cooldownEndsAt: "2026-10-15T20:19:12.000Z"},
  payouts: [
    {time: "2026-09-14T15:02:00.000Z", symbol: "NVDA", amount: 3_120.55, tx: "0x" + "3a".repeat(32)},
    {time: "2026-08-02T21:44:00.000Z", symbol: "SPY", amount: 812.1, tx: "0x" + "7c".repeat(32)},
  ],
};
