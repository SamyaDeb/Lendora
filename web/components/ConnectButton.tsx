"use client";
import {useEffect, useRef, useState} from "react";
import {useAccount, useChainId, useConnect, useDisconnect, useSwitchChain} from "wagmi";
import {chain} from "@/lib/env";
import {short} from "@/lib/format";
import {track} from "@/lib/analytics";

/** APP-R1: connect (injected, WalletConnect, Coinbase Wallet); wrong network → prompt to switch. "Unsupported wallet"
 * state when no connector can be used. */
export function ConnectButton() {
  const {address, isConnected, connector} = useAccount();
  const chainId = useChainId();
  const {connectors, connectAsync, isPending, error} = useConnect();
  const {disconnect} = useDisconnect();
  const {switchChain, isPending: switching} = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  if (!mounted) return <span className="skeleton inline-block h-10 w-36" aria-hidden />;
  const wrongNetwork = isConnected && connector && chainId !== chain.id;
  if (wrongNetwork)
    return (
      <button className="btn" onClick={() => switchChain({chainId: chain.id})} disabled={switching} data-testid="switch-network">
        Switch to {chain.name}
      </button>
    );
  if (isConnected && address)
    return (
      <div className="flex items-center gap-2">
        <span className="num rounded-md border border-[var(--color-line)] px-2 py-2 text-sm" data-testid="account">
          {short(address)}
        </span>
        <button className="btn btn-ghost" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    );
  return (
    <div className="relative" ref={ref}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={isPending} data-testid="connect">
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
      {open && (
        <div role="menu" className="card absolute right-0 z-20 mt-2 w-64 p-2 shadow-lg">
          {connectors.length === 0 && <p className="p-2 text-sm">No supported wallet found. Install a browser wallet or use WalletConnect.</p>}
          {connectors.map((c) => (
            <button
              key={c.uid}
              role="menuitem"
              className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--color-info-bg)]"
              onClick={async () => {
                setOpen(false);
                try {
                  await connectAsync({connector: c, chainId: chain.id});
                  track("connect");
                } catch {
                  /* shown below */
                }
              }}
            >
              {c.name === "Injected" ? "Browser wallet" : c.name}
            </button>
          ))}
          {error && (
            <p role="alert" className="p-2 text-sm text-[var(--color-danger)]">
              {/not found|No provider|ProviderNotFound/i.test(error.message) ? "This wallet is not available in this browser. Try another option." : error.message.split("\n")[0]}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
