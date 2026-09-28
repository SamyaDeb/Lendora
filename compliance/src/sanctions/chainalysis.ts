import {z} from "zod";
import type {SanctionsScreen, ScreenResult} from "../checks.js";
import {checkBaseUrl, DEFAULT_SCREEN_TIMEOUT_MS, getJson, ScreenUnavailable, type HttpOptions} from "./http.js";

/**
 * Chainalysis Address Screening API, v2 entities (CP-R3, Q5). Built from the public reference
 * (https://docs.chainalysis.com/api/address-screening/): register the address with
 * `POST /api/risk/v2/entities {address}`, then read `GET /api/risk/v2/entities/{address}`; the key goes in the `Token`
 * header. The wallet is blocked when the entity risk is `Severe` or any direct identification is in the `sanctions`
 * category (A36). A response that is not `COMPLETE`, or that doesn't parse, is an error: the attestation fails closed.
 */
export const CHAINALYSIS_BASE_URL = "https://api.chainalysis.com/api/risk/v2/entities";

const entity = z.object({
  address: z.string().optional(),
  risk: z.enum(["Low", "Medium", "High", "Severe"]),
  riskReason: z.string().nullish(),
  status: z.string().optional(),
  addressIdentifications: z.array(z.object({category: z.string().nullish(), name: z.string().nullish()}).loose()).nullish(),
});

export class ChainalysisScreen implements SanctionsScreen {
  readonly name = "chainalysis";
  private readonly baseUrl: string;
  constructor(
    private readonly apiKey: string,
    baseUrl = CHAINALYSIS_BASE_URL,
    private readonly http: HttpOptions = {timeoutMs: DEFAULT_SCREEN_TIMEOUT_MS},
  ) {
    if (!apiKey) throw new Error("chainalysis needs an API key");
    this.baseUrl = checkBaseUrl(baseUrl);
  }

  async screen(address: string): Promise<ScreenResult> {
    const headers = {Token: this.apiKey, accept: "application/json", "content-type": "application/json"};
    await getJson(this.name, "register", this.baseUrl, {method: "POST", headers, body: JSON.stringify({address})}, this.http);
    const raw = await getJson(this.name, "entity", `${this.baseUrl}/${encodeURIComponent(address)}`, {method: "GET", headers}, this.http);
    const p = entity.safeParse(raw);
    if (!p.success) throw new ScreenUnavailable(this.name, "entity body");
    if (p.data.status !== undefined && p.data.status !== "COMPLETE") throw new ScreenUnavailable(this.name, `entity status ${p.data.status}`);
    if (p.data.address !== undefined && p.data.address.toLowerCase() !== address.toLowerCase()) throw new ScreenUnavailable(this.name, "entity address mismatch");
    const ids = (p.data.addressIdentifications ?? []).filter((i) => i.category?.toLowerCase() === "sanctions");
    const sanctioned = p.data.risk === "Severe" || ids.length > 0;
    return {sanctioned, provider: this.name, reference: sanctioned ? (p.data.riskReason ?? ids[0]?.name ?? p.data.risk) : undefined};
  }
}
