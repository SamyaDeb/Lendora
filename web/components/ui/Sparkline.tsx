/** Tiny static trend line for table rows (no axes, no animation). `label` describes it for screen readers. */
export function Sparkline({values, color = "var(--accent-text)", width = 72, height = 22, label}: {values: number[]; color?: string; width?: number; height?: number; label: string}) {
  if (values.length < 2) return <span className="inline-block text-[12px] text-muted" style={{width}}>–</span>;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="block overflow-visible">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r="2" fill={color} />
    </svg>
  );
}
