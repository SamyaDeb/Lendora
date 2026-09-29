import {getExternal, isRobinhoodMainnet} from "@stockline/sdk";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {senderFromConfig} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runLoop} from "../common/loop.js";
import {sleeveMarkets} from "../navReporter/navReporter.js";
import {universalRouterSellBuilder} from "../feeConverter/feeConverter.js";
import {defaultDnParams, DnRebalancer, mockDexSwapBuilder, MockVenueMargin, ReportMargin, type DnSwapBuilder} from "./rebalancer.js";
import {LighterFunding, MockVenueFunding} from "./funding.js";

/**
 * DN-R2, R3, R7, R8, R13 rebalancer (the strategy operator key). Dry run by default; `/health` (MON-R9 `KEEPER_DOWN`:
 * DN_REBALANCER). Venue: `DN_VENUE=mock` (anvil, testnet) or `lighter` (margin from the NAV report, funding from the
 * public API). Kill switch (DN-R13, configurable): `DN_KILL_WINDOW_H` (168), `DN_KILL_HOURS` (72),
 * `DN_KILL_LENDING_APY` (0.02).
 */
const cfg = loadConfig();
const env = process.env;
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey);
const d = cfg.deployment;
if (!d.dnVault) throw new Error(`deployment ${String(cfg.deploymentKey)} has no dnVault`);
if (/^0x0{40}$/i.test(d.dnVault.perpAdapter)) throw new Error("the DN vault has no venue adapter (mainnet until one is verified): nothing to rebalance");
const sender = senderFromConfig(cfg, client, chainFor(cfg.deploymentKey));
const markets = await sleeveMarkets(client, d.dnVault.strategy);
const lighter = (env.DN_VENUE ?? "mock") === "lighter";
const ext = isRobinhoodMainnet(cfg.deploymentKey) ? getExternal(4663) : undefined;
const swap: DnSwapBuilder = ext
  ? (() => {
      const ur = universalRouterSellBuilder(ext.uniswap.universalRouter);
      return {target: ur.target, swap: (tokenIn, tokenOut, amountIn, recipient) => ur.sell(tokenIn, tokenOut, amountIn, recipient)};
    })()
  : mockDexSwapBuilder(d.mocks!.swapAggregator);
const lighterIds = (env.LIGHTER_MARKET_IDS ?? "26,15,10").split(",").map(Number);
const margin = lighter ? new ReportMargin(client, d, (env.DN_MMF_WAD ?? "12000000000000000,30000000000000000,30000000000000000").split(",").map(BigInt)) : new MockVenueMargin(client, d.dnVault.perpAdapter);
const funding = lighter ? new LighterFunding(env.LIGHTER_API_URL ?? "https://api.rh.lighter.xyz", lighterIds) : new MockVenueFunding(client, d.dnVault.perpAdapter, markets, BigInt(d.startBlock ?? 0));
const p = {
  ...defaultDnParams,
  kill: {windowHours: Number(env.DN_KILL_WINDOW_H ?? 168), hours: Number(env.DN_KILL_HOURS ?? 72), lendingApy: Number(env.DN_KILL_LENDING_APY ?? 0.02)},
  entryChunkUsdg: BigInt(env.DN_ENTRY_CHUNK_USDG ?? defaultDnParams.entryChunkUsdg),
  slippageBps: BigInt(env.DN_SLIPPAGE_BPS ?? defaultDnParams.slippageBps),
};
if (p.slippageBps > 100n) throw new Error("DN_SLIPPAGE_BPS above 100 (1%) would always revert onchain (DN-R10)");
const interval = Number(env.INTERVAL_MS ?? 60_000);
const health = new Health(Math.max(cfg.maxStaleMs, 3 * interval));
health.serve(cfg.healthPort);
const bot = new DnRebalancer(client, sender, d, swap, margin, funding, p, health);
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
console.log(`[dn-rebalancer] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)} (${sender.kind}), venue ${lighter ? "lighter" : "mock"}, every ${interval} ms`);
await runLoop(() => bot.tick().then(() => undefined), interval, abort.signal);
