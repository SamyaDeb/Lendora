import {BaseError, decodeErrorResult, type Hex} from "viem";
import {erc20Abi, mockStockTokenAbi, morphoAbi, stocklineRouterAbi, stockWrapperAbi, vaultV2FullAbi} from "@stockline/sdk";
import {guardReasonText} from "./guard";

/**
 * APP-R3: every simulation or transaction failure is shown in plain language. Custom errors are decoded against the
 * router, Morpho, Vault V2, wrapper and token ABIs; Morpho's string errors are mapped too.
 */
const abis = [stocklineRouterAbi, vaultV2FullAbi, stockWrapperAbi, mockStockTokenAbi, erc20Abi, morphoAbi];

const MORPHO_STRINGS: Record<string, string> = {
  "insufficient collateral": "Not enough collateral for this borrow at the current oracle price. Add collateral or borrow less.",
  "insufficient liquidity": "The market does not have enough available stock right now. Borrow less, or wait for lenders or the allocator.",
  "transferFrom reverted": "A token transfer failed. Check your balance and approvals.",
  unauthorized: "The router is not authorized on Morpho for your account yet.",
};

function fromName(name: string, args: readonly unknown[] = []): string {
  switch (name) {
    case "GuardTripped":
      return `New borrowing is paused: the safety guard for this market is tripped (${guardReasonText(BigInt(String(args[0] ?? 0)))}). Repay, close and withdraw still work.`;
    case "HealthTooLow":
      return "This position would be too close to liquidation within 24 hours (health factor at t+24h below 1.10, including the weekend or earnings buffer). Add collateral or borrow less.";
    case "PerAddressCapExceeded":
      return "This borrow would exceed the per-address limit for this market.";
    case "GlobalCapExceeded":
      return "Stockline's total collateral cap is reached. Try again later.";
    case "BadAttestation":
      return "The compliance attestation is missing, expired or not for this wallet. Get a new one and retry.";
    case "InsufficientOutput":
      return "The swap returned less than your minimum (price moved beyond your slippage). Retry with a new quote.";
    case "Expired":
      return "The transaction deadline passed. Retry.";
    case "NotListed":
      return "This market is not open for new positions.";
    case "SwapTargetNotAllowed":
      return "That swap route is not allowlisted.";
    case "EnforcedPause":
    case "TokenPaused":
    case "Paused":
      return "The Stock Token issuer has paused transfers. Exits that move this token wait for the issuer to unpause (USDG exits still work).";
    case "Blocked":
    case "AccountBlocked":
      return "The Stock Token issuer has blocklisted an address in this transfer.";
    case "ERC20InsufficientBalance":
      return "Your balance is too low for this amount.";
    case "ERC20InsufficientAllowance":
      return "The approval is too low. Approve again.";
    case "RelativeCapExceeded":
    case "AbsoluteCapExceeded":
      return "The vault is at its supply cap.";
    default:
      return `The transaction would fail (${name}).`;
  }
}

export function explainError(e: unknown): string {
  const err = e as BaseError & {data?: Hex};
  const withData = typeof err?.walk === "function" ? (err.walk((x) => typeof (x as {data?: unknown}).data === "string") as {data?: Hex} | null) : null;
  const data = withData?.data;
  if (data && data.length >= 10) {
    for (const abi of abis) {
      try {
        const d = decodeErrorResult({abi: abi as never, data});
        if (d.errorName === "Error") return explainString(String(d.args?.[0] ?? ""));
        return fromName(d.errorName, d.args ?? []);
      } catch {
        /* next ABI */
      }
    }
  }
  const msg = (err?.shortMessage ?? err?.message ?? String(e)).toString();
  if (/User rejected|User denied|rejected the request/i.test(msg)) return "You cancelled the request in your wallet.";
  const reason = /reverted with reason:?\s*(.*)$/im.exec(msg)?.[1] ?? /reason:\s*"?([^"\n]+)"?/i.exec(msg)?.[1];
  if (reason) return explainString(reason.trim().replace(/\.$/, ""));
  return msg.split("\n")[0];
}

function explainString(s: string): string {
  return MORPHO_STRINGS[s] ?? `The transaction would fail: ${s}.`;
}
