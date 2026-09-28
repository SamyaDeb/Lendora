import {pct} from "@/lib/format";

/** A labelled stacked bar (allocation, yield split). Every segment is also listed with its value; color is not the only cue. */
export function StackBar({items, label}: {items: {label: string; value: number; color: string; note?: string}[]; label: string}) {
  const total = items.reduce((a, i) => a + Math.max(0, i.value), 0) || 1;
  return (
    <div className="space-y-4">
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${label}: ${items.map((i) => `${i.label} ${pct(i.value / total, 1)}`).join(", ")}`}>
        {items
          .filter((i) => i.value > 0)
          .map((i) => (
            <span key={i.label} className="h-full first:rounded-l-full last:rounded-r-full" style={{width: `${((i.value / total) * 100).toFixed(2)}%`, background: i.color}} />
          ))}
      </div>
      <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {items.map((i) => (
          <li key={i.label} className="flex gap-2.5">
            <span className="mt-1.5 size-2.5 shrink-0 rounded-[3px]" style={{background: i.color}} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="flex justify-between gap-3 text-[14px]">
                <span className="text-dim">{i.label}</span>
                <span className="num font-medium">{pct(i.value, 2)}</span>
              </span>
              {i.note && <span className="block text-[12.5px] leading-snug text-muted">{i.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
