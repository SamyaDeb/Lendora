import {createPublicClient, http, type Chain, type PublicClient} from "viem";
import {chainFor as sdkChainFor, robinhoodChain, type DeploymentKey} from "@stockline/sdk";

/** Robinhood Chain (4663; ~0.1 s blocks, receipts polled every 500 ms). Keepers never send there in Phase 2. */
export {robinhoodChain};

/** The viem chain of a deployment key: anvil (31337), testnet (46630) or a fork of 4663. */
export function chainFor(key: DeploymentKey): Chain {
  return key === "fork-4663" ? robinhoodChain : sdkChainFor(key);
}

export function publicClient(rpcUrl: string, key: DeploymentKey): PublicClient {
  return createPublicClient({chain: chainFor(key), transport: http(rpcUrl)}) as PublicClient;
}
