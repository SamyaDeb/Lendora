import {afterEach, describe, expect, it, vi} from "vitest";
import {NextRequest} from "next/server";
import {complianceProxyHeaders, geoPlatform, staticGeo} from "@/lib/complianceProxy";

const SECRET = "web-proxy-secret-0123456789abcdef";

describe("CP-R8 the compliance proxy forwards only platform-set geo and IP headers", () => {
  const spoofed = {
    "cf-ipcountry": "DE",
    "x-geo-country": "DE",
    "x-geo-region": "BE",
    "x-forwarded-for": "198.51.100.7, 10.0.0.1",
    "x-lendora-proxy": "forged",
  };

  it("CP_R8 on Vercel a client-sent cf-ipcountry, x-geo-*, x-forwarded-for and x-lendora-proxy are dropped", () => {
    const h = complianceProxyHeaders(new Headers({...spoofed, "x-vercel-ip-country": "US", "x-real-ip": "192.0.2.44"}), "vercel", SECRET);
    expect(h.get("x-geo-country")).toBe("US");
    expect(h.get("x-geo-region")).toBeNull();
    expect(h.get("x-forwarded-for")).toBe("192.0.2.44");
    expect(h.get("x-lendora-proxy")).toBe(SECRET);
    expect(h.get("cf-ipcountry")).toBeNull();
  });

  it("CP_R8 on Cloudflare only cf-* headers count; a client-sent x-vercel-ip-country is dropped", () => {
    const h = complianceProxyHeaders(new Headers({...spoofed, "x-vercel-ip-country": "DE", "cf-ipcountry": "GB", "cf-connecting-ip": "192.0.2.45"}), "cloudflare", SECRET);
    expect(h.get("x-geo-country")).toBe("GB");
    expect(h.get("x-forwarded-for")).toBe("192.0.2.45");
  });

  it("CP_R8 no platform and no secret: nothing geo is forwarded and no proxy header is invented", () => {
    const h = complianceProxyHeaders(new Headers(spoofed), "none", undefined);
    for (const k of ["x-geo-country", "x-geo-region", "x-forwarded-for", "x-lendora-proxy", "cf-ipcountry"]) expect(h.get(k), k).toBeNull();
  });
});

describe("CP-R8 through the Next route handler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("CP_R8 a spoofed cf-ipcountry from the client never reaches the compliance service", async () => {
    vi.stubEnv("PROXY_SECRET", SECRET);
    vi.stubEnv("GEO_PLATFORM", "vercel");
    const seen: Headers[] = [];
    vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return new Response(JSON.stringify({code: "RESTRICTED_REGION"}), {status: 403});
    });
    const {POST} = await import("@/app/api/compliance/[...path]/route");
    const req = new NextRequest("http://localhost/api/compliance/attest", {
      method: "POST",
      headers: {"cf-ipcountry": "DE", "x-lendora-proxy": "forged", "x-forwarded-for": "198.51.100.7", "x-vercel-ip-country": "US", "x-real-ip": "192.0.2.46"},
      body: JSON.stringify({address: "0x0000000000000000000000000000000000000001"}),
    });
    const r = await POST(req, {params: Promise.resolve({path: ["attest"]})});
    expect(r.status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0].get("x-geo-country")).toBe("US");
    expect(seen[0].get("cf-ipcountry")).toBeNull();
    expect(seen[0].get("x-forwarded-for")).toBe("192.0.2.46");
    expect(seen[0].get("x-lendora-proxy")).toBe(SECRET);
  });
});

describe("CP-R8 GEO_PLATFORM=static (local testnet stack only)", () => {
  const dev = {NODE_ENV: "development", GEO_STATIC_COUNTRY: "DE"} as NodeJS.ProcessEnv;

  it("CP_R8 static in development forwards GEO_STATIC_COUNTRY (and region/IP if set), never the client's headers", () => {
    expect(geoPlatform("static", dev)).toBe("static");
    const h = complianceProxyHeaders(
      new Headers({"cf-ipcountry": "US", "x-geo-country": "US", "x-forwarded-for": "198.51.100.7", "x-lendora-proxy": "forged"}),
      "static",
      SECRET,
      staticGeo({...dev, GEO_STATIC_REGION: "BE", GEO_STATIC_IP: "192.0.2.10"}),
    );
    expect(h.get("x-geo-country")).toBe("DE");
    expect(h.get("x-geo-region")).toBe("BE");
    expect(h.get("x-forwarded-for")).toBe("192.0.2.10");
    expect(h.get("x-lendora-proxy")).toBe(SECRET);
    expect(h.get("cf-ipcountry")).toBeNull();
  });

  it("CP_R8 static throws in a production build (NODE_ENV=production or test)", () => {
    expect(() => geoPlatform("static", {...dev, NODE_ENV: "production"})).toThrow(/development/);
    expect(() => geoPlatform("static", {...dev, NODE_ENV: "test"})).toThrow(/development/);
  });

  it("CP_R8 static throws on a hosting platform (VERCEL or RAILWAY_ENVIRONMENT set), even in development", () => {
    expect(() => geoPlatform("static", {...dev, VERCEL: "1"})).toThrow(/hosting/);
    expect(() => geoPlatform("static", {...dev, RAILWAY_ENVIRONMENT: "production"})).toThrow(/hosting/);
  });

  it("CP_R8 static needs a two-letter GEO_STATIC_COUNTRY", () => {
    expect(() => geoPlatform("static", {NODE_ENV: "development"} as NodeJS.ProcessEnv)).toThrow(/GEO_STATIC_COUNTRY/);
    expect(() => geoPlatform("static", {...dev, GEO_STATIC_COUNTRY: "Germany"})).toThrow(/GEO_STATIC_COUNTRY/);
  });
});
