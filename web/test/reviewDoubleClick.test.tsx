import {act, fireEvent, render, screen} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {ReviewSheet} from "@/components/review/ReviewSheet";
import {ToastProvider, TooltipProvider} from "@/components/ui";

/**
 * 46630 break (double click on Confirm): the lend flow reads previewDeposit before its steps start, so `busy` came
 * late and a second click started the flow again: two sends (the second failed on its nonce here; a real wallet
 * would have shown two prompts). One click, one run.
 */
// jsdom has no matchMedia (the sheet's useMediaQuery): report a desktop viewport.
window.matchMedia = ((q: string) => ({matches: q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}})) as unknown as typeof window.matchMedia;

describe("T32 a double click on Confirm runs the flow once", () => {
  it("the second click while the first is starting does nothing", async () => {
    let release!: () => void;
    const onConfirm = vi.fn(() => new Promise<boolean>((r) => (release = () => r(true))));
    render(
      <TooltipProvider>
        <ToastProvider>
          <ReviewSheet open onOpenChange={() => {}} title="Review lend" confirmLabel="Lend 1 NVDA" summary={null} plan={[]} steps={[]} busy={false} onConfirm={onConfirm} successTitle="Lent" />
        </ToastProvider>
      </TooltipProvider>,
    );
    const b = screen.getByTestId("confirm");
    fireEvent.click(b);
    fireEvent.click(b);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((b as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
  });
});
