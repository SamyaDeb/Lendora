"use client";
import {useCallback, useRef, useState} from "react";
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
  // T29: approvals and authorizations that went through in a failed run; "Try again" resumes after them instead of
  // asking for them again (the allowance read may not have refreshed yet). Cleared on success and on reset.
  const doneRef = useRef(new Set<string>());

  const run = useCallback(
    async (input: Step[]): Promise<boolean> => {
      setBusy(true);
      setError(undefined);
      // Keyed by id and label: one card runs several actions whose approvals are for different tokens.
      const steps = input.map((s) => (doneRef.current.has(`${s.id}:${s.label}`) && (s.kind === "approve" || s.kind === "authorize") ? {...s, skip: true} : s));
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
            doneRef.current.add(`${steps[i].id}:${steps[i].label}`);
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
        doneRef.current.clear();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [funnel],
  );

  return {states, busy, error, run, reset: () => (doneRef.current.clear(), setStates([]), setError(undefined))};
}

export interface Call {
  address: `0x${string}`;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  /** Gas limit floor for calls whose path can change before inclusion (T33). */
  minGas?: bigint;
}

/** Simulate (`eth_call`), then send and wait. Throws decoded-able viem errors. */
/**
 * Gas headroom over the estimate. On Robinhood Chain (Arbitrum Orbit) the gas limit also pays the L1 data fee, which
 * moves between estimation and inclusion: a bare estimate ran out of gas on 46630 (326,005 of 332,112).
 */
export const GAS_HEADROOM_PCT = 30n;

/**
 * T33: `withdrawLend` estimated while the vault holds the stock idle is cheap (~216k); if the allocator keeper moves
 * that idle into Morpho before inclusion, the withdrawal takes the deallocation path (372,545 measured on 46630) and a
 * 30% headroom runs out (tx 0x0b882ead…: 276,432 of 280,320). The floor is that path × 1.3; unused gas isn't charged.
 */
export const WITHDRAW_LEND_MIN_GAS = 500_000n;

export async function simulateAndSend(pc: PublicClient, wc: WalletClient, account: `0x${string}`, call: Call): Promise<`0x${string}`> {
  const {minGas, ...c} = call;
  const {request} = await pc.simulateContract(Object.assign({}, c, {account}) as never);
  const estimate = await pc.estimateContractGas(Object.assign({}, c, {account}) as never);
  const withHeadroom = (estimate * (100n + GAS_HEADROOM_PCT)) / 100n;
  const gas = minGas !== undefined && minGas > withHeadroom ? minGas : withHeadroom;
  const hash = await wc.writeContract(Object.assign({}, request, {gas}) as never);
  const receipt = await pc.waitForTransactionReceipt({hash, pollingInterval: 250});
  if (receipt.status !== "success") {
    if (receipt.gasUsed * 100n >= gas * 97n) throw new Error("The transaction ran out of gas: the market changed while it was pending (liquidity moved, or the network fee rose). Nothing was lost but the fee; retry.");
    // Re-simulate at the latest state to surface the reason.
    await pc.simulateContract(Object.assign({}, c, {account}) as never);
    throw new Error("transaction reverted");
  }
  return hash;
}
