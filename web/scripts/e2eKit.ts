/**
 * Shared by the live-stack suites (testnetE2E.ts, testnetBreak.ts): CLI args, the step/result table, HTTP status
 * checks, and "this call must revert with that error" by simulation.
 */
import {createPublicClient, http, type Abi, type PublicClient} from "viem";

export const arg = (n: string, d = "") => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
export const has = (n: string) => process.argv.includes(`--${n}`);
export const trim = (u: string) => u.replace(/\/$/, "");

export type Result = true | false | "skip";
export type Row = {group: string; name: string; ok: Result; detail: string};

/**
 * `explain`: the web app's APP-R3 message for an error (lib/errors.ts). When given, `refuses` also fails when a user
 * would see a raw or generic message for that revert.
 */
export function kit(rpc: string, tag = "e2e", explain?: (e: unknown) => string) {
  const rows: Row[] = [];
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${tag}] ${m}`);
  const client = createPublicClient({transport: http(rpc)}) as PublicClient;

  async function step(group: string, name: string, f: () => Promise<string | {skip: string}>) {
    try {
      const r = await f();
      const skip = typeof r === "object";
      rows.push({group, name, ok: skip ? "skip" : true, detail: skip ? r.skip : r});
      log(`${skip ? "SKIP" : "ok  "} ${group} · ${name} · ${skip ? r.skip : r}`);
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 220);
      rows.push({group, name, ok: false, detail});
      log(`FAIL ${group} · ${name} · ${detail}`);
    }
  }

  const get = (url: string, init?: RequestInit) => fetch(url, {...init, redirect: "manual", signal: AbortSignal.timeout(60_000)});
  async function status(url: string, want: number | number[], init?: RequestInit): Promise<Response> {
    const r = await get(url, init);
    const ok = Array.isArray(want) ? want.includes(r.status) : r.status === want;
    if (!ok) throw new Error(`${url.replace(/^https?:\/\/[^/]+/, "").slice(0, 120)} → ${r.status}, expected ${want}`);
    return r;
  }

  /** The decoded revert of simulating `fn` from `from`, or undefined when it succeeds. */
  async function revertOf(abi: Abi | readonly unknown[], address: `0x${string}`, functionName: string, args: readonly unknown[], from: `0x${string}`): Promise<{name: string; args: readonly unknown[]; text: string; shown?: string} | undefined> {
    try {
      await client.simulateContract({address, abi: abi as Abi, functionName, args, account: from} as never);
      return undefined;
    } catch (e) {
      const err = e as {shortMessage?: string; message?: string; walk?: (f: (x: unknown) => boolean) => unknown};
      const inner = err.walk?.((x) => typeof (x as {data?: {errorName?: string}}).data?.errorName === "string") as {data?: {errorName?: string; args?: unknown[]}} | undefined;
      const name = inner?.data?.errorName ?? "";
      const a = inner?.data?.args ?? [];
      const shown = explain?.(e);
      return {name, args: a, shown, text: `${name} ${name === "Error" ? String(a[0]) : ""} ${shown ?? ""} ${err.shortMessage ?? ""} ${err.message ?? ""}`};
    }
  }

  /** Simulate `fn` from `from`; passes only when it reverts and the error matches `want`. */
  async function refuses(abi: Abi | readonly unknown[], address: `0x${string}`, functionName: string, args: readonly unknown[], from: `0x${string}`, want: RegExp): Promise<string> {
    const r = await revertOf(abi, address, functionName, args, from);
    if (!r) throw new Error(`did not revert (expected ${want})`);
    const label = r.name === "Error" ? `Error("${String(r.args[0])}")` : r.name || r.text.trim().slice(0, 80);
    if (r.shown !== undefined && /would fail \(|unknown reason|reverted with the following signature|^execution reverted/i.test(r.shown)) throw new Error(`reverted (${label}) but the app would show a raw message: "${r.shown.slice(0, 120)}" (APP-R3)`);
    if (want.test(r.text)) return `reverted: ${label}${r.shown ? ` → "${r.shown.slice(0, 70)}…"` : ""}`;
    throw new Error(`reverted with the wrong reason: ${label.slice(0, 160)} (expected ${want})`);
  }

  function table(): string {
    return `| Group | Check | Result | Detail |
|---|---|---|---|
${rows.map((r) => `| ${r.group} | ${r.name.replace(/\|/g, "\\|")} | ${r.ok === "skip" ? "skip" : r.ok ? "ok" : "**FAIL**"} | ${r.detail.replace(/\|/g, "\\|")} |`).join("\n")}`;
  }
  const counts = () => {
    const failed = rows.filter((r) => r.ok === false).length;
    const skipped = rows.filter((r) => r.ok === "skip").length;
    return {failed, skipped, ok: rows.length - failed - skipped, seconds: Math.round((Date.now() - t0) / 1000)};
  };

  return {rows, log, client, step, get, status, revertOf, refuses, table, counts};
}
