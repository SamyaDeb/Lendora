import {api} from "@stockline/sdk";
import {API_URL, API_URL_SERVER} from "./env";

/** The SDK's typed client for the public API (APP-R5: lists and charts come from the API). */
export const browserApi = () => api.createClient(API_URL);

/** Server components: short revalidation so first paint is fast and fresh (Lighthouse, APP-R7). */
export const serverApi = () =>
  api.createClient(API_URL_SERVER, {fetch: ((input: RequestInfo, init?: RequestInit) => fetch(input, {...init, next: {revalidate: 5}} as RequestInit)) as typeof fetch});

/** Server-side fetch that never throws: the page renders an "unavailable" state instead. */
export async function safe<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

export type Market = api.Market;
export type MarketDetail = api.MarketDetail;
export type HistoryPoint = api.HistoryPoint;
