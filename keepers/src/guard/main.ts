import {getExternal, isRobinhoodMainnet} from "@stockline/sdk";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {senderFromConfig, type TxSender} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runLoop} from "../common/loop.js";
import {GuardKeeper, poolsFor} from "./guard.js";

const cfg = loadConfig();
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey);
const chain = chainFor(cfg.deploymentKey);
// OFF-4: one sender factory for every signing keeper (env key, remote KMS signer, anvil-unlocked, dry run).
const sender: TxSender = senderFromConfig(cfg, client, chain, process.env, cfg.deployment.roles.guardKeeper);
const health = new Health(cfg.maxStaleMs);
health.serve(cfg.healthPort);
const pools = poolsFor(cfg.deployment, isRobinhoodMainnet(cfg.deploymentKey) ? getExternal(4663) : undefined);
const keeper = new GuardKeeper(client, sender, cfg.deployment, pools, undefined, health);
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
console.log(`[guard] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)}, every ${cfg.intervalMs} ms`);
await runLoop(() => keeper.tick().then(() => undefined), cfg.intervalMs, abort.signal);
