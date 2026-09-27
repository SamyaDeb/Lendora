import {getExternal} from "@stockline/sdk";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {DryRunSender, envKeySender, rpcUnlockedSender, type TxSender} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runLoop} from "../common/loop.js";
import {GuardKeeper, poolsFor} from "./guard.js";

const cfg = loadConfig();
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey);
const chain = chainFor(cfg.deploymentKey);
const sender: TxSender =
  cfg.signer === "env-key"
    ? envKeySender(client, cfg.rpcUrl, chain)
    : cfg.signer === "rpc-unlocked"
      ? rpcUnlockedSender(client, cfg.rpcUrl, chain, cfg.unlockedAddress ?? cfg.deployment.roles.guardKeeper)
      : new DryRunSender(cfg.deployment.roles.guardKeeper);
const health = new Health(cfg.maxStaleMs);
health.serve(cfg.healthPort);
const pools = poolsFor(cfg.deployment, cfg.deploymentKey === "fork-4663" ? getExternal(4663) : undefined);
const keeper = new GuardKeeper(client, sender, cfg.deployment, pools, undefined, health);
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
console.log(`[guard] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)}, every ${cfg.intervalMs} ms`);
await runLoop(() => keeper.tick().then(() => undefined), cfg.intervalMs, abort.signal);
