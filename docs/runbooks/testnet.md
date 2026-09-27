# Testnet runbook (Phase 2)

Robinhood Chain testnet (chain id 46630). Everything here uses **test assets with no value**. Phase 2 exit needs
2 clean testnet weekends and 20 external testers (docs/prd/11-milestones.md).

## 1. For testers

**What you need.** A browser wallet (MetaMask, Rabby, Coinbase Wallet) or a WalletConnect wallet, on Robinhood Chain
testnet:

| | |
|---|---|
| Network name | Robinhood Chain Testnet |
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Chain id | 46630 |
| Explorer | `https://explorer.testnet.chain.robinhood.com` |
| App | `<APP_URL>` (set at launch) |

**Getting funds.**

1. Testnet ETH for gas: `faucet.testnet.chain.robinhood.com`, or the QuickNode / Chainlink testnet faucets.
2. Test Stock Tokens and USDG: the Stockline faucet (`mocks.faucet` in `packages/sdk/addresses.json["46630"]`). Call
   `claim(yourAddress)` from the app's faucet button or the explorer: 10 SPY, 10 NVDA, 10 AAPL and 50,000 USDG, once
   per address per 24 hours.

Test Stock Tokens follow real prices: a keeper copies the real Chainlink rounds from mainnet, so prices move 24/5 and
freeze from Friday 20:00 ET to Sunday 20:00 ET, like the real feeds.

**Flows to try** (tick each one in the feedback form):

| # | Flow | Where |
|---|---|---|
| 1 | Lend a stock; see the variable APY and your `rSTOCK` balance | `/lend/NVDA` |
| 2 | Withdraw part of your lend | `/lend/NVDA` → Withdraw |
| 3 | Open a short: USDG collateral, borrow and sell NVDA; read the preview first (health factor now, at the next close, if the price rises 10%) | `/short/NVDA` |
| 4 | Just borrow AAPL (no sale) | `/short/AAPL` → Just borrow |
| 5 | Add collateral to a borrow | `/portfolio` |
| 6 | Repay a borrow with the stock | `/portfolio` → Repay |
| 7 | Close a short (buy back with USDG) | `/portfolio` → Close |
| 8 | Withdraw collateral after repaying | `/portfolio` |
| 9 | Set alerts (health factor, weekend warning) | `/alerts` |
| 10 | Look at the short-interest dashboard and the API | `/short-interest`, `<API_URL>/v1/openapi.json` |
| 11 | Hold a borrow over a weekend and watch the buffer ramp in on Friday afternoon (ET) | `/portfolio` |

**Reporting bugs.** Use the feedback form: `<FEEDBACK_FORM_URL>` (placeholder, owner to create). Include: what you
did, what you expected, what happened, the transaction hash (from your wallet or the app's step list), your browser
and wallet, and a screenshot. Never share your seed phrase or private key; nobody from Stockline will ask for it.

## 2. For operators

**Services** (infra/README.md): indexer (+ daily reconcile), API, compliance, web, keepers (allocator, guard,
liquidator, alerts, feed-mirror). Health: `/ready` (indexer), `/health` (others). Keepers run with
`DRY_RUN=false KEEPER_SIGNER=env-key` on testnet only after the go; keys come from the secret store.

**Deploy** (after the owner's go; the script refuses without `TESTNET_GO=yes`):

```sh
cd contracts
TESTNET_GO=yes STOCKLINE_ATTESTATION_SIGNER=<compliance signer address> \
  forge script script/DeployTestnet.s.sol --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast --slow \
  --private-key $TESTNET_DEPLOYER_KEY
# then: commit packages/sdk/addresses.json["46630"], verify contracts on the explorer, start the services,
TESTNET_GO=yes SMOKE_KEY=$TESTNET_DEPLOYER_KEY PROXY_SECRET=$PROXY_SECRET pnpm --filter @stockline/devnet drive smoke \
  --rpc $ROBINHOOD_TESTNET_RPC_URL --compliance <COMPLIANCE_URL>
```

**Compliance secret (CP-R8).** The compliance service refuses to start on 46630 without `PROXY_SECRET` (≥ 32 chars,
`openssl rand -hex 32`), and trusts geo/IP headers only from requests carrying it. Set the same value on web, with
`GEO_PLATFORM=vercel|cloudflare` for the edge in front of it. The smoke run above talks to compliance directly and
therefore needs the secret in its environment (it sends `x-geo-country: DE` as the operator's declared location).
Check after deploy: a request to `<COMPLIANCE_URL>/v1/compliance/attest` with `cf-ipcountry: DE` and no secret must
answer `403 GEO_UNKNOWN`.

Timelocks are 24h on testnet (02 roles): parameter changes, including the attestation signer, take a day.

## 3. Weekend watch (each of the 2 clean weekends)

A weekend is **clean** when every box below is ticked and no P0/P1 alert fired (docs/prd/10 §Monitoring).
The monitor records it: `curl $MONITOR_URL/weekends` shows each closure's milestones per market and a `clean`
verdict; attach that JSON to the weekend's log entry. Open incidents: `curl $MONITOR_URL/incidents`.

**Friday (before 16:00 ET)**

- [ ] Feed mirror healthy (`/health` 200); testnet feed rounds match mainnet within one round.
- [ ] `/v1/status`: every market `open`, no guard reason, indexer lag ≤ 20 blocks.
- [ ] Allocator healthy; each vault's idle ≈ 10% (U_MAX).
- [ ] At least one open borrow per market (a team wallet if testers have none) to observe the ramp.

**Friday 16:00–20:00 ET (ramp-in)**

- [ ] Status `ramping`; `bufferWad` rises linearly (API history 1m) to b_full (SPY ≈ 3.1%, NVDA ≈ 9.6%, AAPL ≈ 5.2%).
- [ ] Alerts: `ramp_24h` (Thursday) and `ramp_4h` (Friday 12:00 ET) delivered to test wallets whose HF at full buffer < 1.2.
- [ ] No liquidation caused by the ramp alone for positions opened with HF at t+24h ≥ 1.10 (RT-R1).

**Saturday–Sunday (frozen)**

- [ ] No feed rounds; status `closed`; buffer held at b_full.
- [ ] Guard keeper: no spurious DEVIATION trips (mock DEX follows the mirrored price).
- [ ] L2 block production normal (no `L2_GAP`).

**Sunday 20:00 ET (reopen)**

- [ ] The first fresh round releases the buffer (OR-R20 ramp-out on the first round, not on the clock).
- [ ] Liquidations, if any, succeed (fallback liquidator or anyone); no bad debt (`Liquidate.badDebtAssets = 0`).
- [ ] Reconciliation (SI-R5) the next morning: 0 diffs.

**Record** in `docs/runbooks/testnet-weekends.md`: date, buffer curve per market (API history link), alerts sent,
guard events, liquidations, reconciliation result, anything unexpected.
