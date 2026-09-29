import {ponder, type Context} from "ponder:registry";
import {dnAccount, dnDay, dnNav, dnRequest, dnSleeve, receiptMarket} from "ponder:schema";
import {deltaNeutralVaultAbi} from "@stockline/sdk";
import {net} from "./snapshot.js";

/**
 * A3 (G5 receipt markets) and Phase 4 (DN-R11, the delta-neutral vault). Receipt-market totals follow Morpho's storage
 * updates exactly like the stock markets (SI-R5 method). The vault's accounts, requests, NAV points and daily
 * funding / cost / fee sums feed `/v1/vault/*`; live state (sleeves, delta, margin, freshness) is read from chain by
 * the API.
 */

type Block = {number: bigint; timestamp: bigint};
const lc = (a: string) => a.toLowerCase();
const zeroFloorSub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
const DAY = 86_400n;

// ------------------------------------------------------------------ receipt markets

const receiptTicker = (id: string) => net.byReceiptMarketId.get(lc(id));

async function receipt(context: Context, id: string, block: Block, f: (m: typeof receiptMarket.$inferSelect) => Partial<typeof receiptMarket.$inferInsert>) {
  const t = receiptTicker(id);
  if (!t) return;
  const r = net.d.stocks[t].receipt!;
  const prev = (await context.db.find(receiptMarket, {ticker: t})) ?? {
    ticker: t,
    marketId: r.marketId,
    usdgVault: r.usdgVault,
    lltv: BigInt(r.lltv),
    totalSupplyAssets: 0n,
    totalSupplyShares: 0n,
    totalBorrowAssets: 0n,
    totalBorrowShares: 0n,
    collateral: 0n,
    rateAtTarget: 0n,
    lastUpdate: 0n,
    updatedBlock: 0n,
  };
  const next = {...prev, ...f(prev), updatedBlock: block.number};
  await context.db.insert(receiptMarket).values(next).onConflictDoUpdate(next);
}

ponder.on("MorphoReceipt:AccrueInterest", async ({event, context}) => {
  const {interest, feeShares} = event.args;
  await receipt(context, event.args.id, event.block, (m) => ({
    totalBorrowAssets: m.totalBorrowAssets + interest,
    totalSupplyAssets: m.totalSupplyAssets + interest,
    totalSupplyShares: m.totalSupplyShares + feeShares,
    lastUpdate: event.block.timestamp,
  }));
});
ponder.on("MorphoReceipt:Supply", async ({event, context}) => {
  await receipt(context, event.args.id, event.block, (m) => ({totalSupplyAssets: m.totalSupplyAssets + event.args.assets, totalSupplyShares: m.totalSupplyShares + event.args.shares}));
});
ponder.on("MorphoReceipt:Withdraw", async ({event, context}) => {
  await receipt(context, event.args.id, event.block, (m) => ({totalSupplyAssets: m.totalSupplyAssets - event.args.assets, totalSupplyShares: m.totalSupplyShares - event.args.shares}));
});
ponder.on("MorphoReceipt:Borrow", async ({event, context}) => {
  await receipt(context, event.args.id, event.block, (m) => ({totalBorrowAssets: m.totalBorrowAssets + event.args.assets, totalBorrowShares: m.totalBorrowShares + event.args.shares}));
});
ponder.on("MorphoReceipt:Repay", async ({event, context}) => {
  await receipt(context, event.args.id, event.block, (m) => ({totalBorrowAssets: zeroFloorSub(m.totalBorrowAssets, event.args.assets), totalBorrowShares: m.totalBorrowShares - event.args.shares}));
});
ponder.on("MorphoReceipt:SupplyCollateral", async ({event, context}) => {
  await receipt(context, event.args.id, event.block, (m) => ({collateral: m.collateral + event.args.assets}));
});
ponder.on("MorphoReceipt:WithdrawCollateral", async ({event, context}) => {
  await receipt(context, event.args.id, event.block, (m) => ({collateral: m.collateral - event.args.assets}));
});
ponder.on("MorphoReceipt:Liquidate", async ({event, context}) => {
  const {repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares} = event.args;
  await receipt(context, event.args.id, event.block, (m) => ({
    totalBorrowShares: m.totalBorrowShares - repaidShares - badDebtShares,
    totalBorrowAssets: zeroFloorSub(m.totalBorrowAssets, repaidAssets) - badDebtAssets,
    totalSupplyAssets: m.totalSupplyAssets - badDebtAssets,
    collateral: m.collateral - seizedAssets,
  }));
});
ponder.on("IrmReceipt:BorrowRateUpdate", async ({event, context}) => {
  await receipt(context, event.args.id, event.block, () => ({rateAtTarget: event.args.rateAtTarget}));
});

// ------------------------------------------------------------------ delta-neutral vault

async function account(context: Context, address: `0x${string}`, block: Block, f: (a: {shares: bigint; deposited: bigint; withdrawn: bigint}) => Partial<{shares: bigint; deposited: bigint; withdrawn: bigint}>) {
  const prev = (await context.db.find(dnAccount, {address})) ?? {shares: 0n, deposited: 0n, withdrawn: 0n};
  const next = {shares: prev.shares, deposited: prev.deposited, withdrawn: prev.withdrawn, ...f(prev), updatedBlock: block.number};
  await context.db.insert(dnAccount).values({address, ...next}).onConflictDoUpdate(next);
}

async function day(context: Context, ts: bigint, add: {funding?: bigint; costs?: bigint; fee?: bigint; trades?: number}) {
  const d = (ts / DAY) * DAY;
  const prev = (await context.db.find(dnDay, {day: d})) ?? {funding: 0n, costs: 0n, fee: 0n, trades: 0};
  const next = {funding: prev.funding + (add.funding ?? 0n), costs: prev.costs + (add.costs ?? 0n), fee: prev.fee + (add.fee ?? 0n), trades: prev.trades + (add.trades ?? 0)};
  await context.db.insert(dnDay).values({day: d, ...next}).onConflictDoUpdate(next);
}

const ZERO = "0x0000000000000000000000000000000000000000";

ponder.on("DnVault:Transfer", async ({event, context}) => {
  const {from, to, value} = event.args;
  if (from !== ZERO) await account(context, from, event.block, (a) => ({shares: a.shares - value}));
  if (to !== ZERO) await account(context, to, event.block, (a) => ({shares: a.shares + value}));
});

ponder.on("DnVault:Deposit", async ({event, context}) => {
  await account(context, event.args.owner, event.block, (a) => ({deposited: a.deposited + event.args.assets}));
});

ponder.on("DnVault:Withdraw", async ({event, context}) => {
  await account(context, event.args.owner, event.block, (a) => ({withdrawn: a.withdrawn + event.args.assets}));
});

ponder.on("DnVault:RedeemRequested", async ({event, context}) => {
  const {id, owner, receiver, shares, settleBy} = event.args;
  await context.db.insert(dnRequest).values({id, owner, receiver, shares, assets: null, requestedAt: event.block.timestamp, settleBy: BigInt(settleBy), status: "queued", settledAt: null, claimedAt: null}).onConflictDoNothing();
});

ponder.on("DnVault:RedeemSettled", async ({event, context}) => {
  await context.db.update(dnRequest, {id: event.args.id}).set({status: "claimable", assets: event.args.assets, settledAt: event.block.timestamp});
});

ponder.on("DnVault:Claimed", async ({event, context}) => {
  const r = await context.db.find(dnRequest, {id: event.args.id});
  await context.db.update(dnRequest, {id: event.args.id}).set({status: "claimed", claimedAt: event.block.timestamp});
  if (r) await account(context, r.owner, event.block, (a) => ({withdrawn: a.withdrawn + event.args.assets}));
});

ponder.on("DnVault:FeeAccrued", async ({event, context}) => {
  const {feeShares, sharePriceWad} = event.args;
  // shares (1e18 per share) × USDG per share (WAD) → USDG raw (6 dp)
  if (feeShares > 0n) await day(context, event.block.timestamp, {fee: (feeShares * sharePriceWad) / 10n ** 30n});
});

ponder.on("DnNav:Reported", async ({event, context}) => {
  const {equity, nav, signers} = event.args;
  const [supply, price] = await Promise.all([
    context.client.readContract({address: net.dn!.vault, abi: deltaNeutralVaultAbi, functionName: "totalSupply", blockNumber: event.block.number}),
    context.client.readContract({address: net.dn!.vault, abi: deltaNeutralVaultAbi, functionName: "sharePrice", blockNumber: event.block.number}),
  ]);
  await context.db
    .insert(dnNav)
    .values({id: `${event.transaction.hash}-${event.log.logIndex}`, blockNumber: event.block.number, timestamp: event.block.timestamp, nav, totalSupply: supply, sharePriceWad: price, perpEquity: equity, signers: Number(signers)})
    .onConflictDoNothing();
});

async function sleeve(context: Context, id: bigint, set: {killedAt?: bigint; lastTradeAt?: bigint}) {
  const prev = (await context.db.find(dnSleeve, {id: Number(id)})) ?? {killedAt: null, lastTradeAt: null};
  const next = {killedAt: set.killedAt ?? prev.killedAt, lastTradeAt: set.lastTradeAt ?? prev.lastTradeAt};
  await context.db.insert(dnSleeve).values({id: Number(id), ...next}).onConflictDoUpdate(next);
}

ponder.on("DnStrategy:SleeveKilled", async ({event, context}) => {
  await sleeve(context, event.args.id, {killedAt: event.block.timestamp});
});
ponder.on("DnStrategy:ShortAdjusted", async ({event, context}) => {
  await sleeve(context, event.args.id, {lastTradeAt: event.block.timestamp});
});

// Trading costs: what a fill gave up against the feed price (the strategy's onchain floor is 1%).
ponder.on("DnStrategy:SpotBought", async ({event, context}) => {
  const {usdgIn, stockOut, fairStockOut} = event.args;
  const cost = fairStockOut > stockOut && fairStockOut > 0n ? (usdgIn * (fairStockOut - stockOut)) / fairStockOut : 0n;
  await day(context, event.block.timestamp, {costs: cost, trades: 1});
  await sleeve(context, event.args.id, {lastTradeAt: event.block.timestamp});
});
ponder.on("DnStrategy:SpotSold", async ({event, context}) => {
  const {usdgOut, fairUsdgOut} = event.args;
  await day(context, event.block.timestamp, {costs: zeroFloorSub(fairUsdgOut, usdgOut), trades: 1});
  await sleeve(context, event.args.id, {lastTradeAt: event.block.timestamp});
});

ponder.on("DnVenue:FundingApplied", async ({event, context}) => {
  await day(context, event.block.timestamp, {funding: event.args.payment});
});
