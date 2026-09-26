# 12 · Open questions and Phase 0 validation

Phase 0 answers these before Phase 1 code depends on them. Each item names the doc it affects and what changes if the answer
is "no".

## Technical validation checklist

- [ ] **Morpho on Robinhood Chain.** Are Morpho Blue and MetaMorpho (factory) deployed? Which IRMs and LLTVs are enabled? *If not:* coordinate a deployment with Morpho, or deploy with governance approval. Affects [03](03-lending-markets.md).
- [ ] **Stock Token transfers.** Can Stock Tokens be transferred to arbitrary contracts (wrapper, Morpho)? Are there allowlists, blocklists or pause functions held by the issuer? *If restricted:* get the wrapper allowlisted, or the product is blocked. Affects LM-R6, CP-R5.
- [ ] **ERC-8056 semantics.** Does the multiplier change balances (rebasing) or only a view? How are cash dividends handled: multiplier, airdrop or USDG? *If airdrop:* the wrapper needs a claim-and-distribute path to lenders and borrowers owe it. Affects LM-R1…R3.
- [ ] **Chainlink feeds.** Which Stock Token feeds exist, their heartbeat and deviation threshold, whether they publish 24/5 or only regular hours, and whether a market-status flag exists. Affects [04](04-oracle.md), OR-R13.
- [ ] **USDG.** Is there a USDG/USD feed? Which USDG yield vaults exist (for `clUSDG` backing), and can their share price decrease? Affects OR-R4, CL-R1.
- [ ] **DEX liquidity.** Which DEXs and pools hold Stock Token liquidity, and what depth within 2% at weekday and weekend hours? Affects guard keeper, liquidation profitability, router swaps.
- [ ] **Weekend gap data.** Collect Stock Token onchain price vs Chainlink over every weekend since launch; distribution of premiums and Monday gaps. Affects buffer params, caps.
- [ ] **Finality.** Chain finality and reorg depth for the indexer. Affects SI-R3.
- [ ] **Liquidators.** Which Morpho liquidator operators run on Robinhood Chain? Will they add `clUSDG` unwrap support? Affects the fallback liquidator's importance.
- [ ] **Perp venues.** Which venues list these stocks (Lighter, Arcus)? Funding history, depth, weekend trading, and whether contracts can hold margin. Affects [08](08-delta-neutral-vault.md).

## Market validation

- [ ] 15 borrower interviews (perp makers, arb desks, active traders): would they borrow at 3–15% APR? Which stocks? Which size?
- [ ] 10 lender interviews: what APY would make them deposit? Do they understand manufactured dividends?
- [ ] Perp venue partners: interest in an onchain hedge and in consuming the short-interest API.
- [ ] Estimate borrow demand: premium episodes × size that arbitrage would have captured.

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

- [ ] Opinion on securities-lending characterization of Stock Token lending in target jurisdictions.
- [ ] Opinion on `rSTOCK`, `clUSDG` and vault shares.
- [ ] Terms of use, risk disclosure, privacy policy.
- [ ] Issuer relationship: does the Stock Token issuer permit lending use? Is there any contractual restriction?
