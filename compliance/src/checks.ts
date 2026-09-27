import {readFileSync} from "node:fs";

/**
 * The screening pieces behind interfaces (CP-R1…R3): where the visitor is (edge geo headers), whether the IP looks
 * like a datacenter/VPN (borrow flows only, CP-R2) and whether the wallet is sanctioned. Real providers are wired by
 * env; tests use the deterministic implementations.
 */

// ---------------------------------------------------------------------- geo (CP-R1, CP-R2)

export interface Geo {
  country: string | null;
  region: string | null;
}

/** Country/region from the headers the edge adds (Vercel, Cloudflare, or our own proxy). Never from client input:
 * deploy behind a proxy that strips and sets these headers. */
export class HeaderGeoResolver {
  constructor(
    private readonly countryHeaders = ["x-vercel-ip-country", "cf-ipcountry", "x-geo-country"],
    private readonly regionHeaders = ["x-vercel-ip-country-region", "cf-region-code", "x-geo-region"],
  ) {}

  resolve(header: (name: string) => string | undefined): Geo {
    const first = (names: string[]) => names.map((n) => header(n)).find((v) => v && v !== "XX" && v !== "T1");
    const country = first(this.countryHeaders)?.toUpperCase() ?? null;
    const region = first(this.regionHeaders)?.toUpperCase() ?? null;
    return {country, region: region && country && !region.includes("-") ? `${country}-${region}` : region};
  }
}

// ---------------------------------------------------------------------- datacenter / VPN heuristic (CP-R2)

export interface IpReputation {
  /** True if the IP belongs to a hosting provider or a known VPN exit. */
  isDatacenter(ip: string): Promise<boolean>;
}

function ipv4ToInt(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.replace(/^::ffff:/, ""));
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** Static IPv4 CIDR list (config/datacenter-ranges.json or `DATACENTER_RANGES`). IPv6 is not classified here. */
export class StaticRangeReputation implements IpReputation {
  private readonly ranges: {base: number; mask: number}[];
  constructor(cidrs: string[]) {
    this.ranges = cidrs.map((c) => {
      const [ip, bits] = c.split("/");
      const b = Number(bits);
      const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
      const base = ipv4ToInt(ip);
      if (base === undefined || !(b >= 0 && b <= 32)) throw new Error(`bad CIDR ${c}`);
      return {base: (base & mask) >>> 0, mask};
    });
  }

  static fromConfig(env: NodeJS.ProcessEnv = process.env): StaticRangeReputation {
    if (env.DATACENTER_RANGES) return new StaticRangeReputation(env.DATACENTER_RANGES.split(",").map((s) => s.trim()).filter(Boolean));
    const file = JSON.parse(readFileSync(new URL("../config/datacenter-ranges.json", import.meta.url), "utf8")) as {ranges: string[]};
    return new StaticRangeReputation(file.ranges);
  }

  async isDatacenter(ip: string): Promise<boolean> {
    const n = ipv4ToInt(ip);
    if (n === undefined) return false;
    return this.ranges.some((r) => ((n & r.mask) >>> 0) === r.base);
  }
}

// ---------------------------------------------------------------------- sanctions (CP-R3)

export interface ScreenResult {
  sanctioned: boolean;
  provider: string;
  /** Provider reference for the audit trail (never shown to the user). */
  reference?: string;
}

export interface SanctionsScreen {
  screen(address: string): Promise<ScreenResult>;
}

/** Deterministic deny list (tests, and an emergency manual block list in production). */
export class DenyListScreen implements SanctionsScreen {
  private readonly set: Set<string>;
  constructor(addresses: string[]) {
    this.set = new Set(addresses.map((a) => a.toLowerCase()));
  }
  async screen(address: string): Promise<ScreenResult> {
    return {sanctioned: this.set.has(address.toLowerCase()), provider: "deny-list"};
  }
}

/**
 * Chainalysis Address Screening (entity risk API). Adapter only: the endpoint and key come from env and it is not
 * exercised in tests. Any error fails closed (the attestation is refused, exits are unaffected, CP-R4).
 */
export class ChainalysisScreen implements SanctionsScreen {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.chainalysis.com/api/risk/v2/entities",
  ) {}
  async screen(address: string): Promise<ScreenResult> {
    const headers = {Token: this.apiKey, accept: "application/json", "content-type": "application/json"};
    const reg = await fetch(this.baseUrl, {method: "POST", headers, body: JSON.stringify({address})});
    if (!reg.ok) throw new Error(`chainalysis register ${reg.status}`);
    const r = await fetch(`${this.baseUrl}/${address}`, {headers});
    if (!r.ok) throw new Error(`chainalysis ${r.status}`);
    const j = (await r.json()) as {risk?: string; riskReason?: string | null};
    return {sanctioned: j.risk === "Severe", provider: "chainalysis", reference: j.riskReason ?? undefined};
  }
}

/** TRM Labs wallet screening. Adapter only, same fail-closed rule. */
export class TrmScreen implements SanctionsScreen {
  constructor(
    private readonly apiKey: string,
    private readonly chain = "robinhood",
    private readonly url = "https://api.trmlabs.com/public/v2/screening/addresses",
  ) {}
  async screen(address: string): Promise<ScreenResult> {
    const r = await fetch(this.url, {
      method: "POST",
      headers: {"content-type": "application/json", authorization: `Basic ${Buffer.from(`${this.apiKey}:${this.apiKey}`).toString("base64")}`},
      body: JSON.stringify([{address, chain: this.chain}]),
    });
    if (!r.ok) throw new Error(`trm ${r.status}`);
    const j = (await r.json()) as {addressRiskIndicators?: {categoryRiskScoreLevelLabel?: string; category?: string}[]}[];
    const hit = (j[0]?.addressRiskIndicators ?? []).find((x) => x.category === "Sanctions" && x.categoryRiskScoreLevelLabel === "Severe");
    return {sanctioned: Boolean(hit), provider: "trm", reference: hit?.category};
  }
}

/** Provider from env: `SANCTIONS_PROVIDER=chainalysis|trm|deny-list` (+ `SANCTIONS_API_KEY`, `SANCTIONS_DENY_LIST`). */
export function sanctionsFromEnv(env: NodeJS.ProcessEnv = process.env): SanctionsScreen {
  const deny = (env.SANCTIONS_DENY_LIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  switch (env.SANCTIONS_PROVIDER ?? "deny-list") {
    case "chainalysis":
      if (!env.SANCTIONS_API_KEY) throw new Error("SANCTIONS_API_KEY is required for chainalysis");
      return new ChainalysisScreen(env.SANCTIONS_API_KEY);
    case "trm":
      if (!env.SANCTIONS_API_KEY) throw new Error("SANCTIONS_API_KEY is required for trm");
      return new TrmScreen(env.SANCTIONS_API_KEY);
    default:
      return new DenyListScreen(deny);
  }
}
