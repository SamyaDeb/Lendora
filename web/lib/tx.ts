"use client";
import {useCallback, useState} from "react";
import type {Abi, PublicClient, WalletClient} from "viem";
import {explainError} from "./errors";
import {track} from "./analytics";

/**
 * APP-R3: every transaction runs as a visible step list (approve / authorize / sign / execute). Each onchain step is
 * simulated with `eth_call` first; failures are decoded into plain language before anything is signed.
 */
export type StepKind = "approve" | "authorize" | "sign" | "attest" | "execute";
export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface Step {
  id: string;
  label: string;
  kind: StepKind;
  /** Already satisfied (e.g. allowance present): shown as skipped. */
  skip?: boolean;
  run: () => Promise<void>;
}

export interface StepState {
  id: string;
  label: string;
  kind: StepKind;
  status: StepStatus;
  detail?: string;
}

export function useSteps(funnel: string) {
  const [states, setStates] = useState<StepState[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = useCallback(
    async (steps: Step[]): Promise<boolean> => {
      setBusy(true);
      setError(undefined);
      const st: StepState[] = steps.map((s) => ({id: s.id, label: s.label, kind: s.kind, status: s.skip ? "skipped" : "pending"}));
      setStates([...st]);
      track("sign", {funnel});
      try {
        for (let i = 0; i < steps.length; i++) {
          if (steps[i].skip) continue;
          st[i] = {...st[i], status: "active"};
          setStates([...st]);
          try {
            await steps[i].run();
            st[i] = {...st[i], status: "done"};
          } catch (e) {
            const msg = explainError(e);
            st[i] = {...st[i], status: "failed", detail: msg};
            setStates([...st]);
            setError(msg);
            return false;
          }
          setStates([...st]);
        }
        track("confirmed", {funnel});
        return true;
      } finally {
        setBusy(false);
      }
    },
    [funnel],
  );

  return {states, busy, error, run, reset: () => (setStates([]), setError(undefined))};
}

export interface Call {
  address: `0x${string}`;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

/** Simulate (`eth_call`), then send and wait. Throws decoded-able viem errors. */
/**
 * Gas headroom over the estimate. On Robinhood Chain (Arbitrum Orbit) the gas limit also pays the L1 data fee, which
 * moves between estimation and inclusion: a bare estimate ran out of gas on 46630 (326,005 of 332,112).
 */
export const GAS_HEADROOM_PCT = 30n;

export async function simulateAndSend(pc: PublicClient, wc: WalletClient, account: `0x${string}`, call: Call): Promise<`0x${string}`> {
  const {request} = await pc.simulateContract(Object.assign({}, call, {account}) as never);
  const estimate = await pc.estimateContractGas(Object.assign({}, call, {account}) as never);
  const gas = (estimate * (100n + GAS_HEADROOM_PCT)) / 100n;
  const hash = await wc.writeContract(Object.assign({}, request, {gas}) as never);
  const receipt = await pc.waitForTransactionReceipt({hash, pollingInterval: 250});
  if (receipt.status !== "success") {
    if (receipt.gasUsed * 100n >= gas * 97n) throw new Error("The transaction ran out of gas (the network fee moved while it was pending). Nothing was lost but the fee; retry.");
    // Re-simulate at the latest state to surface the reason.
    await pc.simulateContract(Object.assign({}, call, {account}) as never);
    throw new Error("transaction reverted");
  }
  return hash;
}
