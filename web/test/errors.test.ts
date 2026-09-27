import {describe, expect, it} from "vitest";
import {BaseError, encodeErrorResult, encodeAbiParameters} from "viem";
import {stocklineRouterAbi} from "@stockline/sdk";
import {explainError} from "@/lib/errors";

class Wrapped extends BaseError {
  constructor(readonly data: `0x${string}`) {
    super("execution reverted");
  }
}

describe("APP-R3 revert reasons in plain language", () => {
  it("decodes router custom errors", () => {
    const guard = new Wrapped(encodeErrorResult({abi: stocklineRouterAbi, errorName: "GuardTripped", args: [8n]}));
    expect(explainError(guard)).toMatch(/New borrowing is paused.*stale price feed.*Repay, close and withdraw still work/);
    const hf = new Wrapped(encodeErrorResult({abi: stocklineRouterAbi, errorName: "HealthTooLow", args: [10n ** 18n]}));
    expect(explainError(hf)).toMatch(/within 24 hours/);
    expect(explainError(new Wrapped(encodeErrorResult({abi: stocklineRouterAbi, errorName: "BadAttestation"})))).toMatch(/compliance attestation/);
  });

  it("RT-R8: NoDebtPosition explains that adding collateral is a rescue top-up", () => {
    const e = new Wrapped(encodeErrorResult({abi: stocklineRouterAbi, errorName: "NoDebtPosition", args: ["0x0000000000000000000000000000000000000001"]}));
    expect(explainError(e)).toMatch(/only for positions with an open borrow.*open a borrow or short/);
  });

  it("maps Morpho's string errors and wallet rejections", () => {
    const err = new Wrapped(`0x08c379a0${encodeAbiParameters([{type: "string"}], ["insufficient collateral"]).slice(2)}` as `0x${string}`);
    expect(explainError(err)).toMatch(/Not enough collateral/);
    expect(explainError(new Error("User rejected the request."))).toBe("You cancelled the request in your wallet.");
  });
});
