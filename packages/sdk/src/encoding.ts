import {encodeAbiParameters, encodeFunctionData, keccak256, type Hex} from "viem";
import type {Address, ChainDeployment, StockDeployment} from "./addresses.js";
import {mockSwapAggregatorAbi} from "./abis.js";

/**
 * Onchain encodings shared by keepers, the chain driver, the compliance signer and the web app, so every service
 * builds the same bytes: Morpho `MarketParams` and ids, Vault V2 cap ids, the router's EIP-712 attestation (RT-R2,
 * CP-R3) and swap calldata for allowlisted targets (RT-R3).
 */

export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export const marketParamsType = [
  {
    type: "tuple",
    components: [
      {name: "loanToken", type: "address"},
      {name: "collateralToken", type: "address"},
      {name: "oracle", type: "address"},
      {name: "irm", type: "address"},
      {name: "lltv", type: "uint256"},
    ],
  },
] as const;

/** The stock-loan market of a listed stock (loan = wSTOCK, collateral = clUSDG, LM-R10). */
export function marketParamsOf(d: ChainDeployment, s: StockDeployment): MarketParams {
  return {loanToken: s.wrapper, collateralToken: d.clUSDG, oracle: s.oracle, irm: d.adaptiveCurveIrm, lltv: BigInt(s.lltv)};
}

/** `abi.encode(MarketParams)`: the adapter data Vault V2 passes to `allocate` / `deallocate`. */
export function encodeMarketParams(p: MarketParams): Hex {
  return encodeAbiParameters(marketParamsType, [p]);
}

/** Morpho `Id` = `keccak256(abi.encode(marketParams))` (MarketParamsLib). */
export function marketIdOf(p: MarketParams): Hex {
  return keccak256(encodeMarketParams(p));
}

/** The three Vault V2 cap ids of the adapter's market (VaultV2Ids.sol / MorphoMarketV1AdapterV2.ids()). */
export function capIds(adapter: Address, p: MarketParams): [Hex, Hex, Hex] {
  const adapterId = keccak256(encodeAbiParameters([{type: "string"}, {type: "address"}], ["this", adapter]));
  const collateralId = keccak256(
    encodeAbiParameters([{type: "string"}, {type: "address"}], ["collateralToken", p.collateralToken]),
  );
  const marketId = keccak256(
    encodeAbiParameters([{type: "string"}, {type: "address"}, ...marketParamsType], ["this/marketParams", adapter, p]),
  );
  return [adapterId, collateralId, marketId];
}

// ---------------------------------------------------------------------- RT-R2 / CP-R3 attestation

/** EIP-712 type of `LendoraRouter.ATTESTATION_TYPEHASH` = `Attestation(address user,uint256 expiry)`. */
export const attestationTypes = {
  Attestation: [
    {name: "user", type: "address"},
    {name: "expiry", type: "uint256"},
  ],
} as const;

/** The router's EIP-712 domain (`EIP712("StocklineRouter", "1")`, bound to chain and proxy address). */
export function attestationDomain(chainId: number, router: Address) {
  return {name: "StocklineRouter", version: "1", chainId, verifyingContract: router} as const;
}

/** CP-R3: attestations are valid for 24h. */
export const ATTESTATION_TTL_SEC = 24n * 3600n;

// ---------------------------------------------------------------------- RT-R3 swaps

/** `ILendoraRouter.Swap`. */
export interface RouterSwap {
  target: Address;
  data: Hex;
  amountIn: bigint;
  minOut: bigint;
}

/** Exact-in swap through the anvil/testnet `MockSwapAggregator` (router swap mode `Approve`); output to `recipient`
 * (the router). */
export function mockAggregatorSwap(
  aggregator: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  minOut: bigint,
  recipient: Address,
): RouterSwap {
  const data = encodeFunctionData({
    abi: mockSwapAggregatorAbi,
    functionName: "swap",
    args: [tokenIn, tokenOut, amountIn, minOut, recipient],
  });
  return {target: aggregator, data, amountIn, minOut};
}
