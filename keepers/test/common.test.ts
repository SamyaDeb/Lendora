import {describe, expect, it} from "vitest";
import {createPublicClient, http} from "viem";
import {anvil} from "viem/chains";
import {loadConfig} from "../src/common/config.js";
import {Health} from "../src/common/health.js";
import {DryRunSender, envKeySender} from "../src/common/signer.js";
import {runLoop, runService} from "../src/common/loop.js";
import {chainFor} from "../src/common/chain.js";
import {assertMirrorAllowed} from "../src/feedMirror/mirror.js";
import {liquidatorRecipient} from "../src/liquidator/liquidator.js";

describe("keeper plumbing", () => {
  it("defaults to dry run and refuses live mode without a signer", () => {
    const c = loadConfig({DEPLOYMENT_KEY: "31337"});
    expect(c.dryRun).toBe(true);
    expect(c.signer).toBe("dry-run");
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", DRY_RUN: "false"})).toThrow(/KEEPER_SIGNER/);
    expect(loadConfig({DEPLOYMENT_KEY: "fork-4663"}).deployment.stocks.NVDA).toBeDefined();
    expect(() => loadConfig({DEPLOYMENT_KEY: "4663"})).toThrow(/keeper: no deployment "4663".*MN-R6/);
  });

  it("A24 optional archive RPC for past-block reads, validated like RPC_URL", () => {
    expect(loadConfig({DEPLOYMENT_KEY: "31337"}).archiveRpcUrl).toBeUndefined();
    expect(loadConfig({DEPLOYMENT_KEY: "31337", RPC_URL_ARCHIVE: "https://archive.example"}).archiveRpcUrl).toBe("https://archive.example");
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", RPC_URL_ARCHIVE: "not a url"})).toThrow(/RPC_URL_ARCHIVE/);
  });

  it("MN_R6 the feed mirror never runs on 4663 or its fork, nor without mock feeds", () => {
    const fork = loadConfig({DEPLOYMENT_KEY: "fork-4663"});
    expect(() => assertMirrorAllowed(4663, fork.deployment)).toThrow(/never runs on Robinhood Chain mainnet/);
    expect(() => assertMirrorAllowed("fork-4663", fork.deployment)).toThrow(/never runs/);
    expect(() => assertMirrorAllowed(46630, {...fork.deployment, mocks: undefined})).toThrow(/needs mock feeds/);
    expect(() => assertMirrorAllowed(31337, loadConfig({DEPLOYMENT_KEY: "31337"}).deployment)).not.toThrow();
  });

  it("MN_R6 the liquidator needs an explicit profit recipient on mainnet", () => {
    const owner = "0x00000000000000000000000000000000000000aa" as const;
    const signer = "0x00000000000000000000000000000000000000bb" as const;
    expect(() => liquidatorRecipient(4663, undefined, signer, owner)).toThrow(/LIQUIDATOR_RECIPIENT/);
    expect(() => liquidatorRecipient(4663, "nope", signer, owner)).toThrow(/must be an address/);
    expect(liquidatorRecipient(4663, "0x00000000000000000000000000000000000000cc", signer, owner)).toBe("0x00000000000000000000000000000000000000cc");
    expect(liquidatorRecipient(46630, undefined, signer, owner)).toBe(signer);
    expect(liquidatorRecipient(31337, undefined, undefined, owner)).toBe(owner);
  });

  it("MN_R6 keepers sign for chain 4663 on mainnet and its fork", () => {
    expect(chainFor(4663).id).toBe(4663);
    expect(chainFor("fork-4663").id).toBe(4663);
    expect(chainFor(46630).id).toBe(46630);
  });

  it("LM-R33: /health fails when a market has not run for 5 minutes", async () => {
    let now = 0;
    const h = new Health(5 * 60_000, () => now);
    expect(h.report().healthy).toBe(false); // nothing ran yet
    h.ok("NVDA", 10n);
    expect(h.report().healthy).toBe(true);
    now = 5 * 60_000 + 1;
    expect(h.report().healthy).toBe(false);
    h.fail("NVDA", new Error("rpc down"));
    expect(h.report().markets.NVDA.error).toMatch(/rpc down/);
    const server = h.serve(0);
    const port = (server.address() as {port: number}).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    server.close();
  });

  it("signers: dry run records, env-key needs KEEPER_PRIVATE_KEY", async () => {
    const d = new DryRunSender(undefined, () => {});
    expect(await d.send("0x0000000000000000000000000000000000000001", "0x", "x")).toBeUndefined();
    expect(d.sent).toHaveLength(1);
    const client = createPublicClient({chain: anvil, transport: http("http://127.0.0.1:1")});
    expect(() => envKeySender(client as never, "http://127.0.0.1:1", anvil, {})).toThrow(/KEEPER_PRIVATE_KEY/);
  });

  it("the loop keeps running through errors and stops on abort", async () => {
    const abort = new AbortController();
    let n = 0;
    const errors: unknown[] = [];
    await runLoop(
      async () => {
        n++;
        if (n === 1) throw new Error("boom");
        if (n === 3) abort.abort();
      },
      1,
      abort.signal,
      (e) => errors.push(e),
    );
    expect(n).toBe(3);
    expect(errors).toHaveLength(1);
  });

  it("SIGTERM ends the loop, runs cleanup and exits (the /health server no longer keeps the process alive)", async () => {
    const {EventEmitter} = await import("node:events");
    const proc = new EventEmitter();
    const order: string[] = [];
    let n = 0;
    await runService(
      async () => {
        n++;
        if (n === 2) proc.emit("SIGTERM");
      },
      1,
      {proc, cleanup: async () => void order.push("cleanup"), exit: (code) => void order.push(`exit ${code}`)},
    );
    expect(n).toBe(2);
    expect(order).toEqual(["cleanup", "exit 0"]);
  });
});

describe("typed-data signer (Phase 2 compliance, RT-R2)", () => {
  it("reads the key from env or a key file and signs EIP-712 that verifies", async () => {
    const {generatePrivateKey, privateKeyToAccount} = await import("viem/accounts");
    const {verifyTypedData} = await import("viem");
    const {envKeyTypedDataSigner} = await import("../src/common/signer.js");
    const pk = generatePrivateKey();
    const fromFile = envKeyTypedDataSigner("COMPLIANCE_SIGNER", {COMPLIANCE_SIGNER_KEY_FILE: "/secret"}, (p) => (p === "/secret" ? `${pk}\n` : ""));
    const fromEnv = envKeyTypedDataSigner("COMPLIANCE_SIGNER", {COMPLIANCE_SIGNER_KEY: pk});
    expect(fromFile.address).toBe(privateKeyToAccount(pk).address);
    expect(fromEnv.address).toBe(fromFile.address);
    const t = {
      domain: {name: "StocklineRouter", version: "1", chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000000001"},
      types: {Attestation: [{name: "user", type: "address"}, {name: "expiry", type: "uint256"}]},
      primaryType: "Attestation",
      message: {user: "0x0000000000000000000000000000000000000002", expiry: 1n},
    } as const;
    const sig = await fromEnv.signTypedData(t);
    expect(await verifyTypedData({...t, address: fromEnv.address, signature: sig})).toBe(true);
    expect(() => envKeyTypedDataSigner("COMPLIANCE_SIGNER", {})).toThrow(/COMPLIANCE_SIGNER_KEY/);
  });
});
