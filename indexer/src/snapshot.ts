import type {Context} from "ponder:registry";
import {chainHead, dexVolume, flowBucket, latestSnapshot, market, position, rollup, snapshot} from "ponder:schema";
import {createPublicClient, http} from "viem";
import {
  adaptiveCurveBorrowRate,
  erc20Abi,
  expectedMarketBalances,
  marketHoursAbi,
  shortInterestFields,
  stocklineOracleAbi,
  stockWrapperAbi, safeErrorLine} from "@stockline/sdk";
import {networkConfig} from "../lib/network.js";

export const net = networkConfig();

type Block = {number: bigint; timestamp: bigint};
const DAY = 86_400n;
export const INTERVALS = {"1m": 60n, "1h": 3600n, "1d": DAY} as const;

const unavailable = new Set<string>();
/**
 * Oracle/token views go through a raw client with JSON-RPC batching (one HTTP round trip per snapshot, reads pinned
 * to the event's block, no retries). Ponder's per-call queue made every snapshot cost ~200 ms and the head lag grow
 * with the tick rate (SI-R4). The results depend only on the block, so they are reorg-safe with the handler.
 */
const reader = net.rpcUrl ? createPublicClient({transport: http(net.rpcUrl, {batch: {batchSize: 64, wait: 0}, retryCount: 2})}) : undefined;
/** Lowest block known to have state on this node (non-archive nodes, or anvil loaded from a dump, cannot serve older
 * state); probed once per block below it, without retries. */
let stateFloor: bigint | undefined;

async function hasState(block: bigint): Promise<boolean> {
  if (stateFloor !== undefined && block >= stateFloor) return true;
  if (!reader) return true;
  try {
    await reader.getBalance({address: net.d.morpho, blockNumber: block});
    stateFloor = stateFloor === undefined || block < stateFloor ? block : stateFloor;
    return true;
  } catch {
    return false;
  }
}

/** Oracle and token views at `block`. If the node cannot serve the historical read, falls back to the previous
 * snapshot's values, or skips the snapshot if there is none yet. Market totals never depend on these reads. */
async function reads(context: Context, ticker: string, block: Block) {
  const s = net.d.stocks[ticker];
  const c = reader!;
  const blockNumber = block.number;
  try {
    if (!(await hasState(blockNumber))) throw new Error("state not available at this block");
    const [answer, usdg, buffer, reasons, open, supply, multiplier] = await Promise.all([
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "stockAnswer", blockNumber}),
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "usdgAnswer", blockNumber}),
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "buffer", blockNumber}),
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "guardReasons", blockNumber}),
      c.readContract({address: net.d.marketHours, abi: marketHoursAbi, functionName: "isOpen", args: [block.timestamp], blockNumber}),
      c.readContract({address: s.stockToken, abi: erc20Abi, functionName: "totalSupply", blockNumber}),
      c.readContract({address: s.wrapper, abi: stockWrapperAbi, functionName: "multiplier", blockNumber}),
    ]);
    return {answer: answer[0], updatedAt: answer[1], usdg: usdg[0], buffer, reasons, open, supply, multiplier};
  } catch (e) {
    const prev = await context.db.find(latestSnapshot, {ticker});
    if (!prev) {
      if (!unavailable.has(ticker)) console.warn(`[indexer] ${ticker}: no historical state at block ${block.number}; snapshots start when reads succeed (${safeErrorLine(e, process.env)})`);
      unavailable.add(ticker);
      return undefined;
    }
    return {
      answer: prev.priceAnswer,
      updatedAt: prev.priceUpdatedAt,
      usdg: prev.usdgAnswer,
      buffer: prev.bufferWad,
      reasons: prev.guardReasons,
      open: prev.marketOpen,
      supply: prev.tokenTotalSupply,
      multiplier: prev.multiplier,
    };
  }
}

/**
 * Raw wSTOCK borrowed / covered (repay + liquidation) over the rolling 24h before `ts` (07 `newShorts24h`,
 * `covered24h`), at 1-hour granularity: the current hour bucket plus the 23 before it. Key lookups only: `db.sql`
 * reads would flush Ponder's indexing cache on every snapshot.
 */
async function flows24h(context: Context, ticker: string, ts: bigint) {
  const hour = (ts / 3600n) * 3600n;
  let borrowed = 0n;
  let covered = 0n;
  for (let i = 0n; i < 24n; i++) {
    const b = await context.db.find(flowBucket, {ticker, interval: "1h", bucket: hour - i * 3600n});
    if (!b) continue;
    borrowed += b.borrowFlow;
    covered += b.repayFlow + b.liquidationFlow;
  }
  return {borrowed, covered};
}

/** DEX volume over the last 30 UTC days (from the first day with volume if the history is shorter). Null without a
 * volume source on this network. */
async function dex30d(context: Context, ticker: string, ts: bigint) {
  if (net.dexKind === "none") return null;
  const today = ts / DAY;
  let volume = 0n;
  let days = 0;
  for (let i = 29n; i >= 0n; i--) {
    const d = await context.db.find(dexVolume, {ticker, day: today - i});
    if (d && days === 0) days = Number(i) + 1;
    volume += d?.volume ?? 0n;
  }
  return {volume, days: Math.max(days, 1)};
}

/** Compute the 07 §Definitions fields with the SDK and write the snapshot, the latest row and the rollups. */
export async function writeSnapshot(context: Context, ticker: string, block: Block, kind: "event" | "tick"): Promise<void> {
  const m = await context.db.find(market, {ticker});
  if (!m || m.lastUpdate === 0n) return; // market not created yet
  const s = net.d.stocks[ticker];
  const stored = {
    totalSupplyAssets: m.totalSupplyAssets,
    totalSupplyShares: m.totalSupplyShares,
    totalBorrowAssets: m.totalBorrowAssets,
    totalBorrowShares: m.totalBorrowShares,
    lastUpdate: m.lastUpdate,
    fee: m.fee,
  };
  const ts = block.timestamp;
  const accrued = expectedMarketBalances(stored, m.rateAtTarget, ts);
  const rate = adaptiveCurveBorrowRate(stored, m.rateAtTarget, ts).avgRate; // IRM borrowRateView (SI-R20)
  const r = await reads(context, ticker, block);
  if (!r) return;
  const [adapterPos, flows, dex] = await Promise.all([
    context.db.find(position, {ticker, account: s.adapter}),
    flows24h(context, ticker, ts),
    dex30d(context, ticker, ts),
  ]);
  const f = shortInterestFields({
    market: accrued,
    vaultIdle: m.vaultIdle,
    adapterSupplyShares: adapterPos?.supplyShares ?? 0n,
    multiplier: r.multiplier,
    stockAnswer: r.answer,
    feedDecimals: net.feedDecimals,
    tokenTotalSupply: r.supply,
    borrowRatePerSec: rate,
    performanceFee: m.performanceFee,
    borrowers: m.borrowers,
    borrowed24h: flows.borrowed,
    covered24h: flows.covered,
    dexVolume: dex,
    guardReasons: r.reasons,
    bufferWad: r.buffer,
    marketOpen: r.open,
  });
  const row = {
    ticker,
    blockNumber: block.number,
    timestamp: ts,
    suppliedShares: f.suppliedShares,
    borrowedShares: f.borrowedShares,
    borrowedUsd: f.borrowedUsd,
    utilization: f.utilization,
    utilizationVault: f.utilizationVault,
    borrowRatePerSec: f.borrowRatePerSec,
    borrowApr: f.borrowApr,
    borrowApy: f.borrowApy,
    supplyApy: f.supplyApy,
    siPctFloat: f.siPctFloat,
    daysToCover: f.daysToCover,
    borrowers: f.borrowers,
    newShorts24h: f.newShorts24h,
    covered24h: f.covered24h,
    marketStatus: f.marketStatus,
    totalSupplyAssets: accrued.totalSupplyAssets,
    totalBorrowAssets: accrued.totalBorrowAssets,
    vaultIdle: m.vaultIdle,
    priceAnswer: r.answer,
    priceUpdatedAt: r.updatedAt,
    priceUsd: f.priceUsd,
    usdgAnswer: r.usdg,
    multiplier: r.multiplier,
    bufferWad: r.buffer,
    guardReasons: r.reasons,
    marketOpen: r.open,
    tokenTotalSupply: r.supply,
  };
  // An event snapshot is never downgraded to a tick in the same block.
  await context.db
    .insert(snapshot)
    .values({...row, kind})
    .onConflictDoUpdate((prev) => ({...row, kind: prev.kind === "event" ? "event" : kind}));
  await context.db.insert(latestSnapshot).values(row).onConflictDoUpdate(row);
  for (const [interval, secs] of Object.entries(INTERVALS)) {
    const bucket = (ts / secs) * secs;
    await context.db
      .insert(rollup)
      .values({...row, interval, bucket})
      .onConflictDoUpdate(row);
  }
}

/** Add a flow (raw wSTOCK) to the 1m/1h/1d buckets that contain `ts` (SI-R2 rollups; joined with `rollup` by the API). */
export async function addFlow(context: Context, ticker: string, ts: bigint, kind: "borrowFlow" | "repayFlow" | "liquidationFlow", assets: bigint): Promise<void> {
  for (const [interval, secs] of Object.entries(INTERVALS)) {
    const bucket = (ts / secs) * secs;
    await context.db
      .insert(flowBucket)
      .values({ticker, interval, bucket, borrowFlow: 0n, repayFlow: 0n, liquidationFlow: 0n, [kind]: assets})
      .onConflictDoUpdate((prev) => ({[kind]: prev[kind] + assets}));
  }
}

// ------------------------------------------------------------------ SI-R3: head, safe and finalized blocks

let lastTagRead = 0;
let tags = {safe: 0n, finalized: 0n};

/** Record the indexed head and the chain's `safe` / `finalized` tags (read at most every 2 s of wall time). */
export async function writeHead(context: Context, block: Block): Promise<void> {
  if (reader && Date.now() - lastTagRead > 2_000) {
    lastTagRead = Date.now();
    try {
      const [safe, finalized] = await Promise.all([reader.getBlock({blockTag: "safe"}), reader.getBlock({blockTag: "finalized"})]);
      tags = {safe: safe.number ?? 0n, finalized: finalized.number ?? 0n};
    } catch {
      /* keep the last known tags */
    }
  }
  const row = {headBlock: block.number, headTimestamp: block.timestamp, safeBlock: tags.safe, finalizedBlock: tags.finalized};
  await context.db.insert(chainHead).values({chainId: net.chainId, ...row}).onConflictDoUpdate(row);
}
