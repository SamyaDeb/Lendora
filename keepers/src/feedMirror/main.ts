import {createPublicClient, http, type PublicClient} from "viem";
import {getExternal, robinhoodChain} from "@lendora/sdk";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {senderFromConfig, type TxSender} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runService} from "../common/loop.js";
import {assertMirrorAllowed, ChainlinkSource, FeedMirror} from "./mirror.js";

/** `pnpm --filter @lendora/keepers feed-mirror` (testnet only). Reads mainnet (MAINNET_RPC_URL) read-only. */
const cfg = loadConfig();
assertMirrorAllowed(cfg.deploymentKey, cfg.deployment);
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey, cfg.archiveRpcUrl);
const chain = chainFor(cfg.deploymentKey);
const mainnet = createPublicClient({chain: robinhoodChain, transport: http(process.env.MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com")}) as PublicClient;
// OFF-4: one sender factory for every signing keeper (env key, remote KMS signer, anvil-unlocked, dry run).
const sender: TxSender = senderFromConfig(cfg, client, chain, process.env, cfg.deployment.roles.guardKeeper);
const health = new Health(cfg.maxStaleMs);
health.serve(cfg.healthPort);
const mirror = new FeedMirror(client, sender, cfg.deployment, new ChainlinkSource(mainnet, getExternal(4663)!), health);
console.log(`[feed-mirror] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)}, every ${cfg.intervalMs} ms`);
await runService(() => mirror.tick().then(() => undefined), cfg.intervalMs);
