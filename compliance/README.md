# compliance

Compliance signer and access checks (docs/prd/10 CP-R1…R4, 05 RT-R2, 06 APP-R2, APP-R10). A separate service so the
attestation key never lives in the public API process.

| Req | Where |
|---|---|
| CP-R1 | Restricted countries/regions are data: `packages/sdk/data/compliance.json` (shared with the web geo-block), env overrides |
| CP-R2 | `IpReputation` (static CIDR list `config/datacenter-ranges.json`, swappable for a commercial feed): datacenter/VPN IPs get no borrow attestation |
| CP-R3 / RT-R2 | `POST /v1/compliance/attest` signs the router's EIP-712 `Attestation(user, expiry)` (24h, chain time) after geo, IP, sanctions (`SanctionsScreen`: deny list, Chainalysis and TRM adapters, fail-closed) and terms checks |
| CP-R4 | No exit endpoint exists: repay, close, withdraw and unwrap never need an attestation (tested with no signer and the guard tripped) |
| APP-R10 | `GET/POST /v1/compliance/terms`: EIP-191 signature (EOA or ERC-1271) over `termsMessage` (SDK) binding wallet, version and the document's SHA-256; stored with wallet, version, hash, signature, time; no IP |

Denials return `403 {code, error}` with `RESTRICTED_REGION`, `GEO_UNKNOWN`, `DATACENTER_IP`, `SANCTIONED`,
`SCREEN_UNAVAILABLE` or `TERMS_REQUIRED`.

**Geo headers.** The service reads the country from edge headers (`x-vercel-ip-country`, `cf-ipcountry`, …). On
Railway nothing sets them, so the web app calls the service server-side from the edge and forwards them with
`x-lendora-proxy: $PROXY_SECRET`; with `PROXY_SECRET` set, headers from anyone else are ignored (geo unknown →
no attestation).

**Signer.** `COMPLIANCE_SIGNER_KEY` / `_KEY_FILE` (secret manager) or `COMPLIANCE_REMOTE_SIGNER_URL` (KMS/HSM bridge;
every signature is verified against `COMPLIANCE_SIGNER_ADDRESS`). The router's `attestationSigner` is set through the
timelock (24h on testnet). Terms text: `terms/terms-<version>.md` (**draft, pending counsel, CP-R6**).

```sh
pnpm --filter @lendora/compliance dev    # env: .env.example; scripts/dev.sh sets it up on anvil
pnpm --filter @lendora/compliance test   # anvil + Postgres: attestations verified by the deployed router
```
