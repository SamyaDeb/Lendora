import {cn} from "@/lib/cn";
import {pct} from "@/lib/format";

type Key = "lending" | "funding" | "buffer" | "costs";
const PARTS: {key: Key; label: string; color: string}[] = [
  {key: "lending", label: "Lending fees", color: "var(--supply)"},
  {key: "funding", label: "Perp funding", color: "var(--accent-text)"},
  {key: "buffer", label: "Cash buffer", color: "var(--violet-200)"},
  {key: "costs", label: "Costs", color: "var(--danger)"},
];
/** Costs (and any source that turned negative) are drawn as danger stripes over the end of the gross bar. */
const STRIPES = "repeating-linear-gradient(135deg, var(--danger) 0 2px, transparent 2px 5px)";
const signed = (v: number) => `${v < 0 ? "−" : "+"}${pct(Math.abs(v))}`;

/**
 * Where a yield comes from (StackBar variant): lending, funding and buffer fill the gross bar; costs are negative and
 * shown taken off its end. Every part is also listed as text with its signed value, and the net is the sum.
 */
export function YieldSplitBar({split, notes, label = "Yield split", className}: {split: Record<Key, number>; notes?: Partial<Record<Key, string>>; label?: string; className?: string}) {
  const gross = PARTS.filter((p) => p.key !== "costs").reduce((a, p) => a + Math.max(0, split[p.key]), 0);
  const net = split.lending + split.funding + split.buffer + split.costs;
  const w = (v: number) => (gross > 0 ? Math.round((Math.max(0, v) / gross) * 1e4) / 100 : 0);
  const taken = PARTS.reduce((a, p) => a - Math.min(0, split[p.key]), 0); // costs, plus any source that turned negative
  const cost = gross > 0 ? Math.min(100, Math.round((taken / gross) * 1e4) / 100) : 0;
  return (
    <div className={cn("space-y-4", className)} data-testid="yield-split">
      <div className="relative" role="img" aria-label={`${label}: ${PARTS.map((p) => `${p.label} ${signed(split[p.key])}`).join(", ")}; net ${pct(net)}`}>
        <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-white/[0.07]">
          {PARTS.filter((p) => p.key !== "costs" && split[p.key] > 0).map((p) => (
            <span key={p.key} className="h-full" style={{width: `${w(split[p.key])}%`, background: p.color}} />
          ))}
        </div>
        {cost > 0 && <span aria-hidden className="absolute inset-y-0 right-0 rounded-r-full bg-[var(--surface)]" style={{width: `${cost}%`, backgroundImage: STRIPES}} />}
      </div>
      <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {PARTS.map((p) => (
          <li key={p.key} className="flex gap-2.5" data-part={p.key}>
            <span className="mt-1.5 size-2.5 shrink-0 rounded-[3px]" style={p.key === "costs" ? {backgroundImage: STRIPES, boxShadow: "inset 0 0 0 1px var(--danger)"} : {background: p.color}} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="flex justify-between gap-3 text-[14px]">
                <span className="text-dim">{p.label}</span>
                <span className={cn("num font-medium", split[p.key] < 0 && "text-danger")}>{signed(split[p.key])}</span>
              </span>
              {notes?.[p.key] && <span className="block text-[12.5px] leading-snug text-muted">{notes[p.key]}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="flex justify-between gap-3 border-t border-line pt-3 text-[14px]">
        <span className="text-dim">Net APY</span>
        <span className="num font-semibold text-supply" data-testid="split-net">
          {pct(net)}
        </span>
      </p>
    </div>
  );
}
