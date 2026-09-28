"use client";
import type {ReactNode} from "react";
import * as T from "@radix-ui/react-tooltip";
import {Icon} from "./Icon";

export const TooltipProvider = T.Provider;

/** Extra detail on hover or focus. Never the only place for risk information. */
export function Tooltip({content, children}: {content: ReactNode; children: ReactNode}) {
  return (
    <T.Root delayDuration={200}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content sideOffset={6} className="z-[70] max-w-[280px] rounded-[8px] bg-overlay px-3 py-2 text-[13px] leading-snug text-dim shadow-[var(--shadow-pop),inset_0_0_0_1px_var(--border-strong)]">
          {content}
          <T.Arrow className="fill-[var(--overlay)]" />
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

/** An (i) button that opens a tooltip; keyboard focusable. */
export function InfoTip({content, label = "More information"}: {content: ReactNode; label?: string}) {
  return (
    <Tooltip content={content}>
      <button type="button" className="inline-grid size-5 place-items-center rounded-full align-middle text-muted hover:text-fg" aria-label={label}>
        <Icon name="info" size={14} />
      </button>
    </Tooltip>
  );
}
