import {mockAggregatorSwap, type ChainDeployment, type RouterSwap} from "@stockline/sdk";

/** RT-R3: the swap the router runs for openShort / closeShort. Anvil and testnet use the allowlisted mock aggregator;
 * the Uniswap UniversalRouter path (fork/mainnet) is built by the router tests and is not offered by this app yet. */
export function buildSwap(d: ChainDeployment, tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint, minOut: bigint): RouterSwap {
  const agg = d.mocks?.swapAggregator;
  if (!agg) throw new Error("No swap route is configured for this network.");
  return mockAggregatorSwap(agg, tokenIn, tokenOut, amountIn, minOut, d.router!);
}
