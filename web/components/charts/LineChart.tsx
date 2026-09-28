"use client";
import {useId, useState} from "react";
import {feedSessions} from "@stockline/sdk";

/**
 * SVG line chart (no chart library: keeps the bundle small for Lighthouse). Feed closures (weekends, holidays) are
 * shaded in the weekend color. Two series share the x axis; the second gets its own scale on the right. Hover or
 * arrow keys show a readout.
 */
export interface Series {
  label: string;
  points: {t: number; v: number}[];
  unit?: "%" | "" | "$";
  color?: string;
  dashed?: boolean;
  /** Start the axis at 0 (default). False fits the axis to the data (share prices). */
  zero?: boolean;
  /** Overrides the unit formatting (axis and readout). */
  format?: (v: number) => string;
}

const W = 720;
const H = 230;
const PAD = {l: 54, r: 54, t: 14, b: 28};

export function fmtValue(v: number, unit?: string) {
  if (unit === "%") return `${(v * 100).toFixed(v < 0.1 ? 2 : 1)}%`;
  if (unit === "$") return `$${v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0)}`;
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0);
}

export function LineChart({a, b, title, subtitle}: {a: Series; b?: Series; title: string; subtitle?: string}) {
  const gid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const ca = a.color ?? "var(--accent-text)";
  const cb = b?.color ?? "var(--borrow)";
  const head = (
    <figcaption className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span className="text-[15px] font-medium">{title}</span>
      {subtitle && <span className="text-[12.5px] text-muted">{subtitle}</span>}
      <span className="ml-auto flex flex-wrap gap-3 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-4 rounded" style={{background: ca}} /> {a.label}
        </span>
        {b && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0.5 w-4 rounded" style={{background: cb}} /> {b.label}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-3 rounded-[3px] bg-weekend-soft shadow-[inset_0_0_0_1px_rgba(169,156,246,0.35)]" /> Feed closed
        </span>
      </span>
    </figcaption>
  );
  if (a.points.length < 2) {
    return (
      <figure className="panel p-5">
        {head}
        <p className="py-16 text-center text-[14px] text-muted">Not enough history yet. Charts fill in as the market trades.</p>
      </figure>
    );
  }
  const all = [...a.points, ...(b?.points ?? [])];
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const scale = (s: Series) => {
    const vs = s.points.map((p) => p.v);
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const pad = (max - min || Math.abs(max) || 1) * 0.08;
    const lo = s.zero === false ? min - pad : Math.min(0, min);
    const hi = s.zero === false ? max + pad : Math.max(max, lo + 1e-12) * 1.08;
    return {lo, hi, y: (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b)};
  };
  const sa = scale(a);
  const sb = b ? scale(b) : undefined;
  const fa = (v: number) => (a.format ? a.format(v) : fmtValue(v, a.unit));
  const fb = (v: number) => (b?.format ? b.format(v) : fmtValue(v, b?.unit));
  const path = (pts: {t: number; v: number}[], y: (v: number) => number) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${path(a.points, sa.y)} L${x(a.points[a.points.length - 1].t).toFixed(1)},${H - PAD.b} L${x(a.points[0].t).toFixed(1)},${H - PAD.b} Z`;
  const closures = feedSessions
    .slice(0, -1)
    .map((s, i) => ({from: s.closeTs, to: feedSessions[i + 1].openTs}))
    .filter((c) => c.to > t0 && c.from < t1);
  const ticks = [0, 0.5, 1].map((f) => t0 + f * (t1 - t0));
  const hp = hover !== null ? a.points[hover] : undefined;
  const hb = hp && b ? b.points.reduce((best, p) => (Math.abs(p.t - hp.t) < Math.abs(best.t - hp.t) ? p : best), b.points[0]) : undefined;
  const last = a.points[a.points.length - 1];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0);
    let best = 0;
    a.points.forEach((p, i) => Math.abs(p.t - t) < Math.abs(a.points[best].t - t) && (best = i));
    setHover(best);
  };
  return (
    <figure className="panel p-5">
      {head}
      <div className="mt-2 flex items-baseline gap-4 text-[13px]" aria-live="polite">
        <span className="num text-[20px] font-medium tracking-[-0.02em]" style={{color: ca}}>
          {fa((hp ?? last).v)}
        </span>
        {b && <span className="num text-[15px]" style={{color: cb}}>{fb((hb ?? b.points[b.points.length - 1]).v)}</span>}
        <span className="text-muted">{new Date((hp ?? last).t * 1000).toUTCString().slice(5, 22)} UTC</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 h-auto w-full touch-pan-y outline-none"
        role="img"
        aria-label={`${title}: ${a.label}${b ? ` and ${b.label}` : ""} over time. Latest ${a.label} ${fa(last.v)}.`}
        tabIndex={0}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          setHover((h) => Math.max(0, Math.min(a.points.length - 1, (h ?? a.points.length - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
        }}
        onBlur={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`fill-${gid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={ca} stopOpacity="0.22" />
            <stop offset="1" stopColor={ca} stopOpacity="0" />
          </linearGradient>
        </defs>
        {closures.map((c) => (
          <rect key={c.from} x={x(Math.max(c.from, t0))} y={PAD.t} width={Math.max(1, x(Math.min(c.to, t1)) - x(Math.max(c.from, t0)))} height={H - PAD.t - PAD.b} fill="var(--weekend-soft)" />
        ))}
        {[sa.lo, (sa.lo + sa.hi) / 2, sa.hi].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sa.y(v)} y2={sa.y(v)} stroke="var(--border)" />
            <text x={PAD.l - 8} y={sa.y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)" className="num">
              {fa(v)}
            </text>
          </g>
        ))}
        {sb &&
          [sb.lo, sb.hi].map((v) => (
            <text key={v} x={W - PAD.r + 8} y={sb.y(v) + 4} fontSize="11" fill="var(--text-muted)" className="num">
              {fb(v)}
            </text>
          ))}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
            {new Date(t * 1000).toISOString().slice(5, 10)}
          </text>
        ))}
        <path d={area} fill={`url(#fill-${gid})`} />
        <path d={path(a.points, sa.y)} fill="none" stroke={ca} strokeWidth="1.75" strokeLinejoin="round" />
        {b && sb && <path d={path(b.points, sb.y)} fill="none" stroke={cb} strokeWidth="1.5" strokeDasharray={b.dashed === false ? undefined : "4 3"} strokeLinejoin="round" />}
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={H - PAD.b} stroke="var(--border-strong)" />
            <circle cx={x(hp.t)} cy={sa.y(hp.v)} r="3.5" fill={ca} stroke="var(--surface)" strokeWidth="2" />
            {hb && sb && <circle cx={x(hb.t)} cy={sb.y(hb.v)} r="3.5" fill={cb} stroke="var(--surface)" strokeWidth="2" />}
          </g>
        )}
      </svg>
    </figure>
  );
}
