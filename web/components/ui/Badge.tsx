import type {ReactNode} from "react";
import {cn} from "@/lib/cn";
import {Icon, type IconName} from "./Icon";

export type Tone = "neutral" | "accent" | "supply" | "borrow" | "weekend" | "caution" | "danger" | "success";

const TONE: Record<Tone, string> = {
  neutral: "bg-white/[0.06] text-dim shadow-[inset_0_0_0_1px_var(--border)]",
  accent: "bg-accent-soft text-accent-text",
  supply: "bg-supply-soft text-supply",
  borrow: "bg-borrow-soft text-borrow",
  weekend: "bg-weekend-soft text-weekend",
  caution: "bg-caution-soft text-caution",
  danger: "bg-danger-soft text-danger",
  success: "bg-supply-soft text-success",
};

/** Pill badge. Color is always paired with the label (and usually an icon). */
export function Badge({tone = "neutral", icon, children, className, ...rest}: {tone?: Tone; icon?: IconName; children: ReactNode; className?: string; "data-testid"?: string}) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-medium", TONE[tone], className)} {...rest}>
      {icon && <Icon name={icon} size={13} />}
      {children}
    </span>
  );
}

const STATUS: Record<string, {label: string; tone: Tone; icon: IconName}> = {
  open: {label: "Open", tone: "supply", icon: "sun"},
  closed: {label: "Closed · weekend mode", tone: "weekend", icon: "moon"},
  ramping: {label: "Weekend buffer ramping", tone: "weekend", icon: "clock"},
  guard_tripped: {label: "Guard tripped", tone: "danger", icon: "pause"},
};

/** Market session status (06). Labels are the text; the icon and tone repeat it. */
export function StatusBadge({status}: {status: string}) {
  const s = STATUS[status] ?? {label: status, tone: "neutral" as Tone, icon: "info" as IconName};
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

export type Ease = "easy" | "tight" | "hard" | "paused";
const EASE: Record<Ease, {label: string; tone: Tone; icon: IconName}> = {
  easy: {label: "Easy to borrow", tone: "supply", icon: "check"},
  tight: {label: "Tight", tone: "caution", icon: "alert"},
  hard: {label: "Hard to borrow", tone: "danger", icon: "lock"},
  paused: {label: "Borrowing paused", tone: "danger", icon: "pause"},
};

/** Borrow availability, derived from utilization vs the U_MAX cap (see lib/market.ts). */
export function EaseBadge({ease}: {ease: Ease}) {
  const e = EASE[ease];
  return (
    <Badge tone={e.tone} icon={e.icon} data-testid="ease">
      {e.label}
    </Badge>
  );
}
