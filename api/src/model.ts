import {formatUnits} from "viem";
import {
  CLUSDG_VALUE_PER_TOKEN,
  FEED_DECIMALS,
  STOCK_LOAN_SCALE_EXP,
  healthFactor,
  liquidationPrice,
  stockLoanPrice,
  toAssetsUp,
  type ChainDeployment,
} from "@lendora/sdk";
import type {HeadRow, Row} from "./db.js";

/** Formatting for the public API (07 §2: JSON, ISO 8601 UTC times, amounts as decimal strings). Every number is
 * computed by `@lendora/sdk` (indexer snapshots via `shortInterestFields`, positions below); this module only
 * formats. */

export const SCOPE = "Lendora markets only: the stock-loan Morpho Blue market and the rSTOCK Vault V2 of each stock";

const big = (v: unknown): bigint => BigInt(String(v ?? 0));
export const wad = (v: unknown, digits = 18) => formatUnits(big(v), digits);
export const iso = (ts: unknown) => new Date(Number(big(ts)) * 1000).toISOString();

export interface Envelope {
  asOfBlock: string;
  asOfTime: string;
  confirmed: boolean;
  safe: boolean;
  scope: string;
}

/** SI-R13: the block and time the data is as of, and whether that block is final (A23: ≤ `finalized`). */
export function envelope(head: HeadRow | undefined, block?: bigint, timestamp?: bigint): Envelope {
  const b = block ?? big(head?.head_block);
  const t = timestamp ?? big(head?.head_timestamp);
  return {
    asOfBlock: b.toString(),
    asOfTime: iso(t),
    confirmed: head ? b <= big(head.finalized_block) : false,
    safe: head ? b <= big(head.safe_block) : false,
    scope: SCOPE,
  };
}

export const GUARD_REASONS = [
  "MANUAL",
  "DEVIATION",
  "L2_GAP",
  "STALE",
  "SANITY",
  "USDG_FEED",
  "ORACLE_PAUSED",
  "TOKEN_PAUSED",
  "WRAPPER_BLOCKED",
  "MULTIPLIER",
  "SEQUENCER",
  "CALENDAR",
] as const;

/** Decode the oracle's reason bitmask (LendoraOracleBase constants). */
export function guardReasonNames(mask: bigint): string[] {
  return GUARD_REASONS.filter((_, i) => (mask >> BigInt(i)) & 1n);
}

/** One market snapshot, 07 §Definitions. `raw` carries the exact integers (for audits and the lens comparison). */
export function marketView(row: Row, d: ChainDeployment) {
  const s = d.stocks[String(row.ticker)];
  const feed = big(row.price_answer);
  return {
    symbol: String(row.ticker),
    stockToken: s.stockToken,
    marketId: s.marketId,
    blockNumber: String(row.block_number),
    time: iso(row.timestamp),
    supplied: wad(row.supplied_shares),
    borrowed: wad(row.borrowed_shares),
    borrowedUsd: wad(row.borrowed_usd),
    utilization: wad(row.utilization),
    utilizationVault: wad(row.utilization_vault),
    borrowApr: wad(row.borrow_apr),
    borrowApy: Number(row.borrow_apy),
    supplyApy: Number(row.supply_apy),
    rateKind: "variable" as const,
    siPctFloat: wad(row.si_pct_float),
    daysToCover: row.days_to_cover === null ? null : Number(row.days_to_cover),
    borrowers: Number(row.borrowers),
    newShorts24h: wad(row.new_shorts24h),
    covered24h: wad(row.covered24h),
    marketStatus: String(row.market_status) as "open" | "closed" | "ramping" | "guard_tripped",
    price: {
      usdPerShare: wad(row.price_usd),
      usdPerToken: formatUnits(feed, FEED_DECIMALS),
      feedUpdatedAt: iso(row.price_updated_at),
      multiplier: wad(row.multiplier),
    },
    buffer: wad(row.buffer_wad),
    guard: {tripped: big(row.guard_reasons) !== 0n, reasons: guardReasonNames(big(row.guard_reasons))},
    raw: {
      suppliedShares: String(row.supplied_shares),
      borrowedShares: String(row.borrowed_shares),
      utilizationWad: String(row.utilization),
      borrowRatePerSecWad: String(row.borrow_rate_per_sec),
      bufferWad: String(row.buffer_wad),
      marketOpen: Boolean(row.market_open),
      guardReasons: String(row.guard_reasons),
      totalSupplyAssets: String(row.total_supply_assets),
      totalBorrowAssets: String(row.total_borrow_assets),
      vaultIdle: String(row.vault_idle),
      stockAnswer: String(row.price_answer),
      usdgAnswer: String(row.usdg_answer),
      multiplier: String(row.multiplier),
    },
  };
}
export type MarketView = ReturnType<typeof marketView>;

/** A Morpho position with debt, health factor and liquidation price at the snapshot (SDK `healthFactor`,
 * `liquidationPrice`; OR-R22). */
export function positionView(p: Row, snap: Row | undefined, market: Row | undefined, d: ChainDeployment) {
  const ticker = String(p.ticker);
  const s = d.stocks[ticker];
  const borrowShares = big(p.borrow_shares);
  const collateral = big(p.collateral);
  let borrowed = 0n;
  let hf: string | null = null;
  let liq: string | null = null;
  if (snap && borrowShares > 0n) {
    // Debt from the snapshot's accrued totals (shares rounded up, like Morpho's expectedBorrowAssets).
    const totalBorrowShares = big(market?.total_borrow_shares);
    borrowed = toAssetsUp(borrowShares, big(snap.total_borrow_assets), totalBorrowShares);
    const price = stockLoanPrice(CLUSDG_VALUE_PER_TOKEN, big(snap.usdg_answer), big(snap.price_answer), big(snap.buffer_wad), STOCK_LOAN_SCALE_EXP);
    hf = wad(healthFactor(collateral, price, BigInt(s.lltv), borrowed));
    liq = formatUnits(
      liquidationPrice({collateral, borrowed}, big(snap.buffer_wad), CLUSDG_VALUE_PER_TOKEN, big(snap.usdg_answer), BigInt(s.lltv), STOCK_LOAN_SCALE_EXP),
      FEED_DECIMALS,
    );
  }
  const role: "account" | "vault-adapter" = p.account && String(p.account).toLowerCase() === s.adapter.toLowerCase() ? "vault-adapter" : "account";
  return {
    symbol: ticker,
    role,
    supplyShares: String(p.supply_shares),
    borrowShares: borrowShares.toString(),
    borrowed: wad(borrowed),
    collateralUsdg: formatUnits(collateral, 6),
    healthFactor: hf,
    liquidationPriceUsdPerToken: liq,
    updatedBlock: String(p.updated_block),
  };
}

/** One event-feed row. */
export function eventView(e: Row) {
  return {
    id: String(e.id),
    symbol: String(e.ticker),
    type: String(e.type),
    source: String(e.source),
    account: e.account ? String(e.account) : null,
    assets: e.assets === null ? null : wad(e.assets),
    shares: e.shares === null ? null : String(e.shares),
    data: (e.data as Record<string, unknown> | null) ?? null,
    blockNumber: String(e.block_number),
    logIndex: Number(e.log_index),
    time: iso(e.timestamp),
    txHash: String(e.tx_hash),
  };
}

/** History row (rollup bucket close + flows). */
export function historyView(r: Row) {
  return {
    bucket: iso(r.bucket),
    blockNumber: String(r.block_number),
    supplied: wad(r.supplied_shares),
    borrowed: wad(r.borrowed_shares),
    borrowedUsd: wad(r.borrowed_usd),
    utilization: wad(r.utilization),
    utilizationVault: wad(r.utilization_vault),
    borrowApr: wad(r.borrow_apr),
    supplyApy: Number(r.supply_apy),
    siPctFloat: wad(r.si_pct_float),
    borrowers: Number(r.borrowers),
    marketStatus: String(r.market_status),
    buffer: wad(r.buffer_wad),
    priceUsdPerShare: wad(r.price_usd),
    borrowFlow: wad(r.borrow_flow),
    repayFlow: wad(r.repay_flow),
    liquidationFlow: wad(r.liquidation_flow),
  };
}
