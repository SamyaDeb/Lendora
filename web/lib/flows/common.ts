"use client";
import {useCallback, useRef} from "react";
import {useWriter} from "@/lib/hooks";
import {useSteps, type Step, type StepState} from "@/lib/tx";
import {useToast} from "@/components/ui";
import type {Call} from "@/lib/tx";

/** `useWriter` that also remembers the last transaction hash (for the toast's explorer link). Sends are unchanged. */
export function useTrackedWriter() {
  const w = useWriter();
  const last = useRef<`0x${string}` | undefined>(undefined);
  const send = useCallback(
    async (call: Call) => {
      const h = await w.send(call);
      last.current = h;
      return h;
    },
    [w.send],
  );
  return {...w, send, lastHash: last};
}

/** Steps shown in the review sheet before anything runs: skipped where already satisfied, otherwise waiting. */
export const planned = (list: Pick<Step, "id" | "label" | "kind" | "skip">[]): StepState[] => list.map((s) => ({id: s.id, label: s.label, kind: s.kind, status: s.skip ? "skipped" : "pending"}));

/**
 * Runs a step list with transaction toasts: pending ("Lending 10 NVDA") → confirmed ("Lent 10 NVDA") → failed
 * ("Couldn't lend NVDA" + the plain-language reason). The same verb is used from button to toast.
 */
export function useTxRunner(funnel: string, lastHash: {current: `0x${string}` | undefined}) {
  const steps = useSteps(funnel);
  const toast = useToast();
  const run = useCallback(
    async (list: Step[], copy: {pending: string; done: string; failed: string; doneBody?: string}) => {
      lastHash.current = undefined;
      const id = toast.push({status: "pending", title: copy.pending, body: "Confirm each step in your wallet."});
      const ok = await steps.run(list);
      if (ok) toast.update(id, {status: "success", title: copy.done, body: copy.doneBody, hash: lastHash.current});
      else toast.update(id, {status: "error", title: copy.failed, body: "The review shows what went wrong and how to fix it.", hash: lastHash.current});
      return ok;
    },
    [steps, toast, lastHash],
  );
  return {...steps, run};
}

/** Trim a user-typed amount for copy ("10.50" → "10.5"). */
export const amt = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString("en-US", {maximumFractionDigits: 6}) : s;
};
