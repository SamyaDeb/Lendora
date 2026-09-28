"use client";
import {useChainNow} from "@/lib/chainNow";
import {et} from "@/lib/format";
import {countdown} from "@/lib/session";
import {Badge} from "./Badge";

/**
 * Time left until a timestamp, on chain time: pass the data's `asOf` time and when it was fetched (anvil and testnets
 * run ahead of the wall clock). At zero it says `dueLabel`; whether something is actually ready comes from the data.
 */
export function CountdownBadge({to, asOf, fetchedAt = 0, dueLabel = "Due now", ...rest}: {to: string | number; asOf?: string; fetchedAt?: number; dueLabel?: string; "data-testid"?: string}) {
  const now = useChainNow(asOf, fetchedAt);
  const ts = typeof to === "string" ? Math.floor(Date.parse(to) / 1000) : to;
  if (ts <= now)
    return (
      <Badge tone="neutral" icon="clock" {...rest}>
        {dueLabel}
      </Badge>
    );
  return (
    <Badge tone="accent" icon="clock" {...rest}>
      <span className="num" suppressHydrationWarning>
        {countdown(ts, now)}
      </span>
      <span className="sr-only"> left, until {et(ts)}</span>
    </Badge>
  );
}
