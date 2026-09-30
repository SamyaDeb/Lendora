import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {encodeFunctionData, getAddress, type Hex, type TransactionReceipt} from "viem";
import {
  decodeLendoraCall,
  deltaNeutralVaultAbi,
  saltOf,
  lendoraOracleAbi,
  lendoraRouterAbi,
  timelockAbi,
  timelockOperation,
  vaultCuratorOperation,
  vaultV2FullAbi,
  type ChainDeployment,
} from "@lendora/sdk";
import type {Anvil} from "./anvil.js";

/**
 * Part C step 3: the runbook drills that make sense on a **live** 46630, with no time travel. Immediate drills run at
 * once; timelocked ones are scheduled on one run and executed on a later run once the delay has passed (the runner is
 * idempotent and resumable: re-run it after 24h). State and evidence (tx hashes, times, who ran it) go to a JSON file;
 * the markdown row for `docs/runbooks/README.md` is printed at the end.
 *
 * Drills that would leave the shared testnet in a changed state (multiplier latch, > 2× re-anchor, the P0 delist,
 * sentinel deallocation) stay **fork only** (`test/forkDrills.test.ts`).
 */

export type StepStatus = "done" | "scheduled" | "skipped";
export interface StepRecord {
  status: StepStatus;
  txs: string[];
  /** Unix seconds at which the scheduled half can execute. */
  readyAt?: number;
  note: string;
  at: string;
}
export interface LiveDrillState {
  chainId: number;
  mode: "live" | "fork";
  ranBy: string;
  steps: Record<string, StepRecord>;
}

export interface LiveDrillContext {
  a: Anvil;
  d: ChainDeployment;
  /** Sends from the testnet deployer (holder of every testnet role, A27): the env key live, impersonated on a fork. */
  send(to: `0x${string}`, data: Hex): Promise<TransactionReceipt>;
  now(): Promise<bigint>;
  /** A label unique to this drill round (salts). */
  round: string;
  log(m: string): void;
}

interface Drill {
  id: string;
  runbook: string;
  title: string;
  run(c: LiveDrillContext, prev: StepRecord | undefined): Promise<Omit<StepRecord, "at">>;
}

const call = (abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args});
const hashes = (rs: TransactionReceipt[]) => rs.map((r) => r.transactionHash);
const MANUAL = 1n;

export const LIVE_DRILLS: Drill[] = [
  {
    id: "guard-trip-clear",
    runbook: "guard-tripped.md",
    title: "Guardian trips MANUAL on NVDA, then clears it",
    async run(c, prev) {
      if (prev?.status === "done") return prev;
      const oracle = c.d.stocks.NVDA.oracle;
      const t = await c.send(oracle, call(lendoraOracleAbi, "trip", [MANUAL]));
      const tripped = await c.a.client.readContract({address: oracle, abi: lendoraOracleAbi, functionName: "guardReasons"});
      if ((tripped & MANUAL) !== MANUAL) throw new Error("guard did not latch MANUAL");
      const k = await c.send(oracle, call(lendoraOracleAbi, "clear", [MANUAL]));
      return {status: "done", txs: hashes([t, k]), note: "MANUAL latched and cleared by the guardian"};
    },
  },
  {
    id: "governance-change",
    runbook: "governance-change.md",
    title: "An unexpected schedule is decoded (what the monitor pages) and cancelled by the owner",
    async run(c, prev) {
      if (prev?.status === "done") return prev;
      const cap = await c.a.client.readContract({address: c.d.router!, abi: lendoraRouterAbi, functionName: "globalCap"});
      const delay = await c.a.client.readContract({address: c.d.timelock, abi: timelockAbi, functionName: "getMinDelay"});
      const o = timelockOperation(c.d, {kind: "router.setGlobalCap", cap}, {delay, salt: saltOf(`${c.round} governance-change`)});
      const s = await c.send(c.d.timelock, o.scheduleCalldata);
      const decoded = decodeLendoraCall(c.d, o.target, o.data).summary;
      const x = await c.send(c.d.timelock, o.cancelCalldata);
      return {status: "done", txs: hashes([s, x]), note: `scheduled and decoded as \`${decoded}\`, then cancelled`};
    },
  },
  {
    id: "timelock-two-step",
    runbook: "governance-change.md, calendar-push.md (two-step)",
    title: "Owner timelock end to end: schedule now, execute after the delay (a no-op global cap)",
    async run(c, prev) {
      if (prev?.status === "done") return prev;
      const delay = await c.a.client.readContract({address: c.d.timelock, abi: timelockAbi, functionName: "getMinDelay"});
      const cap = await c.a.client.readContract({address: c.d.router!, abi: lendoraRouterAbi, functionName: "globalCap"});
      const salt = saltOf(`${c.round} timelock-two-step`);
      if (prev?.status !== "scheduled") {
        const o = timelockOperation(c.d, {kind: "router.setGlobalCap", cap}, {delay, salt});
        const s = await c.send(c.d.timelock, o.scheduleCalldata);
        return {status: "scheduled", txs: hashes([s]), readyAt: Number((await c.now()) + delay) + 1, note: `router.setGlobalCap(${cap}) scheduled, delay ${delay} s`};
      }
      if (Number(await c.now()) < prev.readyAt!) return {...prev, note: `${prev.note}; waiting until ${new Date(prev.readyAt! * 1000).toISOString()}`};
      // Same call as scheduled: the cap is read again, and a changed cap means someone else changed it meanwhile.
      const o = timelockOperation(c.d, {kind: "router.setGlobalCap", cap}, {delay, salt});
      const ready = await c.a.client.readContract({address: c.d.timelock, abi: timelockAbi, functionName: "isOperationReady", args: [o.id]});
      if (!ready) throw new Error(`operation ${o.id} is not ready (the global cap changed since the schedule?)`);
      const e = await c.send(c.d.timelock, o.executeCalldata);
      return {status: "done", txs: [...prev.txs, e.transactionHash], note: `executed after the delay (cap unchanged, ${cap})`};
    },
  },
  {
    id: "fees-turn-on",
    runbook: "list-stock.md (fees), FE-R1",
    title: "10% performance fee to the FeeSplitter in every vault, through the vault curator timelock",
    async run(c, prev) {
      if (prev?.status === "done") return prev;
      const splitter = c.d.feeSplitter;
      if (!splitter) return {status: "skipped", txs: [], note: "no feeSplitter in addresses.json: run DeployTestnetFees with TESTNET_GO=yes first"};
      const E17 = 10n ** 17n;
      const want = Object.keys(c.d.stocks).flatMap((ticker) => [
        {kind: "vault.setPerformanceFeeRecipient" as const, ticker, recipient: splitter},
        {kind: "vault.setPerformanceFee" as const, ticker, feeWad: E17},
      ]);
      const vaultOf = (t: string) => c.d.stocks[t].vault;
      const isSet = async (x: (typeof want)[number]) =>
        x.kind === "vault.setPerformanceFee"
          ? (await c.a.client.readContract({address: vaultOf(x.ticker), abi: vaultV2FullAbi, functionName: "performanceFee"})) === x.feeWad
          : getAddress(await c.a.client.readContract({address: vaultOf(x.ticker), abi: vaultV2FullAbi, functionName: "performanceFeeRecipient"})) === getAddress(splitter);
      if (prev?.status !== "scheduled") {
        const rs: TransactionReceipt[] = [];
        let readyAt = 0;
        for (const x of want) {
          if (await isSet(x)) continue;
          const o = vaultCuratorOperation(c.d, x);
          const at = await c.a.client.readContract({address: vaultOf(x.ticker), abi: vaultV2FullAbi, functionName: "executableAt", args: [o.data]});
          if (at === 0n) rs.push(await c.send(vaultOf(x.ticker), o.submitCalldata));
          const eta = await c.a.client.readContract({address: vaultOf(x.ticker), abi: vaultV2FullAbi, functionName: "executableAt", args: [o.data]});
          readyAt = Math.max(readyAt, Number(eta));
        }
        if (readyAt === 0) return {status: "done", txs: [], note: "already on (recipient = FeeSplitter, fee = 10%) in every vault"};
        return {status: "scheduled", txs: hashes(rs), readyAt: readyAt + 1, note: `${rs.length} curator submits`};
      }
      if (Number(await c.now()) < prev.readyAt!) return {...prev, note: `${prev.note}; waiting until ${new Date(prev.readyAt! * 1000).toISOString()}`};
      const rs: TransactionReceipt[] = [];
      for (const x of want) if (!(await isSet(x))) rs.push(await c.send(vaultOf(x.ticker), vaultCuratorOperation(c.d, x).data)); // recipient before fee
      for (const x of want) if (!(await isSet(x))) throw new Error(`${x.kind} ${x.ticker} not applied`);
      return {status: "done", txs: [...prev.txs, ...hashes(rs)], note: `on in ${Object.keys(c.d.stocks).length} vaults after the curator timelock`};
    },
  },
  {
    id: "dn-caps-zero",
    runbook: "dn-*.md, Q11",
    title: "USDG Earn deployed with every cap at 0: a deposit is refused",
    async run(c) {
      const dn = c.d.dnVault;
      if (!dn) return {status: "skipped", txs: [], note: "no dnVault in addresses.json: run DeployTestnetVault with TESTNET_GO=yes first"};
      const cap = await c.a.client.readContract({address: dn.vault, abi: deltaNeutralVaultAbi, functionName: "totalCap"});
      const max = await c.a.client.readContract({address: dn.vault, abi: deltaNeutralVaultAbi, functionName: "maxDeposit", args: [c.d.roles.owner as `0x${string}`]});
      if (cap !== 0n || max !== 0n) return {status: "done", txs: [], note: `total cap ${cap} (> 0: the owner raised it)`};
      return {status: "done", txs: [], note: "total cap 0, maxDeposit 0 (Q11)"};
    },
  },
];

export const FORK_ONLY_DRILLS = [
  "multiplier-change.md (would leave SPY latched on the shared testnet)",
  "oracle-stale-or-rejected.md A13 re-anchor (needs a > 2× feed move)",
  "wrapper-backing-shortfall.md P0 delist (irreversible on a live chain)",
  "keeper-down.md sentinel deallocation (moves shared liquidity)",
];

/** One pass over every live drill; returns the updated state (also written to `statePath`). */
export async function runLiveDrills(c: LiveDrillContext, statePath: string, init: Omit<LiveDrillState, "steps">): Promise<LiveDrillState> {
  const state: LiveDrillState = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as LiveDrillState) : {...init, steps: {}};
  if (state.chainId !== init.chainId || state.mode !== init.mode) throw new Error(`state file ${statePath} is for chain ${state.chainId} (${state.mode}), not ${init.chainId} (${init.mode})`);
  for (const drill of LIVE_DRILLS) {
    const prev = state.steps[drill.id];
    try {
      const r = await drill.run(c, prev);
      state.steps[drill.id] = {...r, at: r === prev ? prev.at : new Date(Number(await c.now()) * 1000).toISOString()};
      c.log(`${drill.id}: ${r.status} · ${r.note}`);
    } catch (e) {
      c.log(`${drill.id}: FAILED · ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
      throw e;
    }
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
  return state;
}

/** The evidence row for docs/runbooks/README.md. */
export function drillsMarkdown(s: LiveDrillState): string {
  const rows = LIVE_DRILLS.map((d) => {
    const r = s.steps[d.id];
    return `| ${d.title} | ${d.runbook} | ${r?.status ?? "not run"} · ${r?.note ?? ""} | ${r?.at?.slice(0, 16) ?? "–"} | ${(r?.txs ?? []).map((h) => `\`${h}\``).join(" ") || "–"} |`;
  });
  return [`Chain ${s.chainId} (${s.mode === "live" ? "LIVE" : "anvil fork rehearsal"}), ran by ${s.ranBy}.`, "", "| Drill | Runbook | Result | When (UTC) | Txs |", "|---|---|---|---|---|", ...rows, "", `Fork only: ${FORK_ONLY_DRILLS.join("; ")}.`].join("\n");
}

/**
 * Opens a drill context, or refuses: never 4663; 46630 only; live sends need `TESTNET_GO=yes`, the deployer key in
 * `TESTNET_DEPLOYER_KEY` (env only, never a file in the repo) matching the book's owner role, and `DRILL_RAN_BY`;
 * `unlocked` (the fork rehearsal) only on an anvil node.
 */
export async function openLiveDrills(o: {rpc: string; unlocked: boolean; env: NodeJS.ProcessEnv; log?: (m: string) => void}): Promise<{ctx: LiveDrillContext; init: Omit<LiveDrillState, "steps">}> {
  const {createPublicClient, http} = await import("viem");
  const probe = createPublicClient({transport: http(o.rpc)});
  const chainId = await probe.getChainId();
  if (chainId === 4663) throw new Error("refusing Robinhood Chain mainnet (4663): live drills are for testnet only");
  if (chainId !== 46630) throw new Error(`live drills are for Robinhood Chain testnet (46630), got chain ${chainId}`);
  const client = String(await probe.request({method: "web3_clientVersion" as never})).toLowerCase();
  const {connectAnvil, connectWallet} = await import("./anvil.js");
  let a: Anvil;
  let from: `0x${string}`;
  if (o.unlocked) {
    if (!client.includes("anvil")) throw new Error("--unlocked is for an anvil fork of 46630 (impersonation); the live testnet needs TESTNET_GO=yes and the key");
    a = await connectAnvil(o.rpc);
    from = a.d.roles.owner as `0x${string}`;
  } else {
    if (o.env.TESTNET_GO !== "yes") throw new Error("TESTNET_GO=yes is required to send on testnet (the owner's go)");
    const key = o.env.TESTNET_DEPLOYER_KEY as Hex | undefined;
    if (!key) throw new Error("TESTNET_DEPLOYER_KEY (env) is required");
    if (!o.env.DRILL_RAN_BY) throw new Error("DRILL_RAN_BY (who runs the drills, for the evidence row) is required");
    a = await connectWallet(o.rpc, key);
    from = (a.wallet.account!.address as `0x${string}`);
    if (getAddress(from) !== getAddress(a.d.roles.owner)) throw new Error(`the key's address ${from} is not the testnet deployer ${a.d.roles.owner} (A27: it holds every testnet role)`);
  }
  const now = async () => (await a.client.getBlock()).timestamp;
  const round = `live drills ${o.env.DRILL_ROUND ?? new Date().toISOString().slice(0, 10)}`;
  return {
    ctx: {a, d: a.d, send: (to, data) => a.send(from, to, data), now, round, log: o.log ?? ((m) => console.log(`[live-drills] ${m}`))},
    init: {chainId, mode: o.unlocked ? "fork" : "live", ranBy: o.env.DRILL_RAN_BY ?? "engineering (fork rehearsal)"},
  };
}
