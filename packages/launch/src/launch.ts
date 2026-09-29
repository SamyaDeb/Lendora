import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {createPublicClient, erc20Abi, formatEther, http, type PublicClient} from "viem";
import {getExternal} from "@stockline/sdk";
import {checkBuild, checkChain, checkDisk, checkGates, checkRoles, checkSafes, checkSigner, checkTools, checkTree, Refusal, type Run, type SignerMode} from "./checks.js";
import {publishDeployment} from "./publish.js";
import {applyPlan, describePlan, parseServiceEnv, planProblems} from "./services.js";

export const LAUNCH_STOCKS = ["SPY", "NVDA", "AAPL"] as const;
const SEED2 = 2n * 10n ** 12n; // 2 × SEED raw units per launch stock (MainnetConfig)
const MIN_GAS_WEI = 10n ** 16n; // 0.01 ETH

export interface LaunchOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  /** Local anvil fork of 4663 only: `DeployMainnetDryRun`, a temp address book, nothing sent anywhere else. */
  dryRun: boolean;
  /** Apply the services' env through Railway (only if logged in; never in a dry run). */
  apply: boolean;
  /** Dry run only: skip the full offline suite / the fork suites (they run in CI and in `forge test` separately). */
  skipSuite?: boolean;
  skipForkSuites?: boolean;
  gatesFile?: string;
  servicesEnv?: string;
  /** Dry run: the address book to publish into (a copy); real: packages/sdk/addresses.json. */
  bookPath?: string;
  run: Run;
  /** Shows the summary, returns what the operator typed. */
  confirm: (summary: string, expected: string) => Promise<string>;
  log: (m: string) => void;
  fetchImpl?: typeof fetch;
}

interface State {
  mode: "live" | "dry-run";
  steps: Record<string, string>;
  forkBlock?: string;
}

/**
 * The one supported mainnet launch path (mainnet-launch.md §3, Part D): 1 gates + preflight, 2 env + Safes, 3 fork
 * rehearsal, 4 broadcast after a typed confirmation, 5 VerifyRoles + explorer, 6 publish addresses.json["4663"],
 * 7 services + read-only smoke, 8 post-launch reminders. Idempotent and resumable: a finished step is recorded in
 * `contracts/deployments/<out>.launch.json` and skipped on the next run; checks (1–2) always re-run.
 */
export async function launch(o: LaunchOptions): Promise<State> {
  const contracts = join(o.root, "contracts");
  const out = o.dryRun ? "4663-dry-run" : "4663";
  const statePath = join(contracts, "deployments", `${out}.launch.json`);
  mkdirSync(join(contracts, "deployments"), {recursive: true});
  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {mode: o.dryRun ? "dry-run" : "live", steps: {}};
  const done = (step: string) => {
    state.steps[step] = new Date().toISOString();
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  };
  const refuseOrWarn = (step: string, problems: string[], warnInDryRun = false) => {
    if (!problems.length) return;
    if (o.dryRun && warnInDryRun) {
      for (const p of problems) o.log(`[${step}] WARN (dry run): ${p}`);
      return;
    }
    throw new Refusal(step, problems);
  };
  if ((o.skipSuite || o.skipForkSuites) && !o.dryRun) throw new Refusal("options", ["--skip-suite / --skip-fork-suites are for --dry-run only"]);
  if (o.apply && o.dryRun) throw new Refusal("options", ["--apply is never used with --dry-run"]);

  // ---- 0. the go: the operator sets it after the owner's written go (the launcher never does); the dry run refuses it.
  const go = o.env.I_HAVE_THE_OWNERS_GO;
  if (!o.dryRun && go !== "1") throw new Refusal("go", ["I_HAVE_THE_OWNERS_GO=1 is not set: 4663 needs the owner's written go in the launch log (MN-R4)"]);
  if (o.dryRun && go) throw new Refusal("go", ["unset I_HAVE_THE_OWNERS_GO for a dry run"]);

  // ---- 1. gates and preflight
  refuseOrWarn("gates", checkGates(o.gatesFile ?? join(o.root, "docs/owner-actions/launch-gates.json")), true);
  const tree = checkTree(o.run, o.root);
  refuseOrWarn("preflight", [...checkDisk(o.root), ...checkTools(o.run)]);
  refuseOrWarn("preflight", tree.problems, true);
  refuseOrWarn("preflight", checkBuild(o.run, contracts));
  if (!o.skipSuite && !state.steps.suite) {
    o.log("[preflight] full offline suite: forge test, pnpm -r test (long)");
    const f = o.run("forge", ["test"], {cwd: contracts, env: {...o.env, ROBINHOOD_RPC_URL: ""}});
    if (f.status !== 0) throw new Refusal("preflight", [`forge test failed: ${f.stdout.split("\n").filter((l) => /FAIL|failed/.test(l)).slice(0, 5).join(" | ")}`]);
    const p = o.run("pnpm", ["-r", "test"], {cwd: o.root});
    if (p.status !== 0) throw new Refusal("preflight", ["pnpm -r test failed"]);
    done("suite");
  }
  o.log(`[preflight] ok: tree ${tree.commit?.slice(0, 10)}${tree.tag ? ` (${tree.tag})` : ""}`);

  // ---- 2. env, chain, signer, Safes, deployer funds, service secrets (names only)
  const {problems: roleProblems, roles, deployer} = checkRoles(o.env);
  const signer = checkSigner(o.env, o.dryRun);
  const rpcUrl = o.env.ROBINHOOD_RPC_URL;
  refuseOrWarn("env", [...roleProblems, ...signer.problems, ...(rpcUrl ? [] : ["ROBINHOOD_RPC_URL is not set"])]);
  const client = createPublicClient({transport: http(rpcUrl!)}) as PublicClient;
  refuseOrWarn("env", await checkChain(client, rpcUrl!, o.dryRun));
  refuseOrWarn("env", await checkSafes(client, roles));
  if (!state.steps.broadcast) refuseOrWarn("env", await checkDeployerFunds(client, deployer!));
  const plan = parseServiceEnv(o.servicesEnv ?? join(o.root, "infra/mainnet.env.example"));
  const secretProblems = planProblems(plan, o.env);
  if (o.apply) refuseOrWarn("env", secretProblems);
  else if (secretProblems.length) o.log(`[env] services not applied by this run; still to provide: ${secretProblems.length} item(s) (see step 7)`);
  o.log(`[env] ok: chain 4663${o.dryRun ? " (local anvil fork)" : ""}, ${Object.keys(roles).length} roles distinct, Safes MN-R2, signer ${signer.mode}, deployer ${deployer}`);

  // ---- 3. fork rehearsal at latest
  if (!state.steps.rehearsal) {
    if (o.skipForkSuites) o.log("[rehearsal] SKIPPED (--skip-fork-suites, dry run)");
    else {
      state.forkBlock = String(await client.getBlockNumber());
      for (const args of [["--match-contract", "DeployMainnetForkTest"], ["--match-path", "test/fork/phase1/*"], ["--match-path", "test/fork/phase3/*"], ["--match-path", "test/fork/phase4/*"]]) {
        o.log(`[rehearsal] forge test ${args.join(" ")} at block ${state.forkBlock}`);
        const r = o.run("forge", ["test", ...args], {cwd: contracts, env: {...o.env, ROBINHOOD_RPC_URL: rpcUrl}});
        if (r.status !== 0 || /skipped: pending RPC/.test(r.stdout)) throw new Refusal("rehearsal", [`forge test ${args.join(" ")} failed or skipped`]);
      }
    }
    done("rehearsal");
  }

  // ---- 4. broadcast after the typed confirmation
  const deployment = join(contracts, "deployments", `${out}.json`);
  if (!state.steps.broadcast) {
    const expected = `DEPLOY 4663 ${deployer!.slice(-6).toLowerCase()}`;
    const summary = [
      `Chain 4663 (Robinhood Chain mainnet)${o.dryRun ? " — DRY RUN on a local anvil fork" : ""}`,
      `Deployer ${deployer} (signer: ${signer.mode})`,
      ...Object.entries(roles).map(([r, a]) => `  STOCKLINE_${r.padEnd(19)} ${a}`),
      "Caps: 25% of the D8 targets (SPY $250k, NVDA $250k, AAPL $62.5k), global clUSDG cap $4M, DN vault caps 0 (MN-R3, MN-R7)",
      `Type "${expected}" to broadcast.`,
    ].join("\n");
    const typed = (await o.confirm(summary, expected)).trim();
    if (typed !== expected) throw new Refusal("broadcast", [`confirmation did not match ("${typed}" ≠ "${expected}"); nothing was sent`]);
    const resume = existsSync(join(contracts, "broadcast", o.dryRun ? "DeployMainnetDryRun.s.sol" : "DeployMainnet.s.sol", "4663", "run-latest.json")) && state.steps["broadcast-started"];
    state.steps["broadcast-started"] = new Date().toISOString();
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const args = o.dryRun
      ? ["script", "script/DeployMainnetDryRun.s.sol", "--sig", "runDryRun()", "--rpc-url", rpcUrl!, "--broadcast", "--slow", "--unlocked", "--sender", deployer!]
      : ["script", "script/DeployMainnet.s.sol", "--rpc-url", rpcUrl!, "--broadcast", "--slow", "--gas-estimate-multiplier", "200", "--verify", "--verifier", "blockscout", "--verifier-url", "https://robinhoodchain.blockscout.com/api/", "--sender", deployer!, signerFlag(signer.mode!)];
    if (resume) args.push("--resume");
    const env = o.dryRun ? {...o.env, LAUNCH_DRY_RUN: "1", LAUNCH_OUT: out, I_HAVE_THE_OWNERS_GO: ""} : o.env;
    // Dry run: the (already checked) local anvil signs as the deployer.
    if (o.dryRun) await client.request({method: "anvil_impersonateAccount" as never, params: [deployer] as never});
    o.log(`[broadcast] forge ${args.filter((a) => a !== rpcUrl).join(" ")}`);
    const r = o.run("forge", args, {cwd: contracts, env});
    if (r.status !== 0 || !existsSync(deployment)) throw new Refusal("broadcast", [`forge script failed (exit ${r.status}): ${r.stderr.slice(-400) || r.stdout.slice(-400)}; re-run the launcher to resume`]);
    done("broadcast");
  }

  // ---- 5. verify: VerifyRoles (every row PASS), explorer
  if (!state.steps.verify) {
    const v = o.run("forge", ["script", "script/VerifyRoles.s.sol", "--rpc-url", rpcUrl!], {cwd: contracts, env: {...o.env, STOCKLINE_DEPLOYMENT_JSON: `deployments/${out}.json`, STOCKLINE_DEPLOYER: deployer!}});
    const table = v.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|") || /^VerifyRoles: \d+\/\d+ pass/.test(l));
    writeFileSync(join(contracts, "deployments", `${out}.verify-roles.md`), `${table.join("\n")}\n`);
    if (v.status !== 0 || table.some((l) => l.includes("**FAIL**"))) throw new Refusal("verify", [`VerifyRoles failed: ${table.filter((l) => l.includes("FAIL")).slice(0, 5).join(" ")} (table in deployments/${out}.verify-roles.md)`]);
    o.log(`[verify] ${table.at(-1)?.trim()}`);
    if (!o.dryRun) {
      const unverified = await explorerUnverified(JSON.parse(readFileSync(deployment, "utf8")), o.fetchImpl ?? fetch);
      if (unverified.length) throw new Refusal("verify", [`not verified on the explorer yet: ${unverified.join(", ")} (re-run forge verify-contract, then the launcher)`]);
    } else o.log("[verify] explorer check skipped (dry run: nothing is on the explorer)");
    done("verify");
  }

  // ---- 6. publish addresses.json["4663"], ABIs, OpenAPI
  const book = o.bookPath ?? join(o.root, "packages/sdk/addresses.json");
  const pub = publishDeployment({deploymentsDir: join(contracts, "deployments"), name: out, bookPath: book});
  if (pub.problems.length) throw new Refusal("publish", pub.problems);
  o.log(`[publish] ${pub.changed ? "wrote" : "unchanged:"} ${book} chains["4663"]`);
  if (!o.dryRun && !state.steps.publish) {
    for (const [cmd, args, cwd] of [["node", ["packages/sdk/scripts/export-abis.mjs"], o.root], ["pnpm", ["--filter", "@stockline/sdk", "build"], o.root], ["pnpm", ["--filter", "@stockline/api", "openapi"], o.root]] as const) {
      const r = o.run(cmd, [...args], {cwd});
      if (r.status !== 0) throw new Refusal("publish", [`${cmd} ${args.join(" ")} failed`]);
    }
    o.log(`[publish] now commit: git add packages/sdk/addresses.json contracts/deployments/4663.json packages/sdk/abis packages/sdk/src/abis.ts api/openapi.json packages/sdk/src/api/schema.ts && git commit -m "launch: publish 4663" && git tag mainnet-v1`);
  }
  done("publish");

  // ---- 7. services (monitor first) and the read-only smoke
  o.log(`[services] mainnet env, monitor first:\n${describePlan(plan)}`);
  if (o.apply) {
    const p = applyPlan(plan, o.env, o.run, o.log);
    if (p.length) throw new Refusal("services", p);
    done("services");
  } else if (secretProblems.length) o.log(`[services] to fill before --apply: ${secretProblems.join("; ")}`);
  const smoke = await readOnlySmoke(o.env, o.fetchImpl ?? fetch);
  for (const l of smoke) o.log(`[smoke] ${l}`);

  // ---- 8. post-launch
  o.log(
    [
      "[post-launch] reminders:",
      "  - announce 48h ahead (caps, geo restrictions, risks; comms templates in docs/runbooks/README.md)",
      "  - list the markets at 25% of the target caps; start the allocator; raise caps only through list-stock.md §3",
      "  - first-weekend watch (testnet.md §3 checklist, on-call staffed Friday 16:00 ET → Monday open)",
      "  - bug bounty listing live with the deployed addresses",
      "  - DN vault stays at caps 0 until the sim gate, the venue [VERIFY] items and the risk owner's sign-off",
    ].join("\n"),
  );
  return state;
}

function signerFlag(m: SignerMode): string {
  return {ledger: "--ledger", trezor: "--trezor", aws: "--aws", gcp: "--gcp", unlocked: "--unlocked"}[m];
}

async function checkDeployerFunds(client: PublicClient, deployer: `0x${string}`): Promise<string[]> {
  const out: string[] = [];
  const eth = await client.getBalance({address: deployer});
  if (eth < MIN_GAS_WEI) out.push(`deployer has ${formatEther(eth)} ETH (need ≥ 0.01 for gas)`);
  const ext = getExternal(4663)!;
  for (const t of LAUNCH_STOCKS) {
    const token = (ext.stockTokens as Record<string, `0x${string}`>)[t];
    const b = await client.readContract({address: token, abi: erc20Abi, functionName: "balanceOf", args: [deployer]});
    if (b < SEED2) out.push(`deployer holds ${b} raw ${t} (need ${SEED2}: 2 × SEED)`);
  }
  return out;
}

async function explorerUnverified(d: Record<string, unknown>, f: typeof fetch): Promise<string[]> {
  const targets = ["router", "routerImplementation", "timelock", "marketHours", "clUSDG", "liquidator", "feeSplitter", "treasuryConverter", "backstopConverter"].map((k) => [k, d[k] as string] as const).filter(([, a]) => a);
  const out: string[] = [];
  for (const [k, a] of targets) {
    const r = await f(`https://robinhoodchain.blockscout.com/api/v2/smart-contracts/${a}`).catch(() => undefined);
    const j = r?.ok ? ((await r.json()) as {is_verified?: boolean}) : undefined;
    if (!j?.is_verified) out.push(k);
  }
  return out;
}

/** Read-only: every service's health, the API status, compliance with a real sanctions provider. URLs from env. */
async function readOnlySmoke(env: NodeJS.ProcessEnv, f: typeof fetch): Promise<string[]> {
  const urls: [string, string | undefined][] = [
    ["monitor /health", env.MAINNET_MONITOR_URL && `${env.MAINNET_MONITOR_URL}/health`],
    ["API /v1/status", env.MAINNET_API_URL && `${env.MAINNET_API_URL}/v1/status`],
    ["compliance /health", env.MAINNET_COMPLIANCE_URL && `${env.MAINNET_COMPLIANCE_URL}/health`],
    ["web /", env.MAINNET_WEB_URL],
  ];
  const out: string[] = [];
  for (const [name, url] of urls) {
    if (!url) {
      out.push(`${name}: pending (no URL in env; services start after the publish commit)`);
      continue;
    }
    try {
      const r = await f(url, {signal: AbortSignal.timeout(15_000)});
      let extra = "";
      if (name.startsWith("compliance") && r.ok) {
        const j = (await r.json()) as {sanctions?: string};
        if (!j.sanctions || /deny|static|none|mock/i.test(j.sanctions)) extra = ` — NOT a real sanctions provider (${j.sanctions}): CP-R8 gate`;
        else extra = ` (sanctions ${j.sanctions})`;
      }
      out.push(`${name}: ${r.status}${extra}`);
    } catch (e) {
      out.push(`${name}: unreachable (${String(e).split("\n")[0].slice(0, 80)})`);
    }
  }
  return out;
}
