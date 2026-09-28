import {createHmac} from "node:crypto";
import {lookup as dnsLookup} from "node:dns/promises";
import {request as httpRequest} from "node:http";
import {request as httpsRequest} from "node:https";
import {isIP} from "node:net";
import type {AlertSettings} from "@stockline/sdk";

/**
 * APP-R8 delivery behind one interface. Real providers are wired by env (Resend for email, the Telegram Bot API,
 * signed webhooks); tests use `FakeTransport`; dry run logs only. Secrets (API keys, bot token, webhook signing key)
 * come from env and are never logged.
 */
export interface Alert {
  /** APP-R8 user alerts, or "ops" when an operator page (MON-R*) reuses the Telegram/webhook transports. */
  kind: "hf_below" | "ramp_24h" | "ramp_4h" | "ops";
  address: string;
  ticker: string;
  title: string;
  body: string;
  /** Block that triggered the alert and when it was seen. */
  block: bigint;
  blockTime: bigint;
  data: Record<string, string | number>;
}

export interface Transport {
  readonly channel: "email" | "telegram" | "webhook";
  /** Destination from the wallet's settings, or undefined if this channel is not set. */
  target(s: AlertSettings): string | undefined;
  send(target: string, a: Alert): Promise<void>;
}

export class FakeTransport implements Transport {
  readonly sent: {target: string; alert: Alert; at: number}[] = [];
  constructor(readonly channel: "email" | "telegram" | "webhook" = "webhook") {}
  target(s: AlertSettings) {
    return this.channel === "email" ? s.channels.email : this.channel === "telegram" ? s.channels.telegramChatId : s.channels.webhookUrl;
  }
  async send(target: string, alert: Alert) {
    this.sent.push({target, alert, at: Date.now()});
  }
}

export class ResendEmailTransport implements Transport {
  readonly channel = "email" as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}
  target(s: AlertSettings) {
    return s.channels.email;
  }
  async send(to: string, a: Alert) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {authorization: `Bearer ${this.apiKey}`, "content-type": "application/json"},
      body: JSON.stringify({from: this.from, to, subject: a.title, text: `${a.body}\n\nStockline alerts. Not investment advice.`}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`email ${r.status}`);
  }
}

export class TelegramTransport implements Transport {
  readonly channel = "telegram" as const;
  constructor(private readonly botToken: string) {}
  target(s: AlertSettings) {
    return s.channels.telegramChatId;
  }
  async send(chatId: string, a: Alert) {
    const r = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({chat_id: chatId, text: `${a.title}\n\n${a.body}`, disable_web_page_preview: true}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`telegram ${r.status}`);
  }
}

/**
 * OFF-6 (SSRF): true for any address a webhook must never reach: loopback, private, link-local (cloud metadata),
 * CGNAT (100.64/10), "this network", benchmarking, multicast/reserved, IPv6 ULA/link-local/multicast/unspecified,
 * NAT64, and IPv4-mapped IPv6 forms of all of those (`::ffff:127.0.0.1`, `::ffff:7f00:1`).
 */
export function isPrivateAddress(ip: string): boolean {
  let a = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = /^::ffff:(?:0:)?([0-9.]+|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/.exec(a);
  if (mapped) {
    const m = mapped[1];
    if (m.includes(".")) a = m;
    else {
      const [hi, lo] = m.split(":").map((x) => parseInt(x, 16));
      a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  if (isIP(a) === 4) {
    const [x, y] = a.split(".").map(Number);
    return (
      x === 0 || x === 10 || x === 127 || x >= 224 ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && (y === 168 || (y === 0 && a.split(".")[2] === "0"))) ||
      (x === 198 && (y === 18 || y === 19))
    );
  }
  if (isIP(a) === 6) {
    return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith("64:ff9b:") || a.startsWith("2001:db8:");
  }
  return true; // not an IP at all: refuse
}

/** Resolves every address of a hostname (all A and AAAA records). */
export type Resolver = (host: string) => Promise<{address: string; family: number}[]>;
const systemResolver: Resolver = (h) => dnsLookup(h, {all: true});

/**
 * JSON POST with an HMAC-SHA256 signature header (APP-R8). OFF-6 (SSRF): https only; no credentials in the URL;
 * **every** resolved address must be public, and the connection is pinned to the checked address (no second DNS
 * lookup, so DNS rebinding cannot swap in a private IP); no redirects; 5 s timeout; the signing key is required. Local
 * dev and anvil tests pass `allowPrivate` (http and private addresses allowed).
 */
export class WebhookTransport implements Transport {
  readonly channel = "webhook" as const;
  constructor(
    private readonly signingKey: string,
    private readonly allowPrivate = false,
    private readonly resolve: Resolver = systemResolver,
    private readonly timeoutMs = 5_000,
  ) {}
  target(s: AlertSettings) {
    return s.channels.webhookUrl;
  }
  async send(url: string, a: Alert) {
    const u = new URL(url);
    if (!this.allowPrivate && u.protocol !== "https:") throw new Error("webhook must be https");
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("webhook must be http(s)");
    if (u.username || u.password) throw new Error("webhook URL must not carry credentials");
    if (!this.allowPrivate && this.signingKey.length < 16) throw new Error("webhook signing key (>= 16 chars) is not configured");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [{address: host, family: isIP(host)}] : await this.resolve(host);
    if (!addrs.length) throw new Error("webhook host does not resolve");
    if (!this.allowPrivate && addrs.some((x) => isPrivateAddress(x.address))) throw new Error("webhook resolves to a private address");
    const pin = addrs[0];
    const body = JSON.stringify({...a, block: a.block.toString(), blockTime: a.blockTime.toString()});
    const sig = createHmac("sha256", this.signingKey).update(body).digest("hex");
    const status = await new Promise<number>((resolve, reject) => {
      const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
        u,
        {
          method: "POST",
          headers: {"content-type": "application/json", "content-length": Buffer.byteLength(body), "x-stockline-signature": `sha256=${sig}`},
          // Pinned: the socket connects to the address checked above; TLS still verifies the certificate for `host`.
          lookup: ((_h: string, opts: {all?: boolean}, cb: (...args: unknown[]) => void) =>
            opts?.all ? cb(null, [{address: pin.address, family: pin.family}]) : cb(null, pin.address, pin.family)) as never,
          signal: AbortSignal.timeout(this.timeoutMs),
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    if (status < 200 || status >= 300) throw new Error(`webhook ${status}`); // 3xx included: redirects are not followed
  }
}

/** Transports from env. Dry run (the keeper default) wraps them: plans are logged, nothing is sent. */
export function transportsFromEnv(env: NodeJS.ProcessEnv = process.env): Transport[] {
  const out: Transport[] = [];
  if (env.RESEND_API_KEY && env.ALERTS_EMAIL_FROM) out.push(new ResendEmailTransport(env.RESEND_API_KEY, env.ALERTS_EMAIL_FROM));
  if (env.TELEGRAM_BOT_TOKEN) out.push(new TelegramTransport(env.TELEGRAM_BOT_TOKEN));
  out.push(new WebhookTransport(env.ALERTS_WEBHOOK_SIGNING_KEY ?? "", env.ALERTS_ALLOW_PRIVATE_WEBHOOKS === "true"));
  return out;
}
