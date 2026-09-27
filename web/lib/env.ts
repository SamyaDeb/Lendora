import type {Chain} from "viem";
import {chainFor, getDeployment, type ChainDeployment} from "@stockline/sdk";

/** Public configuration (NEXT_PUBLIC_*, inlined at build time). The app serves exactly one deployment. */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? (CHAIN_ID === 31337 ? "http://127.0.0.1:8545" : undefined);
/** Public short-interest API (07 §2), used for lists and charts (APP-R5). */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:42070";
/** Server-side API URL (inside the platform network), for server components. */
export const API_URL_SERVER = process.env.API_URL_INTERNAL ?? API_URL;
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
/** Playwright on anvil: a mock connector bound to one of anvil's unlocked default accounts (no key in the app). */
export const E2E = process.env.NEXT_PUBLIC_E2E === "1" && CHAIN_ID === 31337;
export const E2E_ACCOUNT = (process.env.NEXT_PUBLIC_E2E_ACCOUNT ?? "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955") as `0x${string}`;

if (CHAIN_ID === 4663) throw new Error("Phase 2 never serves Robinhood Chain mainnet");

export const chain: Chain = chainFor(CHAIN_ID, RPC_URL);

export function deployment(): ChainDeployment {
  const d = getDeployment(CHAIN_ID);
  if (!d) throw new Error(`no deployment for chain ${CHAIN_ID} in @stockline/sdk addresses.json`);
  return d;
}

export const TICKERS = Object.keys(deployment().stocks).sort();
export const explorer = chain.blockExplorers?.default.url;
