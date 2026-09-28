"use client";
import {useEffect, useState} from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {useAccount, useChainId, useConnect, useDisconnect, useSwitchChain} from "wagmi";
import {chain, explorer} from "@/lib/env";
import {short} from "@/lib/format";
import {track} from "@/lib/analytics";
import {cn} from "@/lib/cn";
import {Icon, Skeleton} from "@/components/ui";

const menuCls = "z-50 min-w-[240px] rounded-sm bg-overlay p-1.5 shadow-[var(--shadow-pop),inset_0_0_0_1px_var(--border-strong)]";
const itemCls = "flex w-full cursor-pointer items-center gap-2.5 rounded-[7px] px-3 py-2.5 text-[14px] text-dim outline-none data-[highlighted]:bg-white/[0.07] data-[highlighted]:text-fg";
/** Landing page "Connect Wallet": a violet hairline pill. */
const pill = "pressable inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full px-4 sm:px-5 text-[15px] font-medium shadow-[inset_0_0_0_1px_rgba(141,127,242,0.9)] hover:bg-white/[0.08]";

/** Whether the connected wallet is on another chain (the one-click switch is in the header and the action panel). */
export function useWrongNetwork() {
  const {isConnected, connector} = useAccount();
  const chainId = useChainId();
  return Boolean(isConnected && connector && chainId !== chain.id);
}

/** APP-R1: connect (injected, WalletConnect, Coinbase Wallet); wrong network → one-click switch; "unsupported wallet". */
export function ConnectButton() {
  const {address, isConnected} = useAccount();
  const {connectors, connectAsync, isPending, error} = useConnect();
  const {disconnect} = useDisconnect();
  const {switchChain, isPending: switching} = useSwitchChain();
  const wrong = useWrongNetwork();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <Skeleton className="h-10 w-36 rounded-full" />;
  if (wrong)
    return (
      <button className={cn(pill, "text-caution shadow-[inset_0_0_0_1px_var(--caution)]")} onClick={() => switchChain({chainId: chain.id})} disabled={switching} data-testid="switch-network">
        <Icon name="alert" size={15} />
        {switching ? "Switching…" : `Switch to ${chain.name}`}
      </button>
    );
  if (isConnected && address)
    return (
      <Menu.Root>
        <Menu.Trigger className={cn(pill, "px-3.5")} aria-label={`Account ${short(address)}`}>
          <span className="size-2 rounded-full bg-success" aria-hidden />
          <span className="num" data-testid="account">
            {short(address)}
          </span>
          <Icon name="chevronDown" size={14} className="text-muted" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="end" sideOffset={8} className={menuCls}>
            <p className="px-3 pb-1 pt-2 text-[12px] text-muted">Connected to {chain.name}</p>
            <Menu.Item
              className={itemCls}
              onSelect={(e) => {
                e.preventDefault();
                void navigator.clipboard?.writeText(address).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
              }}
            >
              <Icon name={copied ? "check" : "copy"} className={copied ? "text-success" : undefined} /> {copied ? "Copied" : "Copy address"}
            </Menu.Item>
            {explorer && (
              <Menu.Item asChild className={itemCls}>
                <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">
                  <Icon name="external" /> View on explorer
                </a>
              </Menu.Item>
            )}
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Item className={itemCls} onSelect={() => disconnect()}>
              <Icon name="close" /> Disconnect
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    );
  return (
    <Menu.Root>
      <Menu.Trigger className={pill} disabled={isPending} data-testid="connect">
        <Icon name="wallet" size={16} />
        {isPending ? "Connecting…" : "Connect wallet"}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={8} className={menuCls}>
          {connectors.length === 0 && <p className="p-3 text-[14px] text-dim">No supported wallet found. Install a browser wallet or use WalletConnect.</p>}
          {connectors.map((c) => (
            <Menu.Item
              key={c.uid}
              className={itemCls}
              onSelect={async () => {
                try {
                  await connectAsync({connector: c, chainId: chain.id});
                  track("connect");
                } catch {
                  /* shown below on the next open */
                }
              }}
            >
              <Icon name="wallet" /> {c.name === "Injected" ? "Browser wallet" : c.name}
            </Menu.Item>
          ))}
          {error && (
            <p role="alert" className="px-3 py-2 text-[13px] text-danger">
              {/not found|No provider|ProviderNotFound/i.test(error.message) ? "This wallet isn't available in this browser. Try another option." : error.message.split("\n")[0]}
            </p>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
