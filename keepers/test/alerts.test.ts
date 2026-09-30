import {afterAll, beforeAll, describe, expect, it} from "vitest";
import pg from "pg";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {alertSettingsMessage, nextClosure, type AlertSettings} from "@lendora/sdk";
import {startStack, type Stack} from "@lendora/api/harness";
import {Health} from "../src/common/health.js";
import {alertsApp} from "../src/alerts/server.js";
import {SettingsStore} from "../src/alerts/settings.js";
import {FakeTransport} from "../src/alerts/transports.js";
import {AlertWatcher, IndexerPositions} from "../src/alerts/watcher.js";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

/** APP-R8 on the full local stack (anvil seed week → indexer → Postgres). */
describe("alerts service (APP-R8)", () => {
  let s: Stack;
  let pool: pg.Pool;
  let store: SettingsStore;
  let app: ReturnType<typeof alertsApp>;
  const user = privateKeyToAccount(generatePrivateKey());
  const fake = new FakeTransport("webhook");
  const logs: string[] = [];
  let watcher: AlertWatcher;

  async function save(settings: AlertSettings, issuedAt = new Date().toISOString(), signer = user) {
    const signature = await signer.signMessage({message: alertSettingsMessage(user.address, settings, issuedAt)});
    return app.request("/v1/alerts/settings", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address: user.address, settings, issuedAt, signature})});
  }

  beforeAll(async () => {
    s = await startStack();
    pool = new pg.Pool({connectionString: s.pg.url});
    store = new SettingsStore(pool, `alerts_${Date.now()}`);
    await store.migrate();
    app = alertsApp(store, s.anvil.client, new Health(60_000), {allowHttpWebhooks: true});
    // A keyed wallet (it signs its settings) with an NVDA borrow at HF ≈ 1.25 now.
    await s.drv.borrow("NVDA", user.address, 4_200n * E6, 10n * E18); // NVDA $258.60 after the seed gap
    await s.sync();
    watcher = new AlertWatcher(s.anvil.client, s.config.d, store, new IndexerPositions(pool, s.indexer.viewsSchema), [fake], {dryRun: false, log: (m) => logs.push(m)});
  }, 400_000);

  afterAll(async () => {
    await pool?.end();
    await s?.close();
  });

  it("APP-R8 settings are saved only with a valid signature; tampering and replays are rejected; reads are masked", async () => {
    const settings: AlertSettings = {hfThreshold: 1.05, weekendWarning: true, channels: {webhookUrl: "http://127.0.0.1:9/hook", email: "trader@example.com"}};
    const t0 = new Date(Date.now() - 1000).toISOString();
    expect((await save(settings, t0)).status).toBe(200);
    // Tampered: signed one threshold, sent another.
    const issuedAt = new Date().toISOString();
    const sig = await user.signMessage({message: alertSettingsMessage(user.address, settings, issuedAt)});
    const tampered = await app.request("/v1/alerts/settings", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address: user.address, settings: {...settings, hfThreshold: 3}, issuedAt, signature: sig})});
    expect(tampered.status).toBe(401);
    // Someone else's signature.
    expect((await save(settings, new Date().toISOString(), privateKeyToAccount(generatePrivateKey()))).status).toBe(401);
    // Replay of an older signed setting.
    expect((await save(settings, new Date(Date.now() - 5000).toISOString())).status).toBe(409);
    const got = (await (await app.request(`/v1/alerts/settings/${user.address}`)).json()) as {settings: AlertSettings};
    expect(got.settings.channels.email).toBe("tr…om");
    expect(got.settings.hfThreshold).toBe(1.05);
  });

  it("APP-R8 24h and 4h before the weekend ramp-in, when the HF at the full buffer < 1.2: one alert each, never repeated", async () => {
    const st = await s.anvil.client.getBlock();
    const params = {z: 25n * 10n ** 17n, sigma: 52n * 10n ** 16n, bMin: 10n ** 16n, bMax: 2n * 10n ** 17n, rampIn: 4n * 3600n};
    const nc = nextClosure(Number(st.timestamp), params)!;
    const ramp = BigInt(nc.rampStartTs);
    await s.drv.freshRounds(ramp - 20n * 3600n);
    const a24 = await watcher.tick();
    expect(a24.map((a) => `${a.kind}:${a.ticker}`)).toEqual(["ramp_24h:NVDA"]);
    expect(Number(a24[0].data.healthFactorAtFullBuffer)).toBeLessThan(1.2);
    expect(await watcher.tick()).toEqual([]); // idempotent
    await s.drv.freshRounds(ramp - 3n * 3600n);
    const a4 = await watcher.tick();
    expect(a4.map((a) => a.kind)).toEqual(["ramp_4h"]);
    expect(await watcher.tick()).toEqual([]);
  });

  it("APP-R8 HF below the threshold alerts within 60 s of the triggering block, once, also across a restart", async () => {
    expect((await save({hfThreshold: 1.2, weekendWarning: false, channels: {webhookUrl: "http://127.0.0.1:9/hook"}})).status).toBe(200);
    // Back to a midweek session with the feed fresh.
    const now = (await s.anvil.client.getBlock()).timestamp;
    await s.drv.freshRounds(now + 3n * 86_400n); // next Tuesday-ish, open
    expect(await watcher.tick()).toEqual([]);
    // Run the service loop, then move the price: +6% NVDA pushes HF (≈1.25) under 1.2.
    let running = true;
    const loop = (async () => {
      while (running) {
        await watcher.tick().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    const before = fake.sent.length;
    const r = await s.drv.a.send("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", s.config.d.mocks!.NVDA_feed, (await import("viem")).encodeFunctionData({abi: (await import("@lendora/sdk")).mockAggregatorAbi, functionName: "setAnswer", args: [(s.drv.prices.NVDA * 106n) / 100n]}));
    const tBlock = Date.now();
    const deadline = tBlock + 60_000;
    while (fake.sent.length === before && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    running = false;
    await loop;
    const got = fake.sent.slice(before);
    expect(got).toHaveLength(1);
    expect(got[0].alert.kind).toBe("hf_below");
    expect(got[0].alert.block).toBeGreaterThanOrEqual(r.blockNumber);
    console.log(`[APP-R8] alert delivered ${got[0].at - tBlock} ms after the triggering block`);
    expect(got[0].at - tBlock).toBeLessThan(60_000);

    // Restart: a new watcher over the same store sends nothing new.
    const restarted = new AlertWatcher(s.anvil.client, s.config.d, store, new IndexerPositions(pool, s.indexer.viewsSchema), [fake], {dryRun: false, log: () => {}});
    expect(await restarted.tick()).toEqual([]);
    expect(fake.sent.length).toBe(before + 1);
  });

  it("APP-R8 after recovering above the threshold, a new crossing alerts again", async () => {
    await s.drv.addCollateral("NVDA", user.address, 2_000n * E6);
    expect(await watcher.tick()).toEqual([]); // recovered: latch reset
    await s.drv.rounds({NVDA: (s.drv.prices.NVDA * 160n) / 100n}); // HF ≈ 1.15 with the added collateral
    const again = await watcher.tick();
    expect(again.map((a) => a.kind)).toEqual(["hf_below"]);
  });

  it("dry run logs the plan and sends nothing (keeper standard)", async () => {
    const dryStore = new SettingsStore(pool, `alerts_dry_${Date.now()}`);
    await dryStore.migrate();
    await dryStore.save(user.address, {hfThreshold: 5, weekendWarning: false, channels: {webhookUrl: "http://127.0.0.1:9/x"}}, new Date().toISOString());
    const dryFake = new FakeTransport("webhook");
    const dryLogs: string[] = [];
    const dry = new AlertWatcher(s.anvil.client, s.config.d, dryStore, new IndexerPositions(pool, s.indexer.viewsSchema), [dryFake], {dryRun: true, log: (m) => dryLogs.push(m)});
    expect((await dry.tick()).length).toBe(1);
    expect(dryFake.sent).toHaveLength(0);
    expect(dryLogs.some((l) => l.includes("[dry-run]"))).toBe(true);
  });
});
