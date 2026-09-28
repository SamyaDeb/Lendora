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
