import {formatUnits} from "viem";
import {HF_AMBER_WAD, HF_GREEN_WAD} from "@stockline/sdk";

/** Display helpers. Numbers are computed by @stockline/sdk; these only format. */
export function num(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return "–";
  return x.toLocaleString("en-US", {minimumFractionDigits: digits, maximumFractionDigits: digits});
}
export function wad(x: bigint | string | undefined, digits = 2, decimals = 18): string {
  if (x === undefined) return "–";
  return num(Number(formatUnits(BigInt(x), decimals)), digits);
}
export function pct(x: number | string | bigint | undefined, digits = 2, fromWad = false): string {
  if (x === undefined) return "–";
  const v = typeof x === "bigint" || fromWad ? Number(formatUnits(BigInt(x), 18)) : Number(x);
  return `${num(v * 100, digits)}%`;
}
export function usd(x: number | string, digits = 2): string {
  const v = Number(x);
  if (Math.abs(v) >= 1e6) return `$${num(v / 1e6, 2)}M`;
  if (Math.abs(v) >= 1e4) return `$${num(v / 1e3, 1)}k`;
  return `$${num(v, digits)}`;
}
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** APP-R6: ≥ 1.5 green, 1.1–1.5 amber, < 1.1 red. Liquidation at 1.0. */
export function hfTone(hf: bigint | undefined): "safe" | "warn" | "danger" | "none" {
  if (hf === undefined || hf > 10n ** 30n) return "none";
  if (hf >= HF_GREEN_WAD) return "safe";
  if (hf >= HF_AMBER_WAD) return "warn";
  return "danger";
}
export function hfText(hf: bigint | undefined): string {
  if (hf === undefined) return "–";
  if (hf > 10n ** 30n) return "∞";
  return num(Number(formatUnits(hf, 18)), 2);
}

/** "Fri 12:00 ET" for a UTC timestamp (seconds). */
export function et(ts: number | bigint): string {
  const d = new Date(Number(ts) * 1000);
  return new Intl.DateTimeFormat("en-US", {weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York"}).format(d) + " ET";
}
export function until(ts: number | bigint, now: number): string {
  let s = Math.max(0, Number(ts) - now);
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s - h * 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
