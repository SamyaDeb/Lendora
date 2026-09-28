import {getDeployment, type ChainDeployment, type DeploymentKey} from "@stockline/sdk";

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
  intervalMs: number;
  healthPort: number;
  /** A market not processed for this long makes /health fail (LM-R33: 5 min). */
  maxStaleMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const key = (env.DEPLOYMENT_KEY ?? "31337") as string;
  const deploymentKey: DeploymentKey = key === "fork-4663" ? key : Number(key);
  const deployment = getDeployment(deploymentKey);
  if (!deployment) throw new Error(`no deployment for ${key} in @stockline/sdk addresses.json`);
  const dryRun = env.DRY_RUN !== "false";
  const signer = (env.KEEPER_SIGNER ?? "dry-run") as KeeperConfig["signer"];
  if (!["dry-run", "env-key", "rpc-unlocked", "remote"].includes(signer)) throw new Error(`unknown KEEPER_SIGNER ${signer}`);
  if (!dryRun && signer === "dry-run") throw new Error("DRY_RUN=false needs KEEPER_SIGNER=env-key, remote or rpc-unlocked");
  return {
    rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8545",
    deploymentKey,
    deployment,
    dryRun,
    signer: dryRun ? "dry-run" : signer,
    unlockedAddress: env.KEEPER_ADDRESS as `0x${string}` | undefined,
    remoteSignerUrl: env.KEEPER_REMOTE_SIGNER_URL,
    remoteSignerAuth: env.KEEPER_REMOTE_SIGNER_AUTH,
    intervalMs: Number(env.INTERVAL_MS ?? 30_000),
    healthPort: Number(env.HEALTH_PORT ?? 8787),
    maxStaleMs: Number(env.MAX_STALE_MS ?? 5 * 60_000),
  };
}
