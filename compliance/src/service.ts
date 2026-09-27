import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import pg from "pg";
import type {PublicClient} from "viem";
import {ATTESTATION_TTL_SEC, attestationDomain, attestationTypes, isRestricted, termsMessage, type Address, type RestrictedList} from "@stockline/sdk";
import type {TypedDataSigner} from "@stockline/keepers/signer";
import type {Geo, IpReputation, SanctionsScreen} from "./checks.js";

/**
 * The compliance signer (CP-R1…R3, RT-R2, APP-R10). Issues the router's EIP-712 `Attestation(user, expiry)` valid
 * 24h, only after: the request's IP country is allowed (CP-R1), the IP is not a datacenter/VPN (CP-R2, borrow flows),
 * the wallet passes the sanctions screen, and the wallet has signed the current terms (APP-R10). Stores terms
 * signatures with the wallet, never with the IP (APP-R11).
 */
export type DenialCode = "RESTRICTED_REGION" | "GEO_UNKNOWN" | "DATACENTER_IP" | "SANCTIONED" | "SCREEN_UNAVAILABLE" | "TERMS_REQUIRED";

export class Denied extends Error {
  constructor(
    readonly code: DenialCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Terms {
  version: string;
  text: string;
  /** 0x-prefixed SHA-256 of the document. */
  hash: string;
}

export function loadTerms(version: string): Terms {
  const text = readFileSync(new URL(`../terms/terms-${version}.md`, import.meta.url), "utf8");
  return {version, text, hash: `0x${createHash("sha256").update(text).digest("hex")}`};
}

const ident = (s: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s)) throw new Error(`bad schema ${s}`);
  return `"${s}"`;
};

/** Terms acceptances: wallet, version, document hash, signature, time. No IP, no geo. */
export class TermsStore {
  private readonly s: string;
  constructor(
    readonly pool: pg.Pool,
    schema: string,
  ) {
    this.s = ident(schema);
  }
  async migrate() {
    await this.pool.query(`create schema if not exists ${this.s}`);
    await this.pool.query(`create table if not exists ${this.s}.terms_acceptance (
      address text not null,
      version text not null,
      terms_hash text not null,
      signature text not null,
      signed_at timestamptz not null default now(),
      primary key (address, version)
    )`);
  }
  async accept(address: string, t: Terms, signature: string) {
    await this.pool.query(
      `insert into ${this.s}.terms_acceptance (address, version, terms_hash, signature) values (lower($1), $2, $3, $4)
       on conflict (address, version) do update set signature = excluded.signature, signed_at = now()`,
      [address, t.version, t.hash, signature],
    );
  }
  async accepted(address: string, version: string): Promise<{signedAt: Date} | undefined> {
    const {rows} = await this.pool.query(`select signed_at from ${this.s}.terms_acceptance where address = lower($1) and version = $2`, [address, version]);
    return rows[0] ? {signedAt: rows[0].signed_at} : undefined;
  }
}

export interface ComplianceDeps {
  signer: TypedDataSigner;
  client: PublicClient;
  chainId: number;
  router: Address;
  restricted: RestrictedList;
  ipReputation: IpReputation;
  sanctions: SanctionsScreen;
  terms: Terms;
  store: TermsStore;
}

export class ComplianceService {
  constructor(private readonly d: ComplianceDeps) {}

  get signerAddress() {
    return this.d.signer.address;
  }

  termsMessageFor(address: Address): string {
    return termsMessage(address, this.d.terms.version, this.d.terms.hash);
  }

  /** APP-R10: verify the wallet's signature over the current terms message (EOA or ERC-1271) and store it. */
  async acceptTerms(address: Address, signature: `0x${string}`, version: string): Promise<void> {
    if (version !== this.d.terms.version) throw new Denied("TERMS_REQUIRED", `terms version ${version} is not current (${this.d.terms.version})`);
    const ok = await this.d.client.verifyMessage({address, message: this.termsMessageFor(address), signature});
    if (!ok) throw new Denied("TERMS_REQUIRED", "signature does not match the terms message for this wallet");
    await this.d.store.accept(address, this.d.terms, signature);
  }

  async termsStatus(address: Address) {
    const a = await this.d.store.accepted(address, this.d.terms.version);
    return {accepted: Boolean(a), version: this.d.terms.version, signedAt: a?.signedAt.toISOString() ?? null};
  }

  /** CP-R1/R2 for the requesting connection (used by the app to show the block page and to gate borrow flows). */
  async connectionCheck(geo: Geo, ip: string) {
    return {geo, restricted: isRestricted(geo, this.d.restricted), datacenter: await this.d.ipReputation.isDatacenter(ip)};
  }

  /**
   * RT-R2 / CP-R3: all checks, then sign `Attestation(user, expiry)` with expiry = chain time + 24h (the router
   * compares with `block.timestamp`). Throws `Denied` with a machine-readable code otherwise.
   */
  async attest(user: Address, geo: Geo, ip: string): Promise<{user: Address; expiry: string; signature: `0x${string}`; signer: Address; chainId: number; router: Address}> {
    if (!geo.country) throw new Denied("GEO_UNKNOWN", "your location could not be determined; borrowing needs a known, allowed country");
    if (isRestricted(geo, this.d.restricted)) throw new Denied("RESTRICTED_REGION", "borrowing is not available in your region");
    if (await this.d.ipReputation.isDatacenter(ip)) throw new Denied("DATACENTER_IP", "borrowing is not available from datacenter or VPN connections");
    let screen;
    try {
      screen = await this.d.sanctions.screen(user);
    } catch {
      throw new Denied("SCREEN_UNAVAILABLE", "the sanctions screen is unavailable; try again later (exits are not affected)");
    }
    if (screen.sanctioned) throw new Denied("SANCTIONED", "this wallet cannot open positions");
    if (!(await this.d.store.accepted(user, this.d.terms.version))) throw new Denied("TERMS_REQUIRED", "accept the current terms first");

    const block = await this.d.client.getBlock();
    const expiry = block.timestamp + ATTESTATION_TTL_SEC; // chain time: the router checks expiry ≥ block.timestamp
    const signature = await this.d.signer.signTypedData({
      domain: attestationDomain(this.d.chainId, this.d.router),
      types: attestationTypes,
      primaryType: "Attestation",
      message: {user, expiry},
    });
    return {user, expiry: expiry.toString(), signature, signer: this.d.signer.address, chainId: this.d.chainId, router: this.d.router};
  }
}
