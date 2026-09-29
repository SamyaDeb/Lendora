import {keccak256, toBytes, type Hex} from "viem";
import type {Address} from "./addresses.js";

/**
 * Phase 4 delta-neutral vault (08) helpers shared by the NAV reporter, its co-signer, the rebalancer, the API and the
 * app. The contracts are the source of truth; these mirror their constants and encodings.
 */

/** Venue market id of a sleeve on the mock venue (`DnVaultDeploy._perpMarket`). */
export const perpMarketId = (ticker: string): Hex => keccak256(toBytes(ticker));

/** `NavOracle` EIP-712 domain. */
export const navReportDomain = (chainId: number, navOracle: Address) => ({name: "Stockline NavOracle", version: "1", chainId, verifyingContract: navOracle}) as const;

/** `NavOracle.REPORT_TYPEHASH` layout (DN-R4, DN-R14). */
export const NAV_REPORT_TYPES = {
  Report: [
    {name: "equity", type: "uint256"},
    {name: "deposited", type: "uint256"},
    {name: "requested", type: "uint256"},
    {name: "tradeNonce", type: "uint64"},
    {name: "timestamp", type: "uint64"},
    {name: "shortSizes", type: "uint256[]"},
  ],
} as const;

export interface NavReport {
  equity: bigint;
  deposited: bigint;
  requested: bigint;
  tradeNonce: bigint;
  timestamp: bigint;
  shortSizes: bigint[];
}

/** DN-R4: moves of the perp side above this (bps of NAV) need a second signer. */
export const NAV_SECOND_SIGNER_BPS = 100n;
/** DN-R9 performance fee (WAD). */
export const DN_PERFORMANCE_FEE_WAD = 10n ** 17n;
/** DN-R1: minimum queue time before the next-open rule, seconds. */
export const DN_QUEUE_MIN_S = 72 * 3600;

/** The typed data a NAV signer signs for `r`. */
export function navReportTypedData(chainId: number, navOracle: Address, r: NavReport) {
  return {domain: navReportDomain(chainId, navOracle), types: NAV_REPORT_TYPES, primaryType: "Report" as const, message: r};
}

/** Move of the perp side between the oracle's marked estimate and a new report, bps of NAV (DN-R4). */
export function navMoveBps(estimatePerp: bigint, nextPerp: bigint, navEstimate: bigint): bigint {
  const diff = nextPerp > estimatePerp ? nextPerp - estimatePerp : estimatePerp - nextPerp;
  if (navEstimate === 0n) return diff === 0n ? 0n : 10_000n;
  return (diff * 10_000n) / navEstimate;
}
