"use client";
import {deployment} from "@/lib/env";
import {useTrackedWriter, useTxRunner} from "@/lib/flows/common";
import {Button, Icon, Notice, StepList} from "@/components/ui";

const faucetAbi = [{type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{name: "to", type: "address"}], outputs: []}] as const;

/** Testnet only: claim test Stock Tokens and USDG from the faucet (once per address per day). */
export function FaucetButton() {
  const faucet = deployment().mocks?.faucet;
  const w = useTrackedWriter();
  const steps = useTxRunner("faucet", w.lastHash);
  if (!faucet) return null;
  return (
    <div className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <Icon name="info" size={18} className="shrink-0 text-accent-text" />
      <p className="flex-1 text-[14px] text-dim">Testnet: get 10 SPY, 10 NVDA, 10 AAPL and 50,000 USDG test tokens (no value), once a day.</p>
      <Button
        variant="secondary"
        disabled={!w.ready || steps.busy}
        onClick={() => steps.run([{id: "claim", label: "Claim test tokens", kind: "execute", run: async () => void (await w.send({address: faucet, abi: faucetAbi, functionName: "claim", args: [w.address]}))}], {pending: "Claiming test tokens", done: "Claimed test tokens", failed: "Couldn't claim test tokens"})}
      >
        Get test tokens
      </Button>
      {steps.states.length > 0 && (
        <div className="w-full sm:hidden">
          <StepList steps={steps.states} />
        </div>
      )}
      {steps.error && <Notice tone="danger">{steps.error}</Notice>}
    </div>
  );
}
