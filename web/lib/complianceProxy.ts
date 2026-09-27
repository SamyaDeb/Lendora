/**
 * CP-R8: the headers the web app's server-side proxy sends to the compliance service. Nothing the browser sent is
 * forwarded: only the geo and client-IP headers that the edge platform itself sets (`GEO_PLATFORM`), normalized to
 * `x-geo-country` / `x-geo-region` / `x-forwarded-for`, plus `x-stockline-proxy: $PROXY_SECRET`. A client-sent
 * `cf-ipcountry` on Vercel, `x-vercel-ip-country` on Cloudflare, `x-geo-*`, `x-forwarded-for` or `x-stockline-proxy` is
 * dropped.
 */
export type GeoPlatform = "vercel" | "cloudflare" | "none";

const PLATFORM: Record<GeoPlatform, {country?: string; region?: string; ip: string[]}> = {
  // Vercel overwrites these on every request (the client cannot set them).
  vercel: {country: "x-vercel-ip-country", region: "x-vercel-ip-country-region", ip: ["x-real-ip", "x-vercel-forwarded-for"]},
  // Cloudflare sets these; a client-sent x-forwarded-for is only appended to, so it is never used.
  cloudflare: {country: "cf-ipcountry", region: "cf-region-code", ip: ["cf-connecting-ip"]},
  // Local / no edge: no geo (the compliance service answers GEO_UNKNOWN off anvil).
  none: {ip: []},
};

export function geoPlatform(v: string | undefined): GeoPlatform {
  return v === "cloudflare" || v === "none" ? v : "vercel";
}

export function complianceProxyHeaders(incoming: Headers, platform: GeoPlatform, secret: string | undefined): Headers {
  const p = PLATFORM[platform];
  const out = new Headers({"content-type": "application/json"});
  const country = p.country ? incoming.get(p.country) : null;
  const region = p.region ? incoming.get(p.region) : null;
  if (country) out.set("x-geo-country", country);
  if (region) out.set("x-geo-region", region);
  const ip = p.ip.map((h) => incoming.get(h)?.split(",")[0].trim()).find(Boolean);
  if (ip) out.set("x-forwarded-for", ip);
  if (secret) out.set("x-stockline-proxy", secret);
  return out;
}
