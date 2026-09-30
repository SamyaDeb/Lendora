import {act, renderHook} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {useSteps, type Step} from "@/lib/tx";

vi.mock("@/lib/analytics", () => ({track: () => {}}));

/**
 * 46630 browser pass (row 3 + break): the terms signature rejected after the approval went through; "Try again" sent
 * the approval a second time (the allowance read hadn't refreshed yet). A retry resumes after the steps already done.
 */
describe("T29 Try again does not repeat an approval that already went through", () => {
  it("skips approve/authorize steps done in the failed run; runs the rest again", async () => {
    const approve = vi.fn(async () => {});
    const authorize = vi.fn(async () => {});
    let reject = true;
    const sign = vi.fn(async () => {
      if (reject) throw Object.assign(new Error("User rejected the request."), {code: 4001});
    });
    const execute = vi.fn(async () => {});
    const list = (): Step[] => [
      {id: "approve", label: "Approve USDG", kind: "approve", run: approve},
      {id: "authorize", label: "Authorize", kind: "authorize", run: authorize},
      {id: "terms", label: "Terms", kind: "sign", run: sign},
      {id: "execute", label: "Deposit", kind: "execute", run: execute},
    ];
    const {result} = renderHook(() => useSteps("t"));
    let ok = true;
    await act(async () => void (ok = await result.current.run(list())));
    expect(ok).toBe(false);
    expect(result.current.error).toBe("You cancelled the request in your wallet.");
    reject = false;
    await act(async () => void (ok = await result.current.run(list())));
    expect(ok).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.current.states.map((s) => s.status)).toEqual(["skipped", "skipped", "done", "done"]);
  });
  it("after a success (or a reset) nothing is remembered: the next action runs every step it needs", async () => {
    const approve = vi.fn(async () => {});
    const list = (): Step[] => [{id: "approve", label: "Approve", kind: "approve", run: approve}];
    const {result} = renderHook(() => useSteps("t"));
    await act(async () => void (await result.current.run(list())));
    await act(async () => void (await result.current.run(list())));
    expect(approve).toHaveBeenCalledTimes(2);
  });
});

describe("T29 a different approval (another token, same step id) is never skipped", () => {
  it("close failed after approving USDG; a repay then still approves the stock", async () => {
    const approveUsdg = vi.fn(async () => {});
    const approveStock = vi.fn(async () => {});
    const fail = vi.fn(async () => {
      throw new Error("User rejected the request.");
    });
    const {result} = renderHook(() => useSteps("t"));
    await act(async () => void (await result.current.run([{id: "approve", label: "Approve USDG", kind: "approve", run: approveUsdg}, {id: "close", label: "Close", kind: "execute", run: fail}])));
    await act(async () => void (await result.current.run([{id: "approve", label: "Approve NVDA", kind: "approve", run: approveStock}, {id: "repay", label: "Repay", kind: "execute", run: async () => {}}])));
    expect(approveStock).toHaveBeenCalledTimes(1);
  });
});
