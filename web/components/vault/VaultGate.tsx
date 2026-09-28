"use client";
import type {ReactNode} from "react";
import {NeedFunds, WalletGate} from "@/components/stock/WalletGate";

/** WalletGate, except for a preview-pinned wallet (no real wallet behind it, so nothing to connect or switch). */
export function VaultGate({pinned, children}: {pinned: boolean; children: ReactNode}) {
  return pinned ? <>{children}</> : <WalletGate>{children}</WalletGate>;
}

export {NeedFunds};

/** The review's short risk list for vault actions (no health meter: it isn't a loan). */
export function VaultRiskBlock({items}: {items: string[]}) {
  return (
    <section aria-label="Risks" className="space-y-2 rounded-sm bg-sunken p-4 text-[13px] leading-snug text-dim shadow-[inset_0_0_0_1px_var(--border)]" data-testid="review-risks">
      <h3 className="font-medium text-fg">Before you confirm</h3>
      <ul className="list-disc space-y-1.5 pl-4 marker:text-caution">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </section>
  );
}
