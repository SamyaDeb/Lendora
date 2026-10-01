# Product end-to-end on chain 46630

Run 2026-09-30T23:56:03.085Z by `web/scripts/testnetE2E.ts` (184 s): web http://127.0.0.1:3000, API http://127.0.0.1:42070, compliance http://127.0.0.1:42071, monitor http://127.0.0.1:42073, RPC https://rpc.testnet.chain.robinhood.com.
Feed session open. With flows (tester key).
**All checks passed** (81 ok, 1 skipped).

| Group | Check | Result | Detail |
|---|---|---|---|
| A · surface | API /v1/status: chain and indexer lag | ok | lag 8 blocks |
| A · surface | API /v1/markets → 200 | ok | 3444 bytes |
| A · surface | API /v1/markets/NVDA → 200 | ok | 2417 bytes |
| A · surface | API /v1/markets/NVDA/history → 200 | ok | 25453 bytes |
| A · surface | API /v1/markets/NVDA/events → 200 | ok | 40911 bytes |
| A · surface | API /v1/protocol/revenue → 200 | ok | 2269 bytes |
| A · surface | API /v1/terms → 200 | ok | 487 bytes |
| A · surface | API /v1/receipt-markets → 200 | ok | 208 bytes |
| A · surface | API /v1/openapi.json → 200 | ok | 46715 bytes |
| A · surface | API /v1/positions/0x00DFd7B17Af5D2219b035FeE404Ee07C17E39760 → 200 | ok | 263 bytes |
| A · surface | API /v1/vault/account/0x00DFd7B17Af5D2219b035FeE404Ee07C17E39760 → 200 | ok | 319 bytes |
| A · surface | API /v1/vault/overview → 200 | ok | 2158 bytes |
| A · surface | API /v1/markets/{symbol}: an unknown stock → 404 | ok | 404 |
| A · surface | API invalid address → 400 (positions, vault account) | ok | both 400 |
| A · surface | API /v1/markets/{symbol}: symbol injection refused | ok | 400 |
| A · surface | API numbers equal the chain (vault TVL = totalAssets) | ok | tvl 278.758739 at block 126887170 |
| A · surface | page / → 200 | ok | 46235 bytes |
| A · surface | page /markets → 200 | ok | 56754 bytes |
| A · surface | page /stock/NVDA → 200 | ok | 107278 bytes |
| A · surface | page /stock/NVDA?tab=lend → 200 | ok | 106446 bytes |
| A · surface | page /stock/NVDA?tab=short → 200 | ok | 108086 bytes |
| A · surface | page /portfolio → 200 | ok | 30475 bytes |
| A · surface | page /data → 200 | ok | 148149 bytes |
| A · surface | page /vault → 200 | ok | 29946 bytes |
| A · surface | page /alerts → 200 | ok | 28593 bytes |
| A · surface | page /terms → 200 | ok | 32249 bytes |
| A · surface | page /status → 200 | ok | 36086 bytes |
| A · surface | page /restricted → 200 | ok | 28687 bytes |
| A · surface | legacy route /market/NVDA redirects to /stock/NVDA | ok | 307 → /stock/NVDA |
| A · surface | legacy route /lend/NVDA redirects to tab=lend | ok | 307 → /stock/NVDA?tab=lend |
| A · surface | legacy route /short/NVDA redirects to tab=short | ok | 307 → /stock/NVDA?tab=short |
| A · surface | legacy route /short-interest redirects to /data | ok | 307 → /data |
| A · surface | an unknown page → 404 | ok | 404 |
| A · surface | security headers: CSP with frame-ancestors 'none', object-src 'none' | ok | 12 directives |
| A · surface | compliance proxy: only its fixed paths (anything else 404) | ok | 404 for unknown paths |
| A · surface | compliance proxy: terms text for any address | ok | terms 2026-09-27.1 |
| A · surface | attestation refused before the terms are signed (APP-R10) | ok | 403 {"code":"TERMS_REQUIRED","error":"accept the current terms first"} |
| A · surface | terms acceptance with a wrong signature is refused | ok | 403 |
| A · surface | compliance direct: client geo headers without the proxy secret are not trusted (CP-R8) | ok | 403 {"code":"GEO_UNKNOWN","error":"your location could not be de |
| A · surface | compliance /health | ok | signer = router.attestationSigner; sanctions deny-list |
| A · surface | monitor /health and the weekend log | ok | 1 closure(s) recorded |
| B · edge cases (simulated) | lend: an expired deadline → Expired | ok | reverted: Expired |
| B · edge cases (simulated) | lend: zero amount → ZeroAmount | ok | reverted: ZeroAmount |
| B · edge cases (simulated) | lend: an unlisted token → NotListed | ok | reverted: NotListed |
| B · edge cases (simulated) | borrow: a forged attestation → BadAttestation (RT-R2) | ok | reverted: BadAttestation |
| B · edge cases (simulated) | borrow: an expired attestation → refused | ok | reverted: BadAttestation |
| B · edge cases (simulated) | openShort: a forged attestation → BadAttestation | ok | reverted: BadAttestation |
| B · edge cases (simulated) | addCollateral without a debt position → NoDebtPosition (RT-R8) | ok | reverted: NoDebtPosition |
| B · edge cases (simulated) | router owner action from a stranger → NotOwner | ok | reverted: NotOwner |
| B · edge cases (simulated) | oracle guard trip from a stranger → Unauthorized | ok | reverted: Unauthorized |
| B · edge cases (simulated) | Morpho: withdraw collateral you don't have → reverts | ok | reverted: Panic |
| B · edge cases (simulated) | fee converter: convert by a non-keeper → NotKeeper (FE-R4) | ok | reverted: NotKeeper |
| B · edge cases (simulated) | vault: plain ERC-4626 deposit → AttestationRequired (A42) | ok | reverted: AttestationRequired |
| B · edge cases (simulated) | vault: mint → AttestationRequired | ok | reverted: AttestationRequired |
| B · edge cases (simulated) | vault: attested deposit with a forged attestation → refused | ok | reverted: BadAttestation |
| B · edge cases (simulated) | vault: claim a request that doesn't exist → NotClaimable | ok | reverted: NotClaimable |
| B · edge cases (simulated) | vault: withdraw with no shares → refused | ok | reverted: ExceedsInstant |
| B · edge cases (simulated) | vault: requestRedeem with no shares → refused | ok | reverted: ERC20InsufficientBalance |
| B · edge cases (simulated) | vault: guardian actions from a stranger → NotGuardian | ok | reverted: NotGuardian |
| B · edge cases (simulated) | strategy: operator action from a stranger → NotOperator (DN-R10) | ok | reverted: NotOperator |
| B · edge cases (simulated) | NAV oracle: an unsigned report → BadSignature (DN-R4) | ok | reverted: BadSignature |
| B · edge cases (simulated) | vault: settle with an empty or unpayable queue changes nothing | ok | queue 20..20; settle(20) → 0 |
| C · flows | faucet: claim test USDG + stocks (once per 24h) | skip | already claimed in the last 24h (Error: tx would revert: Execution reverted for an unknown re) |
| C · flows | terms signed + attestation through the web's compliance proxy | ok | valid until 2026-10-01T23:53:36.000Z |
| C · flows | lending and borrowing: lend, short, rescue top-up, repay, close, borrow, repay all, withdraw | ok | 11 txs (lend, openShort, addCollateral, repay, closeShort, borrow, withdrawCollateral, withdrawLend), indexed |
| C · flows | API /v1/positions reflects the wallet after the flows | ok | [] |
| C · edge cases (with a position) | lend 1 NVDA and wait for the allocator keeper to supply the market (liquidity for the checks below) | ok | lent in 0x873f86ca4f33e5da72eb310dd7c02c633c83e027f4009d90e7d18255ea70e932; market has ≥ 0.5 NVDA free |
| C · edge cases (with a position) | borrow inside Morpho's LLTV but under the router's buffered health → HealthTooLow (RT-R1) | ok | reverted: HealthTooLow |
| C · edge cases (with a position) | openShort through a swap target that isn't allowlisted → SwapTargetNotAllowed (RT-R3) | ok | reverted: SwapTargetNotAllowed |
| C · edge cases (with a position) | openShort with a minimum above what the DEX pays → InsufficientOutput (slippage, FE-R4-style bound) | ok | reverted: InsufficientOutput |
| C · edge cases (with a position) | someone else's attestation is refused (bound to the wallet) | ok | reverted: BadAttestation |
| C · edge cases (with a position) | withdraw more lent shares than held → refused | ok | reverted: Panic |
| C · edge cases (with a position) | repay with no debt → refused or no-op | ok | repay(all) with no debt → reverts (The contract function "repay" reverted.) |
| C · edge cases (with a position) | withdraw the 1 NVDA lent for the checks above (forceDeallocate when idle is short, LM-R22) | ok | withdrawn in 0xab40c0ab7dacbab1ae253f871d434f2fcaddf23687f3be17b1264e385e1f8433 |
| C · flows | USDG Earn: attested deposit of 100 USDG mints shares at the share price | ok | 99.99102819564085 shares; API shares 278.974969309191792492 |
| C · edge cases (with a position) | vault: deposit above the cap → refused (DN-R6) | ok | reverted: CapExceeded |
| C · flows | USDG Earn: instant withdrawal of 10 USDG (no attestation, CP-R4) | ok | received 10 USDG |
| C · edge cases (with a position) | vault: instant withdrawal above the cash buffer → ExceedsInstant | ok | reverted: ExceedsInstant |
| C · edge cases (with a position) | vault: requestRedeem more shares than held → refused | ok | reverted: ERC20InsufficientBalance |
| C · flows | USDG Earn: queued withdrawal request (always accepted) | ok | request 20, settles by 2026-10-05T13:30:00.000Z |
| C · edge cases (with a position) | vault: claim before settlement → NotClaimable | ok | reverted: NotClaimable |
| C · flows | USDG Earn: settle (permissionless) then claim; the API shows it claimed | ok | claimed 134.5 USDG; API: claimed |

**Not testable on a live chain now** (needs prices or time we don't control; covered on anvil / forks): liquidation of an
unhealthy position (MON-R2), guard trips from a feed deviation or a stale feed, issuer pause / blocklist, the weekend
buffer ramp (happens by itself Fri 16:00 ET), a > 2× re-anchor, bad debt and backing shortfalls, DN margin top-up after
a big move, the funding kill switch, a venue halt, the queued-withdrawal deadline (72h / next US open).
