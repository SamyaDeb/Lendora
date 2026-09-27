import {getDeployment, getExternal, parseDeploymentKey, type Address, type ChainDeployment, type DeploymentKey, type StockDeployment} from "@stockline/sdk";

/**
 * Which deployment the indexer follows (SI-R1): `STOCKLINE_NETWORK` = "31337" (anvil + mocks), "fork-4663" (anvil
 * fork of Robinhood Chain with the simulated deployment) or "46630" (testnet). Addresses and ABIs come only from
 * `@stockline/sdk`. Never "4663" in Phase 2.
 */
export interface NetworkConfig {
  key: DeploymentKey;
  chainId: number;
  rpcUrl: string;
  wsUrl?: string;
  d: ChainDeployment;
  startBlock: number;
  /** Realtime polling interval (SI-R4: ~0.1 s blocks on Robinhood Chain). */
  pollingMs: number;
  /** Heartbeat snapshot every N blocks (captures time-driven changes: accrual, buffer ramps, staleness). */
  tickInterval: number;
  /** Uniswap v3 pools (fork/mainnet) or the mock swap aggregator (anvil, testnet) whose swaps count as DEX volume. */
  dexAddresses: Address[];
  dexKind: "uniswap" | "mock" | "none";
  feedDecimals: number;
  tickers: string[];
  byMarketId: Map<string, string>;
  byVault: Map<string, string>;
  byOracle: Map<string, string>;
  byToken: Map<string, string>;
  byWrapper: Map<string, string>;
  /** Uniswap pool → [ticker, stock is token0]. */
  byPool: Map<string, {ticker: string; stockIsToken0: boolean}>;
}

const lc = (a: string) => a.toLowerCase();

export function networkConfig(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const raw = env.STOCKLINE_NETWORK ?? env.DEPLOYMENT_KEY ?? "31337";
  if (raw === "4663") throw new Error("Phase 2 never indexes a real 4663 deployment (use fork-4663)");
  const key = parseDeploymentKey(raw);
  const d = getDeployment(key);
  if (!d) throw new Error(`no deployment "${raw}" in @stockline/sdk addresses.json`);
  const chainId = key === "fork-4663" ? 4663 : Number(key);
  const stocks = d.stocks;
  const tickers = Object.keys(stocks).sort();
  const map = (f: (s: StockDeployment) => string) => new Map(tickers.map((t) => [lc(f(stocks[t])), t]));

  const byPool = new Map<string, {ticker: string; stockIsToken0: boolean}>();
  let dexAddresses: Address[] = [];
  let dexKind: NetworkConfig["dexKind"] = "none";
  if (d.mocks?.swapAggregator) {
    dexAddresses = [d.mocks.swapAggregator];
    dexKind = "mock";
  } else {
    const ext = getExternal(4663);
    if (key === "fork-4663" && ext) {
      for (const t of tickers) {
        // USDG and WETH 0.05% pools hold the main liquidity (01-chain-facts §6); token0 is the lower address.
        for (const quote of ["USDG", "WETH"] as const) {
          const pool = ext.uniswapV3Pools[`${t}_${quote}_500`];
          if (!pool) continue;
          const quoteAddr = ext.tokens[quote];
          byPool.set(lc(pool), {ticker: t, stockIsToken0: lc(stocks[t].stockToken) < lc(quoteAddr)});
          dexAddresses.push(pool);
        }
      }
      dexKind = dexAddresses.length ? "uniswap" : "none";
    }
  }

  return {
    key,
    chainId,
    rpcUrl: env.RPC_URL ?? (key === 31337 ? "http://127.0.0.1:8545" : ""),
    wsUrl: env.WS_URL,
    d,
    startBlock: Number(d.startBlock ?? d.forkBlock ?? 0),
    pollingMs: Number(env.PONDER_POLLING_MS ?? (key === 31337 ? 100 : 200)),
    tickInterval: Number(env.TICK_INTERVAL_BLOCKS ?? (key === 31337 ? 1 : 600)),
    dexAddresses,
    dexKind,
    feedDecimals: 8,
    tickers,
    byMarketId: map((s) => s.marketId),
    byVault: map((s) => s.vault),
    byOracle: map((s) => s.oracle),
    byToken: map((s) => s.stockToken),
    byWrapper: map((s) => s.wrapper),
    byPool,
  };
}
