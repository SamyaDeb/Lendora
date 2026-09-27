"use client";
import {useWriter} from "@/lib/hooks";
import {useSteps} from "@/lib/tx";
import {deployment} from "@/lib/env";
import {Notice, StepList} from "./ui";

const faucetAbi = [{type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{name: "to", type: "address"}], outputs: []}] as const;

/** Testnet only: claim test Stock Tokens and USDG from the Stockline faucet (once per address per day). */
export function FaucetButton() {
  const faucet = deployment().mocks?.faucet;
  const w = useWriter();
  const steps = useSteps("faucet");
  if (!faucet) return null;
  return (
    <div className="card space-y-2 p-4">
      <p className="text-sm">Testnet: get 10 SPY, 10 NVDA, 10 AAPL and 50,000 USDG test tokens (no value), once a day.</p>
      <button className="btn" disabled={!w.ready || steps.busy} onClick={() => steps.run([{id: "claim", label: "Claim test tokens", kind: "execute", run: async () => void (await w.send({address: faucet, abi: faucetAbi, functionName: "claim", args: [w.address]}))}])}>
        Get test tokens
      </button>
      <StepList steps={steps.states} />
      {steps.error && <Notice tone="danger">{steps.error}</Notice>}
    </div>
  );
}
