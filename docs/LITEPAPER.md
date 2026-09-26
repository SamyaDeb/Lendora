# Stockline litepaper

**The stock lending layer for Robinhood Chain**

*Draft v0.1, September 2026. Working name. Not investment or legal advice.*

---

## Abstract

Robinhood Chain brought 190+ tokenized US stocks and ETFs onchain. Today they do one thing: sit in wallets. Holders earn nothing, traders can't short, and on weekends nothing ties token prices to the real market.

Stockline is a lending layer for Stock Tokens, built on Morpho Blue. Holders lend their stocks and earn fees. Traders borrow stocks to short, hedge and arbitrage. Stablecoin holders earn price-neutral yield through a delta-neutral vault. And because every borrow is onchain, Stockline publishes the first real-time short-interest data for tokenized equities.

## 1. The problem

**Stock Tokens are one-directional.** You can buy them and hold them. Existing lending markets let you borrow dollars *against* them, but nowhere on Robinhood Chain can you borrow the stocks themselves. That means:

- **Idle holdings.** Fewer than 1 in 20 holders transact monthly. Their tokens earn nothing.
- **No shorting.** When a token trades above its real stock, only optimists can act. Research has shown since Miller (1977) that when short selling is constrained, prices drift above fair value.
- **Broken weekends.** Stock Token minting and burning pauses from Saturday to Monday, and price oracles freeze at Friday's close. Off-hours token prices drift from the frozen reference (up to 2.5% on sampled weekends for SPY, NVDA and AAPL), and thin off-hours liquidity has triggered liquidation cascades on perp venues.
- **A missing yield layer.** Hundreds of millions in stablecoins sit on the chain with few places to earn beyond basic lending.

In traditional markets, stock lending is a core part of market plumbing: it pays holders, enables shorts and hedges, and keeps prices honest. Robinhood Chain doesn't have it yet.

## 2. The solution

Stockline adds four pieces.

### 2.1 Stock lending markets
For each listed stock there's a Morpho market where **the stock is the loan asset**.
- **Lenders** deposit NVDA, AAPL, SPY and others, receive a yield-bearing receipt (rNVDA), and earn the interest traders pay.
- **Borrowers** post collateral and borrow the stock to short, hedge perp inventory, or arbitrage mispricings.

### 2.2 Collateral that earns
Lenders don't have to choose between yield and liquidity. Their receipt tokens can be posted as collateral to borrow USDG. On the other side, traders can post yield-bearing USDG vault shares, so their collateral earns while they borrow. That's the onchain version of the "short rebate" in TradFi stock lending.

### 2.3 The delta-neutral vault
For stablecoin holders who don't want stock risk:
1. Deposit USDG.
2. The vault buys Stock Tokens and lends most of them through Stockline.
3. It shorts the same amount on perps, so price moves cancel out.
4. Depositors earn **lending fees plus funding rates**, paid in USDG.

The vault is also Stockline's biggest natural lender, which solves the supply side of the market.

### 2.4 Live short interest
Every borrow is public. Stockline publishes per-stock supply, borrowed amount, utilization and borrow rate in real time, both onchain and through an API. In TradFi, short interest is reported twice a month with a delay. Research such as Boehmer, Jones & Zhang (2008) shows it predicts returns. Traders, perp venues and AI agents can all use it.

## 3. How it works

```
USDG holders ──► Delta-neutral vault ──► buys stocks ──┐
                        │                              ▼
                        └── shorts perp        Stock lending market (Morpho)
Stock holders ──► deposit stocks ──────────────────────►│
      │                                                 ▼
      └─► borrow USDG against receipts        Traders borrow stocks
                                               (short · hedge · arbitrage)
                                                        │
                           fees ◄───────────────────────┘
          (lenders · vault depositors · backstop · treasury)
```

**Example.** Rahul lends 10 NVDA at $100. Priya posts $1,500 USDG, borrows the 10 NVDA and sells them. If NVDA falls to $90, she buys back for $900, returns the tokens with a fee, and keeps the difference. If NVDA spikes, she's liquidated before her collateral runs out, and Rahul gets his NVDA back either way, plus fees.

## 4. Safety design

- **Built on Morpho Blue.** Custody, debt accounting, interest and liquidations run on audited, battle-tested contracts with existing liquidator networks.
- **Weekend-mode oracle.** Prices come from Chainlink, adjusted for corporate actions via each token's ERC-8056 multiplier. When US markets are closed, a volatility-scaled safety buffer requires borrowers to hold more collateral.
- **Utilization caps.** Pools are never 100% lent, so withdrawals, liquidations and vault rebalancing keep working.
- **Staleness and deviation guards.** New borrowing pauses if oracle and market prices diverge.
- **Backstop pool.** Stakers provide first-loss capital that covers rare bad debt, in exchange for a share of fees.
- **Guarded launch.** Small supply caps, conservative parameters tuned by simulation, and independent audits before mainnet.

## 5. Economics

Borrowers pay interest set by Morpho's utilization-based rate model: the more of a pool is borrowed, the higher the rate. Initial split (subject to tuning):

| Recipient | Share |
|---|---|
| Lenders (stock holders and the vault) | ~90% |
| Backstop stakers | ~5% |
| Protocol treasury | ~5% |

All fees are in USDG. Stockline launches **without a token**. Usage-based points may follow. A governance token, deciding listed stocks and risk parameters and staked as first-loss capital, would come only once the protocol generates real revenue, and subject to legal review.

## 6. Why Robinhood Chain

- **Two-way markets:** more volume and tighter pricing for Stock Tokens.
- **A new yield source:** stock lending fees, not emissions.
- **Idle stablecoins put to work** in Stock Tokens.
- **Complements the ecosystem:** built on Morpho, priced by Chainlink, and gives Lighter and Arcus makers an onchain hedge.
- **Timely:** with US regulators opening a path for onchain trading of tokenized stocks, the market structure these assets need (lending, shorting, reliable pricing) matters more every month.

## 7. Roadmap

| Phase | Focus |
|---|---|
| 0 | Validation: token transfers into Morpho, weekend price gaps, borrower interviews |
| 1 | Lending core: SPY, NVDA, AAPL markets, wrapper, oracle adapter, router |
| 2 | App and short-interest dashboard/API, testnet launch |
| 3 | Audit, then guarded mainnet with caps |
| 4 | Delta-neutral vault, after simulation |
| 5 | Backstop pool, then governance token once there's revenue |
| Later | Own vault shares as collateral, self-repaying loans, more stocks, SDKs for wallets and AI agents |

## 8. Risks

Stockline involves smart contract, oracle, liquidation, short-squeeze, perp-venue and regulatory risks. Borrow demand and lender yields are not guaranteed; fees on widely held stocks are typically low. Stock Tokens are not available in the US, Canada, UK, Switzerland or UAE, and Stockline will restrict access accordingly. Nothing here is an offer of securities or investment advice.

## References

See `RESEARCH.md`. Key works: Miller (1977); D'Avolio (2002); Saffi & Sigurdsson (2011); Boehmer, Jones & Zhang (2008); Cong et al. (2025); Gudgeon et al. (2020); Qin et al. (2021); Perez et al. (2021); Werner et al. (2022); IMF (2026).
