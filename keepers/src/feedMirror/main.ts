import {createPublicClient, http, type PublicClient} from "viem";
import {getExternal, robinhoodChain} from "@stockline/sdk";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {DryRunSender, envKeySender, rpcUnlockedSender, type TxSender} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runLoop} from "../common/loop.js";
import {ChainlinkSource, FeedMirror} from "./mirror.js";

/** `pnpm --filter @stockline/keepers feed-mirror` (testnet only). Reads mainnet (MAINNET_RPC_URL) read-only. */
const cfg = loadConfig();
if (cfg.deploymentKey === "fork-4663" || cfg.deploymentKey === 4663) throw new Error("the feed mirror is for mock-feed deployments (46630, 31337)");
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey);
const chain = chainFor(cfg.deploymentKey);
const mainnet = createPublicClient({chain: robinhoodChain, transport: http(process.env.MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com")}) as PublicClient;
const sender: TxSender =
  cfg.signer === "env-key" ? envKeySender(client, cfg.rpcUrl, chain) : cfg.signer === "rpc-unlocked" ? rpcUnlockedSender(client, cfg.rpcUrl, chain, cfg.unlockedAddress ?? cfg.deployment.roles.guardKeeper) : new DryRunSender(cfg.deployment.roles.guardKeeper);
const health = new Health(cfg.maxStaleMs);
health.serve(cfg.healthPort);
const mirror = new FeedMirror(client, sender, cfg.deployment, new ChainlinkSource(mainnet, getExternal(4663)!), health);
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
console.log(`[feed-mirror] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)}, every ${cfg.intervalMs} ms`);
await runLoop(() => mirror.tick().then(() => undefined), cfg.intervalMs, abort.signal);
