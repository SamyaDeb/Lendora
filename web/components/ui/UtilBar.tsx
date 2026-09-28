"use client";
import {motion, useReducedMotion} from "motion/react";
import {cn} from "@/lib/cn";
import {pct} from "@/lib/format";
import {DUR, EASE_OUT} from "./motion";

/**
 * Utilization bar with the U_MAX cap marked. The fill animates with scaleX (transform only); its color moves from
 * the brand accent to caution near the cap and danger at it. The percentage is always printed next to it.
 */
export function UtilBar({value, cap = 0.9, showLabel = true, className, ...rest}: {value: number; cap?: number; showLabel?: boolean; className?: string; "data-col"?: string}) {
  const reduce = useReducedMotion();
  const v = Math.round(Math.max(0, Math.min(1, value)) * 1e4) / 1e4; // rounded: same transform on server and client
  const color = v >= cap ? "var(--danger)" : v >= cap - 0.1 ? "var(--caution)" : "var(--accent-text)";
  return (
    <span className={cn("flex w-full items-center gap-2.5", className)} {...rest}>
      {showLabel && <span className="num w-[52px] text-right">{pct(v, 1)}</span>}
      <span
        className="relative block h-1.5 w-full min-w-14 overflow-hidden rounded-full bg-white/[0.08]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 1000) / 10}
        aria-label="Utilization"
      >
        <motion.span
          className="absolute inset-y-0 left-0 w-full origin-left rounded-full"
          initial={false}
          animate={{scaleX: v, backgroundColor: color}}
          transition={reduce ? {duration: 0} : {duration: DUR.num, ease: EASE_OUT}}
        />
        <span aria-hidden className="absolute inset-y-[-2px] w-px bg-white/50" style={{left: `${cap * 100}%`}} title={`Cap ${pct(cap, 0)}`} />
      </span>
    </span>
  );
}

/** Progress toward a goal (e.g. backstop coverage target): fills in the positive color; reaching 100% is good. */
export function ProgressBar({value, label}: {value: number; label: string}) {
  const v = Math.round(Math.max(0, Math.min(1, value)) * 1e4) / 1e4;
  return (
    <span className="flex w-full items-center gap-2.5">
      <span className="num w-[52px] text-right">{pct(v, 0)}</span>
      <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}>
        <motion.span className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-success" initial={false} animate={{scaleX: v}} transition={{duration: DUR.num, ease: EASE_OUT}} />
      </span>
    </span>
  );
}
