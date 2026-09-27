import type {NextRequest} from "next/server";

/** Proxy to the alerts service (APP-R8, keepers/alerts): settings are saved with a signed message. */
const ALERTS_URL = process.env.ALERTS_URL ?? "http://127.0.0.1:42072";

async function forward(req: NextRequest, path: string[]) {
  if (!/^settings(\/0x[0-9a-fA-F]{40})?$/.test(path.join("/"))) return Response.json({error: "not found"}, {status: 404});
  const r = await fetch(`${ALERTS_URL}/v1/alerts/${path.join("/")}`, {
    method: req.method,
    headers: {"content-type": "application/json"},
    body: req.method === "POST" ? await req.text() : undefined,
    cache: "no-store",
  }).catch(() => undefined);
  if (!r) return Response.json({error: "the alerts service is unavailable"}, {status: 503});
  return new Response(await r.text(), {status: r.status, headers: {"content-type": "application/json", "cache-control": "no-store"}});
}

export async function GET(req: NextRequest, ctx: {params: Promise<{path: string[]}>}) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: {params: Promise<{path: string[]}>}) {
  return forward(req, (await ctx.params).path);
}
