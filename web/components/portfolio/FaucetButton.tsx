"use client";
import {useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {encodeFunctionData, parseUnits} from "viem";
import {mockStockTokenAbi, mockUsdgAbi} from "@stockline/sdk";
import {CHAIN_ID, RPC_URL, TICKERS, deployment} from "@/lib/env";
import {useTrackedWriter, useTxRunner} from "@/lib/flows/common";
import {faucetAbi, faucetKind} from "@/lib/network";
import {Button, Icon, Notice, StepList, useToast} from "@/components/ui";

/** anvil's default account #0: DeployLocal's deployer, owner of the mock tokens (unlocked on anvil only). */
const ANVIL_DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/**
 * Test funds. Testnet: the Stockline faucet (once per address per day). Local anvil (31337) only: gas ETH plus
 * USDG and every Stock Token, minted by the unlocked deployer through the local RPC, so any browser wallet can run
 * the whole product. Never shown on other chains, and never on mainnet (MN-R6).
 */
export function FaucetButton() {
  const kind = faucetKind(CHAIN_ID, deployment(), RPC_URL); // MN-R6: never on mainnet
  if (kind === "testnet") return <TestnetFaucet faucet={deployment().mocks!.faucet} />;
  if (kind === "local") return <LocalFunds rpc={RPC_URL!} />;
  return null;
}

function TestnetFaucet({faucet}: {faucet: `0x${string}`}) {
  const w = useTrackedWriter();
  const steps = useTxRunner("faucet", w.lastHash);
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

function LocalFunds({rpc}: {rpc: string}) {
  const w = useTrackedWriter();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const d = deployment();

  async function fund() {
    if (!w.address) return;
    setBusy(true);
    const id = toast.push({status: "pending", title: "Adding local test funds", body: "100 ETH for gas, 100,000 USDG and 50 of each Stock Token."});
    const call = async (method: string, params: unknown[]) => {
      const r = (await (await fetch(rpc, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})})).json()) as {result?: unknown; error?: {message: string}};
      if (r.error) throw new Error(r.error.message);
      return r.result;
    };
    const mint = (to: `0x${string}`, data: `0x${string}`) => call("eth_sendTransaction", [{from: ANVIL_DEPLOYER, to, data}]);
    try {
      await call("anvil_setBalance", [w.address, "0x56BC75E2D63100000"]);
      await mint(d.usdg, encodeFunctionData({abi: mockUsdgAbi, functionName: "mint", args: [w.address, parseUnits("100000", 6)]}));
      for (const t of TICKERS) await mint(d.stocks[t].stockToken, encodeFunctionData({abi: mockStockTokenAbi, functionName: "mint", args: [w.address, parseUnits("50", 18)]}));
      await qc.invalidateQueries({queryKey: ["chain"]});
      toast.update(id, {status: "success", title: "Added local test funds", body: `100 ETH, 100,000 USDG and 50 ${TICKERS.join(", ")}.`});
    } catch (e) {
      toast.update(id, {status: "error", title: "Couldn't add test funds", body: `The local chain refused: ${String((e as Error).message).split("\n")[0]}. Is anvil running on ${rpc}?`});
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center" data-testid="local-funds">
      <Icon name="info" size={18} className="shrink-0 text-accent-text" />
      <p className="flex-1 text-[14px] text-dim">Local chain: get 100 ETH for gas, 100,000 USDG and 50 of each Stock Token (test tokens, no value).</p>
      <Button variant="secondary" disabled={!w.address || busy} onClick={fund}>
        {busy ? "Adding…" : "Get test funds"}
      </Button>
    </div>
  );
}
