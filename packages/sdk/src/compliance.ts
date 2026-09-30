import compliance from "../data/compliance.json" with {type: "json"};
import type {Address} from "./addresses.js";

/**
 * Access rules shared by the web app's edge geo-block (APP-R2) and the compliance signer (CP-R1…R3). The list is data
 * (data/compliance.json), overridable per service from env.
 */
export interface RestrictedList {
  countries: string[];
  regions: string[];
}

export const restrictedList: RestrictedList = {countries: compliance.restrictedCountries, regions: compliance.restrictedRegions};
export const COMPLIANCE_LIST_VERSION: string = compliance.version;
/** Current version of the terms of use and risk disclosure (APP-R10). */
export const TERMS_VERSION: string = compliance.termsVersion;

/** Parse "US,CA,…" style env overrides; falls back to the data file. */
export function restrictedListFromEnv(env: Record<string, string | undefined>): RestrictedList {
  const split = (s?: string) => (s ? s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : undefined);
  return {countries: split(env.RESTRICTED_COUNTRIES) ?? restrictedList.countries, regions: split(env.RESTRICTED_REGIONS) ?? restrictedList.regions};
}

/** True if the visitor's country (ISO 3166-1 alpha-2) or region (ISO 3166-2, e.g. "UA-43") is restricted. An unknown
 * country is not restricted here; the compliance signer treats "unknown" as a denial for borrow flows. */
export function isRestricted(geo: {country?: string | null; region?: string | null}, list: RestrictedList = restrictedList): boolean {
  const c = geo.country?.toUpperCase();
  const r = geo.region?.toUpperCase();
  if (c && list.countries.includes(c)) return true;
  if (r && list.regions.includes(r.includes("-") || !c ? r : `${c}-${r}`)) return true;
  return false;
}

/**
 * The EIP-191 message a wallet signs to accept the terms and risk disclosure (APP-R10). The web app shows it and the
 * compliance service verifies the exact same text; `termsHash` is the SHA-256 of the published document.
 */
export function termsMessage(address: Address, version: string, termsHash: string): string {
  return [
    "Lendora: I accept the Terms of Use and the Risk Disclosure.",
    "",
    "I understand that lending and borrowing Stock Tokens carries risk, including liquidation, that rates are variable,",
    "that nothing here is an offer of securities or investment advice, and that access is not available in restricted regions.",
    "",
    `Wallet: ${address.toLowerCase()}`,
    `Terms version: ${version}`,
    `Terms SHA-256: ${termsHash}`,
  ].join("\n");
}
