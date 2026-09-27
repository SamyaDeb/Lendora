import {feedSessions, fullBuffer, type MarketChainState, type Session} from "@stockline/sdk";
import type {Incident, MonitorStore, WeekendEntry} from "./store.js";

/**
 * Weekend log (evidence for the Phase 2 exit "2 clean testnet weekends", runbooks/testnet.md weekend watch). For every
 * feed closure of at least 24h (weekends, holidays) and every market it records, once, when the monitor first saw:
 * `ramp_in_start` (buffer above the floor in the ramp window), `full_buffer` (buffer at b_full for the closure),
 * `closed`, `first_fresh_round` (first feed round at/after the reopen) and `ramp_out` (buffer back at the floor), plus
 * every guard trip/clear between the ramp start and 24h after the reopen. Milestones the monitor did not observe (it
 * was down) stay missing, so the weekend is not "clean": evidence, not eyeballing.
 */
export const MIN_WEEKEND_SEC = 24 * 3600;
export const MILESTONES = ["ramp_in_start", "full_buffer", "closed", "first_fresh_round", "ramp_out"] as const;

export interface Closure {
  closeTs: number;
  reopenTs: number;
}

/** The weekend closures around `now`: the one ahead (or in progress) and the one just behind. */
export function closuresAround(now: number, sessions: Session[] = feedSessions): {ahead?: Closure; behind?: Closure; open: boolean} {
  const i = sessions.findIndex((s) => s.closeTs > now);
  if (i < 0) return {open: false};
  const s = sessions[i];
  const open = s.openTs <= now;
  const weekend = (c: Closure | undefined) => (c && c.reopenTs - c.closeTs >= MIN_WEEKEND_SEC ? c : undefined);
  if (open) {
    return {
      open,
      ahead: weekend(sessions[i + 1] ? {closeTs: s.closeTs, reopenTs: sessions[i + 1].openTs} : undefined),
      behind: weekend(i > 0 ? {closeTs: sessions[i - 1].closeTs, reopenTs: s.openTs} : undefined),
    };
  }
  return {open, ahead: weekend(i > 0 ? {closeTs: sessions[i - 1].closeTs, reopenTs: s.openTs} : undefined)};
}

/** The weekend a guard event at `ts` belongs to (ramp start … reopen + 24h), if any. */
export function closureForEvent(ts: number, rampIn: number, sessions: Session[] = feedSessions): Closure | undefined {
  for (let i = 1; i < sessions.length; i++) {
    const c = {closeTs: sessions[i - 1].closeTs, reopenTs: sessions[i].openTs};
    if (c.reopenTs - c.closeTs < MIN_WEEKEND_SEC) continue;
    if (ts >= c.closeTs - rampIn && ts <= c.reopenTs + 24 * 3600) return c;
    if (c.closeTs - rampIn > ts) break;
  }
  return undefined;
}

/** Record the milestones visible in one market read. */
export async function recordMilestones(store: MonitorStore, st: MarketChainState, sessions: Session[] = feedSessions): Promise<string[]> {
  const now = Number(st.now);
  const {ahead, behind, open} = closuresAround(now, sessions);
  const logged: string[] = [];
  const log = async (c: Closure, kind: string, detail: Record<string, unknown>, ts = st.now) => {
    const e: WeekendEntry = {ticker: st.ticker, closeTs: BigInt(c.closeTs), reopenTs: BigInt(c.reopenTs), kind, seq: "", block: st.block, ts, detail};
    if (await store.logWeekend(e)) logged.push(kind);
  };
  const p = st.params;
  if (ahead) {
    const bFull = fullBuffer(p.z, p.sigma, p.bMin, p.bMax, BigInt(ahead.reopenTs - ahead.closeTs));
    const rampStart = ahead.closeTs - Number(p.rampIn);
    if (now >= rampStart && st.bufferNow > st.bufferFloor) await log(ahead, "ramp_in_start", {buffer: st.bufferNow.toString()});
    if (now >= rampStart && st.bufferNow >= bFull) await log(ahead, "full_buffer", {buffer: st.bufferNow.toString(), bFull: bFull.toString()});
    if (!open && now >= ahead.closeTs) await log(ahead, "closed", {buffer: st.bufferNow.toString()});
  }
  if (behind && open) {
    if (st.stockUpdatedAt >= BigInt(behind.reopenTs)) {
      await log(behind, "first_fresh_round", {updatedAt: st.stockUpdatedAt.toString(), answer: st.stockAnswer.toString()}, st.stockUpdatedAt);
      if (st.bufferNow <= st.bufferFloor) await log(behind, "ramp_out", {buffer: st.bufferNow.toString()});
    }
  }
  return logged;
}

export interface WeekendReport {
  closeTs: string;
  reopenTs: string;
  markets: Record<string, {milestones: Record<string, {ts: string; block: string; detail: Record<string, unknown>}>; guardEvents: {kind: string; ts: string; block: string; detail: Record<string, unknown>}[]; complete: boolean}>;
  /** P0/P1 incidents opened while this weekend was being logged. */
  incidents: {rule: string; subject: string; severity: string; openedBlock: string}[];
  clean: boolean;
}

/** `GET /weekends`: entries grouped by closure and market, with the cleanliness verdict. */
export async function weekendReports(store: MonitorStore, tickers: string[], limit = 20): Promise<WeekendReport[]> {
  const entries = await store.weekendEntries(limit);
  const byClose = new Map<string, WeekendEntry[]>();
  for (const e of entries) byClose.set(e.closeTs.toString(), [...(byClose.get(e.closeTs.toString()) ?? []), e]);
  const out: WeekendReport[] = [];
  for (const [closeTs, list] of byClose) {
    const markets: WeekendReport["markets"] = {};
    for (const t of tickers) markets[t] = {milestones: {}, guardEvents: [], complete: false};
    for (const e of list) {
      const m = (markets[e.ticker] ??= {milestones: {}, guardEvents: [], complete: false});
      const v = {ts: e.ts.toString(), block: e.block.toString(), detail: e.detail};
      if (e.kind.startsWith("guard_")) m.guardEvents.push({kind: e.kind, ...v});
      else m.milestones[e.kind] = v;
    }
    for (const m of Object.values(markets)) m.complete = MILESTONES.every((k) => k in m.milestones);
    const blocks = list.map((e) => e.block);
    const lo = blocks.reduce((a, b) => (b < a ? b : a));
    const hi = blocks.reduce((a, b) => (b > a ? b : a));
    const incidents = (await store.openedBetween(lo, hi)).filter((i: Incident) => i.severity !== "P2");
    const noTrips = Object.values(markets).every((m) => !m.guardEvents.some((g) => g.kind === "guard_trip"));
    out.push({
      closeTs,
      reopenTs: list[0].reopenTs.toString(),
      markets,
      incidents: incidents.map((i) => ({rule: i.rule, subject: i.subject, severity: i.severity, openedBlock: i.openedBlock.toString()})),
      clean: Object.values(markets).every((m) => m.complete) && noTrips && incidents.length === 0,
    });
  }
  return out;
}
