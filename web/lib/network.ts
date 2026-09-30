import {resolveDeployment, type ChainDeployment, type DeploymentKey} from "@stockline/sdk";

/**
 * MN-R6: what the app may show on the network it serves. Pure functions of the chain id and the published deployment,
 * so the rules are unit-tested without a build. Mainnet (4663) is served only once the launch has published
 * `addresses.json["4663"]`; on it there are never test funds or dev pages.
 */
export function webDeployment(chainId: number, lookup?: (k: DeploymentKey) => ChainDeployment | undefined): ChainDeployment {
  return resolveDeployment(String(chainId), "web", lookup).d;
}

export type FaucetKind = "testnet" | "local" | null;

/** The testnet StocklineFaucet (contracts/testnet): `claim(to)`, once per address per cooldown (`TooSoon`). */
export const faucetAbi = [
  {type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{name: "to", type: "address"}], outputs: []},
  {type: "error", name: "TooSoon", inputs: [{name: "nextClaimAt", type: "uint256"}]},
] as const;

/** Test funds: the testnet faucet contract, anvil's unlocked deployer, or nothing (always nothing on 4663). */
export function faucetKind(chainId: number, d: ChainDeployment, rpcUrl?: string): FaucetKind {
  if (chainId === 4663) return null;
  if (d.mocks?.faucet) return "testnet";
  if (chainId === 31337 && rpcUrl) return "local";
  return null;
}

/** The "Get test funds" hint: local anvil and deployments with a faucet, never mainnet. */
export function isTestChain(chainId: number, d: ChainDeployment): boolean {
  return chainId !== 4663 && (chainId === 31337 || Boolean(d.mocks?.faucet));
}

/** `/dev/*` (component gallery, previews on fixtures): on in development; in production only with
 * `NEXT_PUBLIC_DEV_PAGES=1`, and never on mainnet. */
export function devPagesEnabled(env: {NODE_ENV?: string; NEXT_PUBLIC_DEV_PAGES?: string; NEXT_PUBLIC_CHAIN_ID?: string}): boolean {
  if (Number(env.NEXT_PUBLIC_CHAIN_ID ?? 31337) === 4663) return false;
  return env.NODE_ENV !== "production" || env.NEXT_PUBLIC_DEV_PAGES === "1";
}
