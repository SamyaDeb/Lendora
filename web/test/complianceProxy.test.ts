import {afterEach, describe, expect, it, vi} from "vitest";
import {NextRequest} from "next/server";
import {complianceProxyHeaders} from "@/lib/complianceProxy";

const SECRET = "web-proxy-secret-0123456789abcdef";

describe("CP-R8 the compliance proxy forwards only platform-set geo and IP headers", () => {
  const spoofed = {
    "cf-ipcountry": "DE",
    "x-geo-country": "DE",
    "x-geo-region": "BE",
    "x-forwarded-for": "198.51.100.7, 10.0.0.1",
    "x-stockline-proxy": "forged",
  };

  it("CP_R8 on Vercel a client-sent cf-ipcountry, x-geo-*, x-forwarded-for and x-stockline-proxy are dropped", () => {
    const h = complianceProxyHeaders(new Headers({...spoofed, "x-vercel-ip-country": "US", "x-real-ip": "192.0.2.44"}), "vercel", SECRET);
    expect(h.get("x-geo-country")).toBe("US");
    expect(h.get("x-geo-region")).toBeNull();
    expect(h.get("x-forwarded-for")).toBe("192.0.2.44");
    expect(h.get("x-stockline-proxy")).toBe(SECRET);
    expect(h.get("cf-ipcountry")).toBeNull();
  });

  it("CP_R8 on Cloudflare only cf-* headers count; a client-sent x-vercel-ip-country is dropped", () => {
    const h = complianceProxyHeaders(new Headers({...spoofed, "x-vercel-ip-country": "DE", "cf-ipcountry": "GB", "cf-connecting-ip": "192.0.2.45"}), "cloudflare", SECRET);
    expect(h.get("x-geo-country")).toBe("GB");
    expect(h.get("x-forwarded-for")).toBe("192.0.2.45");
  });

  it("CP_R8 no platform and no secret: nothing geo is forwarded and no proxy header is invented", () => {
    const h = complianceProxyHeaders(new Headers(spoofed), "none", undefined);
    for (const k of ["x-geo-country", "x-geo-region", "x-forwarded-for", "x-stockline-proxy", "cf-ipcountry"]) expect(h.get(k), k).toBeNull();
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
      headers: {"cf-ipcountry": "DE", "x-stockline-proxy": "forged", "x-forwarded-for": "198.51.100.7", "x-vercel-ip-country": "US", "x-real-ip": "192.0.2.46"},
      body: JSON.stringify({address: "0x0000000000000000000000000000000000000001"}),
    });
    const r = await POST(req, {params: Promise.resolve({path: ["attest"]})});
    expect(r.status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0].get("x-geo-country")).toBe("US");
    expect(seen[0].get("cf-ipcountry")).toBeNull();
    expect(seen[0].get("x-forwarded-for")).toBe("192.0.2.46");
    expect(seen[0].get("x-stockline-proxy")).toBe(SECRET);
  });
});
