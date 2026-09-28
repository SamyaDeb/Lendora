import type {HistoryPoint, Market} from "./api";

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
