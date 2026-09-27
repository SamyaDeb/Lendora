"use client";
import {useEffect, useState} from "react";
import {useAccount, useSignMessage} from "wagmi";
import {alertSettingsMessage, type AlertSettings} from "@stockline/sdk";
import {Notice} from "./ui";

/** 06 `/alerts` (APP-R8): HF threshold, channels, weekend warning; saved with a signed message (no gas). */
export function AlertsForm() {
  const {address} = useAccount();
  const {signMessageAsync} = useSignMessage();
  const [s, setS] = useState<AlertSettings>({hfThreshold: 1.3, weekendWarning: true, channels: {}});
  const [state, setState] = useState<{busy?: boolean; ok?: string; error?: string}>({});

  useEffect(() => {
    if (!address) return;
    fetch(`/api/alerts/settings/${address}`)
      .then((r) => (r.ok ? r.json() : undefined))
      .then((j: {settings?: AlertSettings} | undefined) => j?.settings && setS(j.settings))
      .catch(() => {});
  }, [address]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!address) return;
    setState({busy: true});
    try {
      const issuedAt = new Date().toISOString();
      const signature = await signMessageAsync({message: alertSettingsMessage(address, s, issuedAt)});
      const r = await fetch("/api/alerts/settings", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address, settings: s, issuedAt, signature})});
      const j = (await r.json().catch(() => ({}))) as {error?: string};
      setState(r.ok ? {ok: "Saved. Alerts go to the channels you set."} : {error: j.error ?? `Could not save (${r.status})`});
    } catch (err) {
      setState({error: /rejected|denied/i.test(String(err)) ? "You cancelled the signature." : String(err).split("\n")[0]});
    }
  }

  const ch = (k: keyof AlertSettings["channels"], v: string) => setS((x) => ({...x, channels: {...x.channels, [k]: v}}));
  return (
    <form onSubmit={save} className="card mx-auto max-w-xl space-y-4 p-4" aria-labelledby="al-h">
      <h1 id="al-h" className="text-2xl font-bold">
        Alerts
      </h1>
      <p className="text-sm text-[var(--color-muted)]">Get a message when a borrow position gets close to liquidation, and before weekend or earnings buffers ramp in. Saving asks for a signature (free, no transaction).</p>
      {!address && <Notice>Connect a wallet to set alerts for its positions.</Notice>}
      <div>
        <label htmlFor="hf" className="text-sm font-medium">
          Alert when health factor is below
        </label>
        <input id="hf" className="input num" type="number" min={1.01} max={5} step={0.01} value={s.hfThreshold} onChange={(e) => setS({...s, hfThreshold: Number(e.target.value)})} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={s.weekendWarning} onChange={(e) => setS({...s, weekendWarning: e.target.checked})} /> Warn 24h and 4h before weekend or earnings ramp-in when my health factor at the full buffer would be below 1.2
      </label>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Channels</legend>
        <div>
          <label htmlFor="em" className="text-xs">
            Email
          </label>
          <input id="em" className="input" type="email" autoComplete="email" value={s.channels.email ?? ""} onChange={(e) => ch("email", e.target.value)} />
        </div>
        <div>
          <label htmlFor="tg" className="text-xs">
            Telegram chat id (message our bot first)
          </label>
          <input id="tg" className="input" inputMode="numeric" value={s.channels.telegramChatId ?? ""} onChange={(e) => ch("telegramChatId", e.target.value)} />
        </div>
        <div>
          <label htmlFor="wh" className="text-xs">
            Webhook URL (HTTPS)
          </label>
          <input id="wh" className="input" type="url" placeholder="https://" value={s.channels.webhookUrl ?? ""} onChange={(e) => ch("webhookUrl", e.target.value)} />
        </div>
      </fieldset>
      <button className="btn w-full" disabled={!address || state.busy}>
        {state.busy ? "Saving…" : "Save alert settings"}
      </button>
      {state.ok && <Notice tone="safe">{state.ok}</Notice>}
      {state.error && <Notice tone="danger">{state.error}</Notice>}
    </form>
  );
}
