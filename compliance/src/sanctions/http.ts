/**
 * Shared HTTP plumbing for the sanctions providers (CP-R3, Q5). Every call has a hard timeout, and every failure
 * becomes a `ScreenUnavailable` whose message names only the provider, the step and the HTTP status: never the API
 * key, the request headers or the response body (offchain review: no secret in logs or errors).
 */
export class ScreenUnavailable extends Error {
  constructor(
    readonly provider: string,
    readonly step: string,
    readonly status?: number,
  ) {
    super(`${provider} ${step} unavailable${status ? ` (HTTP ${status})` : ""}`);
  }
}

/** Default per-request timeout. The attestation request waits for it, so it stays well under the web proxy's. */
export const DEFAULT_SCREEN_TIMEOUT_MS = 5_000;

export interface HttpOptions {
  timeoutMs: number;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export async function getJson(provider: string, step: string, url: string, init: RequestInit, o: HttpOptions): Promise<unknown> {
  let r: Response;
  try {
    r = await (o.fetch ?? fetch)(url, {...init, redirect: "error", signal: AbortSignal.timeout(o.timeoutMs)});
  } catch {
    throw new ScreenUnavailable(provider, step); // timeout, DNS, TLS, reset, redirect: all fail closed
  }
  if (!r.ok) {
    await r.body?.cancel().catch(() => undefined);
    throw new ScreenUnavailable(provider, step, r.status);
  }
  try {
    return await r.json();
  } catch {
    throw new ScreenUnavailable(provider, `${step} body`);
  }
}

/** Base URL override (fake servers in tests, an egress proxy in production). Only https off localhost. */
export function checkBaseUrl(url: string): string {
  const u = new URL(url);
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error(`SANCTIONS_API_URL must be https (got ${u.protocol})`);
  if (u.username || u.password) throw new Error("SANCTIONS_API_URL must not carry credentials");
  return url.replace(/\/+$/, "");
}
