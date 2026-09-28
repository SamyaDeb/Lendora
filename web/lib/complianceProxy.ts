/**
 * CP-R8: the headers the web app's server-side proxy sends to the compliance service. Nothing the browser sent is
 * forwarded: only the geo and client-IP headers that the edge platform itself sets (`GEO_PLATFORM`), normalized to
 * `x-geo-country` / `x-geo-region` / `x-forwarded-for`, plus `x-stockline-proxy: $PROXY_SECRET`. A client-sent
 * `cf-ipcountry` on Vercel, `x-vercel-ip-country` on Cloudflare, `x-geo-*`, `x-forwarded-for` or `x-stockline-proxy` is
 * dropped.
 *
 * `static` is for the local testnet stack only (scripts/dev.sh --network 46630), where no edge sets geo headers: the
 * country comes from `GEO_STATIC_COUNTRY`. It is refused outside `next dev` and on any hosting platform.
 */
export type GeoPlatform = "vercel" | "cloudflare" | "none" | "static";

export interface StaticGeo {
  country: string;
  region?: string;
  ip?: string;
}

const PLATFORM: Record<GeoPlatform, {country?: string; region?: string; ip: string[]}> = {
  // Vercel overwrites these on every request (the client cannot set them).
  vercel: {country: "x-vercel-ip-country", region: "x-vercel-ip-country-region", ip: ["x-real-ip", "x-vercel-forwarded-for"]},
  // Cloudflare sets these; a client-sent x-forwarded-for is only appended to, so it is never used.
  cloudflare: {country: "cf-ipcountry", region: "cf-region-code", ip: ["cf-connecting-ip"]},
  // Local / no edge: no geo (the compliance service answers GEO_UNKNOWN off anvil).
  none: {ip: []},
  // Local testnet stack: nothing from the request; the country is configured (`staticGeo`).
  static: {ip: []},
};

export function geoPlatform(v: string | undefined, env: NodeJS.ProcessEnv = process.env): GeoPlatform {
  if (v === "static") {
    if (env.NODE_ENV !== "development") throw new Error("GEO_PLATFORM=static is allowed only in development (next dev)");
    if (env.VERCEL || env.RAILWAY_ENVIRONMENT) throw new Error("GEO_PLATFORM=static is refused on a hosting platform (VERCEL / RAILWAY_ENVIRONMENT)");
    staticGeo(env);
    return "static";
  }
  return v === "cloudflare" || v === "none" ? v : "vercel";
}

export function staticGeo(env: NodeJS.ProcessEnv = process.env): StaticGeo {
  const country = env.GEO_STATIC_COUNTRY ?? "";
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("GEO_PLATFORM=static needs GEO_STATIC_COUNTRY (ISO 3166-1 alpha-2, e.g. DE)");
  return {country, region: env.GEO_STATIC_REGION || undefined, ip: env.GEO_STATIC_IP || undefined};
}

/** The visitor's country, region and IP as set by `platform` (only its own headers), or the configured static geo. */
export function visitorGeo(incoming: Headers, platform: GeoPlatform, fixed?: StaticGeo): {country?: string | null; region?: string | null; ip?: string} {
  const p = PLATFORM[platform];
  if (platform === "static") return fixed ?? {};
  return {
    country: p.country ? incoming.get(p.country) : null,
    region: p.region ? incoming.get(p.region) : null,
    ip: p.ip.map((h) => incoming.get(h)?.split(",")[0].trim()).find(Boolean),
  };
}

export function complianceProxyHeaders(incoming: Headers, platform: GeoPlatform, secret: string | undefined, fixed?: StaticGeo): Headers {
  const out = new Headers({"content-type": "application/json"});
  const {country, region, ip} = visitorGeo(incoming, platform, fixed);
  if (country) out.set("x-geo-country", country);
  if (region) out.set("x-geo-region", region);
  if (ip) out.set("x-forwarded-for", ip);
  if (secret) out.set("x-stockline-proxy", secret);
  return out;
}
