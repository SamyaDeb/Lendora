import {getExternal, isRobinhoodMainnet} from "@stockline/sdk";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {senderFromConfig} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runService} from "../common/loop.js";
import {loadDnEnv} from "../common/dnEnv.js";
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
const dnEnv = loadDnEnv();
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey, cfg.archiveRpcUrl);
const d = cfg.deployment;
if (!d.dnVault) throw new Error(`deployment ${String(cfg.deploymentKey)} has no dnVault`);
if (/^0x0{40}$/i.test(d.dnVault.perpAdapter)) throw new Error("the DN vault has no venue adapter (mainnet until one is verified): nothing to rebalance");
const sender = senderFromConfig(cfg, client, chainFor(cfg.deploymentKey));
const markets = await sleeveMarkets(client, d.dnVault.strategy);
const lighter = dnEnv.DN_VENUE === "lighter";
const ext = isRobinhoodMainnet(cfg.deploymentKey) ? getExternal(4663) : undefined;
const swap: DnSwapBuilder = ext
  ? (() => {
      const ur = universalRouterSellBuilder(ext.uniswap.universalRouter);
      return {target: ur.target, swap: (tokenIn, tokenOut, amountIn, recipient) => ur.sell(tokenIn, tokenOut, amountIn, recipient)};
    })()
  : mockDexSwapBuilder(d.mocks!.swapAggregator);
const lighterIds = dnEnv.LIGHTER_MARKET_IDS.map(Number);
const margin = lighter ? new ReportMargin(client, d, dnEnv.DN_MMF_WAD.map(BigInt)) : new MockVenueMargin(client, d.dnVault.perpAdapter);
const funding = lighter ? new LighterFunding(dnEnv.LIGHTER_API_URL, lighterIds) : new MockVenueFunding(client, d.dnVault.perpAdapter, markets, BigInt(d.startBlock ?? 0));
const p = {
  ...defaultDnParams,
  kill: {windowHours: dnEnv.DN_KILL_WINDOW_H, hours: dnEnv.DN_KILL_HOURS, lendingApy: dnEnv.DN_KILL_LENDING_APY},
  entryChunkUsdg: dnEnv.DN_ENTRY_CHUNK_USDG,
  slippageBps: dnEnv.DN_SLIPPAGE_BPS,
};
const interval = dnEnv.INTERVAL_MS; // DN_SLIPPAGE_BPS is bounded to 100 (1%, DN-R10) in loadDnEnv
const health = new Health(Math.max(cfg.maxStaleMs, 3 * interval));
health.serve(cfg.healthPort);
const bot = new DnRebalancer(client, sender, d, swap, margin, funding, p, health);
console.log(`[dn-rebalancer] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)} (${sender.kind}), venue ${lighter ? "lighter" : "mock"}, every ${interval} ms`);
await runService(() => bot.tick().then(() => undefined), interval);
