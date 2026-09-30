"use client";
import {useEffect, useState} from "react";
import {useAccount, useSignMessage} from "wagmi";
import {alertSettingsMessage, type AlertSettings} from "@lendora/sdk";
import {Button, Notice} from "./ui";

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
    <form onSubmit={save} className="mx-auto max-w-xl space-y-6" aria-labelledby="al-h">
      <div>
        <h1 id="al-h" className="t-display">
          Alerts
        </h1>
        <p className="mt-2 text-[15px] text-muted">Get a message when a borrow gets close to liquidation, and before weekend or earnings buffers ramp in. Saving asks for a signature: free, no transaction.</p>
      </div>
      {!address && <Notice title="Connect a wallet to set alerts">Alerts watch the positions of the connected wallet.</Notice>}
      <div className="panel space-y-5 p-5">
        <div className="space-y-1.5">
          <label htmlFor="hf" className="text-[13px] font-medium text-dim">
            Alert when health factor is below
          </label>
          <input id="hf" className="field num" type="number" min={1.01} max={5} step={0.01} value={s.hfThreshold} onChange={(e) => setS({...s, hfThreshold: Number(e.target.value)})} />
          <p className="text-[12.5px] text-muted">Liquidation happens at 1.00. 1.3 leaves time to add collateral.</p>
        </div>
        <label className="flex items-start gap-2.5 text-[14px] text-dim">
          <input type="checkbox" className="mt-0.5 size-4" checked={s.weekendWarning} onChange={(e) => setS({...s, weekendWarning: e.target.checked})} /> Warn 24h and 4h before a weekend or earnings ramp-in when my health factor at the full buffer would be below 1.2
        </label>
      </div>
      <fieldset className="panel space-y-4 p-5">
        <legend className="sr-only">Channels</legend>
        <p className="text-[15px] font-medium">Where to send them</p>
        <div className="space-y-1.5">
          <label htmlFor="em" className="text-[13px] text-dim">
            Email
          </label>
          <input id="em" className="field" type="email" autoComplete="email" value={s.channels.email ?? ""} onChange={(e) => ch("email", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="tg" className="text-[13px] text-dim">
            Telegram chat id (message our bot first)
          </label>
          <input id="tg" className="field" inputMode="numeric" value={s.channels.telegramChatId ?? ""} onChange={(e) => ch("telegramChatId", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="wh" className="text-[13px] text-dim">
            Webhook URL (HTTPS)
          </label>
          <input id="wh" className="field" type="url" placeholder="https://" value={s.channels.webhookUrl ?? ""} onChange={(e) => ch("webhookUrl", e.target.value)} />
        </div>
      </fieldset>
      <Button type="submit" size="lg" className="w-full" disabled={!address || state.busy}>
        {state.busy ? "Saving…" : "Save alert settings"}
      </Button>
      {state.ok && <Notice tone="safe">{state.ok}</Notice>}
      {state.error && <Notice tone="danger">{state.error}</Notice>}
    </form>
  );
}
