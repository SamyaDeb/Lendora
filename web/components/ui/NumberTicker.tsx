"use client";
import {useEffect, useRef} from "react";
import {animate, useReducedMotion} from "motion/react";
import {cn} from "@/lib/cn";
import {num} from "@/lib/format";
import {DUR, EASE_OUT} from "./motion";

export type TickerFormat = "num" | "usd" | "pct" | "hf";

export function formatTicker(v: number, format: TickerFormat, digits: number): string {
  if (!Number.isFinite(v)) return "–";
  switch (format) {
    case "usd":
      return `$${num(v, digits)}`;
    case "pct":
      return `${num(v * 100, digits)}%`;
    case "hf":
      return v > 1e12 ? "∞" : num(v, digits);
    default:
      return num(v, digits);
  }
}

/**
 * A number that eases to its new value (400 ms, ease-out) when the value really changes; first render and
 * re-renders with the same value do nothing. Reduced motion: the new value appears at once. Screen readers get the
 * final value only (the animated text is aria-hidden).
 */
export function NumberTicker({value, format = "num", digits = 2, prefix = "", suffix = "", className, ...rest}: {value: number | undefined; format?: TickerFormat; digits?: number; prefix?: string; suffix?: string; className?: string; "data-testid"?: string}) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);
  const reduce = useReducedMotion();
  const text = value === undefined ? "–" : formatTicker(value, format, digits);

  useEffect(() => {
    const el = ref.current;
    const from = prev.current;
    prev.current = value;
    if (!el || value === undefined || from === undefined || from === value || !Number.isFinite(from) || !Number.isFinite(value)) {
      if (el) el.textContent = text;
      return;
    }
    if (reduce || (format === "hf" && (from > 1e12 || value > 1e12))) {
      el.textContent = text;
      return;
    }
    const c = animate(from, value, {duration: DUR.num, ease: EASE_OUT, onUpdate: (v) => (el.textContent = formatTicker(v, format, digits))});
    return () => c.stop();
  }, [value, text, format, digits, reduce]);

  return (
    <span className={cn("num", className)} {...rest}>
      {prefix}
      <span ref={ref} aria-hidden>
        {text}
      </span>
      <span className="sr-only">{text}</span>
      {suffix}
    </span>
  );
}
