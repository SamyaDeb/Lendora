"use client";
import {useState, type ReactNode} from "react";
import {
  Address,
  AmountInput,
  AssetIcon,
  Badge,
  Button,
  EaseBadge,
  EmptyState,
  GuardBanner,
  HealthMeter,
  Notice,
  NumberTicker,
  Row,
  Segmented,
  Sheet,
  Skeleton,
  Sparkline,
  Stat,
  StatusBadge,
  StepList,
  TabPanel,
  Tabs,
  InfoTip,
  UtilBar,
  useToast,
} from "@/components/ui";
import {SessionBarView} from "@/components/shell/SessionBar";
import {OnboardingBody} from "@/components/shell/OnboardingModal";
import type {StepState} from "@/lib/tx";

const W = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const NOW = 1_791_317_952;

function Section({title, children, note}: {title: string; children: ReactNode; note?: string}) {
  return (
    <section className="space-y-4" aria-labelledby={`s-${title}`}>
      <div>
        <h2 id={`s-${title}`} className="t-title">
          {title}
        </h2>
        {note && <p className="t-label mt-1">{note}</p>}
      </div>
      {children}
    </section>
  );
}
const Card = ({children, className = ""}: {children: ReactNode; className?: string}) => <div className={`panel p-5 ${className}`}>{children}</div>;

const SWATCHES: [string, string, string][] = [
  ["--bg", "#0b0a18", "App background"],
  ["--surface", "#1f1b33", "Panels, cards"],
  ["--surface-raised", "#2a2545", "Selected, hover"],
  ["--overlay", "#17124a", "Menus, toasts"],
  ["--accent", "#5b63ff", "Fills, borders"],
  ["--accent-strong", "#2d42fc", "Primary button"],
  ["--accent-text", "#a99cf6", "Accent text 6.9:1"],
  ["--supply", "#59d97a", "Lent, earning 9.2:1"],
  ["--borrow", "#f2a0c9", "Borrowed, shorted 8.4:1"],
  ["--weekend", "#a99cf6", "Weekend mode 6.9:1"],
  ["--caution", "#f2c14e", "At risk 9.9:1"],
  ["--danger", "#ff7a86", "Liquidatable 6.6:1"],
];

export function Gallery() {
  const toast = useToast();
  const [amount, setAmount] = useState("12.5");
  const [tickerVal, setTickerVal] = useState(0.0568);
  const [util, setUtil] = useState(0.62);
  const [hf, setHf] = useState(1.84);
  const [tab, setTab] = useState("lend");
  const [range, setRange] = useState<"7d" | "30d" | "90d">("7d");
  const [sheet, setSheet] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([
    {id: "approve", label: "Approve USDG", kind: "approve", status: "skipped"},
    {id: "authorize", label: "Authorize Morpho (first time only)", kind: "authorize", status: "done"},
    {id: "execute", label: "Borrow 10 NVDA and sell for USDG", kind: "execute", status: "active"},
  ]);
  const [weekend, setWeekend] = useState(false);

  const toggleWeekend = () => {
    const next = !weekend;
    setWeekend(next);
    document.documentElement.dataset.session = next ? "weekend" : "open";
  };

  return (
    <div className="space-y-14">
      <header className="space-y-2">
        <h1 className="t-display">Components</h1>
        <p className="max-w-2xl text-muted">Every Lendora primitive in every state, on the landing page's tokens. Dev only.</p>
      </header>

      <Section title="Session" note="The one signature transition: accent and glow shift to lavender over 600 ms; collateral numbers tick.">
        <div className="space-y-3 overflow-hidden rounded-md shadow-[var(--ring)]">
          <SessionBarView view={{state: "open", nextTs: NOW + 3 * 86400 + 3600 * 4, buffer: 0, paused: []}} now={NOW} />
          <SessionBarView view={{state: "ramping", nextTs: NOW + 3 * 3600 + 720, buffer: 0.04, paused: []}} now={NOW} />
          <SessionBarView view={{state: "weekend", nextTs: NOW + 86400 + 3 * 3600, buffer: 0.101, paused: ["NVDA"]}} now={NOW} />
          <SessionBarView now={NOW} error />
          <SessionBarView now={NOW} />
        </div>
        <Card className="flex flex-wrap items-center gap-6">
          <Button variant="secondary" onClick={toggleWeekend} data-testid="toggle-weekend">
            {weekend ? "Back to market open" : "Switch to weekend mode"}
          </Button>
          <dl className="flex gap-8">
            <Stat label="Collateral required" value={<NumberTicker value={weekend ? 6012.4 : 5461.9} format="usd" />} hint={weekend ? "Includes the 10.1% weekend buffer" : "No weekend buffer now"} />
            <Stat label="Accent (live)" value={<span className="inline-block size-6 rounded-full bg-live align-middle" />} />
          </dl>
        </Card>
      </Section>

      <Section title="Color" note="All from the landing page except caution (derived). Contrast on --surface.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {SWATCHES.map(([name, hex, use]) => (
            <div key={name} className="panel overflow-hidden">
              <div className="h-14" style={{background: `var(${name})`}} />
              <div className="p-3">
                <p className="text-[13px] font-medium">{name}</p>
                <p className="num text-[12px] text-muted">{hex}</p>
                <p className="text-[12px] text-muted">{use}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type" note="Instrument Sans only. Numbers use tabular figures.">
        <Card className="space-y-3">
          <p className="t-display">Lend NVDA, earn what shorts pay</p>
          <p className="t-title">Panel title, 22 / 400 / −0.03em</p>
          <p className="text-[15px] text-dim">Body, 15 / 400 / −0.02em. Rates are variable and move with utilization.</p>
          <p className="t-label">Label, 13 / muted</p>
          <p className="num text-[26px] font-medium">$1,234,567.89 · 11.11%</p>
        </Card>
      </Section>

      <Section title="Buttons" note="Press scales to 0.98. Disabled keeps the label readable.">
        <Card className="space-y-4">
          {(["primary", "secondary", "ghost", "supply", "borrow", "danger"] as const).map((v) => (
            <div key={v} className="flex flex-wrap items-center gap-3">
              <Button variant={v} size="sm">
                {v === "supply" ? "Lend NVDA" : v === "borrow" ? "Short NVDA" : v === "danger" ? "Close position" : "Review"}
              </Button>
              <Button variant={v}>{v === "supply" ? "Lend NVDA" : v === "borrow" ? "Short NVDA" : v === "danger" ? "Close position" : "Review"}</Button>
              <Button variant={v} size="lg">
                {v === "supply" ? "Lend NVDA" : v === "borrow" ? "Short NVDA" : v === "danger" ? "Close position" : "Review"}
              </Button>
              <Button variant={v} disabled>
                Disabled
              </Button>
            </div>
          ))}
        </Card>
      </Section>

      <Section title="Badges and icons">
        <Card className="flex flex-wrap items-center gap-3">
          {["open", "ramping", "closed", "guard_tripped"].map((s) => (
            <StatusBadge key={s} status={s} />
          ))}
          {(["easy", "tight", "hard", "paused"] as const).map((e) => (
            <EaseBadge key={e} ease={e} />
          ))}
          <Badge tone="supply" icon="trendUp">
            Lending
          </Badge>
          <Badge tone="borrow" icon="arrowDown">
            Short
          </Badge>
          <Badge tone="accent">Variable</Badge>
          <span className="mx-2 h-6 w-px bg-line" />
          <AssetIcon ticker="NVDA" size="sm" />
          <AssetIcon ticker="AAPL" />
          <AssetIcon ticker="SPY" size="lg" />
          <AssetIcon ticker="rNVDA" kind="receipt" />
          <AssetIcon ticker="USDG" kind="usd" />
          <InfoTip content="Extra detail on hover or focus. Never the only place for risk information." />
        </Card>
      </Section>

      <Section title="Amount input" note="MAX, balance, live USD, inline validation.">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <AmountInput label="Amount to lend" value={amount} onChange={setAmount} decimals={18} unit="NVDA" max={W(40.25)} usdPrice={182.41} hint="Earns the supply APY, paid by borrowers." />
          </Card>
          <Card>
            <AmountInput label="Amount to lend" value="" onChange={() => {}} decimals={18} unit="NVDA" max={W(40.25)} usdPrice={182.41} />
          </Card>
          <Card>
            <AmountInput label="Collateral" value="90000" onChange={() => {}} decimals={6} unit="USDG" max={50_000n * 10n ** 6n} usdPrice={1} />
          </Card>
          <Card>
            <AmountInput label="Amount to withdraw" value="1.2.3" onChange={() => {}} decimals={18} unit="rNVDA" max={W(5)} maxLabel="Withdrawable now" />
          </Card>
          <Card>
            <AmountInput label="Borrow amount" value="" onChange={() => {}} decimals={18} unit="SPY" disabled hint="Connect a wallet to borrow." />
          </Card>
        </div>
      </Section>

      <Section title="Numbers, bars and meters" note="Tickers and bars animate only when the value changes (400 ms, ease-out).">
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="space-y-4">
            <dl className="grid grid-cols-2 gap-4">
              <Stat label="Supply APY" value={<NumberTicker value={tickerVal} format="pct" />} tone="supply" size="lg" />
              <Stat label="Total supplied" value={<NumberTicker value={tickerVal * 42_000_000} format="usd" digits={0} />} size="lg" />
            </dl>
            <Button variant="secondary" size="sm" onClick={() => setTickerVal((v) => Math.max(0.001, v + (Math.random() - 0.45) * 0.02))}>
              Change value
            </Button>
          </Card>
          <Card className="space-y-3">
            {[0.12, 0.55, util, 0.83, 0.93].map((u, i) => (
              <UtilBar key={i} value={u} />
            ))}
            <Button variant="secondary" size="sm" onClick={() => setUtil(Math.random())}>
              Change utilization
            </Button>
          </Card>
          <Card className="space-y-3">
            <Sparkline values={[3, 4, 3.5, 5, 6, 5.8, 7, 7.4]} label="Borrow rate, 7 days, rising" />
            <Sparkline values={[7, 6.5, 6.8, 5, 4.2, 4.6, 3.9]} color="var(--borrow)" label="Falling" />
            <Sparkline values={[5]} label="No history" />
          </Card>
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <HealthMeter hf={W(2.4)} />
          </Card>
          <Card>
            <HealthMeter hf={W(1.32)} />
          </Card>
          <Card>
            <HealthMeter hf={W(1.04)} />
          </Card>
          <Card>
            <HealthMeter hf={2n ** 256n - 1n} />
          </Card>
          <Card className="space-y-3 md:col-span-2">
            <HealthMeter hf={W(2.1)} next={W(hf)} />
            <input type="range" min={1} max={3} step={0.01} value={hf} onChange={(e) => setHf(Number(e.target.value))} className="w-full" aria-label="Preview health factor" />
            <p className="t-label">Live preview: old value stays as a tick, the fill and color follow the new one.</p>
          </Card>
        </div>
      </Section>

      <Section title="Notices">
        <div className="grid gap-3 md:grid-cols-2">
          <Notice title="Connect a wallet to lend">Your balances and positions appear here.</Notice>
          <Notice tone="weekend" title="Weekend mode">
            Collateral required includes a 10.1% safety buffer until markets reopen.
          </Notice>
          <Notice tone="warn" title="Withdrawals limited by liquidity">
            3 NVDA ready now. 2 NVDA are lent out and free up as borrowers repay.
          </Notice>
          <Notice tone="safe" title="Lent 10 NVDA" />
          <Notice tone="danger" title="The swap returned less than your minimum">
            The price moved beyond your slippage. Retry with a new quote.
          </Notice>
          <GuardBanner reasons={["stale price feed"]} />
        </div>
      </Section>

      <Section title="Transaction stepper">
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="space-y-4">
            <StepList steps={steps} />
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setSteps((s) => {
                  const i = s.findIndex((x) => x.status === "active");
                  if (i < 0) return s.map((x, j) => ({...x, status: j === 0 ? "skipped" : j === 1 ? "active" : "pending"}));
                  return s.map((x, j) => (j === i ? {...x, status: "done"} : j === i + 1 ? {...x, status: "active"} : x));
                })
              }
            >
              Advance
            </Button>
          </Card>
          <Card>
            <StepList
              steps={[
                {id: "a", label: "Approve NVDA", kind: "approve", status: "done"},
                {id: "b", label: "Lend 10 NVDA", kind: "execute", status: "failed", detail: "Your balance is too low for this amount."},
              ]}
            />
          </Card>
        </div>
      </Section>

      <Section title="Tabs, sheet, toasts">
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="space-y-4">
            <Tabs
              id="demo"
              label="Action"
              value={tab}
              onValueChange={setTab}
              items={[
                {value: "lend", label: "Lend", tone: "supply"},
                {value: "borrow", label: "Borrow", tone: "borrow"},
                {value: "short", label: "Short", tone: "borrow"},
              ]}
            >
              <TabPanel value="lend" className="pt-4 text-dim">
                Lend content cross-fades in.
              </TabPanel>
              <TabPanel value="borrow" className="pt-4 text-dim">
                Borrow content.
              </TabPanel>
              <TabPanel value="short" className="pt-4 text-dim">
                Short content.
              </TabPanel>
            </Tabs>
            <Segmented
              label="Range"
              value={range}
              onChange={setRange}
              options={[
                {value: "7d", label: "7d"},
                {value: "30d", label: "30d"},
                {value: "90d", label: "90d"},
              ]}
            />
          </Card>
          <Card className="flex flex-wrap items-start gap-3">
            <Button onClick={() => setSheet(true)}>Open sheet</Button>
            <Button
              variant="secondary"
              onClick={() => {
                const id = toast.push({status: "pending", title: "Lending 10 NVDA", body: "Confirm in your wallet."});
                setTimeout(() => toast.update(id, {status: "success", title: "Lent 10 NVDA", body: "You now hold 9.98 rNVDA.", hash: "0x" + "1".repeat(64) as `0x${string}`}), 1800);
              }}
            >
              Toast: pending → confirmed
            </Button>
            <Button variant="secondary" onClick={() => toast.push({status: "error", title: "Couldn't lend NVDA", body: "You cancelled the request in your wallet."})}>
              Toast: failed
            </Button>
            <div className="w-full pt-2">
              <Address address="0x14dC79964da2C08b23698B3D3cc7Ca32193d9955" />
            </div>
          </Card>
        </div>
        <Sheet open={sheet} onOpenChange={setSheet} title="Review lend" description="Check the details, then confirm in your wallet." footer={<Button className="w-full" onClick={() => setSheet(false)}>Confirm</Button>}>
          <dl className="divide-y divide-line">
            <Row label="You lend" value="10 NVDA ($1,824.10)" emphasis />
            <Row label="You receive" value="9.98 rNVDA" />
            <Row label="Supply APY (variable)" value="5.68%" />
          </dl>
        </Sheet>
      </Section>

      <Section title="Loading, empty, error">
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </Card>
          <EmptyState title="You're not lending anything yet" action={<Button variant="secondary">Pick a stock from the board</Button>}>
            Lend a Stock Token to earn the fees borrowers pay.
          </EmptyState>
          <EmptyState title="Market data didn't load" tone="danger" icon="alert" action={<Button variant="secondary">Try again</Button>}>
            The data API didn&apos;t respond. Your positions still read from the chain.
          </EmptyState>
        </div>
      </Section>

      <Section title="Onboarding">
        <div className="grid gap-4 md:grid-cols-2">
          {(["eligible", "restricted", "unknown", "checking"] as const).map((s) => (
            <Card key={s}>
              <OnboardingBody status={s} country="DE" onDone={() => {}} />
            </Card>
          ))}
        </div>
      </Section>
    </div>
  );
}
