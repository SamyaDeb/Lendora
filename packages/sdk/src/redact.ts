/**
 * Offchain review (Phase 3 task 9, OFF-1): error text must never carry a secret. viem puts the full RPC URL in its
 * error messages (`URL: https://…/v2/<API key>`), and fetch errors can echo request URLs, so every error that reaches a
 * log, a `/health` body or a page goes through `redactSecrets` first.
 *
 * It replaces (1) the value of every env var whose name looks secret (`*_KEY`, `*_SECRET`, `*_TOKEN`, `*_AUTH`,
 * `*PASSWORD*`, `*_URL`, `DATABASE_URL`, `REDIS_URL`) when the value is at least 8 characters, and (2) any URL's
 * userinfo, path and query after the host (`https://host/…` → `https://host/[redacted]`), so a key in a URL is gone
 * even when the var name is unusual. Pure: the caller passes the env (browser bundles never read `process.env`).
 */
const SECRET_NAME = /(_KEY|_SECRET|_TOKEN|_AUTH|PASSWORD|_URL|^DATABASE_URL$|^REDIS_URL$)$/i;
const URL_RE = /\b((?:https?|wss?|postgres(?:ql)?|redis|rediss):\/\/)([^\s/"'`<>]*@)?([^\s/"'`<>?#]+)([/?#][^\s"'`<>]*)?/gi;

export function redactSecrets(text: string, env: Record<string, string | undefined> = {}): string {
  let out = text;
  const values = Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === "string" && v.length >= 8)
    .sort((a, b) => b[1]!.length - a[1]!.length);
  for (const [k, v] of values) out = out.split(v!).join(`[redacted:${k}]`);
  return out.replace(URL_RE, (_m, scheme: string, userinfo: string | undefined, host: string, rest: string | undefined) => {
    const tail = rest && rest !== "/" ? "/[redacted]" : (rest ?? "");
    return `${scheme}${userinfo ? "[redacted]@" : ""}${host}${tail}`;
  });
}

/** One redacted line for an unknown error (its lines joined with " | ", at most `max` characters). */
export function safeErrorLine(e: unknown, env: Record<string, string | undefined> = {}, max = 300): string {
  const first = redactSecrets(e instanceof Error ? `${e.name}: ${e.message}` : String(e), env)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" | ");
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

/**
 * A `pg.Pool` emits `'error'` when an idle client's connection drops (Postgres restart, network blip); with no listener
 * Node throws it and the whole service dies (46630, 2026-09-30: alerts, "Connection terminated unexpectedly"). The pool
 * discards that client and opens a new one on the next query, so logging is enough. Typed structurally so the SDK does
 * not depend on `pg`.
 */
export function logPoolErrors<P extends {on(event: "error", listener: (e: Error) => void): unknown}>(
  pool: P,
  tag: string,
  env: Record<string, string | undefined> = {},
  log: (line: string) => void = console.error,
): P {
  pool.on("error", (e) => log(`[${tag}] postgres idle client error: ${safeErrorLine(e, env)}`));
  return pool;
}
