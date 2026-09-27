/**
 * APP-R11: privacy-respecting page and funnel events (connect → preview → sign → confirmed). Only the event name, the
 * funnel and the page path are sent: no wallet address, no cookies, no identifiers. The server keeps aggregate
 * counts and does not store IPs.
 */
export function track(event: "page" | "connect" | "preview" | "sign" | "confirmed", props: {funnel?: string; path?: string} = {}): void {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({event, funnel: props.funnel ?? null, path: props.path ?? window.location.pathname.replace(/0x[0-9a-fA-F]{40}/g, ":address")});
  try {
    if (navigator.sendBeacon) navigator.sendBeacon("/api/analytics", new Blob([body], {type: "application/json"}));
    else void fetch("/api/analytics", {method: "POST", body, keepalive: true, headers: {"content-type": "application/json"}});
  } catch {
    /* analytics never breaks the app */
  }
}
