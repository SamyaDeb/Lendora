"use client";
import {useEffect, useState} from "react";
import Link from "next/link";
import {useQuery} from "@tanstack/react-query";
import {compliance} from "@/lib/compliance";
import {E2E} from "@/lib/env";
import {Button, Icon, Sheet} from "@/components/ui";

const KEY = "lendora.onboarded.v1";

/** First visit: an eligibility check, a two-line explainer and the risk docs. Shown once per browser. */
export function OnboardingModal() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (E2E) return;
    try {
      if (!localStorage.getItem(KEY)) setOpen(true);
    } catch {
      /* storage blocked: don't nag */
    }
  }, []);
  const close = () => {
    setOpen(false);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
  };
  const q = useQuery({queryKey: ["connection"], queryFn: compliance.connection, enabled: open, retry: 0, staleTime: 60_000});
  return (
    <Sheet open={open} onOpenChange={(o) => (o ? setOpen(true) : close())} title="Welcome to Lendora" description="Stock Token lending on Robinhood Chain, built on Morpho Blue.">
      <OnboardingBody status={q.isPending ? "checking" : q.isError ? "unknown" : q.data?.restricted ? "restricted" : "eligible"} country={q.data?.geo.country ?? undefined} onDone={close} />
    </Sheet>
  );
}

export function OnboardingBody({status, country, onDone}: {status: "checking" | "eligible" | "restricted" | "unknown"; country?: string; onDone: () => void}) {
  const check = {
    checking: {icon: "clock" as const, cls: "text-muted", title: "Checking your region…", body: "This takes a second."},
    eligible: {icon: "check" as const, cls: "text-success", title: "Available in your region", body: `${country ? `Detected ${country}. ` : ""}Borrowing and shorting run one more compliance check before you sign.`},
    restricted: {icon: "lock" as const, cls: "text-danger", title: "Not available in your region", body: "Lendora isn't offered in the US, Canada, the UK, Switzerland, the UAE or sanctioned regions. If you already have a position, you can always repay, close and withdraw."},
    unknown: {icon: "info" as const, cls: "text-caution", title: "We couldn't check your region", body: "You can browse markets. Borrowing checks your region again before you sign."},
  }[status];
  return (
    <div className="space-y-5 pb-2">
      <div className="flex gap-3 rounded-sm bg-sunken p-3.5 shadow-[inset_0_0_0_1px_var(--border)]" role="status">
        <Icon name={check.icon} size={18} className={`mt-0.5 shrink-0 ${check.cls}`} />
        <div>
          <p className="text-[14px] font-medium">{check.title}</p>
          <p className="mt-0.5 text-[13px] text-muted">{check.body}</p>
        </div>
      </div>
      <div className="space-y-2.5 text-[15px] leading-relaxed text-dim">
        <p>
          <span className="font-medium text-supply">Lend</span> Stock Tokens like NVDA and earn the fees borrowers pay.
        </p>
        <p>
          <span className="font-medium text-borrow">Borrow or short</span> them against USDG. Positions are liquidated if their health factor falls below 1.00, and weekends need extra collateral.
        </p>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Link href="/terms" className="inline-flex items-center gap-1.5 text-[14px] text-accent-text hover:underline" onClick={onDone}>
          Read the risks <Icon name="external" size={13} />
        </Link>
        <Button onClick={onDone} disabled={status === "checking"}>
          {status === "restricted" ? "Go to my positions" : "Explore markets"}
        </Button>
      </div>
    </div>
  );
}
