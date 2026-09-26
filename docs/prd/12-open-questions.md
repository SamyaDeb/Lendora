# 12 · Open questions and Phase 0 validation

Phase 0 answers these before Phase 1 code depends on them. Each item names the doc it affects and what changes if the answer
is "no".

## Technical validation checklist

`[x]` verified with evidence, `[~]` partly verified (open part stated), `[ ]` open. Decisions: [`../phase0/04-prd-decisions.md`](../phase0/04-prd-decisions.md).

- [x] **Morpho on Robinhood Chain.** Are Morpho Blue and MetaMorpho (factory) deployed? Which IRMs and LLTVs are enabled? *If not:* coordinate a deployment with Morpho, or deploy with governance approval. Affects [03](03-lending-markets.md). **Phase 0 (2026-09-26):** Morpho Blue `0x9D53…1010` live; AdaptiveCurveIRM and `irm 0` enabled; LLTVs 0, 38.5, 62.5, 77, 86, 91.5, 94.5, 96.5, 98% enabled. **No MetaMorpho v1 factory**; Vault V2 factory live → decision D6. Evidence: [01 §2](../phase0/01-chain-facts.md#2-morpho), [02](../phase0/02-fork-validation.md).
- [x] **Stock Token transfers.** Can Stock Tokens be transferred to arbitrary contracts (wrapper, Morpho)? Are there allowlists, blocklists or pause functions held by the issuer? *If restricted:* get the wrapper allowlisted, or the product is blocked. Affects LM-R6, CP-R5. **Phase 0:** transfers into the wrapper and Morpho are exact (fork-tested). No allowlist, but the issuer has a blocklist, per-token and global pause, and `adminBurn`, all held by single keys with no timelock → decisions D4, D9, D10. Evidence: [01 §3](../phase0/01-chain-facts.md#3-stock-tokens), [02](../phase0/02-fork-validation.md).
- [x] **ERC-8056 semantics.** Does the multiplier change balances (rebasing) or only a view? How are cash dividends handled: multiplier, airdrop or USDG? *If airdrop:* the wrapper needs a claim-and-distribute path to lenders and borrowers owe it. Affects LM-R1…R3. **Phase 0:** view only (not rebasing); `uiMultiplier()` is effective at `effectiveAt` without a poke; cash dividends are reinvested via the multiplier. Evidence: [01 §3.3](../phase0/01-chain-facts.md#33-erc-8056-a1-and-dividends).
- [x] **Chainlink feeds.** Which Stock Token feeds exist, their heartbeat and deviation threshold, whether they publish 24/5 or only regular hours, and whether a market-status flag exists. Affects [04](04-oracle.md), OR-R13. **Phase 0:** 33 stock feeds incl. SPY/NVDA/AAPL; 8 dp, 0.5% deviation, 24 h heartbeat while open; 24/5; the pause flag is `oraclePaused()` on the token; feeds already include the multiplier; **no sequencer uptime feed**; launch-week 1e18-scaled answers. Evidence: [01 §4](../phase0/01-chain-facts.md#4-chainlink), [WS-C §0–1](../../sim/reports/phase0-weekend-gaps.md), decisions D1–D4.
- [~] **USDG.** Is there a USDG/USD feed? Which USDG yield vaults exist (for `clUSDG` backing), and can their share price decrease? Affects OR-R4, CL-R1. **Phase 0:** USDG/USD feed exists; USDG is 6 dp with `permit`; Paxos can freeze and wipe. Yield vaults: 54 Morpho Vault V2 USDG vaults (ERC-4626; share price falls on realized bad debt) and Maple syrupUSDG (not ERC-4626 here). **Open (UNVERIFIED):** whether the syrupUSDG rate can fall. Evidence: [01 §5](../phase0/01-chain-facts.md#5-usdg).
- [~] **DEX liquidity.** Which DEXs and pools hold Stock Token liquidity, and what depth within 2% at weekday and weekend hours? Affects guard keeper, liquidation profitability, router swaps. **Phase 0:** Uniswap v3 0.05% USDG and WETH pools hold the main liquidity; 2% depth measured on a Saturday. **BLOCKED:** weekday comparison needs an archive RPC or a weekday rerun of `dex_depth.py`. Evidence: [01 §6](../phase0/01-chain-facts.md#6-dexs-and-aggregators-a8-rt-r3-or-r31), [WS-C §6](../../sim/reports/phase0-weekend-gaps.md).
- [x] **Weekend gap data.** Collect Stock Token onchain price vs Chainlink over every weekend since launch; distribution of premiums and Monday gaps. Affects buffer params, caps. **Phase 0:** onchain premiums and gaps for all weekends since 2026-06-21, plus 10 years of reference gaps. Evidence: [WS-C report](../../sim/reports/phase0-weekend-gaps.md).
- [x] **Finality.** Chain finality and reorg depth for the indexer. Affects SI-R3. **Phase 0:** ~0.1 s blocks; `safe` lags ~11.5 min, `finalized` ~18 min. Evidence: [01 §1](../phase0/01-chain-facts.md#1-network).
- [~] **Liquidators.** Which Morpho liquidator operators run on Robinhood Chain? Will they add `clUSDG` unwrap support? Affects the fallback liquidator's importance. **Phase 0:** 248 Morpho liquidations by 65 distinct callers; none yet in stock-loan markets. **Open:** whether operators will add `clUSDG` unwrap (outreach). Evidence: [01 §8](../phase0/01-chain-facts.md#8-liquidators).
- [~] **Perp venues.** Which venues list these stocks (Lighter, Arcus)? Funding history, depth, weekend trading, and whether contracts can hold margin. Affects [08](08-delta-neutral-vault.md). **Phase 0:** Lighter (RH instance) lists SPY/NVDA/AAPL perps, trades on weekends, publishes hourly funding. Arcus lists stock perps (details unverified). **Open (UNVERIFIED):** contract-held margin accounts. Evidence: [01 §7](../phase0/01-chain-facts.md#7-perp-venues-phase-4).

## Market validation

- [ ] 15 borrower interviews (kit: [`../phase0/05-interview-kit.md`](../phase0/05-interview-kit.md); pending, run by the owner) (perp makers, arb desks, active traders): would they borrow at 3–15% APR? Which stocks? Which size?
- [ ] 10 lender interviews: what APY would make them deposit? Do they understand manufactured dividends?
- [ ] Perp venue partners: interest in an onchain hedge and in consuming the short-interest API.
- [~] Estimate borrow demand: premium episodes × size that arbitrage would have captured. First pass in [WS-C §8](../../sim/reports/phase0-weekend-gaps.md); interviews pending.

## Product decisions pending

| Question | Default in this PRD | Decide by |
|---|---|---|
| Fees "in USDG" vs lender yield in stock | Lenders earn in stock; protocol share converted to USDG | Phase 1 start |
| DEX floor on the oracle | Off until sim | Before mainnet |
| Overnight buffer when Chainlink is 24/5 | Smaller or zero (`overnightMode`) | After feed check |
| Per-address caps vs whale borrowers (market makers) | $100k default, allowlist for larger limits | Before mainnet |
| Attestation provider (sanctions API) | Chainalysis or TRM | Phase 2 |
| Upgradeable router | Yes, UUPS, 48h timelock | Phase 1 start |
| Brand name (Stockline is a working name) | Stockline | Before public testnet |

## Legal

Questions for counsel: [`../phase0/06-legal-questions.md`](../phase0/06-legal-questions.md). All items pending.

- [ ] Opinion on securities-lending characterization of Stock Token lending in target jurisdictions.
- [ ] Opinion on `rSTOCK`, `clUSDG` and vault shares.
- [ ] Terms of use, risk disclosure, privacy policy.
- [ ] Issuer relationship: does the Stock Token issuer permit lending use? Is there any contractual restriction?

## Phase 1 engineering assumptions (added during build)

Phase 1 started before Phase 0 finished. Code is built against mocks, and each assumption below is isolated behind an
interface or a constructor parameter. Items marked *public docs* come from Robinhood Chain's developer docs
(docs.robinhood.com/chain, read 2026-09-26) and still need an onchain check on a fork.

| # | Assumption | Where it lives | If wrong |
|---|---|---|---|
| A1 | Stock Tokens implement ERC-8056 as published: `uiMultiplier()` (1e18 = 1.0) returns the *effective* multiplier, and scheduled changes are exposed via `newUIMultiplier()` / `effectiveAt()`. *Public docs* confirm the function names. | `src/interfaces/external/IScaledUIAmount.sol`, `StockWrapper.multiplier()` | If `uiMultiplier()` lags until someone pokes, the wrapper and SDK must compute the effective value from `newUIMultiplier`/`effectiveAt`. |
| A2 | Stock Tokens are 18-decimal, non-rebasing, no fee-on-transfer; raw balances never change outside transfers (*public docs*). | `StockWrapper.wrap` reverts if the received amount ≠ `rawAmount` | If fee-on-transfer or rebasing, LM-R1/LM-R7 do not hold and the wrapper design changes. |
| A3 | No issuer allowlist or blocklist on Stock Tokens (*public docs* mention none). LM-R6 is still implemented through an optional, immutable `IHolderAllowlist` adapter (`address(0)` = none). | `src/interfaces/IHolderAllowlist.sol` | If the issuer has an allowlist with a different interface, deploy an adapter; the wrapper does not change. |
| A4 | EVM target `cancun` for Robinhood Chain. | `contracts/foundry.toml` | Lower `evm_version` and rebuild. |
| A5 | Morpho Blue on Robinhood Chain has `irm = address(0)` and `lltv = 0` enabled, which the idle market (LM-R21) needs. | Deploy scripts (task 7) | Ask Morpho governance to enable them, or run the idle reserve outside Morpho. |
| A6 | LM-R20 uses MetaMorpho v1.1 (`morpho-org/metamorpho-v1.1`, pinned at `3b17547`, no release tags). Morpho Vaults V2 now exists; the PRD says "v1.1 or current". | `contracts/lib/metamorpho-v1.1` | Decide before task 7 whether V2 is "current". V2 changes the allocator design (adapters, no idle market). |
| A7 | USDG on Robinhood Chain has 6 decimals and supports EIP-2612 `permit`, like Paxos USDG elsewhere. | `test/mocks/MockUSDG.sol` (decimals are a constructor arg) | Decimals only change test setup (Morpho's price scaling handles any value). No `permit` means the router uses Permit2 only. |
| A8 | Router swaps and guard-keeper prices go through one allowlisted aggregator target called with opaque `swapData`. The real venue is unknown. | `test/mocks/MockSwapAggregator.sol` | Only the mock and the keeper's price source change; RT-R3 already forbids trusting return values (the mock can lie to test that). |

### PRD issues found against public docs (need a decision before task 5)

- **OR-R1 double-counts the multiplier.** Robinhood's docs say the Chainlink Stock Token feed "returns the price of one
  token, which is the underlying share price times the multiplier… don't apply the multiplier yourself". The PRD computes
  `P_wrapped = P_stock * m`, which applies it twice. Since one `wNVDA` = one raw token (LM-R1), the fix is
  `P_wrapped = chainlink(NVDA/USD)`. The multiplier then matters only for display (`underlyingEquivalent`) and as a sanity
  guard (OR-R3). *Proposed edit:* change OR-R1's first two lines to `P_wrapped = chainlink(NVDA/USD) // USD per raw token,
  already multiplier-adjusted` and restate OR-R3 as a guard-only check.
- **Feeds are 24/5.** The docs say "Stock feeds update 24/5, following market hours", which answers OR-R13 (yes). Weeknight
  closures likely need little or no buffer, so `overnightMode` should default on.
- **Sequencer uptime is missing.** Robinhood Chain is an L2 and the docs say to check the sequencer before trusting a
  price. The PRD has no sequencer check. *Proposed:* new OR-R6 — the staleness guard also trips while the sequencer is down
  and for a grace period after it comes back; `price()` still never reverts.
- **Oracle pause flag.** The docs mention an advisory pause flag during corporate actions. Its interface is unknown. It
  should probably feed the guard, like the multiplier-jump guard.
- **Morpho's own oracle assumption.** Morpho Blue's current `IMorpho` docs state that the oracle price "should not be
  able to change instantly such that the new price is less than the old price multiplied by LLTV·LIF". At 77% LLTV that is
  about a 17% instant drop. OR-R3's 0.1×–10× multiplier bound and any step change in the buffer must stay inside this. The
  ramp-in already does; confirm again in task 5.
