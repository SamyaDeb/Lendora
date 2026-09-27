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
}

export interface Roles {
  owner: Address;
  curator: Address;
  guardian: Address;
  allocator: Address;
  guardKeeper: Address;
  feeSplitter: Address;
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
  /** Anvil only: mock feeds, tokens and pools keepers and tests can drive. */
  mocks?: Record<string, Address>;
  forkBlock?: string;
  /** First block to index (the deployment block); the indexer falls back to `forkBlock`, then 0 (anvil). */
  startBlock?: string;
  /** ShortInterestLens (Phase 2, SI-R20). */
  lens?: Address;
  /** Testnet only: faucet for mock Stock Tokens and USDG. */
  faucet?: Address;
}

/** Keys: a chain id ("31337" anvil) or "fork-4663" (a simulated deployment on a Robinhood Chain fork). Real 4663 is
 * never written in Phase 1. */
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
