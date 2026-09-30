import type {PublicClient} from "viem";
import {adaptiveCurveIrmAbi, erc20Abi, marketAdapterAbi, mockSwapAggregatorAbi, morphoAbi, lendoraOracleAbi, lendoraRouterAbi, stockWrapperAbi, vaultV2Abi} from "./abis.js";
import type {ChainDeployment} from "./addresses.js";
import {bufferConfigFor} from "./calendar/schedule.js";
import {expectedMarketBalances, toAssetsUp} from "./math/morpho.js";
import type {StockMarketState} from "./math/oracle.js";
import {CLUSDG_VALUE_PER_TOKEN, STOCK_LOAN_SCALE_EXP} from "./params.js";

/**
 * Chain state for one stock (and optionally one user), read straight from the chain (APP-R5): the web preview panel,
 * the portfolio and the alerts service never depend on the indexer for safety numbers. With a batching transport all
 * reads go out in one JSON-RPC request.
 */
export interface OracleParamsView {
  z: bigint;
  sigma: bigint;
  bMin: bigint;
  bMax: bigint;
  rampIn: bigint;
}

export interface MarketChainState {
  ticker: string;
  now: bigint;
  block: bigint;
  stockAnswer: bigint;
  stockUpdatedAt: bigint;
  usdgAnswer: bigint;
  params: OracleParamsView;
  bufferFloor: bigint;
  bufferNow: bigint;
  guardReasons: bigint;
  multiplier: bigint;
  lltv: bigint;
  market: {totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint};
  rateAtTarget: bigint;
  vaultIdle: bigint;
  adapterAssets: bigint;
  perAddressCapUsd: bigint;
  user?: UserChainState;
}

export interface UserChainState {
  address: `0x${string}`;
  collateral: bigint;
  borrowShares: bigint;
  stockBalance: bigint;
  usdgBalance: bigint;
  vaultShares: bigint;
  vaultAssets: bigint;
  stockAllowance: bigint;
  usdgAllowance: bigint;
  vaultAllowance: bigint;
  authorized: boolean;
}

export async function readMarket(client: PublicClient, d: ChainDeployment, ticker: string, user?: `0x${string}`): Promise<MarketChainState> {
  const s = d.stocks[ticker];
  const r = (address: `0x${string}`, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    client.readContract({address, abi: abi as never, functionName: functionName as never, args: args as never}) as Promise<unknown>;
  const [block, stockAns, usdgAns, params, floor, buffer, reasons, multiplier, market, rat, idle, adapterAssets, cap] = await Promise.all([
    client.getBlock(),
    r(s.oracle, lendoraOracleAbi, "stockAnswer"),
    r(s.oracle, lendoraOracleAbi, "usdgAnswer"),
    r(s.oracle, lendoraOracleAbi, "params"),
    r(s.oracle, lendoraOracleAbi, "bufferFloor"),
    r(s.oracle, lendoraOracleAbi, "buffer"),
    r(s.oracle, lendoraOracleAbi, "guardReasons"),
    r(s.wrapper, stockWrapperAbi, "multiplier"),
    r(d.morpho, morphoAbi, "market", [s.marketId]),
    r(d.adaptiveCurveIrm, adaptiveCurveIrmAbi, "rateAtTarget", [s.marketId]),
    r(s.wrapper, erc20Abi, "balanceOf", [s.vault]),
    r(s.adapter, marketAdapterAbi, "expectedSupplyAssets", [s.marketId]),
    user ? r(d.router!, lendoraRouterAbi, "capOf", [user, s.stockToken]) : Promise.resolve(BigInt(s.perAddressCapUsd) * 10n ** 18n),
  ]);
  const p = params as {zWad: bigint; sigmaWad: bigint; bMinWad: bigint; bMaxWad: bigint; rampIn: number};
  const out: MarketChainState = {
    ticker,
    now: block.timestamp,
    block: block.number,
    stockAnswer: (stockAns as [bigint, bigint])[0],
    stockUpdatedAt: (stockAns as [bigint, bigint])[1],
    usdgAnswer: (usdgAns as [bigint, bigint])[0],
    params: {z: BigInt(p.zWad), sigma: BigInt(p.sigmaWad), bMin: BigInt(p.bMinWad), bMax: BigInt(p.bMaxWad), rampIn: BigInt(p.rampIn)},
    bufferFloor: floor as bigint,
    bufferNow: buffer as bigint,
    guardReasons: reasons as bigint,
    multiplier: multiplier as bigint,
    lltv: BigInt(s.lltv),
    market: market as MarketChainState["market"],
    rateAtTarget: BigInt(rat as bigint),
    vaultIdle: idle as bigint,
    adapterAssets: adapterAssets as bigint,
    perAddressCapUsd: cap as bigint,
  };
  if (user) {
    const [pos, stockBal, usdgBal, shares, stockAllow, usdgAllow, vaultAllow, authorized] = await Promise.all([
      r(d.morpho, morphoAbi, "position", [s.marketId, user]),
      r(s.stockToken, erc20Abi, "balanceOf", [user]),
      r(d.usdg, erc20Abi, "balanceOf", [user]),
      r(s.vault, erc20Abi, "balanceOf", [user]),
      r(s.stockToken, erc20Abi, "allowance", [user, d.router!]),
      r(d.usdg, erc20Abi, "allowance", [user, d.router!]),
      r(s.vault, erc20Abi, "allowance", [user, d.router!]),
      r(d.morpho, morphoAbi, "isAuthorized", [user, d.router!]),
    ]);
    const position = pos as {collateral: bigint; borrowShares: bigint};
    const vaultAssets = (shares as bigint) > 0n ? ((await r(s.vault, vaultV2Abi, "previewRedeem", [shares])) as bigint) : 0n;
    out.user = {
      address: user,
      collateral: position.collateral,
      borrowShares: position.borrowShares,
      stockBalance: stockBal as bigint,
      usdgBalance: usdgBal as bigint,
      vaultShares: shares as bigint,
      vaultAssets,
      stockAllowance: stockAllow as bigint,
      usdgAllowance: usdgAllow as bigint,
      vaultAllowance: vaultAllow as bigint,
      authorized: authorized as boolean,
    };
  }
  return out;
}

/** RT-R3 swap quote on the mock aggregator (anvil/testnet); undefined where the deployment swaps through Uniswap. */
export async function quoteSwap(client: PublicClient, d: ChainDeployment, tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint): Promise<bigint | undefined> {
  const agg = d.mocks?.swapAggregator;
  if (!agg || amountIn === 0n) return undefined;
  return client.readContract({address: agg, abi: mockSwapAggregatorAbi, functionName: "quote", args: [tokenIn, tokenOut, amountIn]});
}

/** The SDK oracle-math state for a market read with `readMarket` (clUSDG backed by USDG, launch price scale). */
export function stockMarketState(s: MarketChainState): StockMarketState {
  return {
    buffer: bufferConfigFor(s.ticker, s.params, s.bufferFloor),
    stockAnswer: s.stockAnswer,
    stockUpdatedAt: s.stockUpdatedAt,
    usdgAnswer: s.usdgAnswer,
    valuePerToken: CLUSDG_VALUE_PER_TOKEN,
    scaleExp: STOCK_LOAN_SCALE_EXP,
    lltv: s.lltv,
  };
}

/** The user's debt now from accrued totals (Morpho `expectedBorrowAssets`). */
export function currentDebt(s: MarketChainState, borrowShares: bigint = s.user?.borrowShares ?? 0n): bigint {
  if (borrowShares === 0n) return 0n;
  const m = expectedMarketBalances(s.market, s.rateAtTarget, s.now);
  return toAssetsUp(borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
}
