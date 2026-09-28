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

/** A wallet screen. `screen` throws when it cannot give an answer (timeout, HTTP error, unexpected body): the caller
 * fails closed for entries (no attestation) and exits never call it (CP-R3, CP-R4). */
export interface SanctionsScreen {
  /** Provider name for the startup log and `/health` (never a key). */
  readonly name?: string;
  screen(address: string): Promise<ScreenResult>;
}

/** Deterministic deny list (tests, and an emergency manual block list in production). */
export class DenyListScreen implements SanctionsScreen {
  readonly name = "deny-list";
  private readonly set: Set<string>;
  constructor(addresses: string[]) {
    this.set = new Set(addresses.map((a) => a.toLowerCase()));
  }
  async screen(address: string): Promise<ScreenResult> {
    return {sanctioned: this.set.has(address.toLowerCase()), provider: "deny-list"};
  }
}

// Real providers (Chainalysis, TRM) and the env factory live in ./sanctions/ (Q5).
