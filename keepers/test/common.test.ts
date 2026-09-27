import {describe, expect, it} from "vitest";
import {createPublicClient, http} from "viem";
import {anvil} from "viem/chains";
import {loadConfig} from "../src/common/config.js";
import {Health} from "../src/common/health.js";
import {DryRunSender, envKeySender} from "../src/common/signer.js";
import {runLoop} from "../src/common/loop.js";

describe("keeper plumbing", () => {
  it("defaults to dry run and refuses live mode without a signer", () => {
    const c = loadConfig({DEPLOYMENT_KEY: "31337"});
    expect(c.dryRun).toBe(true);
    expect(c.signer).toBe("dry-run");
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", DRY_RUN: "false"})).toThrow(/KEEPER_SIGNER/);
    expect(loadConfig({DEPLOYMENT_KEY: "fork-4663"}).deployment.stocks.NVDA).toBeDefined();
    expect(() => loadConfig({DEPLOYMENT_KEY: "4663"})).toThrow(/no deployment/);
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
});
