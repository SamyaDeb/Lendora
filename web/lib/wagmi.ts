"use client";
import {createConfig, http} from "wagmi";
import {coinbaseWallet, injected, mock, walletConnect} from "wagmi/connectors";
import {chain, E2E, E2E_ACCOUNT, RPC_URL, WALLETCONNECT_PROJECT_ID} from "./env";

/**
 * APP-R1: injected wallets, WalletConnect (needs a project id) and Coinbase Wallet, on Robinhood Chain only (or anvil
 * locally). Reads are batched into one JSON-RPC request per tick (APP-R5; the chain's Multicall3 is not assumed).
 */
const connectors = E2E
  ? [mock({accounts: [E2E_ACCOUNT], features: {reconnect: true}})]
  : [
      injected({shimDisconnect: true}),
      ...(WALLETCONNECT_PROJECT_ID ? [walletConnect({projectId: WALLETCONNECT_PROJECT_ID, showQrModal: true, metadata: {name: "Lendora", description: "Stock lending on Robinhood Chain", url: "https://lendora.xyz", icons: []}})] : []),
      coinbaseWallet({appName: "Lendora"}),
    ];

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors,
  transports: {[chain.id]: http(RPC_URL, {batch: {wait: 16}})},
  pollingInterval: 1000,
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
