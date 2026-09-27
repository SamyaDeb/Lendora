"use client";
import {createContext, useContext, useEffect, useState, type ReactNode} from "react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {WagmiProvider, useAccount, useConnect} from "wagmi";
import {usePathname} from "next/navigation";
import {wagmiConfig} from "@/lib/wagmi";
import {track} from "@/lib/analytics";
import {E2E} from "@/lib/env";

/** E2E only (anvil): reconnect the mock connector after full page loads. Real wallets use wagmi's reconnect. */
function E2EAutoConnect() {
  const {isConnected, status} = useAccount();
  const {connectors, connect} = useConnect();
  useEffect(() => {
    if (E2E && !isConnected && status !== "connecting" && status !== "reconnecting" && connectors[0]) connect({connector: connectors[0]});
  }, [isConnected, status, connectors, connect]);
  return null;
}

/** Whether the visitor is in a restricted region (set by proxy.ts on the exit-only routes, APP-R2). */
const RegionContext = createContext(false);
export const useRestricted = () => useContext(RegionContext);

export function Providers({children, restricted}: {children: ReactNode; restricted: boolean}) {
  const [qc] = useState(() => new QueryClient({defaultOptions: {queries: {staleTime: 2_000, refetchOnWindowFocus: true, retry: 1}}}));
  const path = usePathname();
  useEffect(() => track("page", {path}), [path]);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        {E2E && <E2EAutoConnect />}
        <RegionContext.Provider value={restricted}>{children}</RegionContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
