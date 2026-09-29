import {readFileSync, statfsSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {getAddress, isAddress, type PublicClient} from "viem";

/** A command runner (injected in tests). Never given secret values in args. */
export type Run = (cmd: string, args: string[], opts?: {cwd?: string; env?: NodeJS.ProcessEnv}) => {status: number; stdout: string; stderr: string};
export const run: Run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {cwd: opts.cwd, env: opts.env ?? process.env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024});
  return {status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? ""};
};

/** One refusal: the launcher stops and prints every problem of the step. */
export class Refusal extends Error {
  constructor(
    readonly step: string,
    readonly problems: string[],
  ) {
    super(`${step}: ${problems.join("; ")}`);
  }
}

// ------------------------------------------------------------------ 1. gates

export interface Gate {
  id: string;
  gate: string;
  signedBy: string | null;
  date: string | null;
  evidence: string | null;
}

/** Every gate of mainnet-launch §0 signed: a person, a date (not in the future), evidence. Returns the problems. */
export function checkGates(file: string, today = new Date()): string[] {
  const j = JSON.parse(readFileSync(file, "utf8")) as {gates?: Gate[]};
  if (!Array.isArray(j.gates) || j.gates.length === 0) return [`${file}: no gates`];
  const out: string[] = [];
  for (const g of j.gates) {
    const missing = (["signedBy", "date", "evidence"] as const).filter((k) => typeof g[k] !== "string" || !g[k]!.trim());
    if (missing.length) {
      out.push(`gate "${g.id}" not signed (missing ${missing.join(", ")})`);
      continue;
    }
    const d = /^\d{4}-\d{2}-\d{2}$/.test(g.date!) ? new Date(`${g.date}T00:00:00Z`) : new Date(NaN);
    if (Number.isNaN(d.getTime())) out.push(`gate "${g.id}": date "${g.date}" is not YYYY-MM-DD`);
    else if (d.getTime() > today.getTime()) out.push(`gate "${g.id}": dated in the future (${g.date})`);
  }
  return out;
}

// ------------------------------------------------------------------ 1. preflight (machine, tools, tree)

export const FOUNDRY_VERSION = "1.5.1";
export const MIN_FREE_BYTES = 5 * 1024 ** 3; // forge's broadcast journal needs room (testnet lesson: > 1 GB)
export const EIP170 = 24_576;

export function checkDisk(path: string, free = () => {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}): string[] {
  const b = free();
  return b < MIN_FREE_BYTES ? [`only ${(b / 1024 ** 3).toFixed(1)} GB free at ${path} (need ≥ 5 GB)`] : [];
}

export function checkTools(r: Run): string[] {
  const out: string[] = [];
  const forge = r("forge", ["--version"]);
  if (forge.status !== 0) out.push("forge not found");
  else if (!forge.stdout.includes(FOUNDRY_VERSION)) out.push(`forge ${forge.stdout.split("\n")[0]} is not ${FOUNDRY_VERSION} (the pinned version)`);
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) out.push(`node ${process.versions.node} < 22`);
  if (r("pnpm", ["--version"]).status !== 0) out.push("pnpm not found");
  return out;
}

/** A clean tree (nothing modified or untracked) on a tagged commit: what is deployed is exactly a release. */
export function checkTree(r: Run, cwd: string): {problems: string[]; commit?: string; tag?: string} {
  const problems: string[] = [];
  const st = r("git", ["status", "--porcelain"], {cwd});
  if (st.status !== 0) return {problems: ["not a git repository"]};
  if (st.stdout.trim()) problems.push(`dirty tree (${st.stdout.trim().split("\n").length} changed or untracked paths): commit or stash first`);
  const commit = r("git", ["rev-parse", "HEAD"], {cwd}).stdout.trim();
  const tag = r("git", ["describe", "--exact-match", "--tags", "HEAD"], {cwd});
  if (tag.status !== 0) problems.push(`HEAD ${commit.slice(0, 10)} has no tag: tag the release commit first`);
  return {problems, commit, tag: tag.status === 0 ? tag.stdout.trim() : undefined};
}

/** `forge build --sizes`: builds, and the router is under EIP-170. */
export function checkBuild(r: Run, contractsDir: string): string[] {
  const b = r("forge", ["build", "--sizes"], {cwd: contractsDir});
  if (b.status !== 0) return [`forge build failed: ${b.stderr.slice(-300)}`];
  const row = b.stdout.split("\n").find((l) => /\|\s*StocklineRouter\s*\|/.test(l));
  if (!row) return ["StocklineRouter missing from forge build --sizes"];
  const size = Number(row.split("|")[2].replace(/[^\d]/g, ""));
  return size > EIP170 ? [`StocklineRouter runtime ${size} B > EIP-170 ${EIP170} B`] : [];
}

// ------------------------------------------------------------------ 2. env

export const CORE_ROLES = ["OWNER", "CURATOR", "GUARDIAN", "ALLOCATOR", "GUARD_KEEPER", "TREASURY", "BACKSTOP_RESERVE", "FEE_KEEPER", "ATTESTATION_SIGNER"] as const;
export const DN_ROLES = ["DN_OPERATOR", "NAV_SIGNER_1", "NAV_SIGNER_2"] as const;
/** MN-R2: the five multisigs, `[role, min threshold, min signers, exact?]` (owner 4-of-7, guardian 2-of-4, others ≥ 2). */
export const SAFES: readonly [string, number, number][] = [
  ["OWNER", 4, 7],
  ["CURATOR", 2, 2],
  ["GUARDIAN", 2, 4],
  ["TREASURY", 2, 2],
  ["BACKSTOP_RESERVE", 2, 2],
];
export const SIGNERS = ["ledger", "trezor", "aws", "gcp"] as const;
export type SignerMode = (typeof SIGNERS)[number] | "unlocked";

export interface Roles {
  [role: string]: `0x${string}`;
}

/** Every `STOCKLINE_*` role present, an address, non-zero, distinct from each other and from the deployer (MN-R1, MN-R8). */
export function checkRoles(env: NodeJS.ProcessEnv): {problems: string[]; roles: Roles; deployer?: `0x${string}`} {
  const problems: string[] = [];
  const roles: Roles = {};
  for (const r of [...CORE_ROLES, ...DN_ROLES]) {
    const v = env[`STOCKLINE_${r}`];
    if (!v) problems.push(`STOCKLINE_${r} is not set`);
    else if (!isAddress(v, {strict: false})) problems.push(`STOCKLINE_${r} is not an address`);
    else if (/^0x0{40}$/i.test(v)) problems.push(`STOCKLINE_${r} is address(0)`);
    else roles[r] = getAddress(v);
  }
  const d = env.LAUNCH_DEPLOYER;
  let deployer: `0x${string}` | undefined;
  if (!d || !isAddress(d, {strict: false})) problems.push("LAUNCH_DEPLOYER (the fresh deployer address) is not set");
  else deployer = getAddress(d);
  const seen = new Map<string, string>();
  for (const [r, a] of Object.entries(roles)) {
    if (seen.has(a)) problems.push(`STOCKLINE_${r} equals STOCKLINE_${seen.get(a)} (every role distinct, MN-R1)`);
    else seen.set(a, r);
    if (deployer && a === deployer) problems.push(`STOCKLINE_${r} is the deployer (MN-R1)`);
  }
  return {problems, roles, deployer};
}

/** Hardware wallet or KMS only; never a private key anywhere in the launcher's environment. `unlocked` = dry run only. */
export function checkSigner(env: NodeJS.ProcessEnv, dryRun: boolean): {problems: string[]; mode?: SignerMode} {
  const problems: string[] = [];
  const keys = Object.keys(env).filter((k) => /PRIVATE_KEY|MNEMONIC/i.test(k) && env[k]);
  if (keys.length) problems.push(`remove ${keys.join(", ")} from the environment: the launch never uses a private key`);
  const mode = env.LAUNCH_SIGNER as SignerMode | undefined;
  if (dryRun) return {problems, mode: "unlocked"};
  if (!mode || !(SIGNERS as readonly string[]).includes(mode)) problems.push(`LAUNCH_SIGNER must be one of ${SIGNERS.join(", ")} (hardware wallet or KMS)`);
  return {problems, mode};
}

/** Real launch: a real 4663 endpoint (not anvil). Dry run: an anvil fork of 4663 on this machine. */
export async function checkChain(client: PublicClient, rpcUrl: string, dryRun: boolean): Promise<string[]> {
  const id = await client.getChainId();
  if (id !== 4663) return [`ROBINHOOD_RPC_URL is chain ${id}, not Robinhood Chain mainnet (4663)`];
  const version = String(await client.request({method: "web3_clientVersion" as never})).toLowerCase();
  const host = new URL(rpcUrl).hostname;
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
  if (dryRun && !(version.includes("anvil") && local)) return [`--dry-run needs a local anvil fork of 4663 (got ${version} at ${host})`];
  if (!dryRun && version.includes("anvil")) return ["ROBINHOOD_RPC_URL is an anvil node: a real launch needs the real 4663 endpoint (use --dry-run for anvil)"];
  return [];
}

const safeAbi = [
  {type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
  {type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{type: "address[]"}]},
] as const;

/** MN-R2 read onchain: each multisig is a contract with at least its threshold and signers (an EOA is refused). */
export async function checkSafes(client: PublicClient, roles: Roles): Promise<string[]> {
  const out: string[] = [];
  for (const [role, minT, minN] of SAFES) {
    const a = roles[role];
    if (!a) continue;
    const code = await client.getCode({address: a});
    if (!code || code === "0x") {
      out.push(`STOCKLINE_${role} ${a} is an EOA: it must be a deployed multisig (MN-R2)`);
      continue;
    }
    try {
      const t = await client.readContract({address: a, abi: safeAbi, functionName: "getThreshold"});
      const n = (await client.readContract({address: a, abi: safeAbi, functionName: "getOwners"})).length;
      if (t < BigInt(minT) || t > BigInt(n)) out.push(`STOCKLINE_${role} threshold ${t} of ${n} (need ≥ ${minT})`);
      if (n < minN) out.push(`STOCKLINE_${role} has ${n} signers (need ≥ ${minN})`);
    } catch {
      out.push(`STOCKLINE_${role} ${a} does not answer getThreshold/getOwners (not a Safe)`);
    }
  }
  return out;
}
