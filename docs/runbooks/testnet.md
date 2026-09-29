# Testnet runbook (Phases 2–4)

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
| 0 | Open the app, pick a market from the list | `/markets` |
| 1 | Get test funds with the faucet button (once per 24h) | header → Faucet |
| 2 | Lend a stock; see the variable APY and your `rSTOCK` balance | `/stock/NVDA?tab=lend` |
| 3 | Withdraw part of your lend | `/stock/NVDA?tab=lend` → Withdraw |
| 4 | Open a short: USDG collateral, borrow and sell NVDA; read the preview first (health factor now, at the next close, if the price rises 10%) | `/stock/NVDA?tab=short` |
| 5 | Just borrow AAPL (no sale) | `/stock/AAPL?tab=short` → Just borrow |
| 6 | Add collateral to a borrow (the rescue top-up) | `/portfolio` |
| 7 | Repay a borrow with the stock | `/portfolio` → Repay |
| 8 | Close a short (buy back with USDG) | `/portfolio` → Close |
| 9 | Withdraw collateral after repaying | `/portfolio` |
| 10 | Set alerts (health factor, weekend warning) | `/alerts` |
| 11 | Look at the short-interest data, protocol revenue and the API | `/data`, `<API_URL>/v1/openapi.json` |
| 12 | Hold a borrow over a weekend and watch the buffer ramp in on Friday afternoon (ET) | `/portfolio` |
| 13 | Lender yield net of the 10% performance fee, in stock and USD (once the fee is on) | `/stock/NVDA?tab=lend`, `/data` |
| 14 | USDG Earn (Phase 4): read the page; while its cap is 0 (the default on testnet) deposits are refused and the page says so | `/vault` |
| 15 | USDG Earn flows, **only if the owner opens a testnet cap**: deposit, instant withdrawal, queued withdrawal (settles within 72h or the next US open), claim | `/vault`, `/portfolio` |

**Reporting bugs.** Use the feedback form: `<FEEDBACK_FORM_URL>` (placeholder, owner to create). Include: what you
did, what you expected, what happened, the transaction hash (from your wallet or the app's step list), your browser
and wallet, and a screenshot. Never share your seed phrase or private key; nobody from Stockline will ask for it.

## 2. For operators

**Services** (infra/README.md): **monitor first** (before any governance action, MON-R16), indexer (+ daily
reconcile), API, compliance, web (`NEXT_PUBLIC_FEATURE_*` as agreed; the vault page reads the API once `dnVault` is in
the book), keepers (allocator, guard, liquidator, fee converter, feed-mirror, dn-rebalancer, nav-reporter, nav-cosigner
on its own host, alerts). Health: `/ready` (indexer), `/health` (others). Keepers run with
`DRY_RUN=false KEEPER_SIGNER=env-key` on testnet only after the go; keys come from the secret store.

**Deployed 2026-09-28** (owner's go): 349 transactions, 0 failed, deployer `0x3394d7Be60302c9649c6E5A3c7fC7b989f521348`,
addresses in `packages/sdk/addresses.json["46630"]` (router owner = 24h timelock, attestation signer = the compliance
key). Smoke flows on testnet: 13/13 actions confirmed (lend, allocate, openShort, rescue addCollateral, repay,
closeShort, borrow, repay all, withdrawCollateral, withdrawLend). Deployer balance after: ~0.0084 ETH.
Lessons: pass `--gas-estimate-multiplier 200` (the L1 data fee counts inside the gas limit; the default 130% ran a
seed transaction out of gas), keep > 1 GB free disk for forge's broadcast journal (`--resume` continues from it), and
use a dedicated RPC (Alchemy/QuickNode) for services — the public endpoint is not archive.

**Deploy** (after the owner's go; the script refuses without `TESTNET_GO=yes`):

```sh
cd contracts
TESTNET_GO=yes STOCKLINE_ATTESTATION_SIGNER=<compliance signer address> \
  forge script script/DeployTestnet.s.sol --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast --slow \
  --gas-estimate-multiplier 200 --private-key $TESTNET_DEPLOYER_KEY
# then: commit packages/sdk/addresses.json["46630"], verify contracts on the explorer, start the services,
TESTNET_GO=yes SMOKE_KEY=$TESTNET_DEPLOYER_KEY PROXY_SECRET=$PROXY_SECRET pnpm --filter @stockline/devnet drive smoke \
  --rpc $ROBINHOOD_TESTNET_RPC_URL --compliance <COMPLIANCE_URL>
```

**Deployed 2026-09-29** (owner's "go testnet"): `DeployTestnetFees` (`FeeSplitter` `0xc9ED…3674`, treasury and
backstop converters) and `DeployTestnetVault` with the owner's testnet cap `STOCKLINE_DN_TESTNET_CAP_USDG=1000000`
(A49: 1,000,000 test USDG total and per sleeve; mainnet stays 0, MN-R7): vault `0xcDFa…3118`, strategy `0x2a79…C28c`,
NAV oracle `0xE189…8863` (signers: the deployer and a testnet-only co-signer `0x8552…89BE`), mock venue `0x6dBF…9898`
(gated). Deployer ETH 0.00839 → 0.00820. Addresses in `packages/sdk/addresses.json["46630"]`. The venue mirror
(`keepers/src/venueMirror`, A49) applies **Lighter's real hourly funding** (Robinhood Chain instance, public API) to the
mock venue, since Lighter has no testnet with stock perps. Services: `scripts/dev.sh --network 46630` with
`STOCKLINE_SERVICES_RPC_URL=https://rpc.testnet.chain.robinhood.com` (Alchemy's free tier caps `eth_getLogs` at 10
blocks, which breaks the indexer, the monitor and the DN keepers).

**Phase 3–4 contracts on the existing deployment** (each after the owner's go; the deployer needs ~0.0007 ETH at
0.02 gwei for both):

```sh
cd contracts
TESTNET_GO=yes forge script script/DeployTestnetFees.s.sol --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast --slow \
  --gas-estimate-multiplier 200 --private-key $TESTNET_DEPLOYER_KEY    # writes feeSplitter + converters to the book
TESTNET_GO=yes forge script script/DeployTestnetVault.s.sol --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast --slow \
  --gas-estimate-multiplier 200 --private-key $TESTNET_DEPLOYER_KEY    # DN vault, mock venue, caps 0; writes dnVault
# fee turn-on (24h curator timelock) and the live drills: run now, re-run after 24h to execute the scheduled halves
TESTNET_GO=yes TESTNET_DEPLOYER_KEY=… DRILL_RAN_BY="<name>" pnpm --filter @stockline/devnet drive live-drills \
  --rpc $ROBINHOOD_TESTNET_RPC_URL                                     # evidence: docs/runbooks/live-drills-46630.json
# then every feature through the hosted stack:
SMOKE_KEY=… TESTNET_GO=yes pnpm --filter @stockline/web exec tsx scripts/testnetSmoke.ts --web <APP_URL> --api <API_URL> \
  --rpc $ROBINHOOD_TESTNET_RPC_URL --monitor <MONITOR_URL> --flows --report ../docs/runbooks/testnet-smoke.md
```

Rehearsed without the go (2026-09-29): all of the above on an anvil fork of 46630 ([fork-drills-46630.md](fork-drills-46630.md),
`packages/devnet/test/liveDrills.test.ts`) and the smoke on the local full stack ([testnet-smoke.md](testnet-smoke.md)).
The DN vault's NAV signers and operator default to the deployer (A27); set `STOCKLINE_NAV_SIGNER_1/2` and
`STOCKLINE_DN_OPERATOR` to the keeper keys when deploying, or rotate them through the 24h timelock
(`navOracle.setSigner`, `timelockCalldata.ts`).

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
