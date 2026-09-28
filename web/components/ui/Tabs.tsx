"use client";
import {createContext, useContext, useState, type ReactNode} from "react";
import * as T from "@radix-ui/react-tabs";
import {motion, useReducedMotion} from "motion/react";
import {cn} from "@/lib/cn";
import {DUR, EASE_OUT} from "./motion";

/** Whether the user has switched tabs: content fades only on a switch, never on first paint (SSR-safe). */
const Switched = createContext(false);

export interface TabItem {
  value: string;
  label: ReactNode;
  testId?: string;
  tone?: "supply" | "borrow" | "accent";
}

/**
 * Radix tabs (arrow keys, Home/End) with a sliding indicator. Content cross-fades on switch (200 ms). `id` keeps the
 * indicator's layout animation scoped when several tab sets are on one page.
 */
export function Tabs({id, items, value, onValueChange, children, className, listClassName, size = "md", label}: {id: string; items: TabItem[]; value: string; onValueChange: (v: string) => void; children?: ReactNode; className?: string; listClassName?: string; size?: "sm" | "md"; label: string}) {
  const reduce = useReducedMotion();
  const [switched, setSwitched] = useState(false);
  return (
    <T.Root value={value} onValueChange={(v) => (setSwitched(true), onValueChange(v))} className={className}>
      <T.List aria-label={label} className={cn("relative flex rounded-sm bg-sunken p-1 shadow-[inset_0_0_0_1px_var(--border)]", listClassName)}>
        {items.map((it) => {
          const active = it.value === value;
          const tone = it.tone === "supply" ? "text-supply" : it.tone === "borrow" ? "text-borrow" : "text-fg";
          return (
            <T.Trigger
              key={it.value}
              value={it.value}
              data-testid={it.testId}
              className={cn(
                "pressable relative flex-1 whitespace-nowrap rounded-[7px] font-medium outline-offset-1",
                size === "md" ? "h-9 px-3 text-[14.5px]" : "h-7 px-2.5 text-[13px]",
                active ? tone : "text-muted hover:text-dim",
              )}
            >
              {active && (
                <motion.span
                  layoutId={`tab-ind-${id}`}
                  className="absolute inset-0 rounded-[7px] bg-raised shadow-[inset_0_0_0_1px_var(--border-strong)]"
                  transition={reduce ? {duration: 0} : {duration: DUR.base, ease: EASE_OUT}}
                />
              )}
              <span className="relative">{it.label}</span>
            </T.Trigger>
          );
        })}
      </T.List>
      <Switched.Provider value={switched}>{children}</Switched.Provider>
    </T.Root>
  );
}

export function TabPanel({value, children, className}: {value: string; children: ReactNode; className?: string}) {
  const switched = useContext(Switched);
  return (
    <T.Content value={value} className={cn("outline-none", className)}>
      <motion.div initial={switched ? {opacity: 0} : false} animate={{opacity: 1}} transition={{duration: DUR.base, ease: EASE_OUT}}>
        {children}
      </motion.div>
    </T.Content>
  );
}

/** Small radio-style segmented control (chart ranges, deposit / withdraw). */
export function Segmented<V extends string>({options, value, onChange, label, testIdPrefix}: {options: {value: V; label: string}[]; value: V; onChange: (v: V) => void; label: string; testIdPrefix?: string}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-sm bg-sunken p-0.5 shadow-[inset_0_0_0_1px_var(--border)]">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          data-testid={testIdPrefix ? `${testIdPrefix}${o.value}` : undefined}
          onKeyDown={(e) => {
            const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : undefined;
            if (n === undefined) return;
            e.preventDefault();
            const k = (n + options.length) % options.length;
            onChange(options[k].value);
            (e.currentTarget.parentElement?.children[k] as HTMLElement | undefined)?.focus();
          }}
          tabIndex={o.value === value ? 0 : -1}
          className={cn("pressable h-7 rounded-[7px] px-3 text-[13px] font-medium", o.value === value ? "bg-raised text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]" : "text-muted hover:text-dim")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
