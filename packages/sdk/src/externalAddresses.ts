import external from "../external-addresses.json" with {type: "json"};
import type {Address} from "./addresses.js";

/** A Chainlink feed as listed by Chainlink and read onchain in Phase 0 (docs/phase0/01-chain-facts.md). */
export interface ChainlinkFeed {
  proxy: Address;
  /** SVR (Smart Value Recapture) proxy, when Chainlink lists one. */
  svrProxy?: Address;
  aggregator?: Address;
  decimals: number;
  heartbeatSec: number;
  deviationPct: number;
  /** Chainlink `marketHours` tag, e.g. `us_equities_24/5` or `Crypto`. */
  marketHours?: string;
}

/** Third-party contracts Lendora depends on, per chain. Never Lendora's own deployments (see `addresses.ts`). */
export interface ExternalChain {
  name: string;
  tokens: {USDG: Address; WETH: Address; syrupUSDG: Address};
  /** Robinhood Stock Tokens that have a Chainlink feed, by ticker. */
  stockTokens: Record<string, Address>;
  stockTokenAdmin: {accessControlsRegistry: Address; implementation: Address};
  /** Feeds by ticker (`SPY`, `USDG`, `ETH`, …). */
  chainlink: Record<string, ChainlinkFeed>;
  morpho: {
    morpho: Address;
    adaptiveCurveIrm: Address;
    chainlinkOracleV2Factory: Address;
    vaultV2Factory: Address;
    morphoMarketV1AdapterV2Factory: Address;
    morphoVaultV1AdapterFactory: Address;
    morphoRegistry: Address;
    publicAllocator: Address;
    bundler3: Address;
    generalAdapter1: Address;
  };
  uniswap: Record<string, Address>;
  uniswapV3Pools: Record<string, Address>;
  /** ERC-4626 USDG vaults usable as `clUSDG` backing (CL-R1). */
  usdgYieldVaults: Record<string, Address>;
  lighter: {lighter: Address};
  chainlinkDataStreamsVerifierProxy: Address;
}

const {$comment: _comment, ...chains} = external;
const book = chains as unknown as Record<string, ExternalChain>;

/** Third-party addresses for a chain id, or undefined if Phase 0 has not verified that chain. */
export function getExternal(chainId: number): ExternalChain | undefined {
  return book[String(chainId)];
}

/** Chain ids with verified third-party addresses. */
export const externalChainIds: number[] = Object.keys(book).map(Number);
