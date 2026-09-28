/**
 * OFF-12: Content-Security-Policy and HSTS for every page (next.config.ts). The app loads no third-party scripts; the
 * only cross-origin traffic is the public API (HTTP + WebSocket), the JSON-RPC endpoint, and the wallet connectors
 * (WalletConnect relay/verify, Coinbase Wallet). `'unsafe-inline'` stays in script-src because Next's App Router
 * bootstrap is inline and a nonce needs per-request rendering (tracked residual in docs/audit/offchain-review.md);
 * everything else is locked to the listed origins, and framing is refused.
 * Pure: build-time env is passed in, so the unit test and next.config.ts share it.
 */
function origins(url: string | undefined): string[] {
  if (!url) return [];
  try {
    const u = new URL(url);
    const ws = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : undefined;
    return [u.origin, ...(ws ? [`${ws}//${u.host}`] : [])];
  } catch {
    return [];
  }
}

const WALLET_CONNECT = ["https://*.walletconnect.com", "wss://*.walletconnect.com", "https://*.walletconnect.org", "wss://*.walletconnect.org", "https://*.web3modal.org", "https://*.reown.com"];
const COINBASE = ["https://*.coinbase.com", "wss://*.coinbase.com"];

export function contentSecurityPolicy(env: Record<string, string | undefined>): string {
  const dev = env.NODE_ENV === "development";
  const api = env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:42070";
  const rpc = env.NEXT_PUBLIC_RPC_URL ?? (Number(env.NEXT_PUBLIC_CHAIN_ID ?? 31337) === 31337 ? "http://127.0.0.1:8545" : undefined);
  const connect = ["'self'", ...origins(api), ...origins(rpc), ...WALLET_CONNECT, ...COINBASE, ...(dev ? ["ws://localhost:*", "ws://127.0.0.1:*"] : [])];
  const d: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [...new Set(connect)],
    "frame-src": ["https://verify.walletconnect.com", "https://verify.walletconnect.org", "https://secure.walletconnect.org", "https://keys.coinbase.com"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(d)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

/** Headers for every route: the pre-existing four plus CSP and (production only) HSTS. */
export function securityHeaders(env: Record<string, string | undefined>): {key: string; value: string}[] {
  return [
    {key: "X-Content-Type-Options", value: "nosniff"},
    {key: "Referrer-Policy", value: "strict-origin-when-cross-origin"},
    {key: "X-Frame-Options", value: "DENY"},
    {key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()"},
    {key: "Content-Security-Policy", value: contentSecurityPolicy(env)},
    ...(env.NODE_ENV === "production" ? [{key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains"}] : []),
  ];
}
