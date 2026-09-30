import {serve} from "@hono/node-server";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {senderFromConfig, typedDataSignerFromEnv} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runService} from "../common/loop.js";
import {loadNavEnv, navHealthStaleMs} from "../common/dnEnv.js";
import {cosignerApp} from "./server.js";
import {HttpCosigner, LighterAccountSource, MockVenueSource, NavCosigner, NavReporter, sleeveMarkets, type EquitySource} from "./navReporter.js";

/**
 * DN-R4 NAV reporter (`NAV_MODE=reporter`, default) or its independent co-signer (`NAV_MODE=cosigner`). Dry run by
 * default (the report is built and signed but not sent); `/health` (MON-R9 `KEEPER_DOWN`: NAV_REPORTER). Keys: the
 * report signer through `NAV_SIGNER_*` (env key, key file, remote KMS, or anvil-unlocked); gas through the usual
 * `KEEPER_*` sender. Venue source: `NAV_SOURCE=mock` (anvil, testnet) or `lighter` (`LIGHTER_API_URL`,
 * `LIGHTER_MARKET_IDS=26,15,10`).
 */
const cfg = loadConfig();
const env = process.env;
const nav = loadNavEnv(env);
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey, cfg.archiveRpcUrl);
const chain = chainFor(cfg.deploymentKey);
const d = cfg.deployment;
if (!d.dnVault) throw new Error(`deployment ${String(cfg.deploymentKey)} has no dnVault`);
const signer = typedDataSignerFromEnv("NAV_SIGNER", env, cfg.rpcUrl, chain.id);
const markets = await sleeveMarkets(client, d.dnVault.strategy);
const source: EquitySource =
  nav.NAV_SOURCE === "lighter"
    ? new LighterAccountSource(nav.LIGHTER_API_URL, d.dnVault.perpAdapter, nav.LIGHTER_MARKET_IDS.map(Number))
    : new MockVenueSource(client, d.dnVault.perpAdapter, markets);
const health = new Health(navHealthStaleMs(nav, cfg.maxStaleMs));
health.serve(cfg.healthPort);

if (nav.NAV_MODE === "cosigner") {
  const co = new NavCosigner(client, signer, d, source, chain.id);
  serve({fetch: cosignerApp(co, nav.COSIGNER_TOKEN!, health, env).fetch, port: nav.PORT});
  console.log(`[nav-cosigner] listening on ${nav.PORT}, signer ${signer.address} (${signer.kind}), source ${source.name}`);
} else {
  const sender = senderFromConfig(cfg, client, chain);
  const cosigner = nav.COSIGNER_URL ? new HttpCosigner(nav.COSIGNER_URL, nav.COSIGNER_TOKEN) : undefined;
  // NAV_REPORT_EVERY_MS is bounded to 14 minutes: under the oracle's 15-minute max age (DN-R5).
  const opts = {everyMs: nav.NAV_REPORT_EVERY_MS, moveBps: BigInt(nav.NAV_REPORT_MOVE_BPS)};
  const bot = new NavReporter(client, sender, signer, d, source, chain.id, cosigner, opts, health);
  console.log(`[nav-reporter] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)}, signer ${signer.address} (${signer.kind}), source ${source.name}, cosigner ${cosigner ? "on" : "off"}`);
  await runService(() => bot.tick().then(() => undefined), nav.INTERVAL_MS);
}
