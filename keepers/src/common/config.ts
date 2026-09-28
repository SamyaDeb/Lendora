import {z} from "zod";
import {resolveDeployment, type ChainDeployment, type DeploymentKey} from "@stockline/sdk";

/** Keeper configuration from the environment. Never contains key material except via `KEEPER_PRIVATE_KEY`, which is
 * read only by the env-key signer and never logged. */
export interface KeeperConfig {
  rpcUrl: string;
  deploymentKey: DeploymentKey;
  deployment: ChainDeployment;
  /** Dry run is the default: plans are logged, nothing is sent (Phase 1 hard rule). */
  dryRun: boolean;
  signer: "dry-run" | "env-key" | "rpc-unlocked" | "remote";
  /** The keeper's address: the rpc-unlocked account (anvil only) or the remote signer's key (`KEEPER_ADDRESS`). */
  unlockedAddress?: `0x${string}`;
  /** Remote transaction signer (KMS/HSM bridge), `KEEPER_SIGNER=remote`. */
  remoteSignerUrl?: string;
  /** Sent as the `authorization` header to the remote signer (secret store). */
  remoteSignerAuth?: string;
  remoteSignerTimeoutMs: number;
  /** OFF-2: no transaction is signed while the node's `maxFeePerGas` estimate is above this (`MAX_FEE_PER_GAS_GWEI`). */
  maxFeePerGasWei: bigint;
  intervalMs: number;
  healthPort: number;
  /** A market not processed for this long makes /health fail (LM-R33: 5 min). */
  maxStaleMs: number;
}

const int = (name: string, min: number, max: number, dflt: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return dflt;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({code: "custom", message: `${name} must be an integer between ${min} and ${max} (got "${v}")`});
        return z.NEVER;
      }
      return n;
    });
const isLocal = (u: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".railway.internal");
const httpUrl = (name: string, httpsUnlessLocal: boolean) =>
  z.string().refine(
    (v) => {
      try {
        const u = new URL(v);
        if (u.protocol === "https:") return true;
        return u.protocol === "http:" && (!httpsUnlessLocal || isLocal(u));
      } catch {
        return false;
      }
    },
    {message: `${name} must be a URL${httpsUnlessLocal ? " (https unless localhost / *.railway.internal)" : ""}`},
  );
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "KEEPER_ADDRESS must be a 0x-prefixed 20-byte address");
const gwei = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const s = v === undefined || v === "" ? "10" : v;
    if (!/^\d+(\.\d{1,9})?$/.test(s) || Number(s) <= 0) {
      ctx.addIssue({code: "custom", message: `MAX_FEE_PER_GAS_GWEI must be a positive decimal (got "${v}")`});
      return z.NEVER;
    }
    const [w, f = ""] = s.split(".");
    return BigInt(w) * 10n ** 9n + BigInt(f.padEnd(9, "0"));
  });

/** OFF-5: every keeper env var is validated at startup with a message naming the var (before: `INTERVAL_MS=abc` became
 * `NaN`, i.e. a hot loop against the RPC). */
const EnvSchema = z.object({
  DEPLOYMENT_KEY: z.string().default("31337"),
  RPC_URL: httpUrl("RPC_URL", false).default("http://127.0.0.1:8545"),
  DRY_RUN: z.enum(["true", "false", ""]).optional(),
  KEEPER_SIGNER: z.enum(["dry-run", "env-key", "rpc-unlocked", "remote"], {message: "unknown KEEPER_SIGNER (dry-run | env-key | rpc-unlocked | remote)"}).default("dry-run"),
  KEEPER_ADDRESS: address.optional(),
  KEEPER_REMOTE_SIGNER_URL: httpUrl("KEEPER_REMOTE_SIGNER_URL", true).optional(),
  KEEPER_REMOTE_SIGNER_AUTH: z.string().optional(),
  REMOTE_SIGNER_TIMEOUT_MS: int("REMOTE_SIGNER_TIMEOUT_MS", 1_000, 120_000, 15_000),
  MAX_FEE_PER_GAS_GWEI: gwei,
  INTERVAL_MS: int("INTERVAL_MS", 1_000, 86_400_000, 30_000),
  HEALTH_PORT: int("HEALTH_PORT", 0, 65_535, 8787),
  MAX_STALE_MS: int("MAX_STALE_MS", 10_000, 86_400_000, 5 * 60_000),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const p = EnvSchema.safeParse(Object.fromEntries(Object.keys(EnvSchema.shape).map((k) => [k, env[k] === "" ? undefined : env[k]])));
  if (!p.success) throw new Error(`keeper config: ${p.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ")}`);
  const e = p.data;
  const key = e.DEPLOYMENT_KEY;
  const {key: deploymentKey, d: deployment} = resolveDeployment(key, "keeper"); // MN-R6: 4663 only once published
  const dryRun = e.DRY_RUN !== "false";
  const signer = e.KEEPER_SIGNER;
  if (!dryRun && signer === "dry-run") throw new Error("DRY_RUN=false needs KEEPER_SIGNER=env-key, remote or rpc-unlocked");
  if (!dryRun && signer === "remote" && (!e.KEEPER_REMOTE_SIGNER_URL || !e.KEEPER_ADDRESS)) {
    throw new Error("KEEPER_SIGNER=remote needs KEEPER_REMOTE_SIGNER_URL and KEEPER_ADDRESS");
  }
  return {
    rpcUrl: e.RPC_URL,
    deploymentKey,
    deployment,
    dryRun,
    signer: dryRun ? "dry-run" : signer,
    unlockedAddress: e.KEEPER_ADDRESS as `0x${string}` | undefined,
    remoteSignerUrl: e.KEEPER_REMOTE_SIGNER_URL,
    remoteSignerAuth: e.KEEPER_REMOTE_SIGNER_AUTH,
    remoteSignerTimeoutMs: e.REMOTE_SIGNER_TIMEOUT_MS,
    maxFeePerGasWei: e.MAX_FEE_PER_GAS_GWEI,
    intervalMs: e.INTERVAL_MS,
    healthPort: e.HEALTH_PORT,
    maxStaleMs: e.MAX_STALE_MS,
  };
}
