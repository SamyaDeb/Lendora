"use client";
import {useEffect, useState, type ReactNode} from "react";
import {useAccount, useSwitchChain} from "wagmi";
import {chain} from "@/lib/env";
import {Button, Icon} from "@/components/ui";
import {ConnectButton, useWrongNetwork} from "@/components/shell/ConnectButton";

/** Shows the action button only when a wallet is connected on the right chain; otherwise the connect or one-click switch. */
export function WalletGate({children}: {children: ReactNode}) {
  const {isConnected} = useAccount();
  const wrong = useWrongNetwork();
  const {switchChain, isPending} = useSwitchChain();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <>{children}</>;
  if (wrong)
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-[13px] text-caution">
          <Icon name="alert" size={14} /> Your wallet is on another network.
        </p>
        <Button size="lg" className="w-full" onClick={() => switchChain({chainId: chain.id})} disabled={isPending}>
          {isPending ? "Switching…" : `Switch to ${chain.name}`}
        </Button>
      </div>
    );
  if (!isConnected)
    return (
      <div className="flex flex-col items-center gap-2 rounded-sm bg-sunken p-4 text-center shadow-[inset_0_0_0_1px_var(--border)]">
        <p className="text-[13.5px] text-muted">Connect a wallet to see your balances and continue.</p>
        <ConnectButton />
      </div>
    );
  return <>{children}</>;
}
