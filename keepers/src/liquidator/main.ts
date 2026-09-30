import {getExternal, isRobinhoodMainnet} from "@lendora/sdk";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {senderFromConfig, type TxSender} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runService} from "../common/loop.js";
import {LiquidatorBot, liquidatorRecipient, mockDexBuilder, universalRouterBuilder} from "./liquidator.js";

const cfg = loadConfig();
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey, cfg.archiveRpcUrl);
const chain = chainFor(cfg.deploymentKey);
// OFF-4: one sender factory for every signing keeper (env key, remote KMS signer, anvil-unlocked, dry run).
const sender: TxSender = senderFromConfig(cfg, client, chain);
// MN-R6: mainnet and its fork swap through the allowlisted UniversalRouter (Q4); anvil and testnet through the mock DEX.
const swap = isRobinhoodMainnet(cfg.deploymentKey)
  ? universalRouterBuilder(getExternal(4663)!.uniswap.universalRouter)
  : mockDexBuilder(cfg.deployment.mocks!.swapAggregator);
const recipient = liquidatorRecipient(cfg.deploymentKey, process.env.LIQUIDATOR_RECIPIENT, sender.address, cfg.deployment.roles.owner);
const health = new Health(cfg.maxStaleMs);
health.serve(cfg.healthPort);
const bot = new LiquidatorBot(client, sender, cfg.deployment, swap, recipient, {
  slippageBps: BigInt(process.env.LIQUIDATOR_SLIPPAGE_BPS ?? 200),
  minProfit: BigInt(process.env.LIQUIDATOR_MIN_PROFIT ?? 1_000_000),
  fromBlock: BigInt(process.env.LIQUIDATOR_FROM_BLOCK ?? 0),
}, health);
console.log(`[liquidator] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)}, every ${cfg.intervalMs} ms`);
await runService(() => bot.tick().then(() => undefined), cfg.intervalMs);
