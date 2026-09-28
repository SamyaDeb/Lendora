import {decodeFunctionData, type Abi, type Hex} from "viem";
import type {Address, ChainDeployment} from "./addresses.js";
import {
  feeConverterAbi,
  feeSplitterAbi,
  marketHoursAbi,
  stocklineLiquidatorAbi,
  stocklineOracleAbi,
  stocklineRouterAbi,
  vaultV2FullAbi,
} from "./abis.js";

/** A contract call decoded for an operator page (MON-R16…R18): what, on which Stockline contract. */
export interface DecodedCall {
  /** e.g. "router", "oracle:NVDA", "vault:NVDA", "feeSplitter", "timelock", or "unknown". */
  label: string;
  target: Address;
  functionName: string | null;
  /** Arguments as strings (bigints in decimal); nested tuples JSON-encoded. */
  args: string[];
  /** One line: `router.setSwapTarget(0x…, 2)`. */
  summary: string;
}

const lc = (a: string) => a.toLowerCase();

/** Every Stockline contract of a deployment with its label and ABI. */
export function stocklineContracts(d: ChainDeployment): {address: Address; label: string; abi: Abi}[] {
  const out: {address: Address; label: string; abi: Abi}[] = [];
  const add = (address: Address | undefined, label: string, abi: Abi) => address && out.push({address, label, abi});
  add(d.router, "router", stocklineRouterAbi as Abi);
  add(d.marketHours, "marketHours", marketHoursAbi as Abi);
  add(d.liquidator, "liquidator", stocklineLiquidatorAbi as Abi);
  add(d.feeSplitter, "feeSplitter", feeSplitterAbi as Abi);
  add(d.treasuryConverter, "treasuryConverter", feeConverterAbi as Abi);
  add(d.backstopConverter, "backstopConverter", feeConverterAbi as Abi);
  for (const [t, s] of Object.entries(d.stocks)) {
    add(s.oracle, `oracle:${t}`, stocklineOracleAbi as Abi);
    add(s.vault, `vault:${t}`, vaultV2FullAbi as Abi);
  }
  return out;
}

const fmt = (v: unknown): string => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

/** Decode `data` sent to `target` (a timelocked owner call, or a vault curator `submit`'s inner call). Never throws. */
export function decodeStocklineCall(d: ChainDeployment, target: Address, data: Hex): DecodedCall {
  const c = stocklineContracts(d).find((x) => lc(x.address) === lc(target));
  const label = c?.label ?? (lc(target) === lc(d.timelock) ? "timelock" : "unknown");
  if (c) {
    try {
      const r = decodeFunctionData({abi: c.abi, data});
      const args = (r.args ?? []).map(fmt);
      return {label, target, functionName: r.functionName, args, summary: `${label}.${r.functionName}(${args.join(", ")})`};
    } catch {
      // fall through: unknown selector for this contract
    }
  }
  return {label, target, functionName: null, args: [], summary: `${label} ${target} selector ${data.slice(0, 10)}`};
}
