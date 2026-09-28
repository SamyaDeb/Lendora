"use client";
import {useEffect, useState} from "react";
import Link from "next/link";
import {useQuery} from "@tanstack/react-query";
import {AnimatePresence, motion, useReducedMotion} from "motion/react";
import {browserApi, type Market} from "@/lib/api";
import {et, pct} from "@/lib/format";
import {countdown, sessionFromMarkets, type SessionView} from "@/lib/session";
import {Icon} from "@/components/ui";
import {DUR, EASE_OUT} from "@/components/ui/motion";

/** Chain time: the API's snapshot time plus the time since it was fetched (anvil and testnets run ahead of the wall clock). */
export function useChainNow(asOfTime: string | undefined, fetchedAt: number) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  if (!asOfTime || !fetchedAt) return now;
  return Math.floor(Date.parse(asOfTime) / 1000 + (now * 1000 - fetchedAt) / 1000);
}

/** The session bar's data: the markets list (shared cache with the board) and the derived session. */
export function useSession(): {view?: SessionView; now: number; error: boolean} {
  const q = useQuery({queryKey: ["markets"], queryFn: () => browserApi().markets(), refetchInterval: 5000});
  const now = useChainNow(q.data?.asOfTime, q.dataUpdatedAt);
  const view = q.data ? sessionFromMarkets(q.data.data, now) : undefined;
  const state = view?.state;
  useEffect(() => {
    if (state) document.documentElement.dataset.session = state;
  }, [state]);
  return {view, now, error: q.isError && !q.data};
}

export function SessionBar() {
  const {view, now, error} = useSession();
  return <SessionBarView view={view} now={now} error={error} />;
}

/** Presentational session bar ("Market open" / "Weekend mode, higher collateral required"), with the countdown. */
export function SessionBarView({view, now, error}: {view?: SessionView; now: number; error?: boolean; markets?: Market[]}) {
  const reduce = useReducedMotion();
  const key = error ? "error" : (view?.state ?? "loading");
  let icon: "sun" | "moon" | "clock" | "info" = "info";
  let title = "Checking market hours…";
  let detail: React.ReactNode = null;
  let tone = "text-muted";
  if (error) {
    title = "Live market status is unavailable";
    detail = "Positions still read from the chain. Check the status page.";
  } else if (view?.state === "open") {
    icon = "sun";
    tone = "text-supply";
    title = "Market open";
    detail = view.nextTs ? (
      <>
        Weekend mode starts in <span className="num text-fg">{countdown(view.nextTs, now)}</span> <span className="hidden sm:inline">({et(view.nextTs)})</span>
      </>
    ) : null;
  } else if (view?.state === "ramping") {
    icon = "clock";
    tone = "text-weekend";
    title = "Weekend buffer ramping in";
    detail = (
      <>
        Collateral required rises until the close{view.nextTs ? <> in <span className="num text-fg">{countdown(view.nextTs, now)}</span></> : null}
      </>
    );
  } else if (view?.state === "weekend") {
    icon = "moon";
    tone = "text-weekend";
    title = "Weekend mode, higher collateral required";
    detail = (
      <>
        {view.buffer > 0 && <>Oracle safety buffer <span className="num text-fg">{pct(view.buffer, 1)}</span> · </>}
        {view.nextTs ? (
          <>
            Reopens in <span className="num text-fg">{countdown(view.nextTs, now)}</span>
          </>
        ) : (
          "Reopens at the next session"
        )}
      </>
    );
  }
  return (
    <div className="relative border-b border-line bg-[color-mix(in_srgb,var(--accent-live)_9%,var(--bg))] transition-colors duration-[600ms]" data-testid="session-bar" data-session={view?.state}>
      <div className="mx-auto flex h-9 max-w-[1320px] items-center gap-3 px-4 text-[13px] md:px-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={key}
            className="flex min-w-0 items-center gap-2"
            initial={reduce ? false : {opacity: 0, y: 4}}
            animate={{opacity: 1, y: 0}}
            exit={reduce ? {opacity: 0, transition: {duration: 0}} : {opacity: 0, y: -4}}
            transition={{duration: DUR.base, ease: EASE_OUT}}
            role="status"
          >
            <Icon name={icon} size={15} className={tone} />
            <span className="whitespace-nowrap font-medium text-fg">{title}</span>
            {detail && <span className="hidden min-w-0 truncate text-muted sm:inline">· {detail}</span>}
          </motion.div>
        </AnimatePresence>
        {view && view.paused.length > 0 && (
          <Link href="/status" className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-danger-soft px-2.5 py-0.5 text-[12px] font-medium text-danger hover:underline">
            <Icon name="pause" size={12} /> Borrowing paused: {view.paused.join(", ")}
          </Link>
        )}
      </div>
      {detail && <div className="mx-auto -mt-1 max-w-[1320px] truncate px-4 pb-1.5 text-[12px] text-muted sm:hidden">{detail}</div>}
    </div>
  );
}
