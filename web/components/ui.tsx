import type {ReactNode} from "react";
import Link from "next/link";
import {hfText, hfTone} from "@/lib/format";
import type {StepState} from "@/lib/tx";

const STATUS: Record<string, {label: string; cls: string}> = {
  open: {label: "Open", cls: "bg-[var(--color-safe-bg)] text-[var(--color-safe)]"},
  closed: {label: "Closed · weekend mode", cls: "bg-[var(--color-info-bg)] text-[var(--color-ink)]"},
  ramping: {label: "Weekend buffer ramping", cls: "bg-[var(--color-warn-bg)] text-[var(--color-warn)]"},
  guard_tripped: {label: "Guard tripped", cls: "bg-[var(--color-danger-bg)] text-[var(--color-danger)]"},
};

export function StatusBadge({status}: {status: string}) {
  const s = STATUS[status] ?? {label: status, cls: ""};
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${s.cls}`}>{s.label}</span>;
}

/** APP-R6 colors; the text says liquidation happens at 1.00. */
export function HealthFactor({hf, label}: {hf?: bigint; label?: string}) {
  const tone = hfTone(hf);
  const cls = {safe: "text-[var(--color-safe)]", warn: "text-[var(--color-warn)]", danger: "text-[var(--color-danger)]", none: ""}[tone];
  const word = {safe: "healthy", warn: "at risk", danger: "close to liquidation", none: ""}[tone];
  return (
    <span className={`num font-semibold ${cls}`} title="Liquidation happens at 1.00" data-hf-tone={tone} data-wad={hf?.toString()}>
      {label ? `${label} ` : ""}
      {hfText(hf)}
      {word && <span className="sr-only"> ({word}; liquidation at 1.00)</span>}
    </span>
  );
}

export function Stat({label, value, hint}: {label: string; value: ReactNode; hint?: string}) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="num text-base font-semibold" title={hint}>
        {value}
      </dd>
    </div>
  );
}

export function Notice({tone = "info", title, children}: {tone?: "info" | "warn" | "danger" | "safe"; title?: string; children: ReactNode}) {
  const cls = {info: "bg-[var(--color-info-bg)]", warn: "bg-[var(--color-warn-bg)]", danger: "bg-[var(--color-danger-bg)]", safe: "bg-[var(--color-safe-bg)]"}[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-lg p-3 text-sm ${cls}`}>
      {title && <p className="font-semibold">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

export function GuardBanner({reasons}: {reasons: string[]}) {
  return (
    <Notice tone="danger" title="New borrowing is paused for this market">
      The safety guard is tripped ({reasons.join(", ") || "no reason reported"}). Repay, close and withdraw still work.{" "}
      <Link href="/status" className="underline">
        See status
      </Link>
    </Notice>
  );
}

const STEP_ICON: Record<string, string> = {pending: "○", active: "◐", done: "✓", failed: "✕", skipped: "–"};

/** APP-R3 step list. */
export function StepList({steps}: {steps: StepState[]}) {
  if (!steps.length) return null;
  return (
    <ol className="space-y-1 text-sm" aria-label="Transaction steps" data-testid="steps">
      {steps.map((s, i) => (
        <li key={s.id} className="flex gap-2" data-status={s.status}>
          <span aria-hidden className={s.status === "failed" ? "text-[var(--color-danger)]" : s.status === "done" ? "text-[var(--color-safe)]" : ""}>
            {STEP_ICON[s.status]}
          </span>
          <span>
            {i + 1}. {s.label}
            <span className="sr-only"> ({s.status})</span>
            {s.detail && <span className="block text-[var(--color-danger)]">{s.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Skeleton({className = "h-5 w-24"}: {className?: string}) {
  return <span className={`skeleton inline-block ${className}`} aria-hidden />;
}

export function Empty({title, children}: {title: string; children?: ReactNode}) {
  return (
    <div className="card p-8 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-2 text-sm text-[var(--color-muted)]">{children}</div>}
    </div>
  );
}
