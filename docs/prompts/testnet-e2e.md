# Prompt: test the whole product on testnet, end to end (what can be tested today)

Paste everything below the line into a Claude Code session in this repo (with Claude in Chrome, or the built-in browser,
for part 3). The stack must be up: `scripts/dev-testnet.sh --network 46630` (web :3000, API :42070, compliance :42071,
monitor :42073, all keepers live).

---

Test the Stockline / Lendora product end to end on Robinhood Chain testnet (46630) against the local testnet stack, and
report every result honestly: pass, fail (with the tx hash or the error), or skipped with the reason. Do not deploy,
change contracts, change roles or caps, touch mainnet (4663), or read any key file; the tester key comes only from my
environment as `SMOKE_KEY`. Everything here uses test assets.

**1. Pre-checks (no transactions).**
- `df -h /` has > 5 GB free; `curl -s localhost:42070/v1/status` shows chain 46630 and a lag under 60 blocks; every keeper
  `/health` on :8787–:8796 and :42072/:42073 is healthy.
- Note whether the feed session is open now (US market hours, Mon–Fri): entries (lend/borrow/short/vault deposit)
  refuse by design while it is closed, so run part 2 with flows during the session.

**2. Automated suite.** Run, and paste the summary table:
```sh
pnpm --filter @stockline/web exec tsx scripts/testnetE2E.ts --web http://127.0.0.1:3000 --api http://127.0.0.1:42070 \
  --compliance http://127.0.0.1:42071 --monitor http://127.0.0.1:42073 --rpc https://rpc.testnet.chain.robinhood.com \
  --report ../docs/runbooks/testnet-e2e.md                                 # A + B: surface and simulated edge cases
SMOKE_KEY=$SMOKE_KEY TESTNET_GO=yes pnpm --filter @stockline/web exec tsx scripts/testnetE2E.ts \
  --web http://127.0.0.1:3000 --api http://127.0.0.1:42070 --compliance http://127.0.0.1:42071 \
  --monitor http://127.0.0.1:42073 --rpc https://rpc.testnet.chain.robinhood.com --flows \
  --report ../docs/runbooks/testnet-e2e.md                                 # + C: real flows and attested edge cases
```
The tester wallet needs testnet ETH (faucet.testnet.chain.robinhood.com) and, after the suite's faucet claim, ≥ 100
USDG and some NVDA. Compliance rate-limits attestations: if you see `429`, wait a few minutes and re-run.

**3. Browser pass on http://127.0.0.1:3000** (wallet on Robinhood Chain Testnet, chain id 46630, RPC
`https://rpc.testnet.chain.robinhood.com`; use a fresh test wallet funded with testnet ETH). For each row do the action,
then check the expected result on the page **and** in the API; record pass/fail with the tx hash.

| # | Action | Expected |
|---|---|---|
| 1 | Connect the wallet; open `/markets` | 3 markets (SPY, NVDA, AAPL), variable rates, prices near the real ones |
| 2 | Faucet button | 10 SPY, 10 NVDA, 10 AAPL, 50,000 USDG; a second claim within 24h is refused with a clear message |
| 3 | `/terms`: sign the terms | plain-text message saying no funds move; accepted |
| 4 | `/stock/NVDA?tab=lend`: lend 2 NVDA | preview first; rSTOCK balance appears; `/v1/positions/<you>` shows it |
| 5 | Withdraw 1 NVDA of the lend | stock back in the wallet; lend balance halves |
| 6 | `/stock/NVDA?tab=short`: open a short (e.g. 2,000 USDG collateral, 0.5 NVDA) | preview shows health factor now, at the next close and at +10%; tx succeeds; position in `/portfolio` |
| 7 | Try a short that is too big for the collateral | the app blocks it (or the wallet simulation shows a clear "health too low" error); nothing is sent |
| 8 | Set slippage to a tiny value / change the amount between preview and submit | clear slippage error, no funds lost |
| 9 | `/portfolio`: add collateral to the short | health factor rises |
| 10 | Add collateral to a market where you have **no** debt | refused with a clear message (rescue top-up is only for open debt) |
| 11 | Repay part of the debt | debt falls |
| 12 | Close the short | debt 0, collateral back as USDG, leftovers refunded |
| 13 | `/stock/AAPL?tab=short` → Just borrow 0.5 AAPL; repay all; withdraw collateral | position gone, USDG back |
| 14 | `/alerts`: set a health-factor alert | saved after a signed message |
| 15 | `/data`: short-interest leaderboard, charts, protocol revenue | numbers load; `/v1/protocol/revenue` matches |
| 16 | `/vault` (USDG Earn): deposit 100 USDG | approve → terms → compliance → deposit; shares at the share price; rates labelled variable and historical only |
| 17 | Instant withdrawal of 10 USDG | USDG back at once; no attestation asked |
| 18 | Withdraw more than the instant capacity | part now, the rest queued with a settlement date (≤ 72h or next US open) |
| 19 | Claim before settlement | not possible (button disabled or clear error) |
| 20 | After settlement (the rebalancer settles it) claim from `/portfolio` | USDG received; the request shows claimed |
| 21 | Open every page on a 390 px wide window | no horizontal scroll; bottom sheet works |
| 22 | Reload in the middle of a multi-step flow (e.g. after approve) | the app resumes at the right step; no double spend |
| 23 | Reject a wallet prompt | clear "cancelled" state; nothing broken |
| 24 | Switch the wallet to another chain | the app asks to switch back; no tx is sent on the wrong chain |

Geo-block: the local stack runs `GEO_PLATFORM=static GEO_STATIC_COUNTRY=DE`, so the block page can't be triggered with a
header here. To test it, restart the stack with `GEO_STATIC_COUNTRY=US` and check that `/markets` and entries show "not
available in your region" while `/portfolio` still lets you exit.

**4. Watch over time** (no action needed, just record):
- The queued withdrawal of row 18 settles by its date; the monitor pages `DN_QUEUE_OVERDUE` if not.
- Weekend: from Fri 16:00 ET the borrow buffer ramps in, the feed freezes Fri 20:00 ET → Sun 20:00 ET, vault mints and
  instant withdrawals pause (requests still accepted), and `curl localhost:42073/weekends` records each milestone.
- Live drills pass 2 after 2026-09-30 12:03 UTC: `TESTNET_GO=yes TESTNET_DEPLOYER_KEY=… DRILL_RAN_BY="<name>"
  pnpm --filter @stockline/devnet drive live-drills --rpc https://rpc.testnet.chain.robinhood.com`.

**5. Out of scope on testnet** (covered on anvil and forks; say so, don't try to force them): liquidations, guard trips
from feed deviations or a stale feed, issuer pause/blocklist, a > 2× re-anchor, bad debt, wrapper/USDG shortfall, vault
margin calls after a big move, the funding kill switch, a venue halt.

**Report**: a table per part (pass / fail / skipped + evidence), every bug with steps to reproduce, the expected and actual
result and a tx hash, and a one-line verdict.
