# Phase 0 · WS-G · Questions for counsel

Questions only; no legal conclusions are drawn here. Each question says why it matters and which requirement or launch
step it blocks. Facts cited are from [`01-chain-facts.md`](01-chain-facts.md) (collected 2026-09-26). Source documents
counsel will need: the RHJ Base Prospectus and Final Terms (`docs.robinhood.com/rhj`, per the Stock Tokens page),
the Stock Token terms URL returned onchain by `terms()` (`https://robinhood.com/stocktoken/rhj`), Robinhood Chain terms
of service, Paxos USDG terms, Morpho's terms, and this PRD.

## A. Characterization (CP-R6)

| # | Question | Why it matters | Blocks |
|---|---|---|---|
| A1 | Stock Tokens are described by the issuer as "tokenised debt securities issued by Robinhood Assets (Jersey) Limited" that give "economic exposure" but "no legal or beneficial rights" in the underlying shares. In each target jurisdiction, is lending a Stock Token through a Morpho market (lender receives a vault share, borrower returns the same number of tokens plus interest) a securities-lending transaction, a loan of a debt security, or something else? | Determines licensing (lending intermediary, broker), disclosure and reporting | CP-R6, mainnet (Phase 3) |
| A2 | Is `rSTOCK` (an ERC-4626 vault share representing a claim on lent Stock Tokens plus interest) a security, collective investment scheme or fund interest in those jurisdictions? Does the answer change if it is MetaMorpho v1.1 vs Morpho Vault V2 (decision D6)? | Could make the receipt a regulated product | LM-R20, G5 |
| A3 | Is `clUSDG` (a gated, non-transferable wrapper of USDG or a yield-bearing USDG share, usable only as Morpho collateral) an e-money token, stablecoin, security or none of these? Does wrapping a Maple `syrupUSDG` position change the answer? | Collateral design | CL-R1…R6 |
| A4 | Does enabling borrowers to short Stock Tokens raise market-abuse, short-selling (e.g. EU SSR-type) or disclosure obligations, for Stockline or for borrowers, given the tokens reference US-listed shares? | Short-selling rules may apply by analogy | G2, SI product |
| A5 | Is publishing real-time per-stock short interest and borrow rates (API and onchain) regulated market data or investment research anywhere we operate? | SI API terms and access | 07-short-interest |
| A6 | Is the Phase 4 delta-neutral vault (USDG in; buys tokens, lends them, shorts perps) a collective investment scheme / AIF? Can it be offered to anyone without a licence? | Phase 4 go/no-go | DN-R1…R11 |

## B. Issuer relationship and Stock Token terms

| # | Question | Why it matters | Blocks |
|---|---|---|---|
| B1 | Do the Prospectus, Final Terms or Stock Token terms restrict lending, pledging, rehypothecation or holding by smart contracts (the wrapper, Morpho Blue, a vault)? | The product depends on contracts holding tokens | Go/no-go |
| B2 | The issuer's contracts give single keys the power to **blocklist any address** (175 addresses blocked to date, all EOAs), **pause** one or all tokens, and **`adminBurn`** any address's balance, with no timelock. Under what conditions do the terms allow the issuer to use these against a holder that is a DeFi contract (our wrapper or Morpho), and what recourse do end-holders (lenders) have? | A freeze or burn of the wrapper hits every lender at once (fork-tested) | LM-R5, LM-R7, risk disclosure |
| B3 | If the issuer burns tokens held by the wrapper (e.g. under a court order against one user), who bears the loss among wrapper holders, and does Stockline have any duty to allocate it? | The wrapper has no admin and pays first-come-first-served | LM-R7 restatement, terms of use |
| B4 | Are Stockline, lenders or borrowers "holders" entitled to anything from the issuer on insolvency, and does lending change that (the borrower may hold the tokens at the relevant time)? | Loss allocation in an issuer default | Risk disclosure |
| B5 | Cash dividends are reinvested via the token multiplier. When a lender's tokens are lent out over a record/effective date, is the economic dividend (paid by the borrower through the multiplier) treated as a "manufactured dividend" for tax purposes in target jurisdictions? Any withholding implications? | Tax disclosure for lenders and borrowers | LM-R3 UX copy, terms |
| B6 | Would a written no-objection or partnership with the issuer (RHJ / Robinhood) be advisable before mainnet? What should it cover (lending use, freeze policy for DeFi contracts, notice of corporate actions)? | Outreach is yours; this frames it | Mainnet |

## C. Access, geography and compliance (CP-R1…R5)

| # | Question | Why it matters | Blocks |
|---|---|---|---|
| C1 | Stock Tokens "may not be offered, sold, or delivered … in the United States or to … U.S. persons", with restrictions in Canada, the UK, Switzerland and others. Is a borrow of a Stock Token by a restricted person through our interface an offer or delivery by Stockline? Is IP geoblocking plus an attestation (CP-R2, CP-R3) sufficient, or is KYC required for borrowers? For lenders? | Defines the compliance stack | CP-R1…R4, RT-R2 |
| C2 | Exits (repay, withdraw, unwrap) never require attestation (CP-R4). Is allowing a restricted person who already holds a position to exit acceptable, or required? | Users must always be able to leave | CP-R4 |
| C3 | Robinhood Chain's sequencer drops transactions "associated with a sanctioned address". Does relying on this plus a wallet sanctions screen meet our sanctions obligations, or do we need our own blocking in the contracts? | Contracts are permissionless by design | CP-R3, CL-R2 |
| C4 | USDG (Paxos) can freeze and wipe any address. If Paxos freezes Morpho or `clUSDG`, collateral is stuck. What must the risk disclosure say, and are there contractual commitments from Paxos regarding DeFi contracts? | Collateral freeze risk | CL-R5, disclosure |
| C5 | Is running liquidator and keeper bots (fallback liquidator, allocator, guard keeper) an activity that needs a licence in our operating jurisdiction? | Operations | Phase 1 tasks 9–11 |
| C6 | Which list of restricted jurisdictions should `CP-R1` config start from (issuer list + OFAC + others)? | Config | CP-R1 |

## D. Protocol, fees and governance

| # | Question | Why it matters | Blocks |
|---|---|---|---|
| D1 | Does taking a 10% performance fee from lender interest (to `FeeSplitter`: backstop + treasury) make Stockline a fund manager, investment adviser or lending intermediary? | Fee model | LM vault fee, 09-backstop-fees |
| D2 | Does the multisig's curator power (caps, markets, allocator) create fiduciary or custody duties toward lenders? Does moving to Morpho Vault V2 (allocator, sentinel, gates) change this? | Role design | 02 roles, D6 |
| D3 | Marketing: what can the site say about yields and the multiplier ("manufactured dividends") without being an inducement to invest in restricted places (e.g. UK FSMA s.21)? | Copy | CP-R7, 06-web-app |
| D4 | Points program or a later governance token: what must be true (revenue, decentralization) before either is considered, and what restrictions apply? | Roadmap | Phase 5 |
| D5 | Terms of use, risk disclosure and privacy policy: scope for launch (issuer freeze/burn risk, weekend buffer, liquidation, oracle incidents like the launch-week 1e18 scaling, USDG freeze). | Launch documents | 12-open-questions "Legal" |
