/** Browser → same-origin server routes, which proxy to the compliance service from the edge (geo headers + secret). */
export interface Attestation {
  expiry: string;
  signature: `0x${string}`;
}

export class ComplianceDenied extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function j<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => ({}))) as T & {code?: string; error?: string};
  if (!r.ok) throw new ComplianceDenied(body.code ?? String(r.status), body.error ?? `compliance ${r.status}`);
  return body;
}

export const compliance = {
  connection: () => fetch("/api/compliance/connection", {cache: "no-store"}).then((r) => j<{geo: {country: string | null}; restricted: boolean; datacenter: boolean}>(r)),
  terms: (address?: string) => fetch(`/api/compliance/terms${address ? `?address=${address}` : ""}`).then((r) => j<{version: string; hash: string; text: string; message: string | null}>(r)),
  termsStatus: (address: string) => fetch(`/api/compliance/terms/${address}`, {cache: "no-store"}).then((r) => j<{accepted: boolean; version: string}>(r)),
  acceptTerms: (address: string, signature: string, version: string) =>
    fetch("/api/compliance/terms", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address, signature, version})}).then((r) => j<{accepted: boolean}>(r)),
  attest: (address: string) =>
    fetch("/api/compliance/attest", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address})}).then((r) => j<Attestation>(r)),
};
