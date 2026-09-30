# Offchain security review (Phase 3 task 9)

*Engineering self-review, 2026-09-28, of everything outside `contracts/`: keepers (allocator, guard, liquidator, feed
mirror, fee converter, alerts, monitor incl. the governance decoder and liquidation quoter), indexer, public API
(incl. the FE-R5 revenue endpoint), web app, compliance service (incl. the Task 6 sanctions adapters), and the
container/supply chain. It is not a substitute for the external audits; auditors should treat it as a map of what was
checked and what was changed.*

Every fix has a test named after its finding (`OFF_<n>`): `packages/sdk/test/redact.test.ts`,
`keepers/test/offchainReview.test.ts`, `keepers/test/remoteSigner.test.ts`, `api/test/api.test.ts`,
`web/test/offchainReview.test.ts`, `compliance/test/sanctions.test.ts`.

## 1. Findings and fixes

| ID | Sev | Area | Finding | Fix | Test |
|---|---|---|---|---|---|
| OFF-1 | High | keepers, API, compliance, indexer | Errors were logged and shown on the unauthenticated keeper `/health` as `String(e)`. viem's errors carry the full RPC URL (`…/v2/<API key>`), so a provider key leaked through `/health` and every log line | `redactSecrets` / `safeErrorLine` in `@lendora/sdk` (replaces secret-looking env values and every URL's path/userinfo); used by `Health.fail`, `runLoop`, every keeper's error log, the monitor's `KEEPER_DOWN` body, and the API / compliance / monitor / alerts error handlers | `OFF_1_*` (sdk, keepers) |
| OFF-4 | High | keepers | `allocator`, `guard`, `liquidator` and `feed-mirror` built their own sender and ignored `KEEPER_SIGNER=remote`: with a KMS signer configured they fell through to `DryRunSender` **silently** (a mainnet liquidator would never liquidate) | Every signing `main.ts` uses `senderFromConfig` (with the role address as the dry-run / anvil fallback); `loadConfig` refuses `remote` without URL and address | `OFF_4_*` (source check of every `main.ts`) |
| OFF-6 | High | alerts, monitor webhooks | Webhook SSRF guard checked only the first DNS answer, then `fetch` re-resolved (DNS rebinding); IPv4-mapped IPv6, CGNAT `100.64/10`, `0.0.0.0/8`, `::`, NAT64, multicast were not blocked; `http:` allowed; empty signing key accepted | https only; no URL credentials; **all** A/AAAA answers must be public; the socket is pinned to the checked address (`lookup` override, TLS still verifies the hostname); no redirects; 5 s timeout; signing key ≥ 16 chars required off dev | `OFF_6_*` |
| OFF-2 | Medium | keepers | No gas price cap; a fee spike could drain keeper balances, and a remote signer could return a transaction with a higher fee than the keeper built | `MAX_FEE_PER_GAS_GWEI` (default 10 gwei): fees are estimated, checked and set explicitly before signing (`GasPriceTooHigh` skips the tick); the remote signer's result must not raise `maxFeePerGas` or `gas` | `OFF_2_*`, `OFF_2 OFF_3` (remote signer on anvil) |
| OFF-3 | Medium | keepers, compliance | Remote signer calls (tx and EIP-712) had no timeout: a hung KMS bridge stalled the loop forever | `REMOTE_SIGNER_TIMEOUT_MS` (default 15 s) on both signers | `OFF_2 OFF_3` |
| OFF-5 | Medium | keepers, API, compliance | Numeric env vars were `Number(x)`: `INTERVAL_MS=abc` → `NaN` → a zero-delay loop hammering the RPC; URLs and addresses unchecked | zod schema for the keeper config (bounds, URL shape, https for remote signers off `localhost`/`*.railway.internal`, address format), bounded integer parsing in API and compliance, errors name the variable | `OFF_5_*` |
| OFF-7 | Medium | API | Client IP = the *first* `X-Forwarded-For` entry, which the client controls when the edge appends: anyone could pick a fresh rate-limit bucket per request | IP = the entry `TRUSTED_PROXY_HOPS` (default 1) from the right, i.e. what our edge saw; HTTP and WebSocket | `OFF_7_*` |
| OFF-9 | Medium | API | A request with a wrong `X-API-Key` skipped the IP limit and cost a DB lookup each: unlimited DB load with random keys (HTTP and WS upgrade) | A wrong key is charged to the caller's free-tier IP budget (401 until spent, then 429) | `OFF_9_*` (and the updated SI_R10 test) |
| OFF-11 | Medium | API | WebSocket clients could send unlimited messages; every `market` subscribe reads Postgres | 20 messages per 10 s per connection, then close 1008 (payload already capped at 4 KiB; subscriptions are bounded by channels × symbols) | `OFF_11_*` |
| OFF-12 | Medium | web | No Content-Security-Policy and no HSTS | `lib/csp.ts`: `default-src 'self'`, scripts self (+inline), `connect-src` only self, the API (http+ws), the RPC and the wallet connectors, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri`/`form-action 'self'`; HSTS 2 years in production | `OFF_12_*` |
| OFF-14 | Medium | web | The revert decoder knew only router, Vault V2, wrapper, token and Morpho ABIs: errors from the oracle, `clUSDG`, `MarketHours`, liquidator, `FeeSplitter`, `FeeConverter` and the Vault V2 adapter showed as raw hex | Every Lendora ABI is decoded; plain text for the role, slippage (FE-R4) and session errors | `OFF_14_*` (every custom error of 8 ABIs) |
| OFF-16 | Low | compliance | CORS answered `*` whenever `ALLOWED_ORIGINS` was unset, on every network | `*` only on local anvil; elsewhere only the listed origins (browsers use the web app's same-origin proxy anyway) | `OFF_16_*` |
| OFF-8 | Low | API | API keys were accepted in `?apiKey=` on HTTP (access logs, proxies, Referer) | HTTP reads the header only; the WebSocket upgrade still accepts the query parameter because browsers cannot set headers there (documented) | `OFF_7 OFF_8 OFF_9` |
| OFF-10 | Low | API | In-memory SIWE nonce store grew without bound (single-instance mode) | Bounded (10k; expired, then oldest, dropped) | `OFF_10_*` |
| OFF-13 | Low | web | `/api/analytics` counters: unbounded distinct keys (memory growth by inventing paths) | 2,000 distinct keys max | `OFF_13_*` |
| OFF-15 | Low | supply chain | Base images were the floating `node:22-alpine` tag | Every `FROM` pinned by digest (`sha256:0a7108bf…e402`, node v22.23.3, Alpine 3.24); both final stages run as the non-root `app` user (already) | `OFF_15_*` |
| OFF-17 | High (dep) / not reachable | supply chain | `pnpm audit --prod`: 11 advisories, all through `indexer > ponder@0.17.12` (latest): kysely ×3 and drizzle-orm SQL-injection, `@hono/node-server` ×3, vite ×4, esbuild | pnpm overrides `kysely ^0.28.17`, `drizzle-orm ^0.45.2`, `@hono/node-server ^1.19.15` (indexer suite 10/10). Remaining 4 (vite ×3, esbuild) triaged as not reachable: Ponder creates vite's dev server in-process without `listen()` (`ponder/dist/esm/build/index.js`), esbuild's serve mode is unused, and three are Windows-only; containers are Linux | `pnpm audit --prod`: 3 moderate + 1 high, all vite/esbuild |

Severity is for mainnet with the documented deployment (Railway, Vercel/Cloudflare edge, KMS signers).

## 2. Checked, no change needed

| Item | Result |
|---|---|
| SQL | Every query in `api/src/db.ts`, `compliance/src/service.ts`, `keepers/src/*/store.ts` is parameterized; schema names pass an identifier regex. The events filter builds placeholders, never values |
| API input validation | Every route has a zod schema (symbols `^[A-Za-z0-9.]{1,12}$`, addresses, cursors, bounded `limit`s, revenue range ≤ 10 years); OpenAPI generated from the same schemas |
| API CORS | `*` by design: a public, read-only data API with no cookies; keys only in an explicit header |
| Web proxies (SSRF) | `/api/compliance/*` and `/api/alerts/*` forward to fixed internal URLs with strict path regexes; the compliance proxy drops client geo/IP/proxy headers (CP-R8, tested) |
| `NEXT_PUBLIC_*` | `API_URL`, `CHAIN_ID`, `RPC_URL`, `WALLETCONNECT_PROJECT_ID` (public by design), `DEV_PAGES`, `FEATURE_*`, `E2E*`. No secret. Rule added to `web/.env.example`: `NEXT_PUBLIC_RPC_URL` must be a public or domain-restricted endpoint. `PROXY_SECRET` and service URLs are server-only |
| Wallet signing prompts | Terms (APP-R10) and SIWE (API keys) are plain-text messages stating what is signed and that no funds move; alert settings are signed messages; every transaction is previewed (APP-R3) before the wallet prompt |
| Nonces under restart | Signers use the node's `pending` nonce per send; sends are sequential (`await` in every loop), so no in-process races; remote signer output must match nonce, chain, target, value, data |
| Idempotency on replays | Every tick recomputes from chain state; a liquidation or allocation already done reverts in `estimateGas` and is not sent; the fee converter reads balances each tick |
| Liquidator and crafted swap data | Swap calldata is built by the keeper, targets are owner-allowlisted onchain, the contract enforces `minOut` on the balance delta and `minProfit`, holds nothing between calls, and pays only the configured recipient. A third party calling `liquidate` with its own swap data can only spend the seized collateral of that liquidation |
| Fee converter keeper | Cannot receive funds or set the destination (onchain, FE-R4); the onchain 1% floor bounds any sandwich; conversion only when the contract's gates pass |
| Governance decoder / quoter | `decodeLendoraCall` never throws on unknown selectors (tested); chain data is only put into JSON pages, never HTML/Markdown; the quoter uses `eth_call` only |
| Sanctions adapters (task 6) | Hard timeouts, redirects refused, errors name only provider/step/status, fail closed, key never in errors (`CP_R3_*`) |
| Health endpoints | Keeper `/health` returns per-market timing, block and a redacted error only; compliance `/health` the signer address and provider name |
| Lockfile | `pnpm install --frozen-lockfile` in both Dockerfiles; `--ignore-scripts` on install |

## 3. Residual risks (accepted, tracked)

1. **CSP keeps `'unsafe-inline'` for scripts.** Next's App Router bootstrap is inline; a nonce needs per-request
   rendering of every page. No third-party script is loaded, `connect-src` is locked, framing is refused. Revisit
   with Next's nonce support before any user-generated content is rendered.
2. **API key in the WebSocket URL** (browsers cannot set headers on `WebSocket`). Keys are revocable per wallet and
   rate-limited per key.
3. **vite/esbuild advisories** under Ponder (OFF-17) until Ponder ships newer pins; re-run `pnpm audit --prod` on each
   Ponder upgrade.
4. **Webhook pinning uses the first public address**; if it is down the delivery fails (retried next event) rather than
   falling back to an unchecked address.
5. **Disk hygiene in local runs:** anvil keeps per-instance state under `~/.foundry/anvil/tmp` (45 GB accumulated in this
   session's test runs); CI runners are ephemeral, developers should clear it (not a production issue).

## 4. How to re-run

```sh
pnpm audit --prod                                   # expect only the vite/esbuild items in §1 OFF-17
pnpm -r typecheck && pnpm -r lint && pnpm -r test   # OFF_* tests included
docker buildx imagetools inspect node:22-alpine     # before bumping the pinned digest
```

## 5. Phase 4 addendum (task 18, 2026-09-29)

*Scope: the NAV reporter and co-signer (`keepers/src/navReporter`), the DN rebalancer (`keepers/src/dnRebalancer`),
the monitor's DN rules (MON-R21…R25), the indexer's `dn_*` / `receipt_market` handlers, `/v1/vault/*` and
`/v1/receipt-markets`, and the web app's USDG Earn source (`web/lib/vault/apiSource.ts`). The contract side is in
[phase4/README.md](phase4/README.md).* Tests: `keepers/test/offchainReview.test.ts` (`OFF_18`…`OFF_21`),
`api/test/dnReader.test.ts` (`OFF_22`).

| ID | Sev | Area | Finding | Fix | Test |
|---|---|---|---|---|---|
| OFF-18 | Medium | nav co-signer | The co-signer compared its bearer token with `!==`: a timing side channel on the only credential between the reporter and the second NAV key | `cosignerApp` (`navReporter/server.ts`) compares SHA-256 digests with `timingSafeEqual` (length does not leak either); token ≥ 32 chars | `OFF_18_*` |
| OFF-19 | Medium | nav co-signer | No body limit, and malformed JSON reached the RPC reads; a refusal returned the raw `Error.message` (viem errors carry the RPC URL with its key) to the caller, who logs it | 16 KiB body limit (413), shape checked before any read (400, ≤ 16 sizes), refusals are one `safeErrorLine` (422) | `OFF_19_*` |
| OFF-20 | Medium | nav reporter, DN rebalancer | Env numbers were `Number()` / `BigInt()`: `NAV_REPORT_EVERY_MS=abc` became `NaN`, passed the 14-minute check, and the reporter only reported on moves (the oracle goes stale: deposits and settlement pause); bad `DN_KILL_*` silently disabled the kill switch | `loadNavEnv` / `loadDnEnv` (`common/dnEnv.ts`, zod, bounds, names the variable): report interval 1–14 min (DN-R5), move 1–100 bps, slippage 1–100 bps (DN-R10), kill window/hours, lending APY 0–1, venue ids, MMF list | `OFF_20_*` (and a source check that neither `main.ts` parses env directly) |
| OFF-21 | Low | nav reporter | `COSIGNER_URL` accepted `http://` to any host (reports and the token in cleartext), and a URL without a token was accepted | https unless localhost / `*.railway.internal`; a co-signer URL needs a token; `LIGHTER_API_URL` https | `OFF_21_*` |
| OFF-22 | Low | API | `/v1/vault/*` cached chain state per head block, but concurrent requests at a new block each ran the ~20 reads (RPC fan-out per request burst) | Single flight: requests at the same head share one read; a failed read is not cached | `OFF_22_*` |

**Contract finding surfaced by this pass** (fixed before the Phase 4 freeze, [phase4/README.md](phase4/README.md) §8.1):
a single NAV key could chain sub-1% reports; `NavOracle` now accumulates single-signed moves. The reporter asks the
co-signer on every report (falls back to single-signed only while the accumulated move stays ≤ 1%).

**Diagnostics.** A mined transaction that reverts is now replayed on the previous block and the reason is logged
(`common/signer.ts`); before, the keeper logged only the hash.

### 5.1 Checked, no change needed

| Item | Result |
|---|---|
| Co-signer independence | Re-reads the venue from its own source, checks flows and `tradeNonce` against the chain, sizes exactly, equity within 25 bps + 1 USDG, timestamp ≤ 5 min old; never signs what it can't recompute (`dnVault.test.ts` refusal cases) |
| NAV signer keys | `typedDataSignerFromEnv`: env key, key file, remote KMS (same OFF-3 timeout), anvil-unlocked only on 31337. EIP-712 domain binds chain id and the oracle address |
| Rebalancer trades | All bounds are onchain (DN-R10 floors on measured balances, allowlist, caps); the keeper's `DN_SLIPPAGE_BPS` can only be tighter. On 4663 the swap builder is the UniversalRouter builder; the mock aggregator is never used there (MN-R6) |
| Rebalancer without a venue | Refuses to start when the adapter is `address(0)` (mainnet until the venue is verified) |
| `/v1/vault/account/{address}` | zod address param (400 otherwise), parameterized SQL, ≤ 200 requests returned; rate limits as every `/v1/*` route |
| Vault numbers in the API | Rates are historical and labelled `variable`; APY windows are `null` until they have history (never a projection, CP-R7) |
| Web vault source | Transactions simulated before the wallet prompt (APP-R3); deposits go through the same compliance proxy (terms, attestation); exits never ask for an attestation (CP-R4); the fixture source is only selectable by an e2e/dev session pin |
| Indexer handlers | Pure event → row mappings; no external calls |

### 5.2 Residual risks

1. **Co-signer = second NAV key.** Its host, token and venue source must be independent of the reporter's (separate
   Railway project or provider, separate API credentials). Documented in `docs/runbooks/dn-nav-stale.md` ("Co-signer
   independence"); an ops control, not a code one.
2. **Venue API trust.** Both NAV processes read Lighter's API; a wrong API answer to both is a wrong NAV within the
   co-signer's view. An onchain equity read would remove it (A41).
3. **Intermittent keeper test.** `dnVault.test.ts` "DN_R1 a withdrawal…" failed once (1 of 17 full runs) with a mined
   `settle` that reverted; not reproduced since. The replay diagnostic above will name the reason if it recurs.
