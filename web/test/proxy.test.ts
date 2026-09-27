import {describe, expect, it} from "vitest";
import {NextRequest} from "next/server";
import {proxy} from "@/proxy";

const req = (path: string, country?: string) => new NextRequest(`http://localhost${path}`, {headers: country ? {"x-vercel-ip-country": country} : {}});

describe("APP-R2 geo-block (proxy.ts)", () => {
  it("rewrites restricted visitors to the block page", () => {
    const r = proxy(req("/short/NVDA", "US"));
    expect(r.headers.get("x-middleware-rewrite")).toContain("/restricted");
    expect(proxy(req("/", "GB")).headers.get("x-middleware-rewrite")).toContain("/restricted");
  });

  it("keeps exits reachable: the portfolio, terms and API routes pass with a restricted flag", () => {
    for (const p of ["/portfolio", "/terms", "/api/compliance/terms"]) {
      const r = proxy(req(p, "US"));
      expect(r.headers.get("x-middleware-rewrite"), p).toBeNull();
      expect(r.headers.get("x-middleware-request-x-stockline-restricted"), p).toBe("1");
    }
  });

  it("lets allowed countries through untouched", () => {
    const r = proxy(req("/short/NVDA", "DE"));
    expect(r.headers.get("x-middleware-rewrite")).toBeNull();
    expect(r.headers.get("x-middleware-request-x-stockline-restricted")).toBeNull();
  });
});
