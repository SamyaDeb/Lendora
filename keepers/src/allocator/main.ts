import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {DryRunSender, envKeySender, rpcUnlockedSender, type TxSender} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runLoop} from "../common/loop.js";
import {Allocator} from "./allocator.js";

const cfg = loadConfig();
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey);
const chain = chainFor(cfg.deploymentKey);
const sender: TxSender =
  cfg.signer === "env-key"
    ? envKeySender(client, cfg.rpcUrl, chain)
    : cfg.signer === "rpc-unlocked"
      ? rpcUnlockedSender(client, cfg.rpcUrl, chain, cfg.unlockedAddress ?? cfg.deployment.roles.allocator)
      : new DryRunSender(cfg.deployment.roles.allocator);
const health = new Health(cfg.maxStaleMs);
health.serve(cfg.healthPort);
const allocator = new Allocator(client, sender, cfg.deployment, undefined, health);
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
console.log(`[allocator] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)}, every ${cfg.intervalMs} ms`);
await runLoop(() => allocator.tick().then(() => undefined), cfg.intervalMs, abort.signal);
