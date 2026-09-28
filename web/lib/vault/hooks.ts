"use client";
import {createContext, createElement, useContext, useEffect, type ReactNode} from "react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useAccount} from "wagmi";
import {E2E} from "@/lib/env";
import {vaultSource, type VaultSource} from "./index";

type Addr = `0x${string}`;

interface VaultEnv {
  source: VaultSource;
  /** Previews pin the account: an address, or null for "not connected". Undefined = the connected wallet. */
  account?: Addr | null;
}

const Ctx = createContext<VaultEnv | null>(null);

/** Overrides the source (and optionally the account) below it: /dev previews and view tests. */
export function VaultEnvProvider({source, account, children}: VaultEnv & {children: ReactNode}) {
  return createElement(Ctx.Provider, {value: {source, account}}, children);
}

export function useVaultSource(): VaultSource {
  return useContext(Ctx)?.source ?? vaultSource();
}

/** The wallet the vault screens act for, and whether it is pinned by a preview (no real wallet behind it). */
export function useVaultAccount(): {address?: Addr; pinned: boolean} {
  const env = useContext(Ctx);
  const {address} = useAccount();
  if (env && env.account !== undefined) return {address: env.account ?? undefined, pinned: true};
  return {address, pinned: false};
}

/** Overview every 5 s, like the markets (APP-R7). */
export function useVaultOverview() {
  const s = useVaultSource();
  useFixtureHandle(s);
  return useQuery({queryKey: ["vault", s.id, "overview"], queryFn: () => s.overview(), refetchInterval: 5000});
}

/** The wallet's shares, balances and withdrawal requests, every 5 s and after every transaction. */
export function useVaultUser(o: {enabled?: boolean} = {}) {
  const s = useVaultSource();
  const {address} = useVaultAccount();
  return useQuery({queryKey: ["vault", s.id, "user", address ?? null], queryFn: () => s.user(address!), enabled: Boolean(address) && o.enabled !== false, refetchInterval: 5000});
}

/** Refetch everything vault-related (after a transaction). */
export function useVaultRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({queryKey: ["vault"]});
}

/** Dev and e2e: `window.__vaultFixture.advance(seconds)` moves the fixture clock (queued requests become claimable). */
function useFixtureHandle(s: VaultSource) {
  useEffect(() => {
    if (s.kind !== "fixture" || !(E2E || process.env.NODE_ENV !== "production")) return;
    (window as unknown as {__vaultFixture?: unknown}).__vaultFixture = s;
  }, [s]);
}
