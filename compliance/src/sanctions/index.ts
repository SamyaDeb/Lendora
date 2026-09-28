import {DenyListScreen, type SanctionsScreen, type ScreenResult} from "../checks.js";
import {ChainalysisScreen, CHAINALYSIS_BASE_URL} from "./chainalysis.js";
import {DEFAULT_SCREEN_TIMEOUT_MS} from "./http.js";
import {TrmScreen, TRM_BASE_URL} from "./trm.js";

export {ChainalysisScreen, CHAINALYSIS_BASE_URL} from "./chainalysis.js";
export {TrmScreen, TRM_BASE_URL} from "./trm.js";
export {ScreenUnavailable, DEFAULT_SCREEN_TIMEOUT_MS} from "./http.js";

export const SANCTIONS_PROVIDERS = ["deny-list", "chainalysis", "trm"] as const;
export type SanctionsProvider = (typeof SANCTIONS_PROVIDERS)[number];

/**
 * The manual deny list runs first on every provider (emergency block list, CP-R3); a hit never calls the provider,
 * and a miss falls through to it. The provider's error propagates, so the attestation fails closed.
 */
export class LayeredScreen implements SanctionsScreen {
  readonly name: string;
  constructor(
    private readonly deny: DenyListScreen,
    private readonly provider: SanctionsScreen,
  ) {
    this.name = provider.name ?? "custom";
  }
  async screen(address: string): Promise<ScreenResult> {
    const d = await this.deny.screen(address);
    return d.sanctioned ? d : this.provider.screen(address);
  }
}

/** The provider named by `SANCTIONS_PROVIDER` (default `deny-list`); unknown names are refused instead of falling back. */
export function sanctionsProviderOf(env: NodeJS.ProcessEnv): SanctionsProvider {
  const p = (env.SANCTIONS_PROVIDER || "deny-list").trim().toLowerCase();
  if (!(SANCTIONS_PROVIDERS as readonly string[]).includes(p)) throw new Error(`SANCTIONS_PROVIDER must be one of ${SANCTIONS_PROVIDERS.join("|")} (got "${p}")`);
  return p as SanctionsProvider;
}

/**
 * Sanctions screen from env (CP-R3, Q5):
 *   SANCTIONS_PROVIDER    deny-list | chainalysis | trm
 *   SANCTIONS_API_KEY     provider key (required for chainalysis and trm)
 *   SANCTIONS_DENY_LIST   comma-separated addresses, checked before any provider
 *   SANCTIONS_API_URL     base URL override (https; http only on localhost), e.g. an egress proxy
 *   SANCTIONS_TIMEOUT_MS  per-request timeout (default 5000)
 *   SANCTIONS_TRM_CHAIN   TRM chain name (default ethereum, A37)
 */
export function sanctionsFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): SanctionsScreen {
  const deny = new DenyListScreen((env.SANCTIONS_DENY_LIST ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const provider = sanctionsProviderOf(env);
  if (provider === "deny-list") return deny;
  const key = env.SANCTIONS_API_KEY ?? "";
  if (!key) throw new Error(`SANCTIONS_API_KEY is required for ${provider}`);
  const timeoutMs = Number(env.SANCTIONS_TIMEOUT_MS || DEFAULT_SCREEN_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error("SANCTIONS_TIMEOUT_MS must be between 100 and 30000");
  const http = {timeoutMs, fetch: fetchImpl};
  const screen =
    provider === "chainalysis"
      ? new ChainalysisScreen(key, env.SANCTIONS_API_URL || CHAINALYSIS_BASE_URL, http)
      : new TrmScreen(key, env.SANCTIONS_TRM_CHAIN || "ethereum", env.SANCTIONS_API_URL || TRM_BASE_URL, http);
  return new LayeredScreen(deny, screen);
}
