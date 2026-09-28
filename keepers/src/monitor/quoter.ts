import {parseAbi, type PublicClient} from "viem";

/** How much Stock Token the best route delivers for `usdgIn` USDG right now (MON-R19). */
export interface DexQuoter {
  readonly name: string;
  stockOut(stock: `0x${string}`, usdg: `0x${string}`, usdgIn: bigint): Promise<bigint>;
}

/** Anvil / testnet mock aggregator: its onchain `quote` (rate and fee as the chain driver set them). */
export function mockAggregatorQuoter(client: PublicClient, aggregator: `0x${string}`): DexQuoter {
  const abi = parseAbi(["function quote(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)"]);
  return {
    name: "mock-aggregator",
    stockOut: (stock, usdg, usdgIn) => client.readContract({address: aggregator, abi, functionName: "quote", args: [usdg, stock, usdgIn]}),
  };
}

/** Uniswap v3 QuoterV2 (Robinhood Chain, 01-chain-facts §6): the better of the listed fee tiers, simulated (eth_call). */
export function uniswapQuoter(client: PublicClient, quoterV2: `0x${string}`, fees: number[] = [500, 3000]): DexQuoter {
  const abi = parseAbi([
    "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  ]);
  return {
    name: "uniswap-v3",
    async stockOut(stock, usdg, usdgIn) {
      let best = 0n;
      for (const fee of fees) {
        try {
          const {result} = await client.simulateContract({address: quoterV2, abi, functionName: "quoteExactInputSingle", args: [{tokenIn: usdg, tokenOut: stock, amountIn: usdgIn, fee, sqrtPriceLimitX96: 0n}]});
          if (result[0] > best) best = result[0];
        } catch {
          // no pool / no liquidity at this tier
        }
      }
      return best;
    },
  };
}
