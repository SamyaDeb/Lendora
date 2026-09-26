import addresses from "../addresses.json" with {type: "json"};

export type Address = `0x${string}`;
export type Hex32 = `0x${string}`;

export interface StockDeployment {
  stockToken: Address;
  wrapper: Address;
  oracle: Address;
  vault: Address;
  marketId: Hex32;
  idleMarketId: Hex32;
}

export interface ChainDeployment {
  morpho: Address;
  stocks: Record<string, StockDeployment>;
}

const book = addresses.chains as Record<string, ChainDeployment>;

/** Deployment for a chain id, or undefined if Stockline is not deployed there. */
export function getDeployment(chainId: number): ChainDeployment | undefined {
  return book[String(chainId)];
}
