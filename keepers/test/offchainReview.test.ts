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
