import {etToUnix, parseYmd} from "./time.js";

/** Typed input for scheduled events (`packages/sdk/data/events.json`, D5, OR-R14). */
export interface EarningsEvent {
  ticker: string;
  /** Report date, `YYYY-MM-DD` (ET). */
  date: string;
  /** `AMC` = after market close, `BMO` = before market open. */
  timing: "AMC" | "BMO";
  /** Scheduled release time, `HH:MM` ET: the earliest a feed round can carry the result (becomes `endTs`). */
  releaseTimeET: string;
  /** Hours before release at which the buffer must be fully in force (`startTs = endTs − holdHours`). */
  holdHours: number;
  /** Event buffer, 1e18 = 100% (NVDA ≥ 10%, AAPL ≥ 8%; D5). */
  bufferWad: string;
  /** True once the company itself has announced the date. */
  confirmed: boolean;
  /** Where the date comes from. */
  source: string;
}

export interface EventsFile {
  $comment: string;
  events: EarningsEvent[];
}

/** One onchain event window (matches `IMarketHours.EventWindow`). */
export interface EventWindow {
  startTs: number;
  endTs: number;
  bufferWad: bigint;
}

export function toEventWindow(e: EarningsEvent): EventWindow {
  const [h, m] = e.releaseTimeET.split(":").map(Number);
  const endTs = etToUnix(parseYmd(e.date), h, m);
  if (!(e.holdHours >= 0)) throw new Error(`bad holdHours for ${e.ticker} ${e.date}`);
  const bufferWad = BigInt(e.bufferWad);
  if (bufferWad < 0n || bufferWad > 2n * 10n ** 17n) throw new Error(`buffer out of range for ${e.ticker}`);
  return {startTs: endTs - Math.round(e.holdHours * 3600), endTs, bufferWad};
}

/** Event windows per ticker, ordered by start. */
export function eventWindowsByTicker(file: EventsFile): Record<string, EventWindow[]> {
  const out: Record<string, EventWindow[]> = {};
  for (const e of file.events) (out[e.ticker] ??= []).push(toEventWindow(e));
  for (const list of Object.values(out)) list.sort((a, b) => a.startTs - b.startTs);
  return out;
}
