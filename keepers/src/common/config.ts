import {getDeployment, type ChainDeployment, type DeploymentKey} from "@stockline/sdk";

/** Keeper configuration from the environment. Never contains key material except via `KEEPER_PRIVATE_KEY`, which is
 * read only by the env-key signer and never logged. */
export interface KeeperConfig {
  rpcUrl: string;
  deploymentKey: DeploymentKey;
  deployment: ChainDeployment;
  /** Dry run is the default: plans are logged, nothing is sent (Phase 1 hard rule). */
  dryRun: boolean;
  signer: "dry-run" | "env-key" | "rpc-unlocked";
  /** Account used by the rpc-unlocked signer (anvil only). */
  unlockedAddress?: `0x${string}`;
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
  if (!dryRun && signer === "dry-run") throw new Error("DRY_RUN=false needs KEEPER_SIGNER=env-key or rpc-unlocked");
  return {
    rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8545",
    deploymentKey,
    deployment,
    dryRun,
    signer: dryRun ? "dry-run" : signer,
    unlockedAddress: env.KEEPER_ADDRESS as `0x${string}` | undefined,
    intervalMs: Number(env.INTERVAL_MS ?? 30_000),
    healthPort: Number(env.HEALTH_PORT ?? 8787),
    maxStaleMs: Number(env.MAX_STALE_MS ?? 5 * 60_000),
  };
}
