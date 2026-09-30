import {defineChain} from "viem";
import {anvil} from "viem/chains";

/** Chains Lendora runs on (01-chain-facts §1). The app offers only the chain of its deployment (APP-R1). */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: ["https://rpc.mainnet.chain.robinhood.com"]}},
  blockExplorers: {default: {name: "Blockscout", url: "https://robinhoodchain.blockscout.com"}},
  blockTime: 100,
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: ["https://rpc.testnet.chain.robinhood.com"]}},
  blockExplorers: {default: {name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com"}},
  blockTime: 100,
  testnet: true,
});

export const localChain = {...anvil, name: "Lendora local (anvil)"} as const;

/** The viem chain for a deployment's chain id, with an optional RPC override. */
export function chainFor(chainId: number, rpcUrl?: string) {
  const base = chainId === 4663 ? robinhoodChain : chainId === 46630 ? robinhoodTestnet : localChain;
  return rpcUrl ? {...base, rpcUrls: {default: {http: [rpcUrl]}}} : base;
}
