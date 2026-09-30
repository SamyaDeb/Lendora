import {act, renderHook} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {useSlow} from "@/lib/hooks";

/** T39: a chain read that hangs (public RPC bursts) left "Loading positions" on screen for minutes with no word. */
describe("T39 a slow chain read is named after 15 s", () => {
  it("true only once loading has lasted the delay; resets when loading ends", () => {
    vi.useFakeTimers();
    const {result, rerender} = renderHook(({l}) => useSlow(l, 15_000), {initialProps: {l: true}});
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(14_000));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1_500));
    expect(result.current).toBe(true);
    rerender({l: false});
    expect(result.current).toBe(false);
    vi.useRealTimers();
  });
});
