# Phase 0 · WS-F · Market validation kit

For you to run; nothing here has been sent to anyone. Targets from [`12-open-questions.md`](../prd/12-open-questions.md):
15 borrower interviews, 10 lender interviews, and perp-venue partner conversations. Tracker template:
[`outreach-tracker.csv`](outreach-tracker.csv) (columns only).

**Before every call.** Stock Tokens are not offered to US, Canadian, UK, Swiss or UAE persons (and other restricted
jurisdictions). Screen interviewees first and do not interview anyone in a restricted jurisdiction about using the
product. State that Stockline is a research project, nothing is being offered, and there is no token. Do not quote
yields as promises (CP-R7). Take notes in the results template below, not verbatim recordings, unless the interviewee
consents.

**Context you can share (facts from WS-A/C, 2026-09-26).** Lighter's Robinhood Chain instance lists SPY/NVDA/AAPL
perps (SPY open interest ≈ $51M). Stock Tokens trade on weekends while Chainlink feeds freeze from Friday ~20:00 to
Sunday 20:00 ET. Raw Stock Tokens can already sit in Morpho markets. Stock Token dividends are reinvested through the
token's multiplier. The issuer can blocklist addresses, pause tokens and force-burn balances.

## 1. Borrower guide (perp makers, arb desks, active traders) · 15 interviews · ≤ 30 min

Segment tags: `MM` (perp or spot market maker), `ARB` (arb desk / prop), `TRADER` (active individual), `FUND`.

| # | Question | Why (maps to) | Probe |
|---|---|---|---|
| B1 | Which venues do you trade Stock Tokens or equity perps on today, and what is your typical inventory? | Segment, size | Lighter, Arcus, CEX perps, TradFi |
| B2 | How do you hedge short-perp or long-spot inventory in these names today? What does it cost (APR or bps)? | Current alternative, willingness to pay | TradFi borrow, perps on another venue, not hedged |
| B3 | Have you ever wanted to short a Stock Token onchain and could not? What did you do instead? | Pain | Concrete episode, date, size |
| B4 | Weekends: what do you do when the token trades away from Friday's close? Have you taken or avoided a trade because you could not short? | Weekend premium arb (WS-C §5, §8) | Size you would have shorted |
| B5 | If you could borrow NVDA/SPY/AAPL tokens onchain, at what APR would you borrow for (a) a hedge, (b) an arb? Show the 3–15% range. | Pricing (AdaptiveCurveIRM target) | Walk-away rate |
| B6 | Which stocks first? Rank SPY, NVDA, AAPL, plus any others you need. | Listing order | QQQ, TSLA, SPCX |
| B7 | Typical and maximum size per position and in total (USD)? | Per-address cap ($100k default), caps | Would a $100k cap be a dealbreaker? |
| B8 | What collateral would you post: USDG, yield-bearing USDG (e.g. syrupUSDG), USDC, other Stock Tokens? | CL-R1 | Is yield on collateral a must? |
| B9 | How long do you hold a borrow: hours, days, weeks? | Utilization, rate model | Over weekends? |
| B10 | We would mark borrowed stock up by a volatility buffer over weekends (e.g. NVDA ~6–10%), so you need more collateral Friday to Sunday. Acceptable? What buffer would make you close before Friday? | OR buffer design, `overnightMode` | Prefer higher APR vs higher buffer? |
| B11 | Liquidation: 7.4% incentive at 77% LLTV. Do you run liquidation bots? Would you liquidate these markets? | Liquidator presence | Needs: callback, DEX route |
| B12 | Would you need a compliance attestation (geo check + sanctions screen) per wallet? Any issue with a 24 h validity? | RT-R2, CP-R3 | Contract wallets, sub-accounts |
| B13 | What would stop you from using this? (issuer blocklist risk, smart-contract risk, legal, liquidity) | Dealbreakers | Rank top 3 |
| B14 | Would you pay for or use real-time short-interest data? Via API, onchain view, both? | SI product | Latency needs |
| B15 | Who else should we talk to? | Referral | – |

## 2. Lender guide · 10 interviews · ≤ 30 min

Segment tags: `HOLDER` (long-term token holder), `WHALE` (> $250k in Stock Tokens), `TREASURY`, `YIELD` (yield seeker).

| # | Question | Why | Probe |
|---|---|---|---|
| L1 | Which Stock Tokens do you hold, roughly how much, and for how long? | Supply side | Wallet or exchange custody |
| L2 | Do your tokens earn anything today? Would you lend them for yield? | Motivation | Lent elsewhere? |
| L3 | What APY (in stock terms) would make you deposit? What makes you not deposit at any APY? | Target APY | 0.5%, 1%, 3%, 5% |
| L4 | Explain: dividends raise the token's multiplier, so a lent token keeps receiving dividends and the borrower pays them ("manufactured dividends"). Ask them to explain it back. | Comprehension of the multiplier (LM-R3) | Where did it confuse them? |
| L5 | You receive `rNVDA`, a vault share. Would you use it as collateral to borrow USDG? | G5 | At what LTV? |
| L6 | Withdrawals are instant only while the vault has idle liquidity (up to 10% held back). How long could you wait in the worst case: hours, a day, a weekend? | U_MAX, withdrawal UX | What if borrowers hold 90%? |
| L7 | If the issuer froze the wrapper or paused the token, your tokens would be stuck until it is lifted. Does that change your decision? | Disclosure of issuer risk | How would you want to be told? |
| L8 | Would a first-loss backstop or insurance change the APY you require? | Phase 5 | – |
| L9 | Which stocks would you lend first? | Listing | – |
| L10 | Anything that would make this a clear yes? | Close | – |

## 3. Perp venue / partner guide (Lighter, Arcus, others) · 30 min

| # | Question | Why |
|---|---|---|
| P1 | How do your makers hedge equity-perp inventory today, especially over weekends when spot tokens cannot be minted or redeemed? | Hedging demand |
| P2 | Would an onchain stock-borrow market help your makers keep tighter weekend spreads? Which symbols? | Demand, listing |
| P3 | Would you consume a real-time short-interest / borrow-rate feed (API or onchain)? For what (funding, risk, display)? | SI-R10+ |
| P4 | Can a smart contract hold a margin account on your venue (EIP-1271, delegated keys, pTokens)? | DN-R4, Phase 4 |
| P5 | Funding history and depth data: can we get it for a backtest? Terms? | DN sim gate |
| P6 | Any concerns (competition, compliance, oracle alignment)? | Partnership risk |

## 4. Scoring rubric

Score each interview right after the call (0–3 per dimension). The go/no-go memo uses the averages.

| Dimension | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Pain (borrowers) | No need | Nice to have | Recurring workaround with cost | Losing money / trades today |
| Willingness to pay | < 1% APR | 1–3% | 3–8% | > 8% or "any reasonable rate" |
| Size | < $10k | $10k–100k | $100k–1M | > $1M |
| Frequency | Once | Monthly | Weekly | Every weekend / daily |
| Collateral fit | Needs unsupported collateral | USDC only | USDG ok | USDG or yield-bearing USDG preferred |
| Lender APY fit (lenders) | Needs > 8% | 4–8% | 1–4% | Any positive yield |
| Comprehension (lenders, L4) | Wrong | Partly | Right with help | Right unprompted |
| Dealbreaker present | Hard dealbreaker (score the interview as "no") | – | Soft concern | None |

**Thresholds for "Go" on market validation (proposal):** ≥ 8 of 15 borrowers score ≥ 2 on Pain and Willingness to pay,
with ≥ $2M aggregate stated size across SPY/NVDA/AAPL; ≥ 6 of 10 lenders score ≥ 2 on APY fit.

## 5. Results template

| ID | Date | Segment | Region (not restricted: y/n) | Pain | WTP | Size | Freq | Collateral | APY fit | Comprehension | Dealbreaker | Stocks (ranked) | Stated size (USD) | Stated APR / APY | Key quote (paraphrase) | Follow-up |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B-01 | | | | | | | | | – | – | | | | | | |
| L-01 | | | | – | – | | | | | | | | | | | |
| P-01 | | venue | | | | | | | – | – | | | | | | |

Roll-up for the memo: counts per segment, averages per dimension, aggregate stated size per stock, median stated APR
(borrowers) and median required APY (lenders), and the list of dealbreakers with counts.
