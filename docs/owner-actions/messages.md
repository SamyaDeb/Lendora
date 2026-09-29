# Messages ready to send (drafts)

Replace `<…>`. Never quote yields as promises (CP-R7); do not approach people in restricted jurisdictions (CP-R1: US,
Canada, UK, Switzerland, UAE, OFAC-sanctioned).

## Tester recruitment post

> **Help test Stockline on Robinhood Chain testnet (2–3 weeks, test tokens only)**
> We are building a stock lending layer on Morpho Blue: lend Stock Tokens for yield, or borrow them to short or hedge
> over weekends, plus USDG Earn, a delta-neutral USDG vault (variable, historical rates only). We are looking for 20
> testers to lend, borrow, open and close a short, try the vault page, and tell us what breaks.
> Everything uses testnet tokens from our faucet; nothing has real value. Not available to residents of the US, Canada,
> UK, Switzerland, the UAE or sanctioned jurisdictions. Apply: `<form link>` · Guide: `<link to runbooks/testnet.md §1>`

## Feedback form (placeholder, owner to create)

Fields: wallet address (optional) · flow number from [testnet.md §1](../runbooks/testnet.md#1-for-testers) · what you
did · what you expected · what happened · tx hash · browser and wallet · screenshot · severity (blocked / wrong /
confusing / cosmetic). Put its link in place of `<FEEDBACK_FORM_URL>` in testnet.md and `<form link>` above.

## Interview outreach

**Borrowers (perp makers, arb desks, active traders), 30 min:**
> Hi `<name>` — I'm researching borrowing tokenized stocks on Robinhood Chain (to short, hedge perp exposure or arb the
> weekend gap when Chainlink feeds are frozen). Nothing is being offered; it's a research call, 30 minutes, notes only
> with your consent. Would you share how you hedge today and what rate/size would make onchain borrowing useful?
> `<calendar link>`

**Lenders (Stock Token holders), 30 min:**
> Hi `<name>` — you hold Stock Tokens on Robinhood Chain. We're researching whether holders would lend them (keeping the
> stock exposure, dividends via the multiplier) for a variable rate. Research only, nothing offered. 30 minutes?
> `<calendar link>`

## Counsel engagement

> Subject: Engagement request — opinions on onchain lending of tokenized equities (Robinhood Chain)
> We are building Stockline, a lending layer where holders lend Robinhood Stock Tokens through Morpho Blue and borrowers
> post USDG collateral. Before a capped mainnet launch we need opinions on: (A) whether this is securities lending in
> `<jurisdictions>`; (B) the issuer's terms and powers (blocklist, pause, burn); (C) geo-restrictions and sanctions
> screening; (D) protocol fees and governance. The full question list and draft terms are attached
> (06-legal-questions.md, compliance/terms). Please send scope, timeline and fee estimate. `<name, contact>`

## Ecosystem outreach

**Stock Token issuer (via Robinhood Chain BD):**
> We are building a lending market for Stock Tokens on Morpho Blue (wrapper contract, per-stock Morpho markets). Three
> questions: (1) your policy on blocklisting, pausing or `adminBurn` of balances held by DeFi contracts, and whether you
> would notify integrators first; (2) whether lending use is permitted under the Stock Token terms; (3) how the admin
> role keys are custodied (multisig/MPC, timelock?). Contact for incidents: `<ops email>`.

**Chainlink (via Robinhood):**
> We consume the Stock Token and USDG/USD feeds on chain 4663. (1) Is a sequencer uptime feed planned for Robinhood
> Chain? We currently rely on L2 block-gap detection. (2) Could you share the post-mortem of the launch-week answers
> scaled by 1e18? (3) Where do you announce feed changes around corporate actions (splits)?

**Morpho:**
> We are launching per-stock Morpho Vault V2 vaults (official factories on 4663) lending wrapped Stock Tokens against a
> gated USDG collateral token, oracle with a weekend/earnings buffer. We'd value guidance on Vault V2 configuration on
> 4663 (no liquidity adapter, forceDeallocatePenalty 0) and on listing our vaults in the Morpho app. Audit package:
> `<link to docs/audit when shared>`.

**Liquidator operators:**
> Stockline markets on Morpho (chain 4663) use `clUSDG` as collateral: seized `clUSDG` is redeemed 1:1 for USDG with
> `clUSDG.unwrap(amount, to)` (permissionless, no fee). Would you add these markets? The loan asset is a wrapped Stock
> Token (`wrap`/`unwrap` 1:1). Launch caps: $250k–$1M per market. Contract addresses after deployment: `<link>`.
