"use client";
import {useLendFlow} from "@/lib/flows/useLendFlow";
import {useBorrowFlow} from "@/lib/flows/useBorrowFlow";
import {TabPanel, Tabs} from "@/components/ui";
import {LendForm} from "./LendForm";
import {BorrowForm} from "./BorrowForm";

export type ActionTab = "lend" | "borrow" | "short";

/** Lend / Borrow / Short. Borrow and Short share one flow (inputs carry over); the tab is the mode. */
export function ActionPanel({symbol, tab, onTab, price, available}: {symbol: string; tab: ActionTab; onTab: (t: ActionTab) => void; price?: number; available?: number}) {
  const lend = useLendFlow(symbol);
  const borrow = useBorrowFlow(symbol, tab === "borrow" ? "borrow" : "short");
  return (
    <Tabs
      id="action"
      label={`Actions for ${symbol}`}
      value={tab}
      onValueChange={(v) => onTab(v as ActionTab)}
      items={[
        {value: "lend", label: "Lend", tone: "supply", testId: "tab-lend"},
        {value: "borrow", label: "Borrow", tone: "borrow", testId: "tab-borrow"},
        {value: "short", label: "Short", tone: "borrow", testId: "tab-short"},
      ]}
    >
      <TabPanel value="lend" className="pt-5">
        <LendForm f={lend} />
      </TabPanel>
      <TabPanel value="borrow" className="pt-5">
        <BorrowForm f={borrow} price={price} available={available} />
      </TabPanel>
      <TabPanel value="short" className="pt-5">
        <BorrowForm f={borrow} price={price} available={available} />
      </TabPanel>
    </Tabs>
  );
}
