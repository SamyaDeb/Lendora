import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createPublicClient, getAddress, http} from "viem";
import {CONTRACTS_DIR, freePort, startAnvil, type Anvil} from "../src/anvil.js";
import {ChainDriver} from "../src/driver.js";
import {openLiveDrills, runLiveDrills, drillsMarkdown} from "../src/liveDrills.js";

/** A bare anvil with a given chain id (no deployment), for the refusals. */
async function bareAnvil(chainId: number): Promise<{url: string; stop: () => void}> {
  const port = await freePort();
  const cache = mkdtempSync(join(tmpdir(), "stockline-anvil-cache-"));
  const p: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", String(chainId), "--cache-path", cache], {stdio: "ignore"});
  const url = `http://127.0.0.1:${port}`;
  const c = createPublicClient({transport: http(url)});
  for (let i = 0; i < 100; i++) {
    if (await c.getChainId().catch(() => 0)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {url, stop: () => (p.kill(), rmSync(cache, {recursive: true, force: true}))};
}

/** Part C step 3: the live-drill runner refuses everything but a gated 46630 (these run on every `pnpm test`). */
describe("live drills: refusals", () => {
  const nodes: {stop: () => void}[] = [];
  afterAll(() => nodes.forEach((n) => n.stop()));
  const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1: not the testnet deployer

  it("refuses mainnet (4663) in every mode, and any chain but 46630", async () => {
    const m = await bareAnvil(4663);
    const l = await bareAnvil(31337);
    nodes.push(m, l);
    for (const unlocked of [true, false]) {
      await expect(openLiveDrills({rpc: m.url, unlocked, env: {TESTNET_GO: "yes", TESTNET_DEPLOYER_KEY: key, DRILL_RAN_BY: "x"}})).rejects.toThrow(/mainnet \(4663\)/);
      await expect(openLiveDrills({rpc: l.url, unlocked, env: {}})).rejects.toThrow(/46630/);
    }
  }, 60_000);

  it("on 46630, live sends need TESTNET_GO=yes, the key in env, who runs it, and the key must be the deployer", async () => {
    const t = await bareAnvil(46630);
    nodes.push(t);
    await expect(openLiveDrills({rpc: t.url, unlocked: false, env: {}})).rejects.toThrow(/TESTNET_GO=yes/);
    await expect(openLiveDrills({rpc: t.url, unlocked: false, env: {TESTNET_GO: "yes"}})).rejects.toThrow(/TESTNET_DEPLOYER_KEY/);
    await expect(openLiveDrills({rpc: t.url, unlocked: false, env: {TESTNET_GO: "yes", TESTNET_DEPLOYER_KEY: key}})).rejects.toThrow(/DRILL_RAN_BY/);
    await expect(openLiveDrills({rpc: t.url, unlocked: false, env: {TESTNET_GO: "yes", TESTNET_DEPLOYER_KEY: key, DRILL_RAN_BY: "x"}})).rejects.toThrow(/not the testnet deployer/);
  }, 60_000);
});

const RUN = process.env.FORK_DRILLS_46630 === "1";
const RPC = process.env.TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";

/**
 * The same runner on an anvil fork of 46630 (`--unlocked`: the deployer impersonated), after the Part C deploys
 * (DeployTestnetFees + DeployTestnetVault with TESTNET_GO=fork-dry-run). Pass 1 runs the immediate drills and schedules
 * the timelocked ones; a pass before the delay keeps waiting; the test (not the runner) moves time 24h; pass 2
 * executes them. Opt-in like the fork drills: `FORK_DRILLS_46630=1`.
 */
describe.skipIf(!RUN)("live drills rehearsed on an anvil fork of 46630", () => {
  let a: Anvil;
  const dir = mkdtempSync(join(tmpdir(), "live-drills-"));
  const state = join(dir, "state.json");

  beforeAll(async () => {
    a = await startAnvil({state: "empty", args: ["--fork-url", RPC]});
    const op = a.d.roles.owner as `0x${string}`;
    await a.test.impersonateAccount({address: op});
    await a.test.setBalance({address: op, value: 10n ** 20n});
    for (const script of ["DeployTestnetFees", "DeployTestnetVault"]) {
      const r = spawnSync("forge", ["script", `script/${script}.s.sol`, "--rpc-url", a.url, "--broadcast", "--unlocked", "--sender", op, "--slow"], {cwd: CONTRACTS_DIR, env: {...process.env, TESTNET_GO: "fork-dry-run"}, encoding: "utf8"});
      expect(r.status, `${script}: ${r.stderr?.slice(-1500)}`).toBe(0);
    }
    // The live run reads these from addresses.json after the real deploys; the fork rehearsal injects the fork's.
    const fees = JSON.parse(readFileSync(`${CONTRACTS_DIR}/deployments/fork-46630-fees.json`, "utf8")) as Record<string, string>;
    const dn = JSON.parse(readFileSync(`${CONTRACTS_DIR}/deployments/fork-46630-dn.json`, "utf8")) as Record<string, string>;
    a.d.feeSplitter = getAddress(fees.feeSplitter);
    a.d.dnVault = {vault: getAddress(dn.vault), strategy: getAddress(dn.strategy), navOracle: getAddress(dn.navOracle), perpAdapter: getAddress(dn.perpAdapter)};
  }, 900_000);
  afterAll(() => {
    a?.stop();
    rmSync(dir, {recursive: true, force: true});
  });

  it("pass 1 runs and schedules, an early pass waits, pass 2 after 24h executes; nothing is left pending", async () => {
    const {ctx, init} = await openLiveDrills({rpc: a.url, unlocked: true, env: {DRILL_ROUND: "fork test"}, log: () => {}});
    Object.assign(ctx.d, {feeSplitter: a.d.feeSplitter, dnVault: a.d.dnVault});
    let s = await runLiveDrills(ctx, state, init);
    expect(s.mode).toBe("fork");
    expect(s.steps["guard-trip-clear"].status).toBe("done");
    expect(s.steps["governance-change"].note).toMatch(/router\.setGlobalCap/);
    expect(s.steps["timelock-two-step"].status).toBe("scheduled");
    expect(s.steps["fees-turn-on"].status).toBe("scheduled");
    expect(s.steps["dn-caps-zero"].note).toMatch(/total cap 0/);

    s = await runLiveDrills(ctx, state, init);
    expect(s.steps["timelock-two-step"].status, "not before the delay").toBe("scheduled");

    const drv = new ChainDriver(a, {operator: a.d.roles.owner as `0x${string}`, log: () => {}});
    const readyAt = Math.max(s.steps["timelock-two-step"].readyAt!, s.steps["fees-turn-on"].readyAt!);
    await drv.freshRounds(BigInt(readyAt) + 60n);
    s = await runLiveDrills(ctx, state, init);
    for (const [id, r] of Object.entries(s.steps)) expect(r.status, id).toBe("done");
    expect(drillsMarkdown(s)).toContain("anvil fork rehearsal");
  }, 900_000);
});
