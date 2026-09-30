import type {NextRequest} from "next/server";
import {readBody, tooLarge} from "@/lib/bodyLimit";
import {complianceProxyHeaders, geoPlatform, staticGeo} from "@/lib/complianceProxy";

/**
 * Server-side proxy to the compliance service (CP-R1…R3, APP-R10). It runs at the edge of our deployment, where the
 * platform (`GEO_PLATFORM`: vercel | cloudflare) sets the visitor's country and IP, and forwards only those, normalized,
 * with `x-lendora-proxy: $PROXY_SECRET`, the only way the compliance service trusts them. Client-sent geo, IP and
 * proxy headers are dropped (CP-R8). Locally (`next dev` only) `GEO_PLATFORM=static` + `GEO_STATIC_COUNTRY` stands in
 * for the edge.
 */
const COMPLIANCE_URL = process.env.COMPLIANCE_URL ?? "http://127.0.0.1:42071";

async function forward(req: NextRequest, path: string[]) {
  if (!/^(connection|attest|terms(\/0x[0-9a-fA-F]{40})?)$/.test(path.join("/"))) return Response.json({error: "not found"}, {status: 404});
  const url = new URL(`${COMPLIANCE_URL}/v1/compliance/${path.join("/")}`);
  req.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
  const platform = geoPlatform(process.env.GEO_PLATFORM);
  const headers = complianceProxyHeaders(req.headers, platform, process.env.PROXY_SECRET, platform === "static" ? staticGeo() : undefined);
  const body = req.method === "POST" ? await readBody(req) : undefined;
  if (body === null) return tooLarge(); // OFF-15
  const r = await fetch(url, {method: req.method, headers, body, cache: "no-store"});
  return new Response(await r.text(), {status: r.status, headers: {"content-type": "application/json", "cache-control": "no-store"}});
}

export async function GET(req: NextRequest, ctx: {params: Promise<{path: string[]}>}) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: {params: Promise<{path: string[]}>}) {
  return forward(req, (await ctx.params).path);
}
