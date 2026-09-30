"use client";
import {useEffect, useState} from "react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useAccount, usePublicClient, useWalletClient} from "wagmi";
import type {PublicClient} from "viem";
import {deployment} from "./env";
import {readMarket} from "./chain";
import {simulateAndSend, type Call} from "./tx";

/** APP-R5 / APP-R7: the connected user's positions and the preview inputs straight from the chain, refreshed every
 * 5 s and after every transaction. */
export function useChainMarket(ticker: string) {
  const pc = usePublicClient();
  const {address} = useAccount();
  return useQuery({
    queryKey: ["chain", ticker, address ?? null],
    queryFn: () => readMarket(pc as PublicClient, deployment(), ticker, address),
    enabled: Boolean(pc),
    refetchInterval: 5000,
    retry: CHAIN_READ_RETRY,
  });
}

/** T39: one retry for chain reads (viem already retries each request); the 5 s refetch keeps trying after an error. */
export const CHAIN_READ_RETRY = 1;

/** True once `loading` has lasted `ms` (T39: say that a chain read is slow instead of a silent skeleton). */
export function useSlow(loading: boolean, ms = 15_000) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) return setSlow(false);
    const t = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(t);
  }, [loading, ms]);
  return loading && slow;
}

export function useWriter() {
  const pc = usePublicClient();
  const {data: wc} = useWalletClient();
  const {address} = useAccount();
  const qc = useQueryClient();
  return {
    address,
    ready: Boolean(pc && wc && address),
    pc: pc as PublicClient,
    send: async (call: Call) => {
      if (!pc || !wc || !address) throw new Error("Connect a wallet first.");
      const hash = await simulateAndSend(pc as PublicClient, wc, address, call);
      await qc.invalidateQueries({queryKey: ["chain"]});
      return hash;
    },
    refresh: () => qc.invalidateQueries(),
  };
}

export const deadline = (now: bigint) => now + 1800n;
