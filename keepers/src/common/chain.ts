import {createPublicClient, defineChain, http, type PublicClient} from "viem";
import {anvil} from "viem/chains";
import type {DeploymentKey} from "@stockline/sdk";

/** Robinhood Chain (4663). Keepers only read from it in Phase 1; dry-run is the default. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: ["https://rpc.mainnet.chain.robinhood.com"]}},
});

export function chainFor(key: DeploymentKey) {
  return key === "fork-4663" ? robinhoodChain : anvil;
}

export function publicClient(rpcUrl: string, key: DeploymentKey): PublicClient {
  return createPublicClient({chain: chainFor(key), transport: http(rpcUrl)}) as PublicClient;
}
