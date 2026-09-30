# Phase 0 · WS-D/E · PRD decisions pack

One entry per decision: context → verified facts (with links) → options → recommendation → affected IDs → approval.
**Nothing here has been applied to the PRD.** After you approve, the approved items go into the PRD in a separate commit.

Evidence: [WS-A chain facts](01-chain-facts.md), [WS-B fork tests](02-fork-validation.md),
[WS-C report](../../sim/reports/phase0-weekend-gaps.md).

| # | Decision | Recommendation (short) | Needs your approval |
|---|---|---|---|
| D1 | OR-R1 multiplier double-count | `P_wrapped = feed`; multiplier only for display and as a guard input | Yes |
| D2 | `overnightMode` default | On, overnight buffer 0; closure = feed freeze (Fri 20:00 → Sun 20:00 ET) | Yes |
| D3 | Sequencer uptime (new OR-R6) | Pluggable uptime-feed slot (unset at launch) + keeper-side gap detection; ask Chainlink for a feed | Yes |
| D4 | Oracle pause flag + feed sanity | Guard trips on `oraclePaused()`, token `paused()`, a blocked wrapper, and on answers outside a sanity band (new OR-R7) | Yes |
| D5 | Morpho instant-drop constraint | Holds for weekends; **not guaranteed for earnings gaps**. Add scheduled-event buffers for single stocks | Yes |
| D6 | MetaMorpho v1.1 vs Vault V2 | Vault V2 (no v1 factory on this chain) | Yes |
| D7 | A1–A8 | Status table | Info |
| D8 | Product decisions Phase 0 can inform | DEX floor, caps, per-address caps, launch set | Yes (each) |
| D9 | Keep or drop the `StockWrapper` | Needs your call; leaning keep-with-changes | Yes |
| D10 | Required Phase 1 changes | List | Info; approve with D9 |

---

## D1 · OR-R1 multiplier double-counting (PRD issue 1)

**Context.** `04-oracle.md` §1 computes `P_wrapped = P_stock · m`, where `P_stock` is the Chainlink answer and
`m = wNVDA.multiplier()`.

**Verified facts.**
- The Robinhood Stock Token feeds compute "Token Price = Underlying Equity Market Price × Multiplier", reading
  `uiMultiplier()` from the token (Chainlink docs, [01 §4](01-chain-facts.md#4-chainlink)). Robinhood: "don't apply the
  multiplier yourself".
- Onchain data agrees: at each dividend multiplier change the feed/Yahoo ratio stepped up by about the multiplier
  (SPY, NVDA, AAPL; [01 §4](01-chain-facts.md#4-chainlink)).
- Robinhood pauses the oracle during corporate actions so "the token price [stays] continuous" (Chainlink docs).
- One `wNVDA` = one raw token (LM-R1, fork-tested).

**Why it matters more than it looks.** With the PRD formula, a 4:1 split multiplies `m` by 4 while the feed stays
continuous, so `P_eff` jumps ×4 and `price()` drops 75% in one block. That breaks Morpho's instant-drop assumption
(D5) and liquidates every borrower at once. The fork test `immediateUpdateIsAStep` shows the issuer can apply such a
step with no notice.

**Options.** (a) `P_wrapped = chainlink(STOCK/USD)`; the multiplier is used only for display (`underlyingEquivalent`)
and as a guard input. (b) Keep `P_stock · m` but divide the feed by `m` first. That is algebraically (a) plus two
extra reads and a race between the multiplier and the feed.

**Recommendation.** (a). Restate OR-R3: "A multiplier change does not change `price()`. A multiplier change without an
`oraclePaused()` window around it, or outside [0.1×, 10×], trips the guard." Apply the same fix to the receipt-oracle
formula and to DN-R4 ("after multiplier" → "feed price, already multiplier-adjusted").

**Affected.** OR-R1, OR-R3, 04 §1 (both formulas), OR-R22 (SDK `priceAt`), DN-R4. No Phase 1 code exists yet for
the oracle (task 5), so nothing to undo.

## D2 · 24/5 feeds and `overnightMode` (PRD issue 2, OR-R13)

**Verified facts** ([WS-C §1–2](../../sim/reports/phase0-weekend-gaps.md)).
- Rounds occur every weekday hour including 20:00–04:00 ET, and none from Friday evening to Sunday 20:00 ET.
- Overnight round-to-round jumps are ≤ 0.7% (deviation threshold 0.5%).
- Weekend freeze from the last Friday round to the first Sunday round: median 52–58 h, max 76–81 h. The last Friday
  round can come as early as 07:25 ET for SPY, because the feed is deviation-driven.
- US holidays: no rounds on 2026-07-03 (Independence Day observed). Labor Day (2026-09-07) had rounds only from
  20:00 ET, so holidays are frozen like weekends.
- The weekend buffer on the 48 h freeze window is smaller than on the PRD's 65.5 h (NVDA 6.5% vs 7.6% at σ 1y).

**Options.**
- (a) `overnightMode` on, overnight buffer 0. `MarketHours` models *feed sessions*: Sunday 20:00 → Friday 20:00 ET,
  minus holidays.
- (b) On, with a small overnight buffer (e.g. 25% of b_full) to cover thin overnight liquidity.
- (c) Off, as in the PRD: a full overnight buffer every weeknight. This over-collateralizes a feed that is live.

**Recommendation.** (a). Closure hours for `b_full` come from the feed-session calendar (≈ 48 h for a normal
weekend, 72 h for a 3-day weekend). Keep the ramp-in (4 h before the Friday 20:00 ET freeze), and keep ramp-out on the
first fresh round (OR-R20). Earnings are handled separately (D5).

**Affected.** OR-R10, OR-R11 (generator must emit feed sessions), OR-R13, OR-R20, OR-R23 test list, 10-risk launch
table (ramp-in rows).

## D3 · Sequencer uptime check (PRD issue 3, proposed OR-R6)

**Verified facts.** There is no Chainlink L2 Sequencer Uptime Feed for Robinhood Chain; Chainlink lists 11 networks
and not this one ([01 §1](01-chain-facts.md#1-network)). Robinhood's own docs still recommend checking one. Nitro
produces no L2 blocks while the sequencer is down, except force-included delayed-inbox transactions. The stock feeds
already go 20+ h without a round on quiet days, so the staleness guard cannot detect an outage quickly.

**Options.**
- (a) Drop OR-R6; rely on the 24 h staleness guard.
- (b) OR-R6 with an optional `sequencerUptimeFeed` constructor param. `address(0)` disables it; if set, the guard
  trips while the feed is down and for a 1 h grace after. Plus a keeper-side detector that trips the guard when
  consecutive L2 block timestamps jump by more than N minutes.
- (c) (b), and ask Chainlink (via Robinhood) to deploy the feed on 4663. Outreach is yours.

**Recommendation.** (c). `price()` still never reverts. Note what this does *not* do: an oracle cannot delay
liquidations after an outage, only the liquidity pull (new borrows) and app warnings. State this in the risk
disclosure.

**Affected.** New OR-R6, OR-R30–R32, 10-risk alerts table.

## D4 · Oracle pause flag and feed sanity (PRD issue 4; proposed OR-R7)

**Verified facts.**
- The flag is `oraclePaused()` **on the Stock Token**, not on the feed. It is set by `ORACLE_PAUSER_ROLE`; while set,
  Chainlink "stops publishing new prices and holds the last known good value". It is advisory and not enforced onchain
  ([01 §3.2, §4](01-chain-facts.md)).
- The token can also be paused per token or globally (`paused()`), which stops wrap and unwrap
  ([02](02-fork-validation.md)).
- **Launch incident:** for ~1.5 days after launch (to 2026-06-23 ~09:50 ET) every stock feed published answers scaled
  1e18 while `decimals()` = 8, i.e. prices 10¹⁰ too high ([WS-C §0](../../sim/reports/phase0-weekend-gaps.md)). A naive
  oracle would have made every Lendora borrower instantly liquidatable at an absurd price.

**Options for pause.** (a) Guard input only: trip when `oraclePaused()`, clear after unpause *and* a fresh round.
(b) Also freeze the buffer at its current value while paused.

**Recommendation.**
- (a), and trip the guard also when `stock.paused()` is true or the wrapper `isBlocked` in the registry. Either one
  means liquidators cannot exit to the Stock Token.
- Add **OR-R7 (sanity band):** an answer that differs from the last good answer by more than a per-stock bound (e.g.
  ×0.5–×2 for a single round), or whose implied price is outside [$0.01, $1e6], is ignored (last good answer kept) and
  trips the guard. `price()` never reverts.
- Earnings moves up to ~26% (D5) stay inside the band.

**Affected.** OR-R2, OR-R30–R32, new OR-R7, 10-risk alerts.

## D5 · Morpho instant-drop constraint (PRD issue 5)

**Verified facts.**
- Morpho: "The oracle price should not be able to change instantly such that the new price is less than the old price
  multiplied by LLTV*LIF" (`IMorpho.sol` @ `8e26ca6`, L115–117).
- LIF = min(1.15, 1/(1 − 0.3·(1 − LLTV))): at 77% LLTV·LIF = 0.82707, so **max instant drop 17.29%**; at 62.5% it is
  29.58% ([01 §2](01-chain-facts.md#2-morpho)).
- In a stock-loan market `price() = V_coll / P_eff`, so the stock going **up** is `price()` going **down**. A one-step
  rise of g in P_eff drops `price()` by g/(1+g); the constraint breaks at **g > 20.9%**.

**Checks.**

| Event | Step in P_eff | Inside 17.29%? |
|---|---|---|
| Weekend ramp-in (0 → b_full over 4 h) | ≤ b_full spread over many blocks | Yes |
| Buffer ramp-out at open | P_eff falls (price() rises) | Yes (increases are unrestricted) |
| Monday re-open with gap g after buffer b: P_eff goes from P(1+b) to P(1+g) | (1+g)/(1+b) − 1 | Breaks only if g > (1+b)/0.82707 − 1: NVDA (b 6.5%) g > 28.8%. **Max 10y weekend gap up: 7.5% (NVDA)**. Yes |
| Multiplier change (split) | With D1: 0. With the PRD formula: up to ×10 | Yes with D1; **no** without |
| OR-R3 bound 0.1×–10× | Irrelevant to price() after D1 | – |
| Single Chainlink round during an earnings move | One round can carry the whole after-hours jump | **Not guaranteed.** NVDA's largest 10y close→open gap was **+26.2% (2023-05-25)**; +17.3% (2016-11-11). With overnight buffer 0 (D2), a +26% round drops `price()` 21% > 17.29% |
| USDG/USD collateral price | 0.99963–1.00041 observed | Yes |
| Launch-style 1e18 answer | ×10¹⁰ | **No**, unless D4's sanity band ignores it |

**Plainly:** weekend and Monday gaps fit easily. A single-stock earnings gap can exceed Morpho's assumption at 77%
LLTV, and the consequence is bad debt, because positions jump past the liquidation incentive.

**Options.**
- (a) Scheduled-event buffer: `MarketHours` also stores event windows (earnings dates), and the oracle ramps a
  buffer in before them exactly like a weekend.
- (b) LLTV 62.5% for single stocks (29.6% tolerance); keep 77% for SPY.
- (c) Guard pulls liquidity before earnings (stops new borrows only).
- (d) Accept, sized by caps and the Phase 5 backstop.

**Recommendation.** (a) + (c) for NVDA and AAPL, with 77% LLTV kept. Revisit (b) if the sim shows event buffers can't
cover the tail. SPY needs neither.

**Affected.** OR-R10–R12 (event windows), OR-R20, OR-R23, 04 §3, 10-risk LLTV row.

**Worked example (`00-overview.md`) rechecked with verified numbers.** Priya: $1,500 USDG, 10 NVDA at $100, LTV
66.7%, LLTV 77% (enabled onchain). Liquidation above 1,500·0.77/10 = **$115.50**: correct. Incentive 7.41%:
correct. With the weekend buffer, the liquidation *feed* price falls to 115.50/(1+b): **$108.45** at b 6.5%
(σ 1y, 48 h) or $107.35 at b 7.6% (σ 1y, 65.5 h). "Keeps about $100" (before interest): correct.

## D6 · MetaMorpho v1.1 vs Morpho Vault V2 (A6)

**Verified facts.**
- No MetaMorpho v1.x factory is listed or deployed on Robinhood Chain.
- Vault V2 factory `0x0FBa…803c` is live with 70 vaults, plus `MorphoMarketV1AdapterV2Factory` and a public allocator
  ([01 §2](01-chain-facts.md#2-morpho)).
- MetaMorpho v1.1 still works if we deploy its factory ourselves (fork test `idleMarketAndMetaMorphoV11`).
- Vault V2 (Morpho docs, opened 2026-09-26):
  - "the main vault contract … holds the idle assets"; allocation goes through adapters (`MorphoMarketV1AdapterV2`).
  - The Allocator calls `allocate`/`deallocate` and sets a `liquidityAdapter`.
  - The Curator sets absolute and relative caps per id.
  - "All potentially harmful curator actions are protected by configurable timelocks (0 to 3 weeks)".
  - A Sentinel "can reactively reduce risk by deallocating assets, decreasing caps".
  - Gates can restrict who deposits, withdraws or transfers shares.
  - Users can `forceDeallocate` with a penalty "up to 2%".

**What V2 changes for Lendora.**
- *Idle market (LM-R21, A5):* not needed. The idle reserve is the vault's own unallocated balance.
- *Allocator keeper (LM-R30–R34):* same logic. It calls `deallocate` from the stock-market adapter instead of
  `reallocate` into an idle market. Guard trip = deallocate all free liquidity (LM-R31). The Sentinel maps to our
  Guardian (LM-R32).
- *Caps:* relative caps give the utilization cap natively (e.g. ≤ 90% of vault assets allocated).
- *`forceDeallocate`:* any lender can pull liquidity out of the market to exit. That only reduces borrowable
  liquidity, never harms borrowers.
- *Gates:* could enforce geo-attestation on deposits if counsel requires it (06 C1).

**Options.**
- (a) Self-deploy MetaMorpho v1.1 (unmodified, pinned `3b17547`). No code risk, but it is not an official Morpho
  deployment on this chain, so Morpho's app and indexers may not list it.
- (b) Vault V2 via the official factory. The PRD's "or current" already allows it.

**Recommendation.** (b). Deploy scripts (task 7) and the allocator (task 9) are not written yet, so switching now
costs only: a new submodule (`morpho-org/vault-v2` at the deployed commit), rewriting LM-R20–R22 and LM-R30–R34, and
dropping the idle-market requirement. The existing MetaMorpho smoke test stays as history or is removed.

**Affected.** LM-R20, LM-R21, LM-R22, LM-R30–R34, 02 contracts table and roles, 03 §3–4, A5 (becomes moot).

## D7 · Phase 1 assumptions A1–A8

| # | Status | Evidence | Consequence |
|---|---|---|---|
| A1 | **Resolved: holds.** `uiMultiplier()` is effective at `effectiveAt` without a poke | Source + fork test | None |
| A2 | **Resolved: holds.** 18 dp, non-rebasing, no fee on transfer | Source + fork test | None, but see D10 on `adminBurn` |
| A3 | **Changed.** No allowlist, but an issuer blocklist, token/global pause and `adminBurn` | Source, events, fork tests | D9, D10 |
| A4 | **Resolved: holds.** Cancun opcodes run on Nitro | `eth_call` + fork test | None |
| A5 | **Resolved: holds** (irm 0, lltv 0 enabled). Moot if D6 = Vault V2 | Events block 286 | – |
| A6 | **Open → D6** | – | Decide before task 7 |
| A7 | **Resolved: holds.** 6 dp, EIP-2612 `permit` | Fork test | Router can use permit |
| A8 | **Partly resolved.** Uniswap v3/v4 are callable onchain and hold the main liquidity; aggregator contract-caller support unverified | [01 §6](01-chain-facts.md#6-dexs-and-aggregators-a8-rt-r3-or-r31) | Router allowlist starts with Uniswap UniversalRouter; test aggregators with API keys |

## D8 · Product decisions Phase 0 can inform

| Question (12-open-questions) | Phase 0 data | Recommendation |
|---|---|---|
| **DEX floor** on the oracle | See [WS-C §5, §7](../../sim/reports/phase0-weekend-gaps.md) and the note below | Keep **off** (see note) |
| **Overnight buffer** when Chainlink is 24/5 | D2 | Zero overnight (`overnightMode` on) |
| **Per-address caps** vs whales | 2% depth on a Saturday: NVDA ≈ $1.26M (USDG+WETH, buy side), SPY ≈ $314k, AAPL ≈ $146k. Lighter SPY perp OI ≈ $51M | Cap a single position at what the market can absorb in one liquidation: ≈ 25% of 2% depth. At launch: NVDA $250k, SPY $75k, AAPL $35k per address, raised with an allowlist for known market makers that post more collateral |
| **Launch caps** (10-risk: SPY $2M, AAPL $1M, NVDA $1M) | Same depth numbers | NVDA $1M ok; SPY $1M; **AAPL $250k** until depth improves. Re-measure depth on a weekday (BLOCKED on archive RPC) |
| **Launch set** | Only 33 of 195 Stock Tokens have Chainlink feeds; SPY, NVDA, AAPL do; empty competing markets exist for all three | Keep SPY/NVDA/AAPL |
| Fees in USDG vs stock | No Phase 0 data | Unchanged |
| Attestation provider | Sequencer-level sanctions screening already exists (01 §1) | Still needed for geo (06 C3) |

**DEX floor note (WS-C §5, §7).**
- The largest weekend premium sampled (hourly, DEX vs frozen feed) is 2.46% (NVDA); SPY 1.22%, AAPL 1.70%. No weekend
  exceeded 3%. **The litepaper's "~12%" is not observed on Robinhood Chain** for these stocks.
- Break-even premiums for a liquidator buying on the DEX are 8–16% (b + 7.41% incentive, minus slippage), so no
  sampled weekend hour was above break-even.
- A floor would add a manipulation surface: a thin pool could push `price()` down, which must stay inside D5's 17.29%
  per-step bound.
- Keep the floor **off**. Update the litepaper and 00-overview's "Premiums of about 12% have been documented" to
  cite a source or drop the number (needs your approval; it is marketing copy, not a fact we verified).

**Borrow-demand note (WS-C §8).** Weekend premium arbitrage alone is small: NVDA ≈ $130k shortable notional per
weekend on average, a few thousand USD of interest a year. The case rests on hedging demand from perp makers (Lighter
SPY perp open interest ≈ $51M) and lenders' yield, which the interviews must confirm.

**Collateral note (CL-R1).** 54 Morpho Vault V2 USDG vaults exist, the largest "Steakhouse USDG" (~512M USDG,
ERC-4626). It is a better `clUSDG` v1.1 backing candidate than syrupUSDG, which is not ERC-4626 on this chain. Its
share price can fall on realized bad debt, so the oracle must read a manipulation-resistant rate, per CL-R1's
existing caveat.

## D9 · Keep or drop the `StockWrapper`

**Verified facts.**
- Stock Tokens are non-rebasing with static balances (A2), and 19 Morpho markets already use raw Stock Tokens as the
  loan asset.
- The wrapper was meant to isolate Morpho from multiplier-driven balance changes and allowlists (03 §1). Neither
  exists.
- The wrapper creates a **single address** the issuer can block, pause around or `adminBurn`, affecting only
  Lendora (fork tests). Without it, the choke point would be Morpho Blue itself, which holds Stock Tokens for all 189
  markets that use them (19 as loan asset, 170 as collateral).

**Options.**
- (a) **Keep** the wrapper (LM-R1…R7 as built), with the D10 restatements. Lendora-specific freeze risk is
  explicit and bounded to Lendora.
- (b) **Drop** it: loan token = raw Stock Token; vault asset = raw token; router and liquidator simplify (no
  wrap/unwrap). An issuer action would have to target Morpho as a whole, but any `adminBurn` on Morpho's balance would
  still hit whichever markets withdraw last.
- (c) Keep it, but make the vault and router support both, and decide per stock at listing.

**Recommendation.** Your call; it changes Phase 1 task 3, which is already built and tested. I lean to (a): it keeps
our markets insulated from other Morpho markets' raw-token risks, and a wrapper freeze is visible and attributable.
The case for (b) is fewer contracts and audits plus the ecosystem precedent. It should be decided together with the
issuer conversation (06 B2, B6).

## D10 · Required Phase 1 changes (code already written that verified facts invalidate)

Not fixed in this session, per the brief.

| # | Requirement | What the facts break | Proposed change |
|---|---|---|---|
| R1 | **LM-R7** "`underlying.balanceOf(wrapper) >= totalSupply` at all times" | `adminBurn(wrapper, x)` burns backing with no pause or blocklist check; the invariant then fails and the last unwrappers revert (fork test `adminBurnFromWrapper_breaksLMR7`) | Restate: "holds absent issuer `adminBurn`". Add a view `backingShortfall()` for monitoring, and a P0 alert when it is non-zero. The invariant test stays (mocks have no `adminBurn`); add a mock `adminBurn` test documenting the failure mode |
| R2 | **LM-R5** "Anyone can unwrap at any time" | Token pause (per token or global) and blocklisting of the wrapper or recipient make `unwrap` revert (fork tests) | Restate: "anyone can unwrap whenever the Stock Token allows transfers". Guard trips when the token is paused or the wrapper is blocked (D4) |
| R3 | **LM-R6** + `IHolderAllowlist` | No allowlist exists; the token already reverts `Blocked(recipient)` | No code change; deploy with `address(0)`. Optionally add an adapter that returns `!registry.isBlocked(to)` for a pre-check with our own error |
| R4 | `IScaledUIAmount` | Declares `UIMultiplierUpdateCancelled`, which the live token lacks | Cosmetic; comment added in WS-A |
| R5 | `MockStockToken` | Lacks `oraclePaused()`, `paused()`, `adminBurn`, blocklist; the guard work in task 5 needs them | Extend the mock (test-only) before task 5 |
| R6 | `metamorpho-v1.1` submodule + smoke test | If D6 = Vault V2 | Add `vault-v2` submodule, keep or remove the v1.1 smoke test |
| R7 | `StockWrapper` as a whole | If D9 = drop | Retire LM-R1…R7 and task 3 code |
