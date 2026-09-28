import {encodeFunctionData, type Hex} from "viem";
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
