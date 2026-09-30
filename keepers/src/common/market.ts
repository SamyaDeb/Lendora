import {encodeAbiParameters, keccak256, type Hex} from "viem";
import type {ChainDeployment, StockDeployment} from "@lendora/sdk";

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

export interface MarketParams {
  loanToken: `0x${string}`;
  collateralToken: `0x${string}`;
  oracle: `0x${string}`;
  irm: `0x${string}`;
  lltv: bigint;
}

export function marketParams(d: ChainDeployment, s: StockDeployment): MarketParams {
  return {loanToken: s.wrapper, collateralToken: d.clUSDG, oracle: s.oracle, irm: d.adaptiveCurveIrm, lltv: BigInt(s.lltv)};
}

/** `abi.encode(MarketParams)`: the adapter data Vault V2 passes to `allocate` / `deallocate`. */
export function encodeMarketParams(p: MarketParams): Hex {
  return encodeAbiParameters(marketParamsType, [p]);
}

/** The three Vault V2 cap ids of the adapter's market (VaultV2Ids.sol / MorphoMarketV1AdapterV2.ids()). */
export function capIds(adapter: `0x${string}`, p: MarketParams): [Hex, Hex, Hex] {
  const adapterId = keccak256(encodeAbiParameters([{type: "string"}, {type: "address"}], ["this", adapter]));
  const collateralId = keccak256(
    encodeAbiParameters([{type: "string"}, {type: "address"}], ["collateralToken", p.collateralToken]),
  );
  const marketId = keccak256(
    encodeAbiParameters([{type: "string"}, {type: "address"}, ...marketParamsType], ["this/marketParams", adapter, p]),
  );
  return [adapterId, collateralId, marketId];
}
