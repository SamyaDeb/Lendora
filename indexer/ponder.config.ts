import {createConfig} from "ponder";
import {
  adaptiveCurveIrmAbi,
  feeConverterAbi,
  feeSplitterAbi,
  mockSwapAggregatorAbi,
  morphoEventsAbi,
  scaledUiAmountAbi,
  stocklineOracleAbi,
  stocklineRouterAbi,
  uniswapV3PoolAbi,
  vaultV2FullAbi,
} from "@stockline/sdk";
import {networkConfig} from "./lib/network.js";

/**
 * SI-R1: Morpho Blue events filtered to Stockline market ids, the AdaptiveCurveIrm rate updates of those markets,
 * Vault V2 (`rSTOCK`) events, router events, oracle `GuardChanged`, Stock Token multiplier updates (the wrapper's
 * multiplier passes the token's through, LM-R3) and DEX swaps for daysToCover. Phase 3 (FE-R5): `FeeSplitter` and
 * `FeeConverter` events for protocol revenue. Everything from `@stockline/sdk`.
 */
const n = networkConfig();
const ids = n.tickers.map((t) => n.d.stocks[t].marketId);
const chain = "stockline" as const;
const startBlock = n.startBlock;
const converters = [n.d.treasuryConverter, n.d.backstopConverter].filter((x): x is `0x${string}` => Boolean(x));

export default createConfig({
  database: process.env.DATABASE_URL ? {kind: "postgres", connectionString: process.env.DATABASE_URL} : {kind: "pglite"},
  ordering: "omnichain",
  chains: {
    // Anvil (31337) is a different chain after every restart: never reuse Ponder's RPC cache for it.
    [chain]: {id: n.chainId, rpc: n.rpcUrl, ws: n.wsUrl, pollingInterval: n.pollingMs, disableCache: n.key === 31337},
  },
  contracts: {
    Morpho: {
      chain,
      abi: morphoEventsAbi,
      address: n.d.morpho,
      startBlock,
      filter: (["CreateMarket", "Supply", "Withdraw", "Borrow", "Repay", "SupplyCollateral", "WithdrawCollateral", "Liquidate", "AccrueInterest"] as const).map(
        (event) => ({event, args: {id: ids}}),
      ),
    },
    Irm: {chain, abi: adaptiveCurveIrmAbi, address: n.d.adaptiveCurveIrm, startBlock, filter: {event: "BorrowRateUpdate", args: {id: ids}}},
    Vault: {chain, abi: vaultV2FullAbi, address: n.tickers.map((t) => n.d.stocks[t].vault), startBlock},
    Router: {chain, abi: stocklineRouterAbi, address: n.d.router!, startBlock},
    Oracle: {chain, abi: stocklineOracleAbi, address: n.tickers.map((t) => n.d.stocks[t].oracle), startBlock},
    StockToken: {chain, abi: scaledUiAmountAbi, address: n.tickers.map((t) => n.d.stocks[t].stockToken), startBlock},
    // One contract with both swap events: the mock aggregator (anvil, testnet) or Uniswap v3 pools (fork).
    Dex: {
      chain,
      abi: [...mockSwapAggregatorAbi.filter((x) => x.type === "event"), ...uniswapV3PoolAbi.filter((x) => x.type === "event")],
      address: n.dexAddresses.length ? n.dexAddresses : ["0x000000000000000000000000000000000000dEaD"],
      startBlock,
    },
    // FE-R5. Deployments from before Phase 3 (testnet 46630 today) have neither: a placeholder address keeps the
    // handlers typed and never matches a log.
    FeeSplitter: {chain, abi: feeSplitterAbi, address: n.d.feeSplitter ?? "0x000000000000000000000000000000000000dEaD", startBlock},
    FeeConverter: {chain, abi: feeConverterAbi, address: converters.length ? converters : ["0x000000000000000000000000000000000000dEaD"], startBlock},
  },
  blocks: {
    Tick: {chain, startBlock, interval: n.tickInterval},
  },
});
