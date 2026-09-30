import {ponder, type Context} from "ponder:registry";
import {dexVolume, eventFeed, feeDay, feeEvent, market, position} from "ponder:schema";
import {lendoraOracleAbi, vaultV2FullAbi} from "@lendora/sdk";
import {addFlow, net, writeHead, writeSnapshot} from "./snapshot.js";

/**
 * Lendora indexer (SI-R1…R3). Morpho market totals and positions are derived from events exactly as Morpho Blue
 * updates storage (v1.0.0), so the SI-R5 reconciliation against `market()` is meaningful; everything computed goes
 * through `@lendora/sdk`. Each state change writes a snapshot of that stock at the event's block; the `Tick` block
 * source writes heartbeat snapshots so time-driven values (accrual, buffer ramps, staleness) stay current.
 */

type Block = {number: bigint; timestamp: bigint};
type Log = {logIndex: number};
type Tx = {hash: `0x${string}`};
const lc = (a: string) => a.toLowerCase();
const zeroFloorSub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

function tickerOfMarket(id: string): string {
  const t = net.byMarketId.get(lc(id));
  if (!t) throw new Error(`unfiltered market ${id}`);
  return t;
}

async function feed(
  context: Context,
  e: {block: Block; log: Log; transaction: Tx},
  ticker: string,
  type: string,
  source: string,
  fields: {account?: `0x${string}`; assets?: bigint; shares?: bigint; data?: Record<string, unknown>} = {},
) {
  const data = fields.data ? JSON.parse(JSON.stringify(fields.data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) : null;
  await context.db
    .insert(eventFeed)
    .values({
      id: `${e.transaction.hash}-${e.log.logIndex}`,
      ticker,
      type,
      source,
      account: fields.account ?? null,
      assets: fields.assets ?? null,
      shares: fields.shares ?? null,
      data,
      blockNumber: e.block.number,
      logIndex: e.log.logIndex,
      timestamp: e.block.timestamp,
      txHash: e.transaction.hash,
    })
    .onConflictDoNothing();
}

/** Apply `delta` to a position; keeps `market.borrowers` = count of accounts with borrowShares > 0. */
async function updatePosition(
  context: Context,
  ticker: string,
  account: `0x${string}`,
  block: Block,
  delta: {supplyShares?: bigint; borrowShares?: bigint; collateral?: bigint},
) {
  const key = {ticker, account};
  const prev = (await context.db.find(position, key)) ?? {supplyShares: 0n, borrowShares: 0n, collateral: 0n};
  const next = {
    supplyShares: prev.supplyShares + (delta.supplyShares ?? 0n),
    borrowShares: prev.borrowShares + (delta.borrowShares ?? 0n),
    collateral: prev.collateral + (delta.collateral ?? 0n),
    updatedBlock: block.number,
    updatedAt: block.timestamp,
  };
  await context.db.insert(position).values({...key, ...next}).onConflictDoUpdate(next);
  const was = prev.borrowShares > 0n;
  const is = next.borrowShares > 0n;
  if (was !== is) {
    const m = await context.db.find(market, {ticker});
    await context.db.update(market, {ticker}).set({borrowers: (m?.borrowers ?? 0) + (is ? 1 : -1)});
  }
}

async function updateMarket(context: Context, ticker: string, block: Block, f: (m: typeof market.$inferSelect) => Partial<typeof market.$inferInsert>) {
  const m = await context.db.find(market, {ticker});
  if (!m) throw new Error(`market ${ticker} missing`);
  await context.db.update(market, {ticker}).set({...f(m), updatedBlock: block.number});
}

// ------------------------------------------------------------------ setup: static rows

ponder.on("Morpho:setup", async ({context}) => {
  for (const ticker of net.tickers) {
    const s = net.d.stocks[ticker];
    await context.db
      .insert(market)
      .values({
        ticker,
        marketId: s.marketId,
        stockToken: s.stockToken,
        wrapper: s.wrapper,
        oracle: s.oracle,
        vault: s.vault,
        adapter: s.adapter,
        lltv: BigInt(s.lltv),
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 0n,
        totalBorrowShares: 0n,
        lastUpdate: 0n,
        fee: 0n,
        rateAtTarget: 0n,
        vaultIdle: 0n,
        performanceFee: 0n,
        borrowers: 0,
        emittedGuardReasons: 0n,
        updatedBlock: 0n,
      })
      .onConflictDoNothing();
  }
});

// ------------------------------------------------------------------ Morpho Blue (filtered to Lendora ids)

ponder.on("Morpho:CreateMarket", async ({event, context}) => {
  const t = tickerOfMarket(event.args.id);
  await updateMarket(context, t, event.block, () => ({lastUpdate: event.block.timestamp}));
  await feed(context, event, t, "createMarket", "morpho", {data: {lltv: event.args.marketParams.lltv}});
});

ponder.on("Morpho:AccrueInterest", async ({event, context}) => {
  const t = tickerOfMarket(event.args.id);
  const {interest, feeShares} = event.args;
  await updateMarket(context, t, event.block, (m) => ({
    totalBorrowAssets: m.totalBorrowAssets + interest,
    totalSupplyAssets: m.totalSupplyAssets + interest,
    totalSupplyShares: m.totalSupplyShares + feeShares,
    lastUpdate: event.block.timestamp,
  }));
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Morpho:Supply", async ({event, context}) => {
  const t = tickerOfMarket(event.args.id);
  const {onBehalf, assets, shares} = event.args;
  await updateMarket(context, t, event.block, (m) => ({totalSupplyAssets: m.totalSupplyAssets + assets, totalSupplyShares: m.totalSupplyShares + shares}));
  await updatePosition(context, t, onBehalf, event.block, {supplyShares: shares});
  await feed(context, event, t, "supply", "morpho", {account: onBehalf, assets, shares});
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Morpho:Withdraw", async ({event, context}) => {
  const t = tickerOfMarket(event.args.id);
  const {onBehalf, receiver, assets, shares} = event.args;
  await updateMarket(context, t, event.block, (m) => ({totalSupplyAssets: m.totalSupplyAssets - assets, totalSupplyShares: m.totalSupplyShares - shares}));
  await updatePosition(context, t, onBehalf, event.block, {supplyShares: -shares});
  await feed(context, event, t, "withdraw", "morpho", {account: onBehalf, assets, shares, data: {receiver}});
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Morpho:Borrow", async ({event, context}) => {
  const t = tickerOfMarket(event.args.id);
  const {onBehalf, receiver, assets, shares} = event.args;
  await updateMarket(context, t, event.block, (m) => ({totalBorrowAssets: m.totalBorrowAssets + assets, totalBorrowShares: m.totalBorrowShares + shares}));
  await updatePosition(context, t, onBehalf, event.block, {borrowShares: shares});
  await feed(context, event, t, "borrow", "morpho", {account: onBehalf, assets, shares, data: {receiver}});
  await addFlow(context, t, event.block.timestamp, "borrowFlow", assets);
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Morpho:Repay", async ({event, context}) => {
  const t = tickerOfMarket(event.args.id);
  const {onBehalf, assets, shares} = event.args;
  await updateMarket(context, t, event.block, (m) => ({
    totalBorrowAssets: zeroFloorSub(m.totalBorrowAssets, assets),
    totalBorrowShares: m.totalBorrowShares - shares,
  }));
  await updatePosition(context, t, onBehalf, event.block, {borrowShares: -shares});
  await feed(context, event, t, "repay", "morpho", {account: onBehalf, assets, shares});
  await addFlow(context, t, event.block.timestamp, "repayFlow", assets);
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Morpho:SupplyCollateral", async ({event, context}) => {
  const t = tickerOfMarket(event.args.id);
  const {onBehalf, assets} = event.args;
  await updatePosition(context, t, onBehalf, event.block, {collateral: assets});
  await feed(context, event, t, "supplyCollateral", "morpho", {account: onBehalf, assets});
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Morpho:WithdrawCollateral", async ({event, context}) => {
  const t = tickerOfMarket(event.args.id);
  const {onBehalf, receiver, assets} = event.args;
  await updatePosition(context, t, onBehalf, event.block, {collateral: -assets});
  await feed(context, event, t, "withdrawCollateral", "morpho", {account: onBehalf, assets, data: {receiver}});
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Morpho:Liquidate", async ({event, context}) => {
  const t = tickerOfMarket(event.args.id);
  const {caller, borrower, repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares} = event.args;
  // Morpho.liquidate: repaid first (zero-floored assets), then bad debt realized against suppliers.
  await updateMarket(context, t, event.block, (m) => ({
    totalBorrowShares: m.totalBorrowShares - repaidShares - badDebtShares,
    totalBorrowAssets: zeroFloorSub(m.totalBorrowAssets, repaidAssets) - badDebtAssets,
    totalSupplyAssets: m.totalSupplyAssets - badDebtAssets,
  }));
  await updatePosition(context, t, borrower, event.block, {borrowShares: -(repaidShares + badDebtShares), collateral: -seizedAssets});
  await feed(context, event, t, "liquidate", "morpho", {
    account: borrower,
    assets: repaidAssets,
    shares: repaidShares,
    data: {liquidator: caller, seizedAssets, badDebtAssets, badDebtShares},
  });
  await addFlow(context, t, event.block.timestamp, "liquidationFlow", repaidAssets);
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Irm:BorrowRateUpdate", async ({event, context}) => {
  const t = tickerOfMarket(event.args.id);
  await updateMarket(context, t, event.block, () => ({rateAtTarget: event.args.rateAtTarget}));
});

// ------------------------------------------------------------------ Vault V2 (rSTOCK)

const vaultTicker = (addr: string) => net.byVault.get(lc(addr))!;

ponder.on("Vault:Deposit", async ({event, context}) => {
  const t = vaultTicker(event.log.address);
  await updateMarket(context, t, event.block, (m) => ({vaultIdle: m.vaultIdle + event.args.assets}));
  await feed(context, event, t, "deposit", "vault", {account: event.args.onBehalf, assets: event.args.assets, shares: event.args.shares});
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Vault:Withdraw", async ({event, context}) => {
  const t = vaultTicker(event.log.address);
  await updateMarket(context, t, event.block, (m) => ({vaultIdle: m.vaultIdle - event.args.assets}));
  await feed(context, event, t, "vaultWithdraw", "vault", {
    account: event.args.onBehalf,
    assets: event.args.assets,
    shares: event.args.shares,
    data: {receiver: event.args.receiver},
  });
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Vault:Allocate", async ({event, context}) => {
  const t = vaultTicker(event.log.address);
  await updateMarket(context, t, event.block, (m) => ({vaultIdle: m.vaultIdle - event.args.assets}));
  await feed(context, event, t, "allocate", "vault", {assets: event.args.assets});
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Vault:Deallocate", async ({event, context}) => {
  const t = vaultTicker(event.log.address);
  await updateMarket(context, t, event.block, (m) => ({vaultIdle: m.vaultIdle + event.args.assets}));
  await feed(context, event, t, "deallocate", "vault", {assets: event.args.assets});
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("Vault:ForceDeallocate", async ({event, context}) => {
  const t = vaultTicker(event.log.address);
  await feed(context, event, t, "forceDeallocate", "vault", {account: event.args.onBehalf, assets: event.args.assets, data: {penaltyAssets: event.args.penaltyAssets}});
});

ponder.on("Vault:SetPerformanceFee", async ({event, context}) => {
  const t = vaultTicker(event.log.address);
  await updateMarket(context, t, event.block, () => ({performanceFee: event.args.newPerformanceFee}));
});

// ------------------------------------------------------------------ Fees (FE-R5)

const WAD = 10n ** 18n;
const DAY = 86_400n;

/** Feed price of `ticker`'s stock (8 dp) at `block`: USD per raw Stock Token = per wSTOCK (D1). */
async function stockAnswerAt(context: Context, ticker: string, blockNumber: bigint): Promise<bigint> {
  const [answer] = await context.client.readContract({address: net.d.stocks[ticker].oracle, abi: lendoraOracleAbi, functionName: "stockAnswer", blockNumber});
  return answer;
}

/** USD (WAD) of `shares` of `ticker`'s vault at `block`: shares → wSTOCK (vault rate) → feed price. */
async function sharesUsdAt(context: Context, ticker: string, shares: bigint, blockNumber: bigint): Promise<{assets: bigint; usd: bigint}> {
  const [assets, answer] = await Promise.all([
    context.client.readContract({address: net.d.stocks[ticker].vault, abi: vaultV2FullAbi, functionName: "convertToAssets", args: [shares], blockNumber}),
    stockAnswerAt(context, ticker, blockNumber),
  ]);
  return {assets, usd: (assets * answer) / 10n ** BigInt(net.feedDecimals)};
}

function feeEventRow(e: {block: Block; log: Log; transaction: Tx}) {
  return {id: `${e.transaction.hash}-${e.log.logIndex}`, blockNumber: e.block.number, logIndex: e.log.logIndex, timestamp: e.block.timestamp, txHash: e.transaction.hash};
}

// Vault V2 mints the performance fee as shares on every accrual; `feeAssets` = interest × fee, rounded down exactly
// like `accrueInterestView` (the fee is read at the block, so a timelocked fee change is picked up).
ponder.on("Vault:AccrueInterest", async ({event, context}) => {
  const {previousTotalAssets, newTotalAssets, performanceFeeShares} = event.args;
  if (performanceFeeShares === 0n) return;
  const t = vaultTicker(event.log.address);
  const bn = event.block.number;
  const [fee, recipient, answer] = await Promise.all([
    context.client.readContract({address: event.log.address, abi: vaultV2FullAbi, functionName: "performanceFee", blockNumber: bn}),
    context.client.readContract({address: event.log.address, abi: vaultV2FullAbi, functionName: "performanceFeeRecipient", blockNumber: bn}),
    stockAnswerAt(context, t, bn),
  ]);
  const interest = zeroFloorSub(newTotalAssets, previousTotalAssets);
  const feeAssets = (interest * BigInt(fee)) / WAD;
  const feeUsd = (feeAssets * answer) / 10n ** BigInt(net.feedDecimals);
  const day = (event.block.timestamp / DAY) * DAY;
  const prev = await context.db.find(feeDay, {ticker: t, day});
  const next = {
    interestAssets: (prev?.interestAssets ?? 0n) + interest,
    feeShares: (prev?.feeShares ?? 0n) + performanceFeeShares,
    feeAssets: (prev?.feeAssets ?? 0n) + feeAssets,
    feeUsd: (prev?.feeUsd ?? 0n) + feeUsd,
    accruals: (prev?.accruals ?? 0) + 1,
  };
  await context.db.insert(feeDay).values({ticker: t, day, ...next}).onConflictDoUpdate(next);
  await context.db.insert(feeEvent).values({...feeEventRow(event), kind: "accrual", ticker: t, token: event.log.address, account: recipient, shares: performanceFeeShares, assets: feeAssets, usdg: null, usd: feeUsd}).onConflictDoNothing();
});

ponder.on("FeeSplitter:Paid", async ({event, context}) => {
  const {token, account, amount} = event.args;
  const t = vaultTicker(token);
  const v = t ? await sharesUsdAt(context, t, amount, event.block.number) : {assets: null, usd: 0n};
  await context.db.insert(feeEvent).values({...feeEventRow(event), kind: "distribution", ticker: t ?? null, token, account, shares: t ? amount : null, assets: v.assets, usdg: t ? null : amount, usd: v.usd}).onConflictDoNothing();
});

ponder.on("FeeConverter:Converted", async ({event, context}) => {
  const {vault, shares, stockIn, usdgOut, destination} = event.args;
  const t = vaultTicker(vault);
  const [usdgAnswer] = await context.client.readContract({address: net.d.stocks[t!].oracle, abi: lendoraOracleAbi, functionName: "usdgAnswer", blockNumber: event.block.number});
  const usd = (usdgOut * 10n ** 12n * usdgAnswer) / 10n ** BigInt(net.feedDecimals); // USDG 6 dp → WAD at the USDG/USD feed
  await context.db.insert(feeEvent).values({...feeEventRow(event), kind: "conversion", ticker: t ?? null, token: vault, account: destination, shares, assets: stockIn, usdg: usdgOut, usd}).onConflictDoNothing();
});

// ------------------------------------------------------------------ Router (RT-R6 events)

const stockTicker = (addr: string) => net.byToken.get(lc(addr));

ponder.on("Router:Lent", async ({event, context}) => {
  const t = stockTicker(event.args.stock);
  if (t) await feed(context, event, t, "lend", "router", {account: event.args.user, assets: event.args.assets, shares: event.args.shares});
});
ponder.on("Router:Withdrawn", async ({event, context}) => {
  const t = stockTicker(event.args.stock);
  if (t) await feed(context, event, t, "withdrawLend", "router", {account: event.args.user, assets: event.args.assets, shares: event.args.shares});
});
ponder.on("Router:Borrowed", async ({event, context}) => {
  const t = stockTicker(event.args.stock);
  if (t) await feed(context, event, t, "routerBorrow", "router", {account: event.args.user, assets: event.args.borrowed, data: {collateralIn: event.args.collateralIn}});
});
ponder.on("Router:ShortOpened", async ({event, context}) => {
  const t = stockTicker(event.args.stock);
  if (t)
    await feed(context, event, t, "openShort", "router", {
      account: event.args.user,
      assets: event.args.borrowed,
      data: {collateralIn: event.args.collateralIn, usdgOut: event.args.usdgOut, compound: event.args.compound},
    });
});
ponder.on("Router:ShortClosed", async ({event, context}) => {
  const t = stockTicker(event.args.stock);
  if (t)
    await feed(context, event, t, "closeShort", "router", {
      account: event.args.user,
      assets: event.args.repaidAssets,
      data: {usdgIn: event.args.usdgIn, collateralOut: event.args.collateralOut},
    });
});
ponder.on("Router:Repaid", async ({event, context}) => {
  const t = stockTicker(event.args.stock);
  if (t) await feed(context, event, t, "routerRepay", "router", {account: event.args.onBehalf, assets: event.args.assets, data: {payer: event.args.payer}});
});
ponder.on("Router:CollateralAdded", async ({event, context}) => {
  const t = stockTicker(event.args.stock);
  if (t) await feed(context, event, t, "collateralAdded", "router", {account: event.args.onBehalf, assets: event.args.amount});
});
ponder.on("Router:CollateralWithdrawn", async ({event, context}) => {
  const t = stockTicker(event.args.stock);
  if (t) await feed(context, event, t, "collateralWithdrawn", "router", {account: event.args.user, assets: event.args.amount});
});

// ------------------------------------------------------------------ Oracle guard and multiplier

ponder.on("Oracle:GuardChanged", async ({event, context}) => {
  const t = net.byOracle.get(lc(event.log.address))!;
  const {reason, tripped} = event.args;
  await updateMarket(context, t, event.block, (m) => ({emittedGuardReasons: tripped ? m.emittedGuardReasons | reason : m.emittedGuardReasons & ~reason}));
  await feed(context, event, t, "guard", "oracle", {data: {reason, tripped}});
  await writeSnapshot(context, t, event.block, "event");
});

ponder.on("StockToken:UIMultiplierUpdated", async ({event, context}) => {
  const t = net.byToken.get(lc(event.log.address))!;
  await feed(context, event, t, "multiplier", "stockToken", {
    data: {oldMultiplier: event.args.oldMultiplier, newMultiplier: event.args.newMultiplier, effectiveAt: event.args.effectiveAtTimestamp},
  });
  await writeSnapshot(context, t, event.block, "event");
});

// ------------------------------------------------------------------ DEX volume (daysToCover)

async function addVolume(context: Context, ticker: string, ts: bigint, amount: bigint) {
  const day = ts / 86_400n;
  await context.db
    .insert(dexVolume)
    .values({ticker, day, volume: amount, swaps: 1})
    .onConflictDoUpdate((p) => ({volume: p.volume + amount, swaps: p.swaps + 1}));
}

ponder.on("Dex:Swapped", async ({event, context}) => {
  const {tokenIn, tokenOut, amountIn, amountOut} = event.args;
  const tin = net.byToken.get(lc(tokenIn));
  const tout = net.byToken.get(lc(tokenOut));
  if (tin) await addVolume(context, tin, event.block.timestamp, amountIn);
  if (tout) await addVolume(context, tout, event.block.timestamp, amountOut);
});

ponder.on("Dex:Swap", async ({event, context}) => {
  const p = net.byPool.get(lc(event.log.address));
  if (!p) return;
  const amt = p.stockIsToken0 ? event.args.amount0 : event.args.amount1;
  await addVolume(context, p.ticker, event.block.timestamp, amt < 0n ? -amt : amt);
});

// ------------------------------------------------------------------ heartbeat

ponder.on("Tick:block", async ({event, context}) => {
  for (const t of net.tickers) await writeSnapshot(context, t, event.block, "tick");
  await writeHead(context, event.block);
});

if (net.tickInterval > 1) {
  ponder.on("Head:block", async ({event, context}) => {
    await writeHead(context, event.block);
  });
}
