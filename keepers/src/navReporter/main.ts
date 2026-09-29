import {serve} from "@hono/node-server";
import {Hono} from "hono";
import {loadConfig} from "../common/config.js";
import {chainFor, publicClient} from "../common/chain.js";
import {senderFromConfig, typedDataSignerFromEnv} from "../common/signer.js";
import {Health} from "../common/health.js";
import {runLoop} from "../common/loop.js";
import {defaultNavReporterOptions, HttpCosigner, LighterAccountSource, MockVenueSource, NavCosigner, NavReporter, parseReport, sleeveMarkets, type EquitySource} from "./navReporter.js";

/**
 * DN-R4 NAV reporter (`NAV_MODE=reporter`, default) or its independent co-signer (`NAV_MODE=cosigner`). Dry run by
 * default (the report is built and signed but not sent); `/health` (MON-R9 `KEEPER_DOWN`: NAV_REPORTER). Keys: the
 * report signer through `NAV_SIGNER_*` (env key, key file, remote KMS, or anvil-unlocked); gas through the usual
 * `KEEPER_*` sender. Venue source: `NAV_SOURCE=mock` (anvil, testnet) or `lighter` (`LIGHTER_API_URL`,
 * `LIGHTER_MARKET_IDS=26,15,10`).
 */
const cfg = loadConfig();
const env = process.env;
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey);
const chain = chainFor(cfg.deploymentKey);
const d = cfg.deployment;
if (!d.dnVault) throw new Error(`deployment ${String(cfg.deploymentKey)} has no dnVault`);
const signer = typedDataSignerFromEnv("NAV_SIGNER", env, cfg.rpcUrl, chain.id);
const markets = await sleeveMarkets(client, d.dnVault.strategy);
const source: EquitySource =
  (env.NAV_SOURCE ?? "mock") === "lighter"
    ? new LighterAccountSource(env.LIGHTER_API_URL ?? "https://api.rh.lighter.xyz", d.dnVault.perpAdapter, (env.LIGHTER_MARKET_IDS ?? "26,15,10").split(",").map(Number))
    : new MockVenueSource(client, d.dnVault.perpAdapter, markets);
const health = new Health(cfg.maxStaleMs);
health.serve(cfg.healthPort);

if ((env.NAV_MODE ?? "reporter") === "cosigner") {
  const token = env.COSIGNER_TOKEN;
  if (!token || token.length < 32) throw new Error("NAV_MODE=cosigner needs COSIGNER_TOKEN (>= 32 chars)");
  const co = new NavCosigner(client, signer, d, source, chain.id);
  const app = new Hono();
  app.post("/cosign", async (c) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({error: "unauthorized"}, 401);
    try {
      const signature = await co.cosign(parseReport(await c.req.json()));
      health.ok("nav", 0n);
      return c.json({signature});
    } catch (e) {
      return c.json({error: e instanceof Error ? e.message : "refused"}, 422);
    }
  });
  serve({fetch: app.fetch, port: Number(env.PORT ?? 8790)});
  console.log(`[nav-cosigner] listening on ${env.PORT ?? 8790}, signer ${signer.address} (${signer.kind}), source ${source.name}`);
} else {
  const sender = senderFromConfig(cfg, client, chain);
  const cosigner = env.COSIGNER_URL ? new HttpCosigner(env.COSIGNER_URL, env.COSIGNER_TOKEN) : undefined;
  const opts = {everyMs: Number(env.NAV_REPORT_EVERY_MS ?? defaultNavReporterOptions.everyMs), moveBps: BigInt(env.NAV_REPORT_MOVE_BPS ?? defaultNavReporterOptions.moveBps)};
  if (opts.everyMs > 14 * 60_000) throw new Error("NAV_REPORT_EVERY_MS must stay under the oracle's 15-minute max age (DN-R5)");
  const bot = new NavReporter(client, sender, signer, d, source, chain.id, cosigner, opts, health);
  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());
  process.on("SIGTERM", () => abort.abort());
  console.log(`[nav-reporter] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)}, signer ${signer.address} (${signer.kind}), source ${source.name}, cosigner ${cosigner ? "on" : "off"}`);
  await runLoop(() => bot.tick().then(() => undefined), Number(env.INTERVAL_MS ?? 30_000), abort.signal);
}
