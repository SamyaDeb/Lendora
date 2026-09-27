/** Minimal Uniswap v3 pool ABI and TWAP math for the guard keeper (OR-R31). */
export const uniswapV3PoolAbi = [
  {type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {
    type: "function",
    name: "observe",
    stateMutability: "view",
    inputs: [{name: "secondsAgos", type: "uint32[]"}],
    outputs: [
      {name: "tickCumulatives", type: "int56[]"},
      {name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]"},
    ],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      {name: "sender", type: "address", indexed: true},
      {name: "recipient", type: "address", indexed: true},
      {name: "amount0", type: "int256", indexed: false},
      {name: "amount1", type: "int256", indexed: false},
      {name: "sqrtPriceX96", type: "uint160", indexed: false},
      {name: "liquidity", type: "uint128", indexed: false},
      {name: "tick", type: "int24", indexed: false},
    ],
  },
] as const;

/** Arithmetic-mean tick over `window` seconds from two cumulatives, rounded toward −∞ (Uniswap OracleLibrary). */
export function twapTick(cumNow: bigint, cumPast: bigint, window: number): number {
  const delta = cumNow - cumPast;
  let tick = delta / BigInt(window);
  if (delta < 0n && delta % BigInt(window) !== 0n) tick -= 1n;
  return Number(tick);
}

/**
 * USD price of the stock (float) from a pool tick. `stockIsToken0`: price = 1.0001^tick · 10^(dec0 − dec1) in token1
 * per token0. Used for deviation checks only (never onchain).
 */
export function priceFromTick(tick: number, stockIsToken0: boolean, stockDecimals: number, quoteDecimals: number): number {
  const raw = Math.pow(1.0001, tick);
  return stockIsToken0 ? raw * 10 ** (stockDecimals - quoteDecimals) : (1 / raw) * 10 ** (stockDecimals - quoteDecimals);
}

/** Tick of a stock(18 dp)/USDG(6 dp) pool (stock = token0) at a USD feed answer with 8 dp (mock pools, testnet). */
export function tickForAnswer(answer8: bigint): number {
  return Math.floor(Math.log(Number(answer8) / 1e8 / 1e12) / Math.log(1.0001));
}
