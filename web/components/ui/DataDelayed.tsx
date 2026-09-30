"use client";
import {useEffect, useState} from "react";
import {CHAIN_ID} from "@/lib/env";
import {Notice} from "./Notice";

/** Minutes the API's data (`asOfTime`, the indexed block's time) is behind `nowMs`; undefined when under 2 minutes. */
export function delayMinutes(asOfTime: string | undefined, nowMs: number): number | undefined {
  if (!asOfTime) return undefined;
  const m = Math.floor((nowMs - Date.parse(asOfTime)) / 60_000);
  return m >= 2 ? m : undefined;
}

const age = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

/**
 * "Data is delayed" when the API's data is more than two minutes old (T28: while the indexer caught up, cached pages
 * showed hours-old numbers as current). Not on the local chain, whose clock runs apart from the wall clock.
 */
export function DataDelayed({asOfTime, now: fixedNow, className}: {asOfTime?: string; now?: number; className?: string}) {
  const [now, setNow] = useState(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [fixedNow]);
  const m = CHAIN_ID === 31337 && fixedNow === undefined ? undefined : delayMinutes(asOfTime, now);
  if (m === undefined) return null;
  return (
    <div className={className} data-testid="data-delayed">
      <Notice tone="warn" title="Data is delayed">
        Market data is {age(m)} old while the indexer catches up, so rates, totals and history may be out of date. Your positions and the health factor preview read the chain directly and are current.
      </Notice>
    </div>
  );
}
