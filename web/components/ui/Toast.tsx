"use client";
import {createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode} from "react";
import {AnimatePresence, motion, useReducedMotion} from "motion/react";
import {cn} from "@/lib/cn";
import {explorer} from "@/lib/env";
import {Icon} from "./Icon";
import {DUR, EASE_OUT} from "./motion";

export type ToastStatus = "pending" | "success" | "error" | "info";
export interface ToastInput {
  status: ToastStatus;
  title: string;
  body?: string;
  hash?: `0x${string}`;
}
interface ToastItem extends ToastInput {
  id: number;
}
interface ToastApi {
  push: (t: ToastInput) => number;
  update: (id: number, t: Partial<ToastInput>) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi>({push: () => 0, update: () => {}, dismiss: () => {}});
export const useToast = () => useContext(Ctx);

const AUTO_CLOSE: Record<ToastStatus, number | null> = {pending: null, success: 6000, error: 10_000, info: 5000};

/** Transaction toasts: pending → confirmed → failed, each with an explorer link when there is a hash. */
export function ToastProvider({children}: {children: ReactNode}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const reduce = useReducedMotion();

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);
  const schedule = useCallback(
    (id: number, status: ToastStatus) => {
      clearTimeout(timers.current.get(id));
      const ms = AUTO_CLOSE[status];
      if (ms) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );
  const push = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), {...t, id}]);
      schedule(id, t.status);
      return id;
    },
    [schedule],
  );
  const update = useCallback(
    (id: number, t: Partial<ToastInput>) => {
      setItems((xs) => xs.map((x) => (x.id === id ? {...x, ...t} : x)));
      if (t.status) schedule(id, t.status);
    },
    [schedule],
  );
  const api = useMemo(() => ({push, update, dismiss}), [push, update, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:items-end md:p-6" aria-live="polite" role="region" aria-label="Notifications">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout={!reduce}
              initial={reduce ? {opacity: 0} : {opacity: 0, y: 12}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, transition: {duration: DUR.fast}}}
              transition={{duration: DUR.base, ease: EASE_OUT}}
              className="pointer-events-auto flex w-full max-w-[380px] gap-3 rounded-sm bg-overlay p-3.5 shadow-[var(--shadow-pop),inset_0_0_0_1px_var(--border-strong)]"
              role={t.status === "error" ? "alert" : "status"}
              data-testid="toast"
              data-status={t.status}
            >
              <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full", t.status === "success" ? "bg-success text-[#0b0a18]" : t.status === "error" ? "bg-danger text-[#0b0a18]" : "text-accent-text")}>
                {t.status === "pending" ? <span className="size-4 rounded-full border-2 border-accent-text/30 border-t-accent-text motion-safe:animate-spin" /> : <Icon name={t.status === "success" ? "check" : t.status === "error" ? "x" : "info"} size={t.status === "info" ? 18 : 12} strokeWidth={t.status === "info" ? 1.5 : 2.4} />}
              </span>
              <div className="min-w-0 flex-1 text-[14px]">
                <p className="font-medium text-fg">{t.title}</p>
                {t.body && <p className="mt-0.5 text-[13px] leading-snug text-dim">{t.body}</p>}
                {t.hash && explorer && (
                  <a className="mt-1 inline-flex items-center gap-1 text-[13px] text-accent-text underline-offset-2 hover:underline" href={`${explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer">
                    View on explorer <Icon name="external" size={12} />
                  </a>
                )}
              </div>
              <button className="pressable -m-1 grid size-7 shrink-0 place-items-center rounded-[6px] text-muted hover:bg-white/[0.06] hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
                <Icon name="close" size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}
