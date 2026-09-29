import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createPublicClient, createTestClient, createWalletClient, encodeFunctionData, erc20Abi, http, type Hex, type PublicClient} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {getExternal} from "@stockline/sdk";
import {freePort} from "@stockline/devnet";
import {applyPlan, checkChain, checkGates, checkRoles, checkSafes, checkSigner, checkTree, launch, parseServiceEnv, planProblems, publishDeployment, Refusal, run, type Run} from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONTRACTS = join(ROOT, "contracts");
const ANVIL0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // anvil #0, test funds only

async function anvil(args: string[]): Promise<{url: string; stop: () => void; client: PublicClient}> {
  const port = await freePort();
  const cache = mkdtempSync(join(tmpdir(), "launch-anvil-"));
  const p: ChildProcess = spawn("anvil", ["--port", String(port), "--cache-path", cache, ...args], {stdio: "ignore"});
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({transport: http(url)}) as PublicClient;
  for (let i = 0; i < 300; i++) {
    if (await client.getChainId().catch(() => 0)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {url, client, stop: () => (p.kill(), rmSync(cache, {recursive: true, force: true}))};
}

/** Deploys test/mocks/MockSafe (threshold, signers) with anvil #0. */
async function mockSafe(url: string, threshold: number, signers: number, label: string): Promise<`0x${string}`> {
  const art = JSON.parse(readFileSync(join(CONTRACTS, "out/MockSafe.sol/MockSafe.json"), "utf8")) as {abi: unknown[]; bytecode: {object: Hex}};
  const account = privateKeyToAccount(ANVIL0);
  const w = createWalletClient({account, transport: http(url)});
  const c = createPublicClient({transport: http(url)});
  const hash = await w.deployContract({abi: art.abi, bytecode: art.bytecode.object, args: [BigInt(threshold), BigInt(signers), label], chain: null});
  return (await c.waitForTransactionReceipt({hash})).contractAddress!;
}

const addr = () => privateKeyToAccount(generatePrivateKey()).address;

describe("launcher refusals (Part D)", () => {
  const nodes: {stop: () => void}[] = [];
  afterAll(() => nodes.forEach((n) => n.stop()));

  it("unsigned gate: the committed gates file refuses (7 unsigned); a future date is refused; a signed file passes", () => {
    expect(checkGates(join(ROOT, "docs/owner-actions/launch-gates.json"))).toHaveLength(7);
    const dir = mkdtempSync(join(tmpdir(), "gates-"));
    const f = join(dir, "g.json");
    writeFileSync(f, JSON.stringify({gates: [{id: "a", gate: "x", signedBy: "Owner", date: "2026-09-01", evidence: "link"}, {id: "b", gate: "y", signedBy: "Owner", date: "2099-01-01", evidence: "link"}]}));
    expect(checkGates(f, new Date("2026-09-29"))).toEqual(['gate "b": dated in the future (2099-01-01)']);
    rmSync(dir, {recursive: true});
  });

  it("missing role, duplicate role, role = deployer (MN-R1, MN-R8)", () => {
    const env: NodeJS.ProcessEnv = {LAUNCH_DEPLOYER: addr()};
    for (const r of ["OWNER", "CURATOR", "GUARDIAN", "ALLOCATOR", "GUARD_KEEPER", "TREASURY", "BACKSTOP_RESERVE", "FEE_KEEPER", "ATTESTATION_SIGNER", "DN_OPERATOR", "NAV_SIGNER_1", "NAV_SIGNER_2"]) env[`STOCKLINE_${r}`] = addr();
    expect(checkRoles(env).problems).toEqual([]);
    expect(checkRoles({...env, STOCKLINE_FEE_KEEPER: undefined}).problems).toContain("STOCKLINE_FEE_KEEPER is not set");
    expect(checkRoles({...env, STOCKLINE_NAV_SIGNER_2: env.STOCKLINE_NAV_SIGNER_1}).problems.join()).toMatch(/NAV_SIGNER_2 equals STOCKLINE_NAV_SIGNER_1/);
    expect(checkRoles({...env, STOCKLINE_ALLOCATOR: env.LAUNCH_DEPLOYER}).problems.join()).toMatch(/ALLOCATOR is the deployer/);
  });

  it("signer: never a private key in the env; hardware wallet or KMS on a real launch", () => {
    expect(checkSigner({LAUNCH_SIGNER: "ledger"}, false).problems).toEqual([]);
    expect(checkSigner({}, false).problems.join()).toMatch(/LAUNCH_SIGNER/);
    expect(checkSigner({LAUNCH_SIGNER: "ledger", DEPLOYER_PRIVATE_KEY: "0x1"}, false).problems.join()).toMatch(/DEPLOYER_PRIVATE_KEY/);
    expect(checkSigner({}, true).mode).toBe("unlocked");
  });

  it("EOA multisig and a low threshold are refused (MN-R2, read onchain)", async () => {
    const n = await anvil([]);
    nodes.push(n);
    const owner = await mockSafe(n.url, 3, 7, "owner"); // needs 4-of-7
    const guardian = await mockSafe(n.url, 2, 4, "guardian");
    const problems = await checkSafes(n.client, {OWNER: owner, GUARDIAN: guardian, CURATOR: addr()});
    expect(problems.join("\n")).toMatch(/STOCKLINE_OWNER threshold 3 of 7/);
    expect(problems.join("\n")).toMatch(/STOCKLINE_CURATOR .* is an EOA/);
    expect(problems.join("\n")).not.toMatch(/GUARDIAN/);
  }, 60_000);

  it("wrong chain: not 4663; a real launch against anvil; a dry run against a remote node", async () => {
    const l = await anvil([]);
    const m = await anvil(["--chain-id", "4663"]);
    nodes.push(l, m);
    expect((await checkChain(l.client, l.url, true)).join()).toMatch(/chain 31337, not Robinhood Chain mainnet/);
    expect((await checkChain(m.client, m.url, false)).join()).toMatch(/an anvil node/);
    expect(await checkChain(m.client, m.url, true)).toEqual([]);
    expect((await checkChain(m.client, m.url.replace("127.0.0.1", "example.com"), true)).join()).toMatch(/local anvil fork/);
  }, 60_000);

  it("dirty tree and an untagged commit are refused", () => {
    const d = mkdtempSync(join(tmpdir(), "tree-"));
    const g = (...a: string[]) => spawnSync("git", a, {cwd: d, encoding: "utf8"});
    g("init", "-q");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
    writeFileSync(join(d, "f"), "1");
    expect(checkTree(run, d).problems.join()).toMatch(/dirty tree.*untagged|dirty tree/);
    rmSync(join(d, "f"));
    expect(checkTree(run, d).problems.join()).toMatch(/has no tag/);
    g("tag", "v1");
    expect(checkTree(run, d).problems).toEqual([]);
    rmSync(d, {recursive: true});
  });

  it("4663 without the go: refused before anything else; a dry run refuses the go", async () => {
    const base = {root: ROOT, apply: false, run, log: () => {}, confirm: async () => ""};
    await expect(launch({...base, env: {}, dryRun: false})).rejects.toThrow(/I_HAVE_THE_OWNERS_GO=1 is not set/);
    await expect(launch({...base, env: {I_HAVE_THE_OWNERS_GO: "1"}, dryRun: true})).rejects.toThrow(/unset I_HAVE_THE_OWNERS_GO/);
    await expect(launch({...base, env: {I_HAVE_THE_OWNERS_GO: "1"}, dryRun: false, skipSuite: true})).rejects.toThrow(/dry-run only/);
    await expect(launch({...base, env: {}, dryRun: true, apply: true})).rejects.toBeInstanceOf(Refusal);
  });

  it("services: the template starts with the monitor; unfilled values and missing secrets are listed by name; --apply needs railway login", () => {
    const plan = parseServiceEnv(join(ROOT, "infra/mainnet.env.example"));
    expect(plan[0].service).toBe("monitor");
    expect(plan.find((s) => s.service === "api")!.vars.find((v) => v.key === "STOCKLINE_NETWORK")?.literal).toBe("4663");
    const p = planProblems(plan, {PROXY_SECRET: "s".repeat(40)});
    expect(p.join("\n")).toMatch(/compliance.SANCTIONS_API_KEY: secret SANCTIONS_API_KEY is not in the environment/);
    expect(p.join("\n")).not.toMatch(/ssss/); // values never appear
    const calls: string[][] = [];
    const fake: Run = (cmd, args) => (calls.push([cmd, ...args]), {status: args[0] === "whoami" ? 1 : 0, stdout: "", stderr: ""});
    expect(applyPlan(plan, {}, fake, () => {})).toEqual(["railway is not logged in (run `railway login`), nothing applied"]);
    expect(calls).toEqual([["railway", "whoami"]]);
  });

  it("publish: validates, maps deployBlock → startBlock, merges receipt markets, idempotent, refuses a different entry", () => {
    const d = mkdtempSync(join(tmpdir(), "pub-"));
    const book = join(d, "addresses.json");
    copyFileSync(join(ROOT, "packages/sdk/addresses.json"), book);
    const entry = JSON.parse(JSON.stringify(JSON.parse(readFileSync(book, "utf8")).chains["31337"])) as Record<string, unknown>;
    delete entry.dnVault;
    delete entry.mocks;
    delete entry.startBlock;
    entry.deployBlock = "123";
    const nvda = (entry.stocks as Record<string, Record<string, unknown>>).NVDA;
    const receipt = nvda.receipt;
    delete nvda.receipt;
    mkdirSync(join(d, "deployments"));
    writeFileSync(join(d, "deployments/4663.json"), JSON.stringify({...entry, router: undefined}));
    expect(publishDeployment({deploymentsDir: join(d, "deployments"), bookPath: book}).problems).toContain("router missing or not an address");
    writeFileSync(join(d, "deployments/4663.json"), JSON.stringify(entry));
    writeFileSync(join(d, "deployments/4663-receipt-NVDA.json"), JSON.stringify(receipt));
    const r = publishDeployment({deploymentsDir: join(d, "deployments"), bookPath: book});
    expect(r.problems).toEqual([]);
    expect(r.changed).toBe(true);
    const pub = JSON.parse(readFileSync(book, "utf8")).chains["4663"];
    expect(pub.startBlock).toBe(123);
    expect(pub.deployBlock).toBeUndefined();
    expect(pub.stocks.NVDA.receipt).toEqual(receipt);
    expect(publishDeployment({deploymentsDir: join(d, "deployments"), bookPath: book}).changed).toBe(false);
    writeFileSync(join(d, "deployments/4663.json"), JSON.stringify({...entry, deployBlock: "124"}));
    expect(publishDeployment({deploymentsDir: join(d, "deployments"), bookPath: book}).problems.join()).toMatch(/already has a different "4663" entry/);
    rmSync(d, {recursive: true});
  });
});

const DRY = process.env.LAUNCH_DRY_RUN_4663 === "1";
const MAINNET_RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

/**
 * The full dry run: a local anvil fork of 4663 (latest), Safe-like placeholders for the five multisigs, a fresh deployer
 * with gas and 2 × SEED of each launch stock, then the launcher end to end with `--dry-run` (`DeployMainnetDryRun`;
 * nothing leaves this machine): a wrong confirmation sends nothing; the right one deploys, VerifyRoles passes every
 * row, the temp address book gets chains["4663"]; the real address book is untouched. Opt-in (needs the public 4663
 * RPC to fork from): `LAUNCH_DRY_RUN_4663=1 pnpm --filter @stockline/launch test`.
 */
describe.skipIf(!DRY)("launcher --dry-run on a local anvil fork of 4663", () => {
  let n: Awaited<ReturnType<typeof anvil>>;
  const env: NodeJS.ProcessEnv = {};
  const bookBefore = readFileSync(join(ROOT, "packages/sdk/addresses.json"), "utf8");
  let book: string;

  beforeAll(async () => {
    n = await anvil(["--fork-url", MAINNET_RPC]);
    const test = createTestClient({mode: "anvil", transport: http(n.url)});
    const deployer = addr();
    Object.assign(env, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ROBINHOOD_RPC_URL: n.url,
      LAUNCH_DEPLOYER: deployer,
      STOCKLINE_OWNER: await mockSafe(n.url, 4, 7, "owner"),
      STOCKLINE_CURATOR: await mockSafe(n.url, 3, 5, "curator"),
      STOCKLINE_GUARDIAN: await mockSafe(n.url, 2, 4, "guardian"),
      STOCKLINE_TREASURY: await mockSafe(n.url, 2, 3, "treasury"),
      STOCKLINE_BACKSTOP_RESERVE: await mockSafe(n.url, 2, 3, "backstop"),
      STOCKLINE_ALLOCATOR: addr(),
      STOCKLINE_GUARD_KEEPER: addr(),
      STOCKLINE_FEE_KEEPER: addr(),
      STOCKLINE_ATTESTATION_SIGNER: addr(),
      STOCKLINE_DN_OPERATOR: addr(),
      STOCKLINE_NAV_SIGNER_1: addr(),
      STOCKLINE_NAV_SIGNER_2: addr(),
    });
    await test.setBalance({address: deployer, value: 10n ** 18n});
    // 2 × SEED of each launch stock from its USDG pool (impersonated on the fork).
    const ext = getExternal(4663)!;
    for (const t of ["SPY", "NVDA", "AAPL"]) {
      const pool = (ext.uniswapV3Pools as Record<string, `0x${string}`>)[`${t}_USDG_500`];
      await test.impersonateAccount({address: pool});
      await test.setBalance({address: pool, value: 10n ** 18n});
      const w = createWalletClient({transport: http(n.url)});
      const hash = await w.sendTransaction({account: pool, chain: null, to: (ext.stockTokens as Record<string, `0x${string}`>)[t], data: encodeFunctionData({abi: erc20Abi, functionName: "transfer", args: [deployer, 2n * 10n ** 12n]})});
      expect((await n.client.waitForTransactionReceipt({hash})).status).toBe("success");
    }
    book = join(mkdtempSync(join(tmpdir(), "launch-book-")), "addresses.json");
    copyFileSync(join(ROOT, "packages/sdk/addresses.json"), book);
    for (const f of ["4663-dry-run.json", "4663-dry-run.launch.json", "4663-dry-run.verify-roles.md"]) rmSync(join(CONTRACTS, "deployments", f), {force: true});
  }, 600_000);
  afterAll(() => {
    n?.stop();
    for (const f of ["4663-dry-run.json", "4663-dry-run.launch.json"]) rmSync(join(CONTRACTS, "deployments", f), {force: true});
  });

  it("a wrong confirmation sends nothing; the right one deploys, verifies (every VerifyRoles row PASS) and publishes to the temp book", async () => {
    const logs: string[] = [];
    const base = {root: ROOT, env, dryRun: true, apply: false, skipSuite: true, skipForkSuites: true, bookPath: book, run, log: (m: string) => logs.push(m)};
    const nonce0 = await n.client.getTransactionCount({address: env.LAUNCH_DEPLOYER as `0x${string}`});
    await expect(launch({...base, confirm: async () => "yes"})).rejects.toThrow(/confirmation did not match/);
    expect(await n.client.getTransactionCount({address: env.LAUNCH_DEPLOYER as `0x${string}`})).toBe(nonce0);
    let shown = "";
    const s = await launch({
      ...base,
      confirm: async (summary, expected) => {
        shown = summary;
        return expected;
      },
    });
    expect(shown).toMatch(/DRY RUN on a local anvil fork/);
    expect(Object.keys(s.steps)).toEqual(expect.arrayContaining(["rehearsal", "broadcast", "verify", "publish"]));
    const table = readFileSync(join(CONTRACTS, "deployments/4663-dry-run.verify-roles.md"), "utf8");
    expect(table).not.toContain("**FAIL**");
    expect(table).toMatch(/VerifyRoles: (\d+)\/\1 pass/);
    const pub = JSON.parse(readFileSync(book, "utf8")).chains["4663"];
    expect(pub.router).toMatch(/^0x/);
    expect(pub.startBlock).toBeGreaterThan(0);
    expect(pub.dnVault.vault).toMatch(/^0x/);
    expect(readFileSync(join(ROOT, "packages/sdk/addresses.json"), "utf8")).toBe(bookBefore);
    expect(existsSync(join(CONTRACTS, "deployments/4663.json"))).toBe(false);
    expect(logs.join("\n")).toMatch(/\[post-launch\] reminders/);
    // Resumable: a second run skips the finished steps and changes nothing.
    await launch({...base, confirm: async () => "never asked"});
  }, 1_800_000);
});
