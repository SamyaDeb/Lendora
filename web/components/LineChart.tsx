import {feedSessions} from "@stockline/sdk";

/**
 * Minimal SVG line chart (no chart library: keeps the bundle small for Lighthouse). Feed closures (weekends,
 * holidays) are shaded (07 §4). Two series share the x axis; the second gets its own scale on the right only when
 * given.
 */
export interface Series {
  label: string;
  points: {t: number; v: number}[];
  unit?: "%" | "" | "$";
}

const W = 720;
const H = 220;
const PAD = {l: 52, r: 52, t: 12, b: 28};

function fmt(v: number, unit?: string) {
  if (unit === "%") return `${(v * 100).toFixed(v < 0.1 ? 2 : 1)}%`;
  if (unit === "$") return `$${v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0)}`;
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0);
}

export function LineChart({a, b, title}: {a: Series; b?: Series; title: string}) {
  const all = [...a.points, ...(b?.points ?? [])];
  if (a.points.length < 2) {
    return (
      <figure className="card p-4">
        <figcaption className="text-sm font-semibold">{title}</figcaption>
        <p className="py-10 text-center text-sm text-[var(--color-muted)]">Not enough history yet.</p>
      </figure>
    );
  }
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const scale = (pts: {v: number}[]) => {
    const lo = Math.min(0, ...pts.map((p) => p.v));
    const hi = Math.max(...pts.map((p) => p.v), lo + 1e-12);
    return {lo, hi, y: (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b)};
  };
  const sa = scale(a.points);
  const sb = b ? scale(b.points) : undefined;
  const path = (pts: {t: number; v: number}[], y: (v: number) => number) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const closures = feedSessions
    .slice(0, -1)
    .map((s, i) => ({from: s.closeTs, to: feedSessions[i + 1].openTs}))
    .filter((c) => c.to > t0 && c.from < t1);
  const ticks = [0, 0.5, 1].map((f) => t0 + f * (t1 - t0));
  return (
    <figure className="card p-4">
      <figcaption className="flex flex-wrap items-center gap-3 text-sm font-semibold">
        {title}
        <span className="flex items-center gap-1 text-xs font-normal text-[var(--color-muted)]">
          <span aria-hidden className="inline-block h-0.5 w-4 bg-[var(--color-accent)]" /> {a.label}
        </span>
        {b && (
          <span className="flex items-center gap-1 text-xs font-normal text-[var(--color-muted)]">
            <span aria-hidden className="inline-block h-0.5 w-4 bg-[var(--color-warn)]" /> {b.label}
          </span>
        )}
        <span className="flex items-center gap-1 text-xs font-normal text-[var(--color-muted)]">
          <span aria-hidden className="inline-block h-3 w-4 bg-[var(--color-info-bg)]" /> feed closed
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-auto w-full" role="img" aria-label={`${title}: ${a.label}${b ? ` and ${b.label}` : ""} over time`}>
        {closures.map((c) => (
          <rect key={c.from} x={x(Math.max(c.from, t0))} y={PAD.t} width={Math.max(1, x(Math.min(c.to, t1)) - x(Math.max(c.from, t0)))} height={H - PAD.t - PAD.b} fill="var(--color-info-bg)" />
        ))}
        {[sa.lo, (sa.lo + sa.hi) / 2, sa.hi].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sa.y(v)} y2={sa.y(v)} stroke="var(--color-line)" />
            <text x={PAD.l - 6} y={sa.y(v) + 4} textAnchor="end" fontSize="11" fill="var(--color-muted)">
              {fmt(v, a.unit)}
            </text>
          </g>
        ))}
        {sb &&
          [sb.lo, sb.hi].map((v) => (
            <text key={v} x={W - PAD.r + 6} y={sb.y(v) + 4} fontSize="11" fill="var(--color-muted)">
              {fmt(v, b!.unit)}
            </text>
          ))}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--color-muted)">
            {new Date(t * 1000).toISOString().slice(5, 10)}
          </text>
        ))}
        <path d={path(a.points, sa.y)} fill="none" stroke="var(--color-accent)" strokeWidth="2" />
        {b && sb && <path d={path(b.points, sb.y)} fill="none" stroke="var(--color-warn)" strokeWidth="2" strokeDasharray="4 3" />}
      </svg>
    </figure>
  );
}
