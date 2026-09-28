# Bug bounty (Q14) · proposal

*Immunefi-style program draft, Phase 3 task 10 (2026-09-28). Payouts and the platform are **proposals for the owner to
confirm** (Q14); nothing is listed until mainnet addresses exist and the owner signs off. Brand name pending (Q6).*

## 1. Assets in scope

**Smart contracts on Robinhood Chain (4663)**, at the addresses in `packages/sdk/addresses.json["4663"]` once deployed
(filled in at launch from `contracts/deployments/4663.json`, after `VerifyRoles` passes):

| Contract | Source | Notes |
|---|---|---|
| `StocklineRouter` (proxy + implementation) | `contracts/src/StocklineRouter.sol` | UUPS, owner = 48h timelock |
| `StocklineOracle` (one per stock) | `contracts/src/oracles/StocklineOracle.sol`, `StocklineOracleBase.sol` | |
| `MarketHours` | `contracts/src/MarketHours.sol` | |
| `StockWrapper` (wSTOCK, one per stock) | `contracts/src/StockWrapper.sol` | |
| `CollateralToken` (`clUSDG`) | `contracts/src/CollateralToken.sol` | |
| `StocklineLiquidator` | `contracts/src/StocklineLiquidator.sol` | |
| `FeeSplitter`, `FeeConverter` (×2) | `contracts/src/fees/*.sol` | |
| `ShortInterestLens` | `contracts/src/ShortInterestLens.sol` | view-only; Low at most |
| Libraries used by the above | `contracts/src/libraries/*.sol` | |
| Deployment configuration | the deployed wiring (roles, timelocks, caps) as checked by `contracts/script/VerifyRoles.s.sol` | a misconfiguration that `VerifyRoles` does not catch counts |

**Web and services** (only for impacts listed in §3): the app at the production domain, the public API, the compliance
service's attestation logic (a way to obtain an attestation without passing the checks), keeper logic that can be made
to lose funds or skip a liquidation.

## 2. Out of scope

- Morpho Blue, Morpho Vault V2 and `MorphoMarketV1AdapterV2` (unmodified, deployed by Morpho; report to Morpho), the
  Robinhood Stock Tokens and their issuer controls, Paxos USDG, Chainlink feeds, Uniswap, Robinhood Chain itself.
- Known issues and accepted risks: [README §7 and §8.5](README.md#7-known-issues-and-accepted-risks) (e.g. the soft-gate
  residual, `forceDeallocatePenalty = 0`, issuer `adminBurn`/pause, USDG freeze/wipe, no sequencer feed, the
  converter's 1% slippage allowance, revert-all splitter).
- Anything requiring a compromised owner (4-of-7), guardian (2-of-4) or curator multisig, or a compromised compliance
  or keeper key, **unless** the impact exceeds what the role is documented to allow ([README §3](README.md#3-roles-and-trust-assumptions)).
- Price moves of the underlying stock, weekend gaps within the documented buffer design, economic outcomes of
  parameters the risk owner signed (report as an improvement, not a bug).
- Testnet (46630) deployments, mocks, `test/`, `script/` other than the deployment wiring, `client/` (marketing).
- Web: missing best-practice headers without an exploit, clickjacking on pages without sensitive actions, self-XSS,
  rate-limit bypass without impact, reports from automated scanners, DoS by volume, social engineering, phishing.
- Anything already found in the audits ([findings.md](findings.md)) or already public.

## 3. Severity and impacts (Immunefi v2.3 classification, adapted)

| Severity | Smart contract impacts | Web/service impacts |
|---|---|---|
| **Critical** | Direct theft of user funds (lender `rSTOCK`/wSTOCK, borrower `clUSDG`/USDG) or of protocol fees; permanent freezing of user funds; insolvency (bad debt) created without a market move beyond the documented bounds; bypassing the timelock | Attestation for a sanctioned/restricted wallet at scale; key extraction from a service; forcing a keeper to send funds anywhere |
| **High** | Temporary freezing of funds > 24h (exits blocked while the docs say they work, CP-R4); theft of unclaimed yield/fees; `price()` manipulation that enables unfair liquidations or borrows beyond caps | Making the liquidator skip liquidations (bad debt risk); making the guard keeper trip or clear guards falsely |
| **Medium** | Griefing with damage to users or the protocol without profit; a guard or cap that can be bypassed without direct loss; `distribute`/`convert` blocked by a third party | Leaking secrets or PII; stored XSS or a signing prompt that misrepresents what is signed |
| **Low** | Contract fails to deliver promised returns without losing value; incorrect events or views used by integrators | Incorrect data in the public API that could mislead users |

## 4. Payouts (proposal, owner to confirm)

The max payout is **10% of the funds directly at risk under the launch caps** (Q14 default):

| Funds at risk at launch | Amount |
|---|---|
| Lender supply at 25% of D8 caps (SPY $250k, NVDA $250k, AAPL $62.5k) | $562.5k |
| Borrower collateral, capped by the global `clUSDG` cap | $4.0M |
| **Total** | **≈ $4.56M** |

| Severity | Payout |
|---|---|
| Critical | 10% of funds directly affected, **min $50,000, max $450,000** at launch caps (re-sized at every ×2 cap step) |
| High | $10,000 – $50,000 |
| Medium | $2,500 – $10,000 |
| Low | $1,000 |

Paid in USDG. Requires a runnable PoC (Foundry fork test against the deployed addresses, or the local stack from
`scripts/dev.sh`). KYC per the platform's rules; sanctioned persons and jurisdictions (CP-R1) are not eligible.
Budget: the owner reserves at least the Critical max in the treasury Safe before listing.

## 5. Disclosure process

1. Report privately through the bounty platform (or `security@<domain>` with PGP key published in `SECURITY.md` at
   launch). Never on public channels, GitHub issues or onchain.
2. Acknowledgement within **24h**; severity assessment within **72h**; the on-call follows
   [runbooks](../runbooks/README.md) (P0 if funds are at risk: guardian pause of new entries, allocator pulls,
   timelocked fix).
3. Fix following [fix-workflow.md](fix-workflow.md): failing-first test, fix, re-review by an auditor for Critical/High,
   timelocked deployment (48h; users can exit in the window).
4. Payout within 14 days of the fix being deployed (or of the decision not to fix, for accepted findings).
5. Public disclosure by agreement after the fix, at the earliest 30 days after deployment.
6. Safe harbor: good-faith research following these rules, on a fork or a local stack, is authorized; no testing
   against mainnet state that could move funds, no front-running of fixes.

## 6. Before listing (owner checklist)

- [ ] Addresses filled in §1 from `deployments/4663.json`; `VerifyRoles` table attached.
- [ ] Payout table confirmed (Q14) and budget in the treasury Safe.
- [ ] Platform chosen (Immunefi proposed), `security@` mailbox and PGP key live, `SECURITY.md` published.
- [ ] Both audit reports public; their findings listed as out of scope.
