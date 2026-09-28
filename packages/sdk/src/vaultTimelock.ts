import {encodeAbiParameters, encodeFunctionData, keccak256, type Hex} from "viem";
import type {Address, ChainDeployment} from "./addresses.js";
import {vaultV2FullAbi} from "./abis.js";

/**
 * Calldata for Vault V2 **curator** actions (FE-R1 and every other timelocked vault setting). Unlike the router,
 * oracles and `MarketHours` (owned by the OpenZeppelin `TimelockController`), a vault timelocks its own curator
 * actions: the curator (owner multisig on mainnet, the deployer on testnet) `submit`s the exact call, which becomes
 * executable after `timelock(selector)` (48h mainnet, 24h testnet); then **anyone** sends the call itself. The
 * curator or a sentinel (guardian) can `revoke` it before that. This module only encodes: it never sends.
 */
export type VaultCuratorAction =
  | {kind: "vault.setPerformanceFeeRecipient"; ticker: string; recipient: Address} // FE-R1 (turn fees on later)
  | {kind: "vault.setPerformanceFee"; ticker: string; feeWad: bigint}; // FE-R1: 10% = 1e17

export interface VaultCuratorOperation {
  action: VaultCuratorAction["kind"];
  /** The vault: the target of every step. */
  vault: Address;
  /** The timelocked call (step 2, sent by anyone after `executableAt(data)`). */
  data: Hex;
  /** Step 1, from the curator: `submit(data)`. */
  submitCalldata: Hex;
  /** Veto before execution, from the curator or a sentinel: `revoke(data)`. */
  revokeCalldata: Hex;
}

/** Vault V2 `MAX_PERFORMANCE_FEE` (50%). */
export const VAULT_MAX_PERFORMANCE_FEE = 5n * 10n ** 17n;

export function vaultCuratorOperation(d: ChainDeployment, a: VaultCuratorAction): VaultCuratorOperation {
  const s = d.stocks[a.ticker];
  if (!s) throw new Error(`unknown ticker ${a.ticker} (have ${Object.keys(d.stocks).join(", ")})`);
  let data: Hex;
  switch (a.kind) {
    case "vault.setPerformanceFeeRecipient":
      if (/^0x0{40}$/i.test(a.recipient)) throw new Error("recipient must not be address(0) while a fee is set");
      data = encodeFunctionData({abi: vaultV2FullAbi, functionName: "setPerformanceFeeRecipient", args: [a.recipient]});
      break;
    case "vault.setPerformanceFee":
      if (a.feeWad > VAULT_MAX_PERFORMANCE_FEE) throw new Error("fee above Vault V2 MAX_PERFORMANCE_FEE (50%)");
      data = encodeFunctionData({abi: vaultV2FullAbi, functionName: "setPerformanceFee", args: [a.feeWad]});
      break;
  }
  return {
    action: a.kind,
    vault: s.vault,
    data,
    submitCalldata: encodeFunctionData({abi: vaultV2FullAbi, functionName: "submit", args: [data]}),
    revokeCalldata: encodeFunctionData({abi: vaultV2FullAbi, functionName: "revoke", args: [data]}),
  };
}

/** Vault V2 WAD relative cap of 100% (the receipt vault has one market). */
export const RECEIPT_RELATIVE_CAP = 10n ** 18n;
/** CL-R10: the receipt market is listed no earlier than 30 days after the stock market's launch. */
export const RECEIPT_LISTING_DELAY_S = 30 * 86_400;

/** The Morpho market params of a stock's receipt market (USDG loan, `rSTOCK` collateral, 05 §3). */
export function receiptMarketParams(d: ChainDeployment, ticker: string) {
  const s = d.stocks[ticker];
  if (!s?.receipt) throw new Error(`no receipt market for ${ticker} (run ListReceiptMarket first)`);
  return {loanToken: d.usdg, collateralToken: s.vault, oracle: s.receipt.oracle, irm: d.adaptiveCurveIrm, lltv: BigInt(s.receipt.lltv)};
}

const marketParamsType = {
  type: "tuple",
  components: [
    {name: "loanToken", type: "address"},
    {name: "collateralToken", type: "address"},
    {name: "oracle", type: "address"},
    {name: "irm", type: "address"},
    {name: "lltv", type: "uint256"},
  ],
} as const;

/** The three Vault V2 cap id datas of a `MorphoMarketV1AdapterV2` market (as `VaultV2Ids.sol`). */
export function adapterCapIdDatas(adapter: Address, collateralToken: Address, mp: ReturnType<typeof receiptMarketParams>): {adapter: Hex; collateral: Hex; market: Hex} {
  return {
    adapter: encodeAbiParameters([{type: "string"}, {type: "address"}], ["this", adapter]),
    collateral: encodeAbiParameters([{type: "string"}, {type: "address"}], ["collateralToken", collateralToken]),
    market: encodeAbiParameters([{type: "string"}, {type: "address"}, marketParamsType], ["this/marketParams", adapter, mp]),
  };
}

export interface ReceiptListingOperation {
  label: string;
  vault: Address;
  data: Hex;
  submitCalldata: Hex;
  revokeCalldata: Hex;
}

/**
 * A3 / G5 listing: the six timelocked curator calls on the receipt USDG vault (absolute cap to `capUsdgRaw` and
 * relative cap to 100% on the adapter, collateral and market ids). The curator multisig sends the six `submit`s;
 * after the vault timelock (48h mainnet, 24h testnet) anyone sends the six `data` calls. CL-R10: on 4663 pass
 * `launchTs` (the stock market's launch) and `nowTs`; refused before launch + 30 days.
 */
export function receiptListingOperations(
  d: ChainDeployment,
  ticker: string,
  capUsdgRaw: bigint,
  o: {chainId: number; launchTs?: number; nowTs?: number},
): ReceiptListingOperation[] {
  if (o.chainId === 4663) {
    if (!o.launchTs) throw new Error("CL-R10: launchTs (the stock market's launch, from the launch log) is required on 4663");
    if ((o.nowTs ?? Math.floor(Date.now() / 1000)) < o.launchTs + RECEIPT_LISTING_DELAY_S) throw new Error("CL-R10: the receipt market lists >= 30 days after launch");
  }
  if (capUsdgRaw <= 0n) throw new Error("capUsdgRaw must be > 0");
  const mp = receiptMarketParams(d, ticker);
  const r = d.stocks[ticker].receipt!;
  const ids = adapterCapIdDatas(r.usdgAdapter, d.stocks[ticker].vault, mp);
  const ops: ReceiptListingOperation[] = [];
  for (const [name, idData] of Object.entries(ids)) {
    const calls: [string, Hex][] = [
      [`increaseAbsoluteCap(${name}, ${capUsdgRaw})`, encodeFunctionData({abi: vaultV2FullAbi, functionName: "increaseAbsoluteCap", args: [idData, capUsdgRaw]})],
      [`increaseRelativeCap(${name}, 100%)`, encodeFunctionData({abi: vaultV2FullAbi, functionName: "increaseRelativeCap", args: [idData, RECEIPT_RELATIVE_CAP]})],
    ];
    for (const [label, data] of calls) {
      ops.push({
        label,
        vault: r.usdgVault,
        data,
        submitCalldata: encodeFunctionData({abi: vaultV2FullAbi, functionName: "submit", args: [data]}),
        revokeCalldata: encodeFunctionData({abi: vaultV2FullAbi, functionName: "revoke", args: [data]}),
      });
    }
  }
  return ops;
}

/** Vault V2 cap id (`keccak256(idData)`) of the receipt market in its USDG vault; equals `adapterMarketCapId`. */
export function receiptMarketCapId(d: ChainDeployment, ticker: string): Hex {
  const r = d.stocks[ticker].receipt!;
  return keccak256(adapterCapIdDatas(r.usdgAdapter, d.stocks[ticker].vault, receiptMarketParams(d, ticker)).market);
}
