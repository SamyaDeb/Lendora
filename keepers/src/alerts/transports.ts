import {createHmac} from "node:crypto";
import {lookup} from "node:dns/promises";
import type {AlertSettings} from "@stockline/sdk";

/**
 * APP-R8 delivery behind one interface. Real providers are wired by env (Resend for email, the Telegram Bot API,
 * signed webhooks); tests use `FakeTransport`; dry run logs only. Secrets (API keys, bot token, webhook signing key)
 * come from env and are never logged.
 */
export interface Alert {
  kind: "hf_below" | "ramp_24h" | "ramp_4h";
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

const PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^::1$/, /^f[cd]/i, /^fe80/i];

/** JSON POST with an HMAC-SHA256 signature header; refuses private addresses (SSRF) unless allowed (anvil/dev). */
export class WebhookTransport implements Transport {
  readonly channel = "webhook" as const;
  constructor(
    private readonly signingKey: string,
    private readonly allowPrivate = false,
  ) {}
  target(s: AlertSettings) {
    return s.channels.webhookUrl;
  }
  async send(url: string, a: Alert) {
    const u = new URL(url);
    if (!this.allowPrivate) {
      const {address} = await lookup(u.hostname);
      if (PRIVATE.some((r) => r.test(address))) throw new Error("webhook resolves to a private address");
    }
    const body = JSON.stringify({...a, block: a.block.toString(), blockTime: a.blockTime.toString()});
    const sig = createHmac("sha256", this.signingKey).update(body).digest("hex");
    const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json", "x-stockline-signature": `sha256=${sig}`}, body, signal: AbortSignal.timeout(5_000), redirect: "error"});
    if (!r.ok) throw new Error(`webhook ${r.status}`);
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
