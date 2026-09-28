/**
 * APP-R11: aggregate page and funnel counters. The request body carries only {event, funnel, path}; nothing about the
 * wallet, and the IP is never read or logged here. Counts are per process (the platform's log drain aggregates the
 * one-line JSON records).
 */
const EVENTS = new Set(["page", "connect", "preview", "sign", "confirmed"]);
const counts = new Map<string, number>();
/** OFF-13: distinct counter keys are capped, so a client inventing paths cannot grow memory without bound. */
export const MAX_KEYS = 2_000;

export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as {event?: string; funnel?: string | null; path?: string} | null;
  if (!b || !EVENTS.has(b.event ?? "")) return new Response(null, {status: 204});
  const funnel = typeof b.funnel === "string" ? b.funnel.slice(0, 32) : "";
  const path = typeof b.path === "string" ? b.path.replace(/0x[0-9a-fA-F]{40}/g, ":address").slice(0, 64) : "";
  const key = `${b.event}|${funnel}|${path}`;
  if (!counts.has(key) && counts.size >= MAX_KEYS) return new Response(null, {status: 204});
  counts.set(key, (counts.get(key) ?? 0) + 1);
  console.log(JSON.stringify({analytics: b.event, funnel, path}));
  return new Response(null, {status: 204});
}

export async function GET() {
  return Response.json(Object.fromEntries(counts));
}
