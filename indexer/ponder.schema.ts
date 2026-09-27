import {index, onchainTable, primaryKey, type PgColumnsBuilders} from "ponder";

/**
 * Stockline indexer schema (SI-R2). Amounts are raw onchain integers (numeric); "shares" fields are shares of stock
 * after the ERC-8056 multiplier (1e18). The API reads these tables through the `--views-schema` views.
 */

/** Current state per stock, derived from events (reconciled against `market()` by SI-R5). */
export const market = onchainTable("market", (t) => ({
  ticker: t.text().primaryKey(),
  marketId: t.hex().notNull(),
  stockToken: t.hex().notNull(),
  wrapper: t.hex().notNull(),
  oracle: t.hex().notNull(),
  vault: t.hex().notNull(),
  adapter: t.hex().notNull(),
  lltv: t.bigint().notNull(),
  // Morpho Market struct
  totalSupplyAssets: t.bigint().notNull(),
  totalSupplyShares: t.bigint().notNull(),
  totalBorrowAssets: t.bigint().notNull(),
  totalBorrowShares: t.bigint().notNull(),
  lastUpdate: t.bigint().notNull(),
  fee: t.bigint().notNull(),
  /** AdaptiveCurveIrm `rateAtTarget` (from `BorrowRateUpdate`; 0 before the first accrual). */
  rateAtTarget: t.bigint().notNull(),
  /** wSTOCK held by the vault (Deposit − Withdraw − Allocate + Deallocate). */
  vaultIdle: t.bigint().notNull(),
  performanceFee: t.bigint().notNull(),
  borrowers: t.integer().notNull(),
  /** Reasons as last emitted by `GuardChanged` (the snapshot reads the live `guardReasons()`). */
  emittedGuardReasons: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
}));

/** Morpho position per (stock, account) (SI-R2). */
export const position = onchainTable(
  "position",
  (t) => ({
    ticker: t.text().notNull(),
    account: t.hex().notNull(),
    supplyShares: t.bigint().notNull(),
    borrowShares: t.bigint().notNull(),
    collateral: t.bigint().notNull(),
    updatedBlock: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (t) => ({pk: primaryKey({columns: [t.ticker, t.account]}), accountIdx: index().on(t.account)}),
);

const snapshotColumns = (t: PgColumnsBuilders) => ({
  ticker: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  // 07 §Definitions (computed by @stockline/sdk shortInterestFields)
  suppliedShares: t.bigint().notNull(),
  borrowedShares: t.bigint().notNull(),
  borrowedUsd: t.bigint().notNull(),
  utilization: t.bigint().notNull(),
  utilizationVault: t.bigint().notNull(),
  borrowRatePerSec: t.bigint().notNull(),
  borrowApr: t.bigint().notNull(),
  borrowApy: t.doublePrecision().notNull(),
  supplyApy: t.doublePrecision().notNull(),
  siPctFloat: t.bigint().notNull(),
  daysToCover: t.doublePrecision(),
  borrowers: t.integer().notNull(),
  newShorts24h: t.bigint().notNull(),
  covered24h: t.bigint().notNull(),
  marketStatus: t.text().notNull(),
  // Inputs, kept for charts, the lens comparison and audits
  totalSupplyAssets: t.bigint().notNull(),
  totalBorrowAssets: t.bigint().notNull(),
  vaultIdle: t.bigint().notNull(),
  priceAnswer: t.bigint().notNull(),
  priceUpdatedAt: t.bigint().notNull(),
  priceUsd: t.bigint().notNull(),
  /** USDG/USD answer in use by the oracle (8 dp); with `priceAnswer` and `bufferWad` it gives the Morpho price. */
  usdgAnswer: t.bigint().notNull(),
  multiplier: t.bigint().notNull(),
  bufferWad: t.bigint().notNull(),
  guardReasons: t.bigint().notNull(),
  marketOpen: t.boolean().notNull(),
  tokenTotalSupply: t.bigint().notNull(),
});

/** Per-market snapshot at every block where state changed, plus heartbeat blocks (`kind = "tick"`) (SI-R2). */
export const snapshot = onchainTable(
  "snapshot",
  (t) => ({...snapshotColumns(t), kind: t.text().notNull()}),
  (t) => ({pk: primaryKey({columns: [t.ticker, t.blockNumber]}), timeIdx: index().on(t.ticker, t.timestamp)}),
);

/** Latest snapshot per stock (what `GET /markets` serves). */
export const latestSnapshot = onchainTable("latest_snapshot", (t) => ({...snapshotColumns(t), ticker: t.text().primaryKey()}));

/** 1m / 1h / 1d rollups: the last snapshot in the bucket (SI-R2). */
export const rollup = onchainTable(
  "rollup",
  (t) => ({...snapshotColumns(t), interval: t.text().notNull(), bucket: t.bigint().notNull()}),
  (t) => ({pk: primaryKey({columns: [t.ticker, t.interval, t.bucket]})}),
);

/** Borrow, repay and liquidation flows (raw wSTOCK) summed per 1m / 1h / 1d bucket (SI-R2). */
export const flowBucket = onchainTable(
  "flow_bucket",
  (t) => ({
    ticker: t.text().notNull(),
    interval: t.text().notNull(),
    bucket: t.bigint().notNull(),
    borrowFlow: t.bigint().notNull(),
    repayFlow: t.bigint().notNull(),
    liquidationFlow: t.bigint().notNull(),
  }),
  (t) => ({pk: primaryKey({columns: [t.ticker, t.interval, t.bucket]})}),
);

/** Event feed (07 §2 `/markets/{symbol}/events`). `type` is the Morpho/router/vault/oracle event, lower camel. */
export const eventFeed = onchainTable(
  "event_feed",
  (t) => ({
    id: t.text().primaryKey(),
    ticker: t.text().notNull(),
    type: t.text().notNull(),
    source: t.text().notNull(),
    account: t.hex(),
    assets: t.bigint(),
    shares: t.bigint(),
    data: t.json(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({tickerTypeIdx: index().on(t.ticker, t.type, t.blockNumber), timeIdx: index().on(t.ticker, t.timestamp)}),
);

/** Stock Token DEX volume per UTC day, raw units (daysToCover). */
export const dexVolume = onchainTable(
  "dex_volume",
  (t) => ({ticker: t.text().notNull(), day: t.bigint().notNull(), volume: t.bigint().notNull(), swaps: t.integer().notNull()}),
  (t) => ({pk: primaryKey({columns: [t.ticker, t.day]})}),
);

/** Indexed head and the chain's `safe` / `finalized` blocks (SI-R3); the API derives `confirmed` from it. */
export const chainHead = onchainTable("chain_head", (t) => ({
  chainId: t.integer().primaryKey(),
  headBlock: t.bigint().notNull(),
  headTimestamp: t.bigint().notNull(),
  safeBlock: t.bigint().notNull(),
  finalizedBlock: t.bigint().notNull(),
}));
