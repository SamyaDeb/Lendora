"use client";
import {motion} from "motion/react";
import {cn} from "@/lib/cn";
import type {StepState} from "@/lib/tx";
import {EASE_OUT} from "./motion";

const WORD: Record<StepState["status"], string> = {pending: "Waiting", active: "Confirm in your wallet", done: "Done", failed: "Failed", skipped: "Already done"};

function Mark({status}: {status: StepState["status"]}) {
  const base = "relative grid size-6 shrink-0 place-items-center rounded-full";
  if (status === "done")
    return (
      <span className={cn(base, "bg-success text-[#0b0a18]")}>
        <svg viewBox="0 0 20 20" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <motion.path d="M4.5 10.5l3.5 3.5L15.5 6" initial={{pathLength: 0}} animate={{pathLength: 1}} transition={{duration: 0.28, ease: EASE_OUT}} />
        </svg>
      </span>
    );
  if (status === "failed")
    return (
      <span className={cn(base, "bg-danger text-[#0b0a18]")}>
        <svg viewBox="0 0 20 20" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden>
          <path d="M5 5l10 10M15 5L5 15" />
        </svg>
      </span>
    );
  if (status === "active")
    return (
      <span className={cn(base, "shadow-[inset_0_0_0_2px_var(--accent)]")}>
        <span className="size-2 rounded-full bg-accent-text motion-safe:animate-pulse" />
      </span>
    );
  if (status === "skipped")
    return (
      <span className={cn(base, "bg-white/[0.06] text-muted")}>
        <svg viewBox="0 0 20 20" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <path d="M6 10h8" />
        </svg>
      </span>
    );
  return <span className={cn(base, "shadow-[inset_0_0_0_1.5px_var(--border-strong)]")} />;
}

/**
 * APP-R3 transaction stepper (Approve → Authorize Morpho, first time only → … → Confirm). Each finished step draws
 * its check. `data-status` on each item is what the e2e tests read.
 */
export function StepList({steps, className}: {steps: StepState[]; className?: string}) {
  if (!steps.length) return null;
  return (
    <ol className={cn("space-y-0", className)} aria-label="Transaction steps" data-testid="steps">
      {steps.map((s, i) => (
        <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0" data-status={s.status} aria-current={s.status === "active" ? "step" : undefined}>
          {i < steps.length - 1 && <span aria-hidden className={cn("absolute left-[11.5px] top-7 bottom-1 w-px", s.status === "done" || s.status === "skipped" ? "bg-success/50" : "bg-white/12")} />}
          <Mark status={s.status} />
          <div className="min-w-0 pt-0.5">
            <p className={cn("text-[14px] leading-snug", s.status === "pending" ? "text-muted" : s.status === "skipped" ? "text-muted line-through decoration-white/20" : "text-fg")}>
              {s.label}
            </p>
            <p className={cn("text-[12.5px]", s.status === "failed" ? "text-danger" : s.status === "active" ? "text-accent-text" : "text-muted")}>
              {s.detail ?? WORD[s.status]}
              <span className="sr-only"> ({s.status})</span>
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
