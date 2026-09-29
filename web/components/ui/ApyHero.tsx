"use client";
import {cn} from "@/lib/cn";
import {pct} from "@/lib/format";
import {NumberTicker} from "./NumberTicker";
import {Sparkline} from "./Sparkline";
import {Segmented} from "./Tabs";

export type ApyWindow = "7d" | "30d" | "90d";
const WINDOWS: ApyWindow[] = ["7d", "30d", "90d"];
const KEY = {"7d": "d7", "30d": "d30", "90d": "d90"} as const;

/**
 * Headline net APY for a yield product (CP-R7): always labelled "net APY (window, variable)" and historical. The
 * window switch changes the headline (it ticks) and whatever the caller ties to it; the other two windows stay
 * visible as text, and the sparkline shows the daily history.
 */
export function ApyHero({apy, series, window, onWindow, className}: {apy: {d7: number | null; d30: number | null; d90: number | null}; series: number[]; window: ApyWindow; onWindow: (w: ApyWindow) => void; className?: string}) {
  const others = WINDOWS.filter((w) => w !== window);
  return (
    <div className={cn("space-y-3", className)} data-testid="apy-hero">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] font-medium text-dim" data-testid="apy-label">
          Net APY ({window}, variable)
        </p>
        <Segmented<ApyWindow> label="APY window" value={window} onChange={onWindow} testIdPrefix="apy-" options={WINDOWS.map((w) => ({value: w, label: w}))} />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        {apy[KEY[window]] === null ? (
          <span className="text-[44px] font-medium leading-none tracking-[-0.035em] text-dim sm:text-[56px]" data-testid="apy-headline" title="Not enough history for this window yet">
            –
          </span>
        ) : (
          <NumberTicker value={apy[KEY[window]]!} format="pct" className="text-[44px] font-medium leading-none tracking-[-0.035em] text-supply sm:text-[56px]" data-testid="apy-headline" />
        )}
        {series.length > 1 && <Sparkline values={series} color="var(--supply)" width={148} height={40} label={`Daily net APY over the last ${series.length} days (historical)`} />}
      </div>
      <p className="num text-[13px] text-muted">
        {others.map((w) => `${w} ${apy[KEY[w]] === null ? "–" : pct(apy[KEY[w]]!)}`).join(" · ")} · historical, after costs and the performance fee
        {apy[KEY[window]] === null && " · not enough history for this window yet"}
      </p>
    </div>
  );
}
