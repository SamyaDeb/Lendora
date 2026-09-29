import addresses from "../addresses.json" with {type: "json"};

export type Address = `0x${string}`;
export type Hex32 = `0x${string}`;

/** One listed stock (written by contracts/script/StocklineDeploy.sol, LM-R10). */
export interface StockDeployment {
  stockToken: Address;
  feed: Address;
  wrapper: Address;
  oracle: Address;
  /** Morpho Vault V2 `rSTOCK`. */
  vault: Address;
  /** `MorphoMarketV1AdapterV2` of the vault. */
  adapter: Address;
  /** Morpho Blue market id (wSTOCK / clUSDG). */
  marketId: Hex32;
  /** Vault V2 cap id of the market (`keccak256(abi.encode("this/marketParams", adapter, marketParams))`). */
  adapterMarketCapId: Hex32;
  lltv: number | string;
  /** Absolute cap in raw wSTOCK units at listing (decimal string). */
  capAssets: string;
  perAddressCapUsd: number;
  /** G5 receipt market (05 §3, A3): `rSTOCK` collateral, USDG loan, supplied by a Stockline USDG Vault V2. Present once
   * `ListReceiptMarket` ran (stage 1); it lends only after the curator's timelocked listing raised its caps. */
  receipt?: ReceiptMarketDeployment;
}

export interface ReceiptMarketDeployment {
  /** `ReceiptCollateralOracle` (owner = timelock). */
  oracle: Address;
  /** USDG Vault V2 supplying the market (liquidity adapter = the market). */
  usdgVault: Address;
  /** Its `MorphoMarketV1AdapterV2`. */
  usdgAdapter: Address;
  /** Morpho Blue market id (USDG / rSTOCK). */
  marketId: Hex32;
  adapterMarketCapId: Hex32;
  /** 62.5% at launch. */
  lltv: number | string;
}

export interface Roles {
  owner: Address;
  curator: Address;
  guardian: Address;
  allocator: Address;
  guardKeeper: Address;
  /** Treasury multisig: treasury share of the performance fee (Phase 3, Q9). */
  treasury?: Address;
  /** `BackstopReserve` multisig: backstop share until Phase 5 (FE-R3, Q9). */
  backstopReserve?: Address;
  /** Fee-converter keeper EOA (FE-R4): may only trigger conversions. */
  feeKeeper?: Address;
  /** Phase 1–2 placeholder fee recipient (testnet 46630 was deployed with it; the real one is `feeSplitter`). */
  feeSplitter?: Address;
}

export interface ChainDeployment {
  morpho: Address;
  adaptiveCurveIrm: Address;
  usdg: Address;
  usdgFeed: Address;
  timelock: Address;
  marketHours: Address;
  clUSDG: Address;
  vaultV2Factory: Address;
  adapterFactory: Address;
  router?: Address;
  liquidator?: Address;
  routerImplementation?: Address;
  roles: Roles;
  stocks: Record<string, StockDeployment>;
  /** Anvil and testnet: mock feeds, tokens, pools, swap aggregator (and the testnet `faucet`). */
  mocks?: Record<string, Address>;
  forkBlock?: string;
  /** First block to index (the deployment block); the indexer falls back to `forkBlock`, then 0 (anvil). */
  startBlock?: string;
  /** ShortInterestLens (Phase 2, SI-R20). */
  lens?: Address;
  /** FeeSplitter: every vault's performance fee recipient (Phase 3, FE-R1…R3). */
  feeSplitter?: Address;
  /** FeeConverter of the treasury share → USDG → treasury (FE-R4). */
  treasuryConverter?: Address;
  /** FeeConverter of the backstop share → USDG → `BackstopReserve` (FE-R3, FE-R4). */
  backstopConverter?: Address;
  /** Phase 4 delta-neutral vault ("USDG Earn", 08). */
  dnVault?: DnVaultDeployment;
}

export interface DnVaultDeployment {
  vault: Address;
  strategy: Address;
  navOracle: Address;
  /** Zero address on mainnet until a live venue adapter is verified (MN-R7); the mock venue on anvil and testnet. */
  perpAdapter: Address;
}

/** Keys: a chain id ("31337" anvil, "46630" testnet, "4663" mainnet once the launch publishes it) or "fork-4663" (a
 * simulated deployment on a Robinhood Chain fork). Only the mainnet launcher's publish step writes "4663" (MN-R6). */
export type DeploymentKey = number | "fork-4663";

/** Parse `DEPLOYMENT_KEY` / `STOCKLINE_NETWORK` ("31337", "46630", "fork-4663"). */
export function parseDeploymentKey(s: string): DeploymentKey {
  return s === "fork-4663" ? s : Number(s);
}

const book = addresses.chains as unknown as Record<string, ChainDeployment>;

/** Deployment for a key, or undefined if Stockline is not deployed there. */
export function getDeployment(key: DeploymentKey): ChainDeployment | undefined {
  return book[String(key)];
}

/** All keys in the address book. */
export const deploymentKeys: string[] = Object.keys(book);

/** Chain id of a deployment key ("fork-4663" runs on a fork of 4663). */
export function chainIdOf(key: DeploymentKey): number {
  return key === "fork-4663" ? 4663 : key;
}

/** Robinhood Chain mainnet or a fork of it: the real tokens, pools and feeds of `external-addresses.json` apply. */
export function isRobinhoodMainnet(key: DeploymentKey): boolean {
  return key === 4663 || key === "fork-4663";
}

/**
 * MN-R6: the one startup check every service shares. A network is served only if `addresses.json` has a deployment
 * for it, so mainnet (4663) runs once the launcher has published `chains["4663"]` and never before (the Phase 2
 * blanket refusal is gone). Throws with the service name and the key.
 */
export function resolveDeployment(
  raw: string,
  service: string,
  lookup: (key: DeploymentKey) => ChainDeployment | undefined = getDeployment,
): {key: DeploymentKey; chainId: number; d: ChainDeployment} {
  const key = parseDeploymentKey(raw);
  if (typeof key === "number" && (!Number.isInteger(key) || key <= 0)) throw new Error(`${service}: invalid network "${raw}" (a chain id or "fork-4663")`);
  const d = lookup(key);
  if (!d) {
    const hint = key === 4663 ? ": mainnet is served only after the launch publishes it (MN-R6)" : "";
    throw new Error(`${service}: no deployment "${raw}" in @stockline/sdk addresses.json${hint}`);
  }
  return {key, chainId: chainIdOf(key), d};
}
