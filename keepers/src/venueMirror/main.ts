import {z} from "zod";
import {loadConfig, httpUrl} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {senderFromConfig, type TxSender} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runService} from "../common/loop.js";
import {assertVenueMirrorAllowed, LighterFundingFeed, VenueMirror} from "./mirror.js";

/** `pnpm --filter @lendora/keepers venue-mirror` (testnet only): Lighter's real hourly funding → the mock venue.
 * Reads Lighter's public API (`LIGHTER_API_URL`, no account, no key); signs with the mock-venue operator. */
const cfg = loadConfig();
assertVenueMirrorAllowed(cfg.deploymentKey, cfg.deployment);
const env = z.object({LIGHTER_API_URL: httpUrl("LIGHTER_API_URL", true).default("https://api.rh.lighter.xyz")}).parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey, cfg.archiveRpcUrl);
// OFF-4: one sender factory for every signing keeper (env key, remote KMS signer, anvil-unlocked, dry run).
const sender: TxSender = senderFromConfig(cfg, client, chainFor(cfg.deploymentKey));
const health = new Health(Math.max(cfg.maxStaleMs, 3 * cfg.intervalMs));
health.serve(cfg.healthPort);
const mirror = new VenueMirror(client, sender, cfg.deployment, new LighterFundingFeed(env.LIGHTER_API_URL), health);
console.log(`[venue-mirror] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)} (${sender.kind}), Lighter ${env.LIGHTER_API_URL}, every ${cfg.intervalMs} ms`);
await runService(() => mirror.tick().then(() => undefined), cfg.intervalMs);
