import {createHmac} from "node:crypto";
import {readFileSync, readdirSync} from "node:fs";
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {PublicClient} from "viem";
import {generatePrivateKey} from "viem/accounts";
import {anvil as anvilChain} from "viem/chains";
import {Health} from "../src/common/health.js";
import {loadConfig} from "../src/common/config.js";
import {envKeySender, GasPriceTooHigh, senderFromConfig} from "../src/common/signer.js";
import {isPrivateAddress, WebhookTransport, type Alert} from "../src/alerts/transports.js";
import {loadDnEnv, loadNavEnv, navHealthStaleMs} from "../src/common/dnEnv.js";
import {defaultDnParams, plan, type DnState} from "../src/dnRebalancer/rebalancer.js";
import {cosignerApp} from "../src/navReporter/server.js";

/** Offchain security pass (Phase 3 task 9, docs/audit/offchain-review.md): one test per keeper finding. */
const alert: Alert = {kind: "ops", address: "", ticker: "NVDA", title: "t", body: "b", block: 1n, blockTime: 2n, data: {}};

describe("OFF-1 no secret in /health or logs", () => {
  it("OFF_1 a failing market's /health error is one redacted line without the RPC key", () => {
    const env = {RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/SuperSecretKey123"};
    const h = new Health(60_000, () => 0, env);
    h.fail("NVDA", new Error(`HTTP request failed.\n\nURL: ${env.RPC_URL}\nRequest body: {}`));
    const body = JSON.stringify(h.report());
    expect(body).not.toContain("SuperSecretKey123");
    expect(body).toContain("[redacted:RPC_URL]");
    expect(h.report().markets.NVDA.error).not.toContain("\n");
  });
});

describe("OFF-2 gas price cap", () => {
  const stub = (maxFeePerGas: bigint) =>
    ({
      estimateFeesPerGas: async () => ({maxFeePerGas, maxPriorityFeePerGas: 1n}),
      waitForTransactionReceipt: async () => {
        throw new Error("must not be reached");
      },
    }) as unknown as PublicClient;

  it("OFF_2 nothing is signed or sent while the fee estimate is above MAX_FEE_PER_GAS_GWEI", async () => {
    const s = envKeySender(stub(100n * 10n ** 9n), "http://127.0.0.1:1", anvilChain, {KEEPER_PRIVATE_KEY: generatePrivateKey()}, 10n * 10n ** 9n);
    await expect(s.send("0x0000000000000000000000000000000000000001", "0x", "x")).rejects.toBeInstanceOf(GasPriceTooHigh);
  });

  it("OFF_2 the cap defaults to 10 gwei and parses decimals", () => {
    expect(loadConfig({DEPLOYMENT_KEY: "31337"}).maxFeePerGasWei).toBe(10n * 10n ** 9n);
    expect(loadConfig({DEPLOYMENT_KEY: "31337", MAX_FEE_PER_GAS_GWEI: "0.05"}).maxFeePerGasWei).toBe(50_000_000n);
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", MAX_FEE_PER_GAS_GWEI: "-1"})).toThrow(/MAX_FEE_PER_GAS_GWEI/);
  });
});

describe("OFF-4 every signing keeper honours KEEPER_SIGNER=remote", () => {
  it("OFF_4 senderFromConfig builds the remote signer, and every signing main.ts uses senderFromConfig", () => {
    const cfg = loadConfig({
      DEPLOYMENT_KEY: "31337",
      DRY_RUN: "false",
      KEEPER_SIGNER: "remote",
      KEEPER_REMOTE_SIGNER_URL: "https://kms.example/sign",
      KEEPER_ADDRESS: "0x0000000000000000000000000000000000000abc",
    });
    expect(senderFromConfig(cfg, {} as PublicClient, anvilChain).kind).toBe("remote");
    const src = new URL("../src/", import.meta.url);
    for (const dir of readdirSync(src)) {
      let main: string;
      try {
        main = readFileSync(new URL(`${dir}/main.ts`, src), "utf8");
      } catch {
        continue;
      }
      if (!/sender|Sender/.test(main)) continue; // read-only services (monitor, alerts)
      expect(main, `${dir}/main.ts`).toMatch(/senderFromConfig\(/);
      expect(main, `${dir}/main.ts`).not.toMatch(/envKeySender|rpcUnlockedSender|new DryRunSender/);
    }
  });
});

describe("OFF-5 keeper env is validated at startup", () => {
  it("OFF_5 bad numbers, URLs and addresses fail with the variable's name", () => {
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", INTERVAL_MS: "abc"})).toThrow(/INTERVAL_MS must be an integer/);
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", INTERVAL_MS: "10"})).toThrow(/INTERVAL_MS/); // hot loop
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", HEALTH_PORT: "99999"})).toThrow(/HEALTH_PORT/);
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", RPC_URL: "not a url"})).toThrow(/RPC_URL/);
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", KEEPER_ADDRESS: "0x123"})).toThrow(/KEEPER_ADDRESS/);
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", KEEPER_REMOTE_SIGNER_URL: "http://kms.example/sign"})).toThrow(/https/);
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", KEEPER_SIGNER: "kms"})).toThrow(/KEEPER_SIGNER/);
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", DRY_RUN: "false", KEEPER_SIGNER: "remote"})).toThrow(/KEEPER_REMOTE_SIGNER_URL/);
    expect(loadConfig({DEPLOYMENT_KEY: "31337", INTERVAL_MS: "", KEEPER_REMOTE_SIGNER_URL: "http://signer.railway.internal/sign"}).intervalMs).toBe(30_000);
  });
});

describe("OFF-6 webhook SSRF", () => {
  let server: Server;
  let port: number;
  const got: {sig?: string; body: string}[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        got.push({sig: req.headers["x-stockline-signature"] as string, body: b});
        res.writeHead(req.url === "/redirect" ? 302 : 200, req.url === "/redirect" ? {location: "http://169.254.169.254/"} : {}).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("OFF_6 private, mapped, CGNAT, metadata and reserved addresses are private; public ones are not", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "172.31.0.1", "192.168.1.1", "0.0.0.0", "198.18.0.1", "224.0.0.1", "::", "::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "not-an-ip"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("OFF_6 refuses http, credentials, a missing signing key, and any private address among all records", async () => {
    const key = "k".repeat(32);
    const pub = async () => [{address: "93.184.215.14", family: 4}];
    await expect(new WebhookTransport(key, false, pub).send("http://hooks.example/x", alert)).rejects.toThrow(/https/);
    await expect(new WebhookTransport(key, false, pub).send("https://u:p@hooks.example/x", alert)).rejects.toThrow(/credentials/);
    await expect(new WebhookTransport("", false, pub).send("https://hooks.example/x", alert)).rejects.toThrow(/signing key/);
    const mixed = async () => [{address: "93.184.215.14", family: 4}, {address: "10.0.0.5", family: 4}];
    await expect(new WebhookTransport(key, false, mixed).send("https://hooks.example/x", alert)).rejects.toThrow(/private/);
    const mapped = async () => [{address: "::ffff:127.0.0.1", family: 6}];
    await expect(new WebhookTransport(key, false, mapped).send("https://hooks.example/x", alert)).rejects.toThrow(/private/);
    await expect(new WebhookTransport(key, false, pub).send("https://[::1]/x", alert)).rejects.toThrow(/private/);
  });

  it("OFF_6 the socket connects to the checked address (no second lookup), signs the body and does not follow redirects", async () => {
    const key = "k".repeat(32);
    let calls = 0;
    const pinned = async () => {
      calls++;
      return [{address: "127.0.0.1", family: 4}];
    };
    // `hook.invalid` never resolves in DNS: delivery only works because the connection uses the pinned address.
    await new WebhookTransport(key, true, pinned).send(`http://hook.invalid:${port}/ok`, alert);
    expect(calls).toBe(1);
    const last = got[got.length - 1];
    expect(last.sig).toBe(`sha256=${createHmac("sha256", key).update(last.body).digest("hex")}`);
    await expect(new WebhookTransport(key, true, pinned).send(`http://hook.invalid:${port}/redirect`, alert)).rejects.toThrow(/webhook 302/);
  });
});

describe("OFF-15 supply chain: pinned base images, non-root containers", () => {
  it("OFF_15 every FROM is pinned by sha256 digest and every final stage runs as a non-root user", () => {
    for (const f of ["Dockerfile", "web.Dockerfile"]) {
      const src = readFileSync(new URL(`../../infra/${f}`, import.meta.url), "utf8");
      const froms = src.split("\n").filter((l) => l.startsWith("FROM "));
      expect(froms.length, f).toBeGreaterThan(0);
      const stages = new Set<string>();
      for (const l of froms) {
        const [, image, , stage] = /^FROM (\S+)( AS (\w+))?$/.exec(l) ?? [];
        if (!stages.has(image)) expect(l, `${f}: ${l}`).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}( AS \w+)?$/); // images; earlier stages are fine
        if (stage) stages.add(stage);
      }
      const lastStage = src.slice(src.lastIndexOf("\nFROM "));
      expect(lastStage, f).toMatch(/\nUSER (?!root)\w+/);
    }
  });
});

/** Phase 4 task 18 (docs/audit/offchain-review.md §1, OFF-18…OFF-21): the NAV co-signer service and the DN keepers' env. */
describe("OFF-18…OFF-21 NAV co-signer and DN keepers", () => {
  const token = "t".repeat(40);
  const report = {equity: "1", deposited: "0", requested: "0", tradeNonce: "0", timestamp: "1", shortSizes: ["0", "0", "0"]};
  const post = (app: ReturnType<typeof cosignerApp>, body: string, auth?: string) =>
    app.request("/cosign", {method: "POST", headers: {"content-type": "application/json", ...(auth ? {authorization: auth} : {})}, body});

  it("OFF_18 the bearer token is required and checked (wrong, missing, prefix-only and longer tokens are 401)", async () => {
    let called = 0;
    const app = cosignerApp({cosign: async () => (called++, "0xsig")}, token);
    for (const a of [undefined, "Bearer x", `Bearer ${token.slice(0, 39)}`, `Bearer ${token}x`, token]) expect((await post(app, JSON.stringify(report), a)).status).toBe(401);
    expect(called).toBe(0);
    const ok = await post(app, JSON.stringify(report), `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({signature: "0xsig"});
    expect(readFileSync(new URL("../src/navReporter/server.ts", import.meta.url), "utf8")).toMatch(/timingSafeEqual/);
  });

  it("OFF_19 oversized and malformed bodies are refused before any read; refusals carry no RPC key", async () => {
    let called = 0;
    const env = {RPC_URL: "https://rpc.example/v2/SuperSecretKey123"};
    const app = cosignerApp(
      {
        cosign: async () => {
          called++;
          throw new Error(`HTTP request failed.\nURL: ${env.RPC_URL}`);
        },
      },
      token,
      undefined,
      env,
    );
    const auth = `Bearer ${token}`;
    expect((await post(app, "x".repeat(17 * 1024), auth)).status).toBe(413);
    expect((await post(app, "{not json", auth)).status).toBe(400);
    expect((await post(app, JSON.stringify({...report, shortSizes: Array(17).fill("0")}), auth)).status).toBe(400);
    expect((await post(app, JSON.stringify({...report, equity: "abc"}), auth)).status).toBe(400);
    expect(called).toBe(0);
    const r = await post(app, JSON.stringify(report), auth);
    expect(r.status).toBe(422);
    const text = await r.text();
    expect(text).not.toContain("SuperSecretKey123");
    expect(called).toBe(1);
  });

  it("OFF_20 NAV and DN keeper numbers are validated with the variable's name", () => {
    expect(() => loadNavEnv({NAV_REPORT_EVERY_MS: "abc"})).toThrow(/NAV_REPORT_EVERY_MS/);
    expect(() => loadNavEnv({NAV_REPORT_EVERY_MS: String(15 * 60_000)})).toThrow(/NAV_REPORT_EVERY_MS/); // DN-R5 max age
    expect(() => loadNavEnv({NAV_REPORT_MOVE_BPS: "0"})).toThrow(/NAV_REPORT_MOVE_BPS/);
    expect(() => loadNavEnv({LIGHTER_MARKET_IDS: "26,x"})).toThrow(/LIGHTER_MARKET_IDS/);
    expect(loadNavEnv({}).NAV_REPORT_EVERY_MS).toBe(5 * 60_000);
    expect(loadNavEnv({COSIGNER_URL: "", COSIGNER_TOKEN: ""}).COSIGNER_URL).toBeUndefined(); // `.env.example` blanks
    expect(() => loadDnEnv({DN_SLIPPAGE_BPS: "101"})).toThrow(/DN_SLIPPAGE_BPS/); // DN-R10: 1% onchain floor
    expect(() => loadDnEnv({DN_KILL_HOURS: "NaN"})).toThrow(/DN_KILL_HOURS/);
    expect(() => loadDnEnv({DN_KILL_LENDING_APY: "5"})).toThrow(/DN_KILL_LENDING_APY/);
    expect(() => loadDnEnv({DN_ENTRY_CHUNK_USDG: "-1"})).toThrow(/DN_ENTRY_CHUNK_USDG/);
    expect(() => loadDnEnv({DN_MMF_WAD: "1e16"})).toThrow(/DN_MMF_WAD/);
    expect(loadDnEnv({}).DN_SLIPPAGE_BPS).toBe(50n);
    expect(loadDnEnv({}).DN_MIN_TRADE_USDG).toBe(100_000_000n);
    expect(() => loadDnEnv({DN_MIN_TRADE_USDG: "0"})).toThrow(/DN_MIN_TRADE_USDG/);
    for (const dir of ["navReporter", "dnRebalancer"]) {
      const main = readFileSync(new URL(`../src/${dir}/main.ts`, import.meta.url), "utf8");
      expect(main, dir).not.toMatch(/Number\(env\.|BigInt\(env\./);
    }
  });

  it("OFF_21 the co-signer URL is https off localhost / *.railway.internal and always carries a token; the co-signer needs one", () => {
    expect(() => loadNavEnv({COSIGNER_URL: "http://cosigner.example.com/cosign", COSIGNER_TOKEN: token})).toThrow(/COSIGNER_URL/);
    expect(() => loadNavEnv({COSIGNER_URL: "https://cosigner.example.com/cosign"})).toThrow(/COSIGNER_TOKEN/);
    expect(loadNavEnv({COSIGNER_URL: "http://nav-cosigner.railway.internal:8790/cosign", COSIGNER_TOKEN: token}).COSIGNER_URL).toContain("railway.internal");
    expect(() => loadNavEnv({NAV_MODE: "cosigner", COSIGNER_TOKEN: "short"})).toThrow(/COSIGNER_TOKEN/);
    expect(() => loadNavEnv({LIGHTER_API_URL: "http://api.rh.lighter.xyz"})).toThrow(/LIGHTER_API_URL/);
  });

  it("T14 a small book (46630: 157.5 USDG) deploys only when the minimum trade fits its sleeves (DN_MIN_TRADE_USDG)", () => {
    const E6n = 10n ** 6n;
    const sleeve = (id: number) => ({id, active: true, capUsdg: 10n ** 13n, maxLendBps: 9000n, stockToken: "0x1" as const, wrapper: "0x2" as const, rVault: "0x3" as const, unitValue: 200n * E6n, spot: 0n, lent: 0n, wrapped: 0n, loose: 0n, rShares: 0n, short: 0n, others: 0n, guardClear: true});
    const s: DnState = {now: 0n, open: true, regular: true, fresh: true, paused: false, nav: 157_500_001n, idle: 157_500_001n, bufferBps: 500n, stratUsdg: 0n, queuedAssets: 0n, headOverdue: false, headPayable: false, margin: {equity: 0n, maintenance: 0n}, pending: 0n, sleeves: [sleeve(0), sleeve(1), sleeve(2)], kill: [false, false, false]};
    // Default $100 minimum: the largest sleeve's target spot is ~$56, so nothing is ever built and venue equity stays 0.
    expect(plan(s, defaultDnParams, false).filter((a) => a.kind === "build")).toEqual([]);
    const builds = plan(s, {...defaultDnParams, minTradeUsdg: 10n * E6n}, false).filter((a) => a.kind === "build");
    expect(builds.map((a) => a.sleeve)).toEqual([0, 1, 2]);
  });

  it("T15 the NAV co-signer's /health allows the oracle's max age between requests, not the keepers' 5 minutes", () => {
    // The reporter asks every NAV_REPORT_EVERY_MS (5 min, up to 14): a 5-minute window read 503 between requests.
    expect(navHealthStaleMs(loadNavEnv({NAV_MODE: "cosigner", COSIGNER_TOKEN: "x".repeat(32)}), 5 * 60_000)).toBe(15 * 60_000);
    expect(navHealthStaleMs(loadNavEnv({}), 5 * 60_000)).toBe(5 * 60_000); // the reporter ticks every 30 s
    expect(navHealthStaleMs(loadNavEnv({NAV_MODE: "cosigner", COSIGNER_TOKEN: "x".repeat(32)}), 20 * 60_000)).toBe(20 * 60_000);
    // A co-signer that just started is healthy (its window counts from start), not 503 until the first request:
    // every restart paged KEEPER_DOWN for up to NAV_REPORT_EVERY_MS.
    const clock = {t: 0};
    const h = new Health(15 * 60_000, () => clock.t);
    cosignerApp({cosign: async () => "0xsig"}, "x".repeat(32), h);
    expect(h.report().healthy).toBe(true);
    clock.t = 16 * 60_000;
    expect(h.report().healthy).toBe(false);
  });
});
