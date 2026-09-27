import type {NextRequest} from "next/server";

/**
 * Server-side proxy to the compliance service (CP-R1…R3, APP-R10). It runs at the edge of our deployment, where the
 * platform sets the visitor's country (`x-vercel-ip-country`, `cf-ipcountry`), and forwards those headers and the
 * client IP with `x-stockline-proxy: $PROXY_SECRET`, the only way the compliance service trusts them.
 */
const COMPLIANCE_URL = process.env.COMPLIANCE_URL ?? "http://127.0.0.1:42071";
const FORWARD = ["x-vercel-ip-country", "x-vercel-ip-country-region", "cf-ipcountry", "cf-region-code"];

async function forward(req: NextRequest, path: string[]) {
  if (!/^(connection|attest|terms(\/0x[0-9a-fA-F]{40})?)$/.test(path.join("/"))) return Response.json({error: "not found"}, {status: 404});
  const url = new URL(`${COMPLIANCE_URL}/v1/compliance/${path.join("/")}`);
  req.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
  const headers = new Headers({"content-type": "application/json"});
  for (const h of FORWARD) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? req.headers.get("x-real-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  if (process.env.PROXY_SECRET) headers.set("x-stockline-proxy", process.env.PROXY_SECRET);
  const r = await fetch(url, {method: req.method, headers, body: req.method === "POST" ? await req.text() : undefined, cache: "no-store"});
  return new Response(await r.text(), {status: r.status, headers: {"content-type": "application/json", "cache-control": "no-store"}});
}

export async function GET(req: NextRequest, ctx: {params: Promise<{path: string[]}>}) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: {params: Promise<{path: string[]}>}) {
  return forward(req, (await ctx.params).path);
}
