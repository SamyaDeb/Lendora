"use client";
import type {ReactNode} from "react";
import {Segmented} from "@/components/ui";
import type {PanelMode} from "./VaultView";

/** Deposit / Withdraw switch over the two forms (both stay mounted so their review sheets survive a switch). */
export function VaultPanel({mode, onMode, deposit, withdraw}: {mode: PanelMode; onMode: (m: PanelMode) => void; deposit: ReactNode; withdraw: ReactNode}) {
  return (
    <div className="space-y-4">
      <Segmented<PanelMode>
        label="Deposit or withdraw"
        value={mode}
        onChange={onMode}
        testIdPrefix="mode-"
        options={[
          {value: "deposit", label: "Deposit"},
          {value: "withdraw", label: "Withdraw"},
        ]}
      />
      <div hidden={mode !== "deposit"}>{deposit}</div>
      <div hidden={mode !== "withdraw"}>{withdraw}</div>
    </div>
  );
}
