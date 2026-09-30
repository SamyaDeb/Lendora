import {describe, expect, it} from "vitest";
import {BaseError, encodeErrorResult, encodeAbiParameters, zeroAddress} from "viem";
import {collateralTokenAbi, lendoraRouterAbi} from "@lendora/sdk";
import {explainError} from "@/lib/errors";
import {faucetAbi} from "@/lib/network";

const erc20ErrorsAbi = [{type: "error", name: "ERC20InvalidReceiver", inputs: [{name: "receiver", type: "address"}]}] as const;
const panicAbi = [{type: "error", name: "Panic", inputs: [{name: "code", type: "uint256"}]}] as const;

class Wrapped extends BaseError {
  constructor(readonly data: `0x${string}`) {
    super("execution reverted");
  }
}

describe("APP-R3 revert reasons in plain language", () => {
  it("decodes router custom errors", () => {
    const guard = new Wrapped(encodeErrorResult({abi: lendoraRouterAbi, errorName: "GuardTripped", args: [8n]}));
    expect(explainError(guard)).toMatch(/New borrowing is paused.*stale price feed.*Repay, close and withdraw still work/);
    const hf = new Wrapped(encodeErrorResult({abi: lendoraRouterAbi, errorName: "HealthTooLow", args: [10n ** 18n]}));
    expect(explainError(hf)).toMatch(/within 24 hours/);
    expect(explainError(new Wrapped(encodeErrorResult({abi: lendoraRouterAbi, errorName: "BadAttestation"})))).toMatch(/compliance attestation/);
  });

  it("RT-R8: NoDebtPosition explains that adding collateral is a rescue top-up", () => {
    const e = new Wrapped(encodeErrorResult({abi: lendoraRouterAbi, errorName: "NoDebtPosition", args: ["0x0000000000000000000000000000000000000001"]}));
    expect(explainError(e)).toMatch(/only for positions with an open borrow.*open a borrow or short/);
  });

  it("APP_R3 a second faucet claim inside 24h says when the next claim opens (was: 'unknown reason')", () => {
    const next = 1_790_870_400n; // 2026-10-01T16:00:00Z
    const e = new Wrapped(encodeErrorResult({abi: faucetAbi, errorName: "TooSoon", args: [next]}));
    expect(explainError(e)).toMatch(/already claimed.*2026-10-01 16:00 UTC/);
  });

  it("APP_R3 no Lendora revert reaches the user as a bare error name (found by testnetBreak on 46630)", () => {
    const one = "0x0000000000000000000000000000000000000001" as const;
    const cases: [string, `0x${string}`, RegExp][] = [
      ["ZeroAmount", encodeErrorResult({abi: lendoraRouterAbi, errorName: "ZeroAmount"}), /greater than zero/],
      ["ZeroAddress", encodeErrorResult({abi: lendoraRouterAbi, errorName: "ZeroAddress"}), /recipient.*empty/],
      ["ERC20InvalidReceiver", encodeErrorResult({abi: erc20ErrorsAbi, errorName: "ERC20InvalidReceiver", args: [zeroAddress]}), /recipient.*empty/],
      ["NotOwner", encodeErrorResult({abi: lendoraRouterAbi, errorName: "NotOwner"}), /reserved to a Lendora role/],
      ["NotRouter", encodeErrorResult({abi: collateralTokenAbi, errorName: "NotRouter"}), /only through the Lendora router/],
      ["TransferNotAllowed", encodeErrorResult({abi: collateralTokenAbi, errorName: "TransferNotAllowed", args: [one, one]}), /only through the Lendora router/],
      ["Panic 0x11", encodeErrorResult({abi: panicAbi, errorName: "Panic", args: [0x11n]}), /more than you hold/],
    ];
    for (const [name, data, want] of cases) {
      const msg = explainError(new Wrapped(data));
      expect(msg, name).toMatch(want);
      expect(msg, name).not.toMatch(/would fail \(/);
    }
  });

  it("maps Morpho's string errors and wallet rejections", () => {
    const err = new Wrapped(`0x08c379a0${encodeAbiParameters([{type: "string"}], ["insufficient collateral"]).slice(2)}` as `0x${string}`);
    expect(explainError(err)).toMatch(/Not enough collateral/);
    expect(explainError(new Error("User rejected the request."))).toBe("You cancelled the request in your wallet.");
  });
});
