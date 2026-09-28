import {getExternal} from "@stockline/sdk";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {senderFromConfig, type TxSender} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runLoop} from "../common/loop.js";
import {LiquidatorBot, mockDexBuilder, universalRouterBuilder} from "./liquidator.js";

const cfg = loadConfig();
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey);
const chain = chainFor(cfg.deploymentKey);
// OFF-4: one sender factory for every signing keeper (env key, remote KMS signer, anvil-unlocked, dry run).
const sender: TxSender = senderFromConfig(cfg, client, chain);
const swap =
  cfg.deploymentKey === "fork-4663"
    ? universalRouterBuilder(getExternal(4663)!.uniswap.universalRouter)
    : mockDexBuilder(cfg.deployment.mocks!.swapAggregator);
const recipient = (process.env.LIQUIDATOR_RECIPIENT ?? sender.address ?? cfg.deployment.roles.owner) as `0x${string}`;
const health = new Health(cfg.maxStaleMs);
health.serve(cfg.healthPort);
const bot = new LiquidatorBot(client, sender, cfg.deployment, swap, recipient, {
  slippageBps: BigInt(process.env.LIQUIDATOR_SLIPPAGE_BPS ?? 200),
  minProfit: BigInt(process.env.LIQUIDATOR_MIN_PROFIT ?? 1_000_000),
  fromBlock: BigInt(process.env.LIQUIDATOR_FROM_BLOCK ?? 0),
}, health);
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
console.log(`[liquidator] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)}, every ${cfg.intervalMs} ms`);
await runLoop(() => bot.tick().then(() => undefined), cfg.intervalMs, abort.signal);
