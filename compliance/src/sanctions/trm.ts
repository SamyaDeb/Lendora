import {z} from "zod";
import type {SanctionsScreen, ScreenResult} from "../checks.js";
import {checkBaseUrl, DEFAULT_SCREEN_TIMEOUT_MS, getJson, ScreenUnavailable, type HttpOptions} from "./http.js";

/**
 * TRM Labs wallet screening (CP-R3, Q5). Built from the public reference
 * (https://documentation.trmlabs.com/tag/Screening): `POST /public/v2/screening/addresses` with a one-element array
 * `[{address, chain}]` and HTTP Basic auth `apiKey:apiKey`. The wallet is blocked when an entity it belongs to is in
 * the `Sanctions` category, or an ownership risk indicator (or any `Sanctions` indicator) is `Severe` (A36). The chain
 * name comes from `SANCTIONS_TRM_CHAIN` (default `ethereum`: TRM does not list Robinhood Chain; EVM addresses are the
 * same key across chains, A37 [VERIFY] with TRM). Anything that doesn't parse is an error: the attestation fails closed.
 */
export const TRM_BASE_URL = "https://api.trmlabs.com/public/v2/screening/addresses";

const indicator = z
  .object({category: z.string().nullish(), categoryRiskScoreLevelLabel: z.string().nullish(), riskType: z.string().nullish()})
  .loose();
const entityRef = z.object({category: z.string().nullish(), entity: z.string().nullish(), riskScoreLevelLabel: z.string().nullish()}).loose();
const result = z.array(
  z
    .object({
      address: z.string(),
      addressRiskIndicators: z.array(indicator).nullish(),
      entities: z.array(entityRef).nullish(),
    })
    .loose(),
);

export class TrmScreen implements SanctionsScreen {
  readonly name = "trm";
  private readonly url: string;
  constructor(
    private readonly apiKey: string,
    private readonly chain = "ethereum",
    url = TRM_BASE_URL,
    private readonly http: HttpOptions = {timeoutMs: DEFAULT_SCREEN_TIMEOUT_MS},
  ) {
    if (!apiKey) throw new Error("trm needs an API key");
    this.url = checkBaseUrl(url);
  }

  async screen(address: string): Promise<ScreenResult> {
    const auth = `Basic ${Buffer.from(`${this.apiKey}:${this.apiKey}`).toString("base64")}`;
    const raw = await getJson(
      this.name,
      "screen",
      this.url,
      {method: "POST", headers: {"content-type": "application/json", accept: "application/json", authorization: auth}, body: JSON.stringify([{address, chain: this.chain}])},
      this.http,
    );
    const p = result.safeParse(raw);
    if (!p.success || p.data.length !== 1) throw new ScreenUnavailable(this.name, "screen body");
    const row = p.data[0];
    if (row.address.toLowerCase() !== address.toLowerCase()) throw new ScreenUnavailable(this.name, "screen address mismatch");
    const isSanctions = (c?: string | null) => c?.toLowerCase() === "sanctions";
    const severe = (l?: string | null) => l?.toLowerCase() === "severe";
    const ent = (row.entities ?? []).find((e) => isSanctions(e.category));
    const ind = (row.addressRiskIndicators ?? []).find(
      (i) => severe(i.categoryRiskScoreLevelLabel) && (isSanctions(i.category) || i.riskType?.toUpperCase() === "OWNERSHIP"),
    );
    const sanctioned = Boolean(ent ?? ind);
    return {sanctioned, provider: this.name, reference: sanctioned ? (ent?.entity ?? ent?.category ?? ind?.category ?? "severe") : undefined};
  }
}
