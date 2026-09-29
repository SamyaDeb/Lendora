import createFetchClient from "openapi-fetch";
import type {components, paths} from "./schema.js";

/**
 * Typed client for the Stockline public API (docs/prd/07 §2), generated from `api/openapi.json` (OpenAPI 3.1):
 * `schema.ts` is produced by `pnpm --filter @stockline/api openapi` and only wrapped here.
 *
 *   import {api} from "@stockline/sdk";
 *   const sl = api.createClient("https://api.stockline.xyz", {apiKey});
 *   const {data} = await sl.markets();
 */
export type {paths, components};
export type Market = components["schemas"]["Market"];
export type MarketDetail = components["schemas"]["MarketDetail"];
export type HistoryPoint = components["schemas"]["HistoryPoint"];
export type Event = components["schemas"]["Event"];
export type Position = components["schemas"]["Position"];
export type StatusResponse = components["schemas"]["StatusResponse"];
export type RevenueResponse = components["schemas"]["RevenueResponse"];
export type VaultOverviewResponse = components["schemas"]["VaultOverviewResponse"];
export type VaultAccountResponse = components["schemas"]["VaultAccountResponse"];
export type ReceiptMarketsResponse = components["schemas"]["ReceiptMarketsResponse"];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  apiKey?: string;
  fetch?: typeof fetch;
}

type Result<T> = {data?: T; error?: unknown; response: Response};

async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (r.error !== undefined || r.data === undefined) {
    const msg = (r.error as {error?: string} | undefined)?.error ?? `HTTP ${r.response.status}`;
    throw new ApiError(r.response.status, msg);
  }
  return r.data;
}

export function createClient(baseUrl: string, opts: ClientOptions = {}) {
  const headers = opts.apiKey ? {"X-API-Key": opts.apiKey} : undefined;
  const c = createFetchClient<paths>({baseUrl, headers, fetch: opts.fetch});
  const base = baseUrl.replace(/\/$/, "");
  return {
    raw: c,
    markets: () => unwrap(c.GET("/v1/markets")),
    market: (symbol: string) => unwrap(c.GET("/v1/markets/{symbol}", {params: {path: {symbol}}})),
    history: (symbol: string, query: {interval?: "1m" | "1h" | "1d"; from?: string; to?: string; limit?: number} = {}) =>
      unwrap(c.GET("/v1/markets/{symbol}/history", {params: {path: {symbol}, query: {...query, format: "json"}}})) as Promise<components["schemas"]["HistoryResponse"]>,
    /** SI-R12: the same series as CSV text. */
    historyCsv: async (symbol: string, query: {interval?: "1m" | "1h" | "1d"; from?: string; to?: string} = {}) => {
      const qs = new URLSearchParams({...query, format: "csv"} as Record<string, string>);
      const r = await (opts.fetch ?? fetch)(`${base}/v1/markets/${encodeURIComponent(symbol)}/history?${qs}`, {headers});
      if (!r.ok) throw new ApiError(r.status, await r.text());
      return r.text();
    },
    events: (symbol: string, query: {type?: "borrow" | "repay" | "liquidate" | "lend" | "withdrawLend" | "all"; cursor?: string; limit?: number; account?: string} = {}) =>
      unwrap(c.GET("/v1/markets/{symbol}/events", {params: {path: {symbol}, query}})),
    positions: (address: string) => unwrap(c.GET("/v1/positions/{address}", {params: {path: {address}}})),
    status: () => unwrap(c.GET("/v1/status")),
    /** FE-R5: protocol revenue per stock per day (UTC days `YYYY-MM-DD`, default the last 90). */
    revenue: (query: {from?: string; to?: string} = {}) => unwrap(c.GET("/v1/protocol/revenue", {params: {query}})),
    /** DN-R11: USDG Earn overview (historical, variable rates; CP-R7). */
    vaultOverview: () => unwrap(c.GET("/v1/vault/overview")),
    /** USDG Earn position and withdrawal requests of an address. */
    vaultAccount: (address: string) => unwrap(c.GET("/v1/vault/account/{address}", {params: {path: {address}}})),
    /** A3: G5 receipt markets (rSTOCK collateral, USDG loans). */
    receiptMarkets: () => unwrap(c.GET("/v1/receipt-markets")),
    terms: () => unwrap(c.GET("/v1/terms")),
    nonce: () => unwrap(c.GET("/v1/auth/nonce")),
    createKey: (message: string, signature: string, label?: string) => unwrap(c.POST("/v1/auth/keys", {body: {message, signature, label}})),
    keys: () => unwrap(c.GET("/v1/auth/keys")),
    revokeKey: (id: string) => unwrap(c.DELETE("/v1/auth/keys/{id}", {params: {path: {id}}})),
    /** `WS /v1/stream` URL (send `{"channel":"market","symbol":"NVDA"}`). */
    streamUrl: () => `${base.replace(/^http/, "ws")}/v1/stream${opts.apiKey ? `?apiKey=${encodeURIComponent(opts.apiKey)}` : ""}`,
  };
}

export type StocklineApiClient = ReturnType<typeof createClient>;
