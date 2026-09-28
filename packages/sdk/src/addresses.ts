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
