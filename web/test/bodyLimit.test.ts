import {afterEach, describe, expect, it, vi} from "vitest";
import {NextRequest} from "next/server";
import {POST as compliancePost} from "@/app/api/compliance/[...path]/route";
import {POST as alertsPost} from "@/app/api/alerts/[...path]/route";
import {POST as analyticsPost} from "@/app/api/analytics/route";
import {MAX_BODY_BYTES, readBody} from "@/lib/bodyLimit";

/**
 * OFF-15 (found by testnetBreak on 46630): the server routes buffered any request body (12 MB accepted, then parsed
 * or forwarded), so a client could make the web server hold arbitrary amounts of memory. Every body is capped.
 */
const huge = () => JSON.stringify({address: "0x0000000000000000000000000000000000000001", pad: "x".repeat(MAX_BODY_BYTES + 1)});
/** A body with no content-length (a chunked upload): the cap must hold while streaming, not only on the header. */
const chunked = (bytes: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let sent = 0; sent < bytes; sent += 4096) c.enqueue(new Uint8Array(4096).fill(120));
      c.close();
    },
  });
const ctx = (path: string[]) => ({params: Promise.resolve({path})});

describe("OFF-15 request bodies are capped on every server route", () => {
  afterEach(() => vi.restoreAllMocks());

  it("readBody returns the text under the cap and null over it, by header or while streaming", async () => {
    expect(await readBody(new Request("http://x", {method: "POST", body: "{}"}))).toBe("{}");
    expect(await readBody(new Request("http://x", {method: "POST", body: huge()}))).toBeNull();
    expect(await readBody(new Request("http://x", {method: "POST", body: chunked(MAX_BODY_BYTES * 4), duplex: "half"} as RequestInit))).toBeNull();
  });

  it("compliance and alerts proxies answer 413 and never forward an oversized body", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    for (const [post, path] of [[compliancePost, ["attest"]], [alertsPost, ["settings"]]] as const) {
      const r = await post(new NextRequest("http://localhost/api/x", {method: "POST", body: huge()}), ctx([...path]));
      expect(r.status).toBe(413);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("analytics answers 413 to an oversized body and still counts a normal one", async () => {
    expect((await analyticsPost(new Request("http://x/api/analytics", {method: "POST", body: huge()}))).status).toBe(413);
    expect((await analyticsPost(new Request("http://x/api/analytics", {method: "POST", body: JSON.stringify({event: "page", path: "/markets"})}))).status).toBe(204);
  });
});
