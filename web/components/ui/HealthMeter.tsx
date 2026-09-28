"use client";
import {formatUnits} from "viem";
import {motion, useReducedMotion} from "motion/react";
import {cn} from "@/lib/cn";
import {hfText, hfTone} from "@/lib/format";
import {Icon, type IconName} from "./Icon";
import {DUR, EASE_OUT} from "./motion";
import {NumberTicker} from "./NumberTicker";

const TONE = {
  safe: {color: "var(--success)", text: "text-success", word: "Healthy", icon: "check"},
  warn: {color: "var(--caution)", text: "text-caution", word: "At risk", icon: "alert"},
  danger: {color: "var(--danger)", text: "text-danger", word: "Close to liquidation", icon: "alert"},
  none: {color: "var(--text-muted)", text: "text-muted", word: "No debt", icon: "check"},
} as const;

/** APP-R6 colors (≥ 1.5 green, 1.1–1.5 amber, < 1.1 red); the text says liquidation happens at 1.00. */
export function HealthFactor({hf, label}: {hf?: bigint; label?: string}) {
  const tone = hfTone(hf);
  const cls = {safe: "text-success", warn: "text-caution", danger: "text-danger", none: ""}[tone];
  const word = {safe: "healthy", warn: "at risk", danger: "close to liquidation", none: ""}[tone];
  return (
    <span className={`num font-semibold ${cls}`} title="Liquidation happens at 1.00" data-hf-tone={tone} data-wad={hf?.toString()}>
      {label ? `${label} ` : ""}
      {hfText(hf)}
      {word && <span className="sr-only"> ({word}; liquidation at 1.00)</span>}
    </span>
  );
}

/** Rounded so the server and client render the same transform. */
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const hfNum = (hf?: bigint) => (hf === undefined ? undefined : hf > 10n ** 30n ? Infinity : Number(formatUnits(hf, 18)));
/** Position on the meter: 1.0 → 0%, 1.1 → 12%, 1.5 → 45%, 3.0+ → 100% (log scale, so the risky end has room). */
const pos = (v: number | undefined) => (v === undefined ? 0 : !Number.isFinite(v) ? 1 : Math.max(0, Math.min(1, Math.log(Math.max(v, 1)) / Math.log(3))));

/**
 * Health meter: a track with the three APP-R6 zones, a fill to the current HF, the value (animated), a word and an
 * icon. When `next` is given (a preview), the fill shows the new value and the old one stays as a ghost tick.
 */
export function HealthMeter({hf, next, size = "md", className, ...rest}: {hf?: bigint; next?: bigint; size?: "sm" | "md"; className?: string; "data-testid"?: string}) {
  const reduce = useReducedMotion();
  const shown = next ?? hf;
  const tone = hfTone(shown);
  const t = TONE[tone];
  const v = hfNum(shown);
  const zones = [pos(1.1), pos(1.5)].map((z) => (z * 100).toFixed(2));
  return (
    <div className={cn("space-y-1.5", className)} {...rest}>
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium", t.text)}>
          <Icon name={t.icon as IconName} size={14} />
          {t.word}
        </span>
        <span className="flex items-baseline gap-1.5">
          {next !== undefined && hf !== undefined && hf !== next && (
            <>
              <span className="num text-[13px] text-muted">{hfText(hf)}</span>
              <Icon name="chevronRight" size={12} className="text-muted" />
            </>
          )}
          <NumberTicker value={v} format="hf" className={cn(size === "md" ? "text-xl" : "text-base", "font-medium", t.text)} />
          <span data-hf-tone={tone} data-wad={shown?.toString()} className="sr-only">
            Health factor {hfText(shown)}. Liquidation happens at 1.00.
          </span>
        </span>
      </div>
      <div className={cn("relative w-full overflow-hidden rounded-full bg-white/[0.07]", size === "md" ? "h-2" : "h-1.5")} aria-hidden>
        {/* zone boundaries */}
        <span className="absolute inset-y-0 w-px bg-white/25" style={{left: `${zones[0]}%`}} />
        <span className="absolute inset-y-0 w-px bg-white/25" style={{left: `${zones[1]}%`}} />
        <motion.span
          className="absolute inset-y-0 left-0 w-full origin-left rounded-full"
          initial={false}
          animate={{scaleX: tone === "none" ? 0 : round4(Math.max(0.02, pos(v))), backgroundColor: t.color}}
          transition={reduce ? {duration: 0} : {duration: DUR.num, ease: EASE_OUT}}
        />
        {next !== undefined && hf !== undefined && hfNum(hf) !== undefined && (
          <span className="absolute inset-y-0 w-0.5 bg-white/70" style={{left: `calc(${(pos(hfNum(hf)) * 100).toFixed(2)}% - 1px)`}} />
        )}
      </div>
      <div className="flex justify-between text-[11.5px] text-muted" aria-hidden>
        <span>Liquidation at 1.00</span>
        <span className="num">1.1 · 1.5 · 3.0+</span>
      </div>
    </div>
  );
}
