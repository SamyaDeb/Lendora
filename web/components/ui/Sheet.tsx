"use client";
import {useEffect, useState, type ReactNode} from "react";
import * as D from "@radix-ui/react-dialog";
import {AnimatePresence, motion, useReducedMotion} from "motion/react";
import {cn} from "@/lib/cn";
import {Icon} from "./Icon";
import {DUR, EASE_OUT} from "./motion";

export function useMediaQuery(q: string) {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(q);
    setM(mq.matches);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

/**
 * Modal sheet (Radix Dialog: focus trap, Esc, focus return). Desktop: centered, scales in. Mobile: bottom sheet that
 * slides up. Reduced motion: fades only.
 */
export function Sheet({open, onOpenChange, title, description, children, footer, size = "md", dismissable = true}: {open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: "md" | "lg"; dismissable?: boolean}) {
  const desktop = useMediaQuery("(min-width: 768px)");
  const reduce = useReducedMotion();
  const panel = reduce
    ? {initial: {opacity: 0}, animate: {opacity: 1}, exit: {opacity: 0}}
    : desktop
      ? {initial: {opacity: 0, scale: 0.96}, animate: {opacity: 1, scale: 1}, exit: {opacity: 0, scale: 0.98}}
      : {initial: {y: "100%"}, animate: {y: 0}, exit: {y: "100%"}};
  return (
    <D.Root open={open} onOpenChange={(o) => (dismissable || o ? onOpenChange(o) : undefined)}>
      <AnimatePresence>
        {open && (
          <D.Portal forceMount>
            <D.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-40 bg-[var(--scrim)] backdrop-blur-[2px]" initial={{opacity: 0}} animate={{opacity: 1}} exit={{opacity: 0}} transition={{duration: DUR.base}} />
            </D.Overlay>
            <D.Content asChild forceMount onInteractOutside={(e) => !dismissable && e.preventDefault()} onEscapeKeyDown={(e) => !dismissable && e.preventDefault()}>
              <motion.div
                {...panel}
                transition={{duration: desktop ? DUR.base + 0.05 : 0.32, ease: EASE_OUT}}
                className={cn(
                  "fixed z-50 flex flex-col bg-surface shadow-[var(--shadow-pop),inset_0_0_0_1px_var(--border-strong)] outline-none",
                  "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[var(--r-lg)]",
                  "md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[88vh] md:w-full md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-[var(--r-lg)]",
                  size === "md" ? "md:max-w-[460px]" : "md:max-w-[640px]",
                )}
              >
                <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/20 md:hidden" aria-hidden />
                <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-4 md:px-6 md:pt-5">
                  <div className="min-w-0">
                    <D.Title className="t-title">{title}</D.Title>
                    {description ? <D.Description className="mt-1 text-[13.5px] text-muted">{description}</D.Description> : <D.Description className="sr-only">Review and confirm</D.Description>}
                  </div>
                  {dismissable && (
                    <D.Close className="pressable -mr-1 grid size-8 shrink-0 place-items-center rounded-[8px] text-muted hover:bg-white/[0.06] hover:text-fg" aria-label="Close">
                      <Icon name="close" size={18} />
                    </D.Close>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 md:px-6">{children}</div>
                {footer && <div className="border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">{footer}</div>}
              </motion.div>
            </D.Content>
          </D.Portal>
        )}
      </AnimatePresence>
    </D.Root>
  );
}
