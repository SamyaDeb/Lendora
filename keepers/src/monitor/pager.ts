import {TelegramTransport, WebhookTransport, type Alert, type Transport} from "../alerts/transports.js";

/**
 * Operator paging (10 "Monitoring and paging", MON-R*). One `Pager` interface; PagerDuty (Events API v2) and Opsgenie
 * (Alert API) are wired by env, Telegram and signed webhooks reuse the APP-R8 transports, `FakePager` records pages in
 * tests and `ConsolePager` logs when nothing is configured. Every page carries a stable `key` (`rule:subject`) so the
 * provider groups triggers, re-notifications and the resolve of one incident. Secrets come from env, never logged.
 */
export type Severity = "P0" | "P1" | "P2";
export type PageAction = "trigger" | "renotify" | "resolve";

export interface Page {
  action: PageAction;
  rule: string;
  subject: string;
  severity: Severity;
  /** `rule:subject`: the dedupe key sent to the provider. */
  key: string;
  title: string;
  details: Record<string, unknown>;
  /** docs/runbooks page for this rule, if any (task 4). */
  runbook?: string;
  block: bigint;
  at: number;
}

export interface Pager {
  readonly name: string;
  send(p: Page): Promise<void>;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export class FakePager implements Pager {
  readonly name = "fake";
  readonly sent: Page[] = [];
  /** Make the next `failures` sends throw (delivery retry tests). */
  failures = 0;
  async send(p: Page) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("fake pager down");
    }
    this.sent.push(p);
  }
  of(rule: string, action?: PageAction): Page[] {
    return this.sent.filter((p) => p.rule === rule && (!action || p.action === action));
  }
}

export class ConsolePager implements Pager {
  readonly name = "console";
  async send(p: Page) {
    console.error(`[page ${p.severity} ${p.action}] ${p.key} ${p.title} ${json(p.details)}`);
  }
}

/** PagerDuty Events API v2: trigger / resolve with `dedup_key`; re-notifications are triggers on the same key. */
export class PagerDutyPager implements Pager {
  readonly name = "pagerduty";
  constructor(
    private readonly routingKey: string,
    private readonly url = "https://events.pagerduty.com/v2/enqueue",
  ) {}
  async send(p: Page) {
    const body =
      p.action === "resolve"
        ? {routing_key: this.routingKey, event_action: "resolve", dedup_key: p.key}
        : {
            routing_key: this.routingKey,
            event_action: "trigger",
            dedup_key: p.key,
            payload: {
              summary: `[${p.severity}] ${p.title}`,
              source: "stockline-monitor",
              severity: p.severity === "P0" ? "critical" : p.severity === "P1" ? "error" : "warning",
              custom_details: {...p.details, runbook: p.runbook, block: p.block.toString()},
            },
          };
    const r = await fetch(this.url, {method: "POST", headers: {"content-type": "application/json"}, body: json(body), signal: AbortSignal.timeout(10_000)});
    if (!r.ok) throw new Error(`pagerduty ${r.status}`);
  }
}

/** Opsgenie Alert API: create with `alias` (Opsgenie dedupes open alerts by alias), close by alias. */
export class OpsgeniePager implements Pager {
  readonly name = "opsgenie";
  constructor(
    private readonly apiKey: string,
    private readonly base = "https://api.opsgenie.com",
  ) {}
  async send(p: Page) {
    const headers = {"content-type": "application/json", authorization: `GenieKey ${this.apiKey}`};
    const alias = encodeURIComponent(p.key);
    const r =
      p.action === "resolve"
        ? await fetch(`${this.base}/v2/alerts/${alias}/close?identifierType=alias`, {method: "POST", headers, body: json({source: "stockline-monitor"}), signal: AbortSignal.timeout(10_000)})
        : await fetch(`${this.base}/v2/alerts`, {
            method: "POST",
            headers,
            body: json({message: `[${p.severity}] ${p.title}`.slice(0, 130), alias: p.key, priority: p.severity === "P0" ? "P1" : p.severity === "P1" ? "P2" : "P3", details: {...p.details, runbook: p.runbook ?? ""}, source: "stockline-monitor"}),
            signal: AbortSignal.timeout(10_000),
          });
    if (!r.ok) throw new Error(`opsgenie ${r.status}`);
  }
}

/** A Telegram chat or a webhook URL through the APP-R8 transports (same signing, SSRF and timeout rules). */
export class TransportPager implements Pager {
  readonly name: string;
  constructor(
    private readonly transport: Transport,
    private readonly target: string,
  ) {
    this.name = transport.channel;
  }
  async send(p: Page) {
    const verb = p.action === "resolve" ? "RESOLVED" : p.action === "renotify" ? "STILL FIRING" : "FIRING";
    const alert: Alert = {
      kind: "ops",
      address: "",
      ticker: String(p.details.ticker ?? ""),
      title: `[${p.severity} ${verb}] ${p.title}`,
      body: `${p.key}\n${json(p.details)}${p.runbook ? `\nRunbook: ${p.runbook}` : ""}`,
      block: p.block,
      blockTime: BigInt(Math.floor(p.at / 1000)),
      data: {rule: p.rule, subject: p.subject, severity: p.severity, action: p.action},
    };
    await this.transport.send(this.target, alert);
  }
}

/**
 * Pagers from env: `PAGERDUTY_ROUTING_KEY`, `OPSGENIE_API_KEY`, `MONITOR_TELEGRAM_BOT_TOKEN` + `MONITOR_TELEGRAM_CHAT_ID`,
 * `MONITOR_WEBHOOK_URL` (+ `MONITOR_WEBHOOK_SIGNING_KEY`). None configured → console only (and /health says so).
 */
export function pagersFromEnv(env: NodeJS.ProcessEnv = process.env): Pager[] {
  const out: Pager[] = [];
  if (env.PAGERDUTY_ROUTING_KEY) out.push(new PagerDutyPager(env.PAGERDUTY_ROUTING_KEY));
  if (env.OPSGENIE_API_KEY) out.push(new OpsgeniePager(env.OPSGENIE_API_KEY, env.OPSGENIE_API_URL));
  if (env.MONITOR_TELEGRAM_BOT_TOKEN && env.MONITOR_TELEGRAM_CHAT_ID) out.push(new TransportPager(new TelegramTransport(env.MONITOR_TELEGRAM_BOT_TOKEN), env.MONITOR_TELEGRAM_CHAT_ID));
  if (env.MONITOR_WEBHOOK_URL) out.push(new TransportPager(new WebhookTransport(env.MONITOR_WEBHOOK_SIGNING_KEY ?? "", env.MONITOR_ALLOW_PRIVATE_WEBHOOKS === "true"), env.MONITOR_WEBHOOK_URL));
  if (!out.length) out.push(new ConsolePager());
  return out;
}
