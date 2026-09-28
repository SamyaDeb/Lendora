import type {ReactNode} from "react";
import Link from "next/link";
import {cn} from "@/lib/cn";
import {Icon, type IconName} from "./Icon";

type NoticeTone = "info" | "warn" | "danger" | "safe" | "weekend";
const TONE: Record<NoticeTone, {cls: string; icon: IconName; iconCls: string}> = {
  info: {cls: "bg-white/[0.04] shadow-[inset_0_0_0_1px_var(--border)]", icon: "info", iconCls: "text-accent-text"},
  warn: {cls: "bg-caution-soft shadow-[inset_0_0_0_1px_rgba(242,193,78,0.28)]", icon: "alert", iconCls: "text-caution"},
  danger: {cls: "bg-danger-soft shadow-[inset_0_0_0_1px_rgba(255,122,134,0.32)]", icon: "alert", iconCls: "text-danger"},
  safe: {cls: "bg-supply-soft shadow-[inset_0_0_0_1px_rgba(89,217,122,0.28)]", icon: "check", iconCls: "text-success"},
  weekend: {cls: "bg-weekend-soft shadow-[inset_0_0_0_1px_rgba(169,156,246,0.3)]", icon: "moon", iconCls: "text-weekend"},
};

/** Inline message. Danger is announced (role=alert); the others are polite status. */
export function Notice({tone = "info", title, children, action, className}: {tone?: NoticeTone; title?: string; children?: ReactNode; action?: ReactNode; className?: string}) {
  const t = TONE[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex gap-3 rounded-sm p-3.5 text-[14px] leading-snug", t.cls, className)}>
      <Icon name={t.icon} size={18} className={cn("mt-px shrink-0", t.iconCls)} />
      <div className="min-w-0 flex-1 space-y-0.5">
        {title && <p className="font-medium text-fg">{title}</p>}
        {children && <div className="text-dim">{children}</div>}
        {action && <div className="pt-2">{action}</div>}
      </div>
    </div>
  );
}

/** APP-R4: borrowing paused by the oracle guard, with the reason and the status link. Exits stay open. */
export function GuardBanner({reasons}: {reasons: string[]}) {
  return (
    <Notice tone="danger" title="New borrowing is paused for this market">
      The safety guard is tripped ({reasons.join(", ") || "no reason reported"}). Repay, close and withdraw still work.{" "}
      <Link href="/status" className="underline underline-offset-2">
        See status
      </Link>
    </Notice>
  );
}
