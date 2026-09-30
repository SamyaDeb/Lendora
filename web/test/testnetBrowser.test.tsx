import {render} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import config from "../next.config";
import TermsPage from "../app/(app)/terms/page";

/** Found in the 46630 browser pass (2026-09-30), docs/runbooks/testnet-issues.md T18, T19. */
describe("testnet browser pass", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("T18 the dev server serves its client to http://127.0.0.1:3000 (the testers' URL), not only localhost", () => {
    // Next 16 blocks dev resources for origins not listed: on 127.0.0.1 the app never hydrated (no wallet connect,
    // "Checking market hours…" forever).
    expect(config.allowedDevOrigins).toContain("127.0.0.1");
  });

  it("T19 /terms: the 66-character terms hash wraps instead of widening the page (390 px scrolled sideways to 514)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({version: "2026-09-27.1", hash: `0x${"6d".repeat(32)}`, text: "Terms"})));
    const {getByText} = render(await TermsPage());
    const hash = getByText(`0x${"6d".repeat(32)}`);
    expect(hash.className).toMatch(/break-all/);
  });
});
