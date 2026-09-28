import type {ReactNode} from "react";
import {cn} from "@/lib/cn";
import {Icon, type IconName} from "./Icon";

export function Skeleton({className = "h-5 w-24"}: {className?: string}) {
  return <span className={cn("skeleton inline-block", className)} aria-hidden />;
}

/** Empty or error state with a next action. */
export function EmptyState({title, children, action, icon = "layers", tone = "neutral", className}: {title: string; children?: ReactNode; action?: ReactNode; icon?: IconName; tone?: "neutral" | "danger"; className?: string}) {
  return (
    <div className={cn("panel flex flex-col items-center px-6 py-10 text-center", className)} role={tone === "danger" ? "alert" : undefined}>
      <span className={cn("grid size-11 place-items-center rounded-sm bg-white/[0.06] shadow-[inset_0_0_0_1px_var(--border-strong)]", tone === "danger" ? "text-danger" : "text-accent-text")}>
        <Icon name={icon} size={20} />
      </span>
      <p className="mt-4 text-[17px] font-medium tracking-[-0.02em]">{title}</p>
      {children && <div className="mt-1.5 max-w-md text-[14px] text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Back-compat name used by older call sites. */
export const Empty = EmptyState;
