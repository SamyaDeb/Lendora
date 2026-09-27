"use client";
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
  });
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
