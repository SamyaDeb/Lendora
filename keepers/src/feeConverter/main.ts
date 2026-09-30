import {getExternal, isRobinhoodMainnet} from "@lendora/sdk";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {senderFromConfig} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runService} from "../common/loop.js";
import {defaultFeeConverterOptions, FeeConverterBot, mockDexSellBuilder, universalRouterSellBuilder} from "./feeConverter.js";

/** FE-R4 fee-converter keeper. Dry run by default; `/health` per stock (MON-R9 `KEEPER_DOWN`: FEE_CONVERTER). */
const cfg = loadConfig();
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey, cfg.archiveRpcUrl);
const sender = senderFromConfig(cfg, client, chainFor(cfg.deploymentKey));
const d = cfg.deployment;
if (!d.feeSplitter || !d.treasuryConverter || !d.backstopConverter) throw new Error(`deployment ${String(cfg.deploymentKey)} has no FeeSplitter / FeeConverters`);
const ext = isRobinhoodMainnet(cfg.deploymentKey) ? getExternal(4663) : undefined;
const sell = ext ? universalRouterSellBuilder(ext.uniswap.universalRouter) : mockDexSellBuilder(d.mocks!.swapAggregator);
const env = process.env;
const opts = {
  thresholdUsdg: BigInt(env.FEE_CONVERTER_THRESHOLD_USDG ?? defaultFeeConverterOptions.thresholdUsdg),
  periodSec: BigInt(env.FEE_CONVERTER_PERIOD_SEC ?? defaultFeeConverterOptions.periodSec),
  minUsdg: BigInt(env.FEE_CONVERTER_MIN_USDG ?? defaultFeeConverterOptions.minUsdg),
  slippageBps: BigInt(env.FEE_CONVERTER_SLIPPAGE_BPS ?? defaultFeeConverterOptions.slippageBps),
  regularHoursOnly: env.FEE_CONVERTER_REGULAR_HOURS_ONLY !== "false",
  fromBlock: BigInt(env.FEE_CONVERTER_FROM_BLOCK ?? d.startBlock ?? d.forkBlock ?? 0),
};
if (opts.slippageBps > 100n) throw new Error("FEE_CONVERTER_SLIPPAGE_BPS above 100 (1%) would always revert onchain (FE-R4)");
// Hourly by default: the schedule is weekly / > $1k, so a tick only needs to notice the session and the threshold.
const interval = Number(env.INTERVAL_MS ?? 3_600_000);
const health = new Health(Math.max(cfg.maxStaleMs, 3 * interval));
health.serve(cfg.healthPort);
const bot = new FeeConverterBot(client, sender, d, sell, opts, health);
console.log(`[fee-converter] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)} (${sender.kind}), every ${interval} ms`);
await runService(() => bot.tick().then(() => undefined), interval);
