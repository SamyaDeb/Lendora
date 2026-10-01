# Break-the-product run on chain 46630

Run 2026-10-01T00:01:13.463Z by `web/scripts/testnetBreak.ts` (296 s): web http://127.0.0.1:3000, API http://127.0.0.1:42070, compliance http://127.0.0.1:42071, monitor http://127.0.0.1:42073.
Feed session open. With real bypass transactions (tester key).
**Nothing broke** (124 ok, 0 skipped).

| Group | Check | Result | Detail |
|---|---|---|---|
| W · web | reflected script in /stock/{symbol} is not echoed and is not a 5xx | ok | 404, not reflected |
| W · web | reflected markup in ?tab= is not echoed | ok | 200, not reflected |
| W · web | unknown or lower-case stock symbols are a clean 404 or a redirect, never a 5xx | ok | nvda:200 TSLA:404 N%00VDA:404 %F0%9F%9:404 AAAAAAAA:404 |
| W · web | no open redirect: /market//evil.example | ok | 308 → /market/evil.example |
| W · web | no open redirect: /market/%2F%2Fevil.example | ok | 307 → /stock/%2F%2FEVIL.EXAMPLE |
| W · web | no open redirect: /lend/..%2F..%2F%2Fevil.example | ok | 307 → /stock/..%2F..%2F%2FEVIL.EXAMPLE?tab=lend |
| W · web | no open redirect: /short/%5C%5Cevil.example | ok | 307 → /stock/%5C%5CEVIL.EXAMPLE?tab=short |
| W · web | no open redirect: /short-interest?next=//evil.example | ok | 307 → /data |
| W · web | no open redirect: //evil.example/ | ok | 308 → /evil.example/ |
| W · web | a 16 KB path is refused cleanly | ok | 431 |
| W · web | compliance proxy: a non-JSON body is a 4xx | ok | 400 |
| W · web | compliance proxy: a 12 MB body is refused before it is buffered and forwarded | ok | 413 in 93 ms |
| W · web | compliance terms proxy: a non-JSON body is a 4xx | ok | 400 |
| W · web | compliance terms proxy: a 12 MB body is refused before it is buffered and forwarded | ok | 413 in 61 ms |
| W · web | alerts proxy: a non-JSON body is a 4xx | ok | 404 |
| W · web | alerts proxy: a 12 MB body is refused before it is buffered and forwarded | ok | 413 in 45 ms |
| W · web | analytics proxy: a non-JSON body is a 4xx | ok | 204 |
| W · web | analytics proxy: a 12 MB body is refused before it is buffered and forwarded | ok | 413 in 41 ms |
| W · web | the web app still serves pages after the oversized bodies | ok | 200 |
| W · web | proxy path escape refused: /api/compliance/%2e%2e/health | ok | 404 |
| W · web | proxy path escape refused: /api/compliance/..%252f..%252fhealth | ok | 404 |
| W · web | proxy path escape refused: /api/compliance/terms/0xZZ | ok | 404 |
| W · web | proxy path escape refused: /api/compliance/terms/0x1e0193C43B323490512C126beB22e425E6DE8C11/../../health | ok | 404 |
| W · web | proxy path escape refused: /api/compliance/attest%00 | ok | 404 |
| W · web | proxy path escape refused: /api/alerts/..%2fhealth | ok | 404 |
| W · web | proxy path escape refused: /api/alerts/settings/../../admin | ok | 404 |
| W · web | PUT on the compliance proxy → 405 | ok | 405 |
| W · web | DELETE on the compliance proxy → 405 | ok | 405 |
| W · web | PATCH on the compliance proxy → 405 | ok | 405 |
| W · web | alerts proxy with the alerts service down → 503 with a message, not a hang | ok | 200 {"settings":null,"issuedAt":null} |
| W · web | security headers on every page: CSP frame-ancestors/object-src, nosniff, referrer-policy | ok | 7 pages |
| P · API | SIWE: create an API key (07 §2) | ok | key created; replaying the signed message → 401 |
| P · API | SIWE: a message for another domain is refused | ok | 401 |
| P · API | SIWE: a signature by another wallet is refused | ok | 401 |
| P · API | a wrong API key → 401 (and it costs the free budget, OFF-9) | ok | 401 |
| P · API | keys list and revoke need a key | ok | 401 / 401 |
| P · API | a 3 MB key request body is refused | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/history?interval=bogus | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/history?from=abc | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/history?from=-1 | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/history?from=99999999999&to=1 | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/history?limit=0 | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/history?limit=-5 | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/history?limit=100000000000 | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/history?limit=1e3 | ok | 200 |
| P · API | hostile input /v1/markets/NVDA/history?format=xml | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/history?from=1&to=99999999999&interval=1m | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/events?type=bogus | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/events?cursor='%3B%20drop%20table%20x%3B-- | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/events?cursor=999999999999999999999999999999999999999 | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/events?account=0x123 | ok | 400 |
| P · API | hostile input /v1/markets/NVDA/events?limit=999999999 | ok | 400 |
| P · API | hostile input /v1/protocol/revenue?from=abc | ok | 400 |
| P · API | hostile input /v1/protocol/revenue?from=5&to=1 | ok | 400 |
| P · API | hostile input /v1/positions/0x1e0193c43b323490512c126beb22e425e6de8c11 | ok | 200 |
| P · API | hostile input /v1/positions/0x1E0193C43B323490512C126BEB22E425E6DE8C11 | ok | 200 |
| P · API | hostile input /v1/markets/nvda | ok | 200 |
| P · API | hostile input /v1/markets/%F0%9F%92%A9 | ok | 400 |
| P · API | hostile input /v1/markets/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA | ok | 400 |
| P · API | hostile input /v1/vault/account/0x0000000000000000000000000000000000000000 | ok | 200 |
| P · API | hostile input /v1/definitely-not-a-route | ok | 404 |
| P · API | history CSV is CSV (SI-R12) | ok | text/csv; charset=utf-8, 69 lines |
| P · API | POST on a read route → 404/405 | ok | 404 |
| P · API | CORS never reflects an arbitrary origin with credentials | ok | allow-origin *, credentials no |
| P · API | WebSocket: welcome, a push on a new block, message flood closes it (OFF-11), one free socket per IP (SI-R10) | ok | 22 messages; second socket → 0; flood → close 1008 |
| K · compliance | attest with {} → 4xx | ok | 400 |
| K · compliance | attest with address 0x123 → 4xx | ok | 400 |
| K · compliance | attest with address as a number → 4xx | ok | 400 |
| K · compliance | attest with not JSON → 4xx | ok | 400 |
| K · compliance | attest with a JSON array → 4xx | ok | 400 |
| K · compliance | terms: a malformed signature → 4xx | ok | 403 |
| K · compliance | terms: the right key signing a wrong version is refused | ok | 403 |
| K · compliance | a sanctioned address (deny-list) is never attested | ok | 403 {"code":"SANCTIONED","error":"this wallet cannot open positions"} |
| K · compliance | compliance direct: forged proxy secret is not trusted (CP-R8) | ok | 403 {"code":"GEO_UNKNOWN","error":"your location could not be de |
| K · compliance | compliance direct: a 12 MB body is refused | ok | 403 |
| R · router (simulated) | router.listMarket from a stranger → NotOwner | ok | reverted: NotOwner → "This action is reserved to a Lendora role (owner, guardian or keeper);…" |
| R · router (simulated) | router.delistMarket from a stranger → NotOwner | ok | reverted: NotOwner → "This action is reserved to a Lendora role (owner, guardian or keeper);…" |
| R · router (simulated) | router.setCapOverride from a stranger → NotOwner | ok | reverted: NotOwner → "This action is reserved to a Lendora role (owner, guardian or keeper);…" |
| R · router (simulated) | router.setGlobalCap from a stranger → NotOwner | ok | reverted: NotOwner → "This action is reserved to a Lendora role (owner, guardian or keeper);…" |
| R · router (simulated) | router.setAttestationSigner from a stranger → NotOwner | ok | reverted: NotOwner → "This action is reserved to a Lendora role (owner, guardian or keeper);…" |
| R · router (simulated) | router.setSwapTarget from a stranger → NotOwner | ok | reverted: NotOwner → "This action is reserved to a Lendora role (owner, guardian or keeper);…" |
| R · router (simulated) | router.transferOwnership from a stranger → NotOwner | ok | reverted: NotOwner → "This action is reserved to a Lendora role (owner, guardian or keeper);…" |
| R · router (simulated) | router.upgradeToAndCall from a stranger → NotOwner | ok | reverted: NotOwner → "This action is reserved to a Lendora role (owner, guardian or keeper);…" |
| R · router (simulated) | clUSDG.mint outside the router → NotRouter (CL-R2) | ok | reverted: NotRouter → "clUSDG collateral moves only through the Lendora router (or Morpho); i…" |
| R · router (simulated) | clUSDG wallet-to-wallet transfer → TransferNotAllowed (CL-R3) | ok | reverted: TransferNotAllowed → "clUSDG collateral moves only through the Lendora router (or Morpho); i…" |
| R · router (simulated) | lend to the zero address is refused (shares would be lost) | ok | reverted: ZeroAddress → "The recipient address is empty (0x0). Send to your own wallet address.…" |
| R · router (simulated) | lend more than the balance → ERC20InsufficientBalance | ok | reverted: Your balance is too low for this amount. The contract function "lend" reverted w → "Your balance is too low for this amount.…" |
| R · router (simulated) | lend with minShares above the preview → InsufficientOutput | ok | reverted: InsufficientOutput → "The swap returned less than your minimum (price moved beyond your slip…" |
| R · router (simulated) | withdrawLend to the zero address is refused | ok | reverted: Panic → "That amount is more than you hold in this position. Use a smaller amou…" |
| R · router (simulated) | withdrawLend 0 shares does not move funds | ok | reverts: ZeroAmount |
| R · router (simulated) | repay with both assets and shares, or neither → ZeroAmount | ok | reverted: ZeroAmount → "Enter an amount greater than zero.…" |
| R · router (simulated) | withdrawCollateral(all) with no collateral → ZeroAmount | ok | reverted: ZeroAmount → "Enter an amount greater than zero.…" |
| R · router (simulated) | addCollateral 0 → ZeroAmount; for a wallet with no debt → NoDebtPosition | ok | reverted: NoDebtPosition → "Adding collateral is only for positions with an open borrow (it protec…" |
| R · router (simulated) | a real attestation with its expiry moved by 1 s → BadAttestation | ok | reverted: BadAttestation → "The compliance attestation is missing, expired or not for this wallet.…" |
| R · router (simulated) | a real attestation after its expiry → BadAttestation (block time override) | ok | reverted: Execution reverted for an unknown reason. |
| R · router (simulated) | borrow 0 against collateral (a collateral-only entry) is refused (RT-R8) | ok | reverted: Error("inconsistent input") → "The transaction would fail: inconsistent input.…" |
| R · router (simulated) | borrow to the zero address is refused | ok | reverted: ZeroAddress → "The recipient address is empty (0x0). Send to your own wallet address.…" |
| R · router (simulated) | openShort selling more than it borrowed → InsufficientOutput | ok | reverted: InsufficientOutput → "The swap returned less than your minimum (price moved beyond your slip…" |
| R · router (simulated) | openShort with Morpho or clUSDG as the swap target → SwapTargetNotAllowed (RT-R3) | ok | reverted: SwapTargetNotAllowed → "That swap route is not allowlisted.…" |
| R · router (simulated) | faucet: a second claim inside 24h → TooSoon (decoded) | ok | reverted: TooSoon → "You already claimed test tokens in the last 24 hours. The next claim o…" |
| R · router (simulated) | faucet: anyone can claim for any fresh address (sybil, testnet only) | ok | allowed: one wallet can drip for unlimited fresh addresses (mock tokens only; P3) |
| R · router (simulated) | vault: requestRedeem 0 → ZeroAmount; to the zero address → ZeroAddress; for someone else without allowance → refused | ok | reverted: ERC20InsufficientAllowance → "The approval is too low. Approve again.…" |
| R · router (simulated) | vault: a dust deposit (1 USDG unit) mints shares or reverts ZeroAmount, never 0 shares for your USDG | ok | 1 unit → 999910280583 shares |
| R · router (simulated) | vault: deposit to the zero address is refused | ok | reverted: ERC20InvalidReceiver → "The recipient address is empty (0x0). Send to your own wallet address.…" |
| R · router (simulated) | vault: guardian and fee setters from a stranger are refused | ok | setDepositsPaused: NotGuardian, setTotalCap: OwnableUnauthorizedAccount, setBufferBps: OwnableUnauthorizedAccount, setFeeRecipient: OwnableUnauthorizedAccount |
| X · bypass (real txs) | setup: lend 1 NVDA and wait for the allocator to supply the market | ok | lent in 0x5e307ed9d70284e9636bfec10529f902f3187d78ab9ca987434b9bdee44f8477 |
| X · bypass (real txs) | setup: an attested borrow at Morpho health 1.6 (router HF at t+24h ≥ 1.1) | ok | borrowed 0.41984852069227535 NVDA in 0xe1c09e669ced63af3da6bdb4718242600b8ffb2140568bf09cf9d72991d9929d; HF at t+24h 1.600 |
| X · bypass (real txs) | residual (e): router.withdrawCollateral with debt can go below the 24h buffer, down to Morpho's LLTV (05 §1 (e); the app only offers it with no debt) | ok | RESIDUAL (e) confirmed: withdrawing 71.25 of 200 USDG would leave Morpho HF 1.03 (HF at t+24h < 1.1); simulated only |
| X · bypass (real txs) | residual (e) live: a direct Morpho withdrawal to HF(t+24h) 1.05 is accepted and the monitor pages COLLATERAL_BELOW_BUFFER (MON-R26, T10) | ok | withdrew 68.749999 clUSDG in 0xcc682a6601cccd24d5141f6ae1ea4e47eb501756f6f9471abf7535bf938814ee (HF at t+24h 1.050); paged NVDA:0x8571b0664e409f4bb06f71b5dfb1d5ea45d78282, path direct |
| X · bypass (real txs) | residual (e) live: supplying the collateral back resolves COLLATERAL_BELOW_BUFFER | ok | resupplied in 0xd00afd0150e1ce684c393fe01747e834c210d46bcaac2b75ba08de59634b82df; incident resolved |
| X · bypass (real txs) | residual (d): an attested wallet hands clUSDG to a never-attested wallet through Morpho | ok | withdrew 20 clUSDG from Morpho and supplied it for 0x1c9582D1D914c300BcF9e652ce6055F90D386034 in 0xb5c746dcdc4df86e5a198b5701517db8af27991bb8e576dc55c92685d3ef9e87 |
| X · bypass (real txs) | residual (d): the never-attested wallet borrows on Morpho directly (no terms, no attestation, no cap; 05 §1 (d)) | ok | RESIDUAL (d) confirmed: a wallet that never passed compliance borrowed 0.001 wNVDA in 0x76b954a53b837610cf086a54fe0737afbbb243eea068a1af6ab5cd204cfc0755; detection below |
| X · bypass (real txs) | the monitor pages DIRECT_BORROW for that borrow and names the supplier (MON-R10, T9) | ok | paged: NVDA:0x1c9582d1d914c300bcf9e652ce6055f90d386034; collateral supplied by 0x8571b0664e409f4bb06f71b5dfb1d5ea45d78282 |
| X · bypass (real txs) | unwind: repay the ghost's debt through the router (anyone may repay anyone), its collateral back to USDG | ok | ghost debt 0, 20 clUSDG unwrapped to USDG for the tester in 0x48670a70021c5180000090efce21e189b87526f777f2ea0ba0c0cc9653d1e0fc |
| X · bypass (real txs) | rescue top-up by a third party for a position with debt (RT-R8: anyone may top up anyone) | ok | collateral 180 → 185 USDG |
| X · bypass (real txs) | repay more than the debt refunds the excess (RT-R4) | ok | debt 0.4198485353636699, spent 0.4198485376596791 |
| X · bypass (real txs) | unwind: withdraw all collateral and the lend | ok | withdrawn in 0x2248e8cd9a601af76e1d37906b52515de33ddbb99e9bfff28a3e95e39054ae3d |
| X · bypass (real txs) | vault: a 1-share withdrawal request goes through the queue and claims 0 without breaking the API | ok | request 21 claimed (0x2d74fe0686c8c5f16345a4e55d1223b020fec80a85d8b5154b41f3ef85bc058b); a second claim → NotClaimable; API: claimed |
| S · invariants | the router holds no tokens between transactions | ok | 8 tokens, all 0 |
| S · invariants | clUSDG backing ≥ supply (CL-R6); each wrapper's backing ≥ supply | ok | clUSDG 0, AAPL ok, NVDA ok, SPY ok |
| S · invariants | API positions equal Morpho at the API's block | ok | at 126889033: AAPL 0/0, NVDA 0/0, SPY 0/0 |
| Z · abuse | API burst without a key: 429 with Retry-After after the free budget (SI-R10), keyed still served | ok | 30/90 limited, Retry-After 49s; keyed → 200 |
| Z · abuse | pages keep rendering real data while this IP's API budget is exhausted (server-side calls share the web server's IP) | ok | 24/24 rendered |
| Z · abuse | compliance attestation flood for one fresh wallet → 429 (per-wallet / per-IP limit) | ok | 5/25 → 429 (others 403); waited out the 60 s window |
