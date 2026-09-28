import {afterEach, describe, expect, it, vi} from "vitest";
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

describe("APP-R2 the block page reads only the configured platform's geo headers (CP-R8)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const rewritten = (r: Response) => r.headers.get("x-middleware-rewrite")?.includes("/restricted") ?? false;

  it("APP_R2 behind Cloudflare a client-sent x-vercel-ip-country cannot hide a restricted cf-ipcountry", () => {
    vi.stubEnv("GEO_PLATFORM", "cloudflare");
    expect(rewritten(proxy(new NextRequest("http://localhost/short/NVDA", {headers: {"x-vercel-ip-country": "DE", "cf-ipcountry": "US"}})))).toBe(true);
  });

  it("APP_R2 GEO_PLATFORM=static (next dev) blocks on GEO_STATIC_COUNTRY whatever the client sends", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GEO_PLATFORM", "static");
    vi.stubEnv("GEO_STATIC_COUNTRY", "US");
    expect(rewritten(proxy(new NextRequest("http://localhost/short/NVDA", {headers: {"x-vercel-ip-country": "DE", "cf-ipcountry": "DE"}})))).toBe(true);
    vi.stubEnv("GEO_STATIC_COUNTRY", "DE");
    expect(rewritten(proxy(new NextRequest("http://localhost/short/NVDA", {headers: {"x-vercel-ip-country": "US"}})))).toBe(false);
  });
});
