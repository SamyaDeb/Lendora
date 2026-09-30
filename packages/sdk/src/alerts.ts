import type {Address} from "./addresses.js";

/**
 * Alert settings (APP-R8) are saved from `/alerts` with a signed message (EIP-191), verified by the alerts service.
 * One canonical text for both sides; `issuedAt` is the replay guard (the service keeps the latest per wallet).
 */
export interface AlertSettings {
  /** Alert when the health factor falls below this (e.g. 1.3). */
  hfThreshold: number;
  /** Warn 24h and 4h before a weekend/event ramp-in when the HF at the full buffer would be < 1.2. */
  weekendWarning: boolean;
  channels: {email?: string; telegramChatId?: string; webhookUrl?: string};
}

export function canonicalSettings(s: AlertSettings): string {
  const ch = s.channels;
  return JSON.stringify({
    hfThreshold: Number(s.hfThreshold),
    weekendWarning: Boolean(s.weekendWarning),
    channels: {email: ch.email || null, telegramChatId: ch.telegramChatId || null, webhookUrl: ch.webhookUrl || null},
  });
}

export function alertSettingsMessage(address: Address, s: AlertSettings, issuedAt: string): string {
  return ["Lendora alert settings", "", `Wallet: ${address.toLowerCase()}`, `Issued at: ${issuedAt}`, `Settings: ${canonicalSettings(s)}`].join("\n");
}
