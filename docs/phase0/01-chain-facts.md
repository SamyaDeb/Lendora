# Phase 0 · WS-A · Chain, protocol and asset facts

*Collected 2026-09-26. Machine-readable addresses: [`packages/sdk/external-addresses.json`](../../packages/sdk/external-addresses.json).*

**Status legend.** `VERIFIED onchain`: read from the chain (address, block, call or event given). `VERIFIED docs only`:
a source I opened on 2026-09-26, quoted. `UNVERIFIED`: not proven; says what would prove it. `NO`: checked and absent.
`BLOCKED`: could not check; says what is needed. If a doc and the chain disagree, the chain wins and both are recorded.

**How the onchain reads were made.** Public RPC `https://rpc.mainnet.chain.robinhood.com` (Nitro
`v3.12.0-rc.3`, from `web3_clientVersion`). It is **not an archive node**: state older than a few thousand blocks
returns `historical state … is not available`; logs are served for the full history. So every `eth_call` below is at
"latest" around blocks 73,178,000–73,214,000 (2026-09-26 14:55–16:08 UTC) unless a block is given, and history comes
from event logs. Blockscout's API (`robinhoodchain.blockscout.com/api`) sits behind a Cloudflare challenge (HTTP 403),
so verified source code was taken from **Sourcify** (`sourcify.dev/server/v2/contract/4663/<address>`), which reports
exact matches for the contracts cited. Raw pulls are cached in `sim/data/raw/` by `sim/phase0/rpc.py`.

## Summary: what changes for Lendora

| # | Finding | Status | Impact |
|---|---|---|---|
| 1 | Morpho Blue is live with AdaptiveCurveIRM, `irm = 0`, and LLTVs 0 / 62.5% / 77% enabled | VERIFIED onchain | No blocker. A5 holds. |
| 2 | Stock Tokens move into contracts and Morpho with exact amounts; raw Stock Tokens are already a Morpho **loan** asset in 19 markets | VERIFIED onchain | No blocker. Competing (empty) stock-loan markets exist. |
| 3 | The issuer can **blocklist** any address (incl. our wrapper), **pause** one token or all tokens, and **`adminBurn`** from any address. Role holders are single EOAs; no timelock | VERIFIED onchain (source + events + fork) | A3 is wrong. LM-R5/LM-R7 cannot hold "at all times". Needs decisions (see 04). |
| 4 | No MetaMorpho v1.x factory on Robinhood Chain; Morpho lists only **Vault V2** here | VERIFIED docs + onchain absence | A6 must be decided: deploy v1.1 ourselves or move to V2. |
| 5 | Chainlink stock feeds already include the multiplier; they are 24/5, 0.5% deviation, 24h heartbeat, and pause via the token's `oraclePaused()` | VERIFIED docs + onchain | PRD issues 1, 2, 4 confirmed. |
| 6 | **No Chainlink L2 sequencer uptime feed** for Robinhood Chain | NO (docs) | PRD issue 3: OR-R6 needs another design. |
| 7 | USDG is 6 decimals with EIP-2612 `permit`; Paxos can **freeze and wipe** any address | VERIFIED onchain (source + fork) | A7 holds. New collateral risk. |
| 8 | Only 33 Stock Tokens (of 195) have Chainlink feeds; SPY, NVDA, AAPL do | VERIFIED docs + onchain | Launch set is fine. |

## 1. Network

| Item | Value | Status | Evidence |
|---|---|---|---|
| Chain id | **4663** (testnet 46630) | VERIFIED onchain | `eth_chainId` = 4663 on the public RPC; docs.robinhood.com/chain/connecting: "Chain ID 4663 46630" |
| RPC | Public `https://rpc.mainnet.chain.robinhood.com` (rate-limited, non-archive); Alchemy `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}`; also Chainstack, QuickNode, Blockdaemon, dRPC, Validation Cloud | VERIFIED docs + onchain | connecting page: "For historical reads and indexing, use an archive endpoint — available through providers such as Alchemy." Non-archive confirmed by `historical state … is not available` at `latest-10000` |
| Explorer | `robinhoodchain.blockscout.com` (API `…/api/`, Etherscan-compatible); testnet `explorer.testnet.chain.robinhood.com` | VERIFIED docs; API **BLOCKED** | API returns HTTP 403 Cloudflare challenge without a key/browser. Needs `ROBINHOOD_EXPLORER_API_KEY` or a browser session. Sourcify used instead |
| Stack | Arbitrum Nitro L2 ("Arbitrum Dedicated Blockchains"), Ethereum blobs for DA, ETH gas, BoLD with 2 permissioned validators (Offchain Labs, Alchemy), 8-signer Security Council (6/8 + 7-day timelock; 7/8 emergency) | VERIFIED docs | connecting: "an Arbitrum Layer-2 Chain built on Ethereum, using Ethereum blobs for data availability"; governance page. L1 Rollup `0x23A19d23e89166adedbDcB432518AB01e4272D94` |
| EVM version (A4) | **Cancun opcodes work**: TSTORE/TLOAD, MCOPY, PUSH0 execute on the Nitro node; invalid opcode 0xEF is rejected | VERIFIED onchain | `eth_call` of creation code `0x600760425d60425c6000526020600060205e60206020f3` returns `…07` at block ≈73,206,541 (same result on Ethereum mainnet); the Stock Token implementation itself is compiled with `evmVersion: cancun` (Sourcify). Fork test `EvmVersion.fork.t.sol` also passes. **A4 holds.** |
| Block time | ≈ **0.10 s** recently (100,000 blocks in 9,972 s near head); the long-run average since genesis is 0.18 s | VERIFIED onchain | Block timestamps sampled every 100k blocks (`sim/data/raw/block_times.json`). Genesis block 1 at 2026-04-30 16:52:11 UTC |
| `block.number` | Returns an L1 block estimate, not the L2 block. Use `ArbSys(0x64).arbBlockNumber()` for L2 | VERIFIED docs | differences-from-ethereum: "block.number returns an estimate of the L1 (Ethereum) block number" |
| Finality / reorgs (SI-R3) | Soft confirmation sub-second; batch posted to L1 in minutes; Ethereum finality ≈13 min after posting. Measured: `safe` tag lags `latest` by **6,871 blocks (~11.5 min)**, `finalized` by **10,989 blocks (~18 min)** | VERIFIED docs + onchain | transaction-finality: "Once a transaction is posted to Ethereum, it cannot be reorganized unless Ethereum itself reorganizes." Tags read at latest 73,214,206 |
| Transaction screening | Sequencer drops txs "associated with a sanctioned address"; reads unaffected | VERIFIED docs | differences-from-ethereum, "Transaction screening". Matters for liquidators and keepers |
| Ordering | First-come first-served, no priority-fee auction | VERIFIED docs | differences-from-ethereum, "Transaction ordering" |
| Contract size | 96 KB code / 192 KB initcode limit | VERIFIED docs | differences-from-ethereum |
| Sequencer uptime feed (OR-R6) | **None.** Chainlink's L2 Sequencer Uptime Feeds page lists 11 networks, not Robinhood Chain; Robinhood's oracle page tells integrators to check one anyway | **NO** | docs.chain.link/data-feeds/l2-sequencer-feeds (opened 2026-09-26). The Arbitrum One feed address `0xFdB6…697D` has no code here (fork test) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | VERIFIED docs | protocol-contracts page |

## 2. Morpho

| Item | Value | Status | Evidence |
|---|---|---|---|
| Morpho Blue | `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`, deployed block 286. Sourcify exact match, solc 0.8.19, via-IR, `paris` (matches the `v1.0.0` release build) | VERIFIED onchain | docs.morpho.org/get-started/resources/addresses (Robinhood Chain tab); code 15,582 bytes |
| Owner | `0x060595638692de6CCd47ca04094F1772D3D39728`, a Safe, **5-of-9** | VERIFIED onchain | `owner()`; `getThreshold()` = 5; `getOwners()` 9 addresses. Initial owner `0xc673…dd2b` set then transferred in tx `0xe1927e1a…4d20` (block 286) |
| Fee recipient | `address(0)` (no Morpho fee switch configured) | VERIFIED onchain | `feeRecipient()` |
| Enabled IRMs | `address(0)` **and** AdaptiveCurveIRM `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` | VERIFIED onchain | `EnableIrm` events, block 286, tx `0xe1927e1a…4d20` |
| Enabled LLTVs | **0**, 38.5%, **62.5%**, **77%**, 86%, 91.5%, 94.5%, 96.5%, 98% | VERIFIED onchain | `EnableLltv` events, block 286, same tx. **A5 holds** (irm 0 + lltv 0 exist for the idle market) |
| Markets | 285 created; LLTV mix: 62.5% ×133, 38.5% ×64, 77% ×36, 86% ×32 … | VERIFIED onchain | `CreateMarket` logs to block 73,186,092 |
| Stock Tokens as **loan** asset | **19 markets** already exist, e.g. NVDA←USDG 62.5% (`0x2fdd5af0…`, `0xfa02b9d5…`), SPY←USDG 62.5% (`0xf670348a…`), AAPL←USDG 62.5% (`0xb257b94f…`). All empty except SPCX dust | VERIFIED onchain | `market(id)`: supply 0 / borrow 0 for NVDA/SPY/AAPL markets; SPCX market `0x45cac327…` has live supply and borrow |
| Stock Tokens as **collateral** | 170 markets (166 vs USDG) | VERIFIED onchain | decoded `CreateMarket` |
| MetaMorpho v1.0/v1.1 factory | **None** | **NO** (docs) | Morpho addresses page: the "Morpho Vault V1" section lists no Robinhood Chain tab (it does for Blue, Vault V2, Bundles, Bundlers). |
| Vault V2 factory | `0x0FBad98595b0186dA120E41f77C102beb49f803c`; **70** `CreateVaultV2` events since block 288: 54 with asset USDG, 7 SPCX ("ORBIT Develop SPCX …" pilots, dust), 3 WETH, 1 NVDA ("Flap NVDA Vault", 1e-9 NVDA) | VERIFIED onchain | docs + logs. Adapters: MorphoMarketV1AdapterV2Factory `0x79370Ed0…93e1`, MorphoVaultV1AdapterFactory `0x7a91222F…85e`, MorphoRegistry `0xe785a2eF…676f` |
| Public allocator | `0xCe5c1aFa115fF8b1D6913509bfc79D9AE08CC857` ("Blue Public Allocator") | VERIFIED docs + code present | code 7,697 bytes |
| Bundler3 / GeneralAdapter1 | `0x6478e939…44a6` / `0xc5E18854…65D6`; bundles `VaultBundlesV1`, `BlueBundlesV1` etc. also listed | VERIFIED docs + code present | |
| ChainlinkOracleV2 factory | `0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2` | VERIFIED docs + code present | |
| Oracle assumption (WS-D) | "The oracle price should not be able to change instantly such that the new price is less than the old price multiplied by LLTV*LIF." LIF = min(1.15, 1/(1 − 0.3·(1 − LLTV))) → 77%: LIF 1.07411, LLTV·LIF 0.82707, **max instant drop 17.29%**; 62.5%: 29.58% | VERIFIED docs (source) | `morpho-org/morpho-blue` `main` @ `8e26ca6`, `src/interfaces/IMorpho.sol` L115–117; constants `LIQUIDATION_CURSOR = 0.3e18`, `MAX_LIQUIDATION_INCENTIVE_FACTOR = 1.15e18` in our `v1.0.0` submodule |

## 3. Stock Tokens

Launch tokens (all 18 decimals, `api.robinhood.com/rhj/assets` fetched 2026-09-26, 195 assets, cross-checked onchain):

| Ticker | Token | Chainlink feed (proxy) | `uiMultiplier` | Last `UIMultiplierUpdated` |
|---|---|---|---|---|
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | `0x319724394D3A0e3669269846abE664Cd621f9f6A` | 1.001717991187472003 | block 65,779,981, 2026-09-18 00:00:49 UTC, 1.0 → 1.001718, effective 00:10:33, tx `0x2fe45ab2…1025` |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | 1.000775159164630595 | block 58,952,659, 2026-09-09 23:50:42 UTC, 1.0 → 1.000775, effective 2026-09-10 00:00:30, tx `0x4ac23f2e…d956` |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | 1.000566080061092436 | block 36,345,344, 2026-08-14 15:03:06 UTC, 1.0 → 1.000566, effective 15:12:46, tx `0x6d72ca59…ff35` |

All 195 assets: `api.robinhood.com/rhj/assets`. The 35 with a Chainlink feed are in `external-addresses.json`.

### 3.1 Contract structure

| Item | Value | Status | Evidence |
|---|---|---|---|
| Proxy | Every Stock Token is a **BeaconProxy** (283-byte code) whose beacon is `AccessControlsRegistry` `0xe10b6f6B275de231345c20D14Ab812db62151b00` | VERIFIED onchain | EIP-1967 beacon slot of SPY/NVDA/AAPL = `0xe10b…1b00`; registry `implementation()` = `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` |
| Implementation | `Stock` (`src/Stock.sol`), solc 0.8.33, cancun; Sourcify exact match. Beacon upgraded to it twice (blocks 7,796 and 657,134, same address) | VERIFIED onchain | Sourcify 4663/0xb354…5aE2; registry `Upgraded` events |
| Decimals, rebasing (A2) | 18 decimals; OZ `ERC20Upgradeable` `_update`; balances change only by transfer/mint/burn; no fee on transfer | VERIFIED onchain (source + fork) | `Stock.sol`, `ERC20ScaledUIUpgradeable.sol`; fork test transfers exact odd amounts. **A2 holds** |
| Permit | EIP-2612 `permit` on Stock Tokens (EIP-712 name = token name, version "1") | VERIFIED onchain (source) | `ERC20PermitUpgradeable`, `_EIP712Version() = "1"` |

### 3.2 Admin powers (A3, LM-R6, CP-R5)

Roles live in the registry (OZ `AccessControl`). Holders from `RoleGranted`/`RoleRevoked` events (274 registry logs,
decoded in full); all role holders have **no code (EOAs or MPC keys; not distinguishable onchain)**. No timelock on any.
The deployer `0x0743…1279` renounced `DEFAULT_ADMIN_ROLE` and `BEACON_UPGRADER_ROLE` at blocks 8,692–8,695.

| Power | Function | Role holder (granted at block) | Effect on Lendora |
|---|---|---|---|
| Upgrade all Stock Tokens | `registry.upgradeTo(impl)` | BEACON_UPGRADER `0xCd8C6182e7C6Ca3B5156D6a90a67719d7e2Be094` (8,646) | Any behavior can change for all 195 tokens at once, instantly |
| Admin of all roles | `grantRole` / `revokeRole` | DEFAULT_ADMIN `0xD6f8378F8e440c65F8382F5f2728c78DfD55B66d` (7,802) | Can create any role holder. Used at blocks 616,387/618,536 (grant/revoke MINTER to `0x…dead`) |
| **Blocklist** any address | `registry.blockAccounts(address[])` | BLOCKER `0x913cA87347391218e5De2C17c5A0AEba8B0b28fD` (8,687) | A blocked address cannot send, receive, approve, permit, mint or burn. **175 addresses currently blocked, all EOAs, no contracts.** Blocking our wrapper freezes all backing: no wrap, no unwrap (fork-tested) |
| Global pause | `registry.pause()` | PAUSER `0xe7BCB188254Bc6eBBfF63014DfED4cD4A024F22A` (7,833) | Stops transfers of all Stock Tokens. Used once: paused block 611,101 (2026-06-30 17:01:41 UTC), unpaused 611,243 (17:02:50) |
| Per-token pause | `stock.pause()` | TOKEN_PAUSER `0xFCcF56B674113d9C4eb0F9B3370930ceD9E6Ab23` (7,844) | Stops transfer/approve/permit for one token. No `Paused` event on SPY/NVDA/AAPL so far |
| **Forced burn** | `stock.adminBurn(from, amount)` | ADMIN_BURNER `0x957B6de6525C63349f7619743Ef1E0ad93cd74D4` (7,828) | No pause or blocklist check. Can burn the wrapper's (or Morpho's) balance. Breaks LM-R7's "at all times" (fork-tested) |
| Mint / burn | `mint(to,a)`, `burn(from,a)` | MINTER `0x2b94105fFf37630f98e1f24811daD588FC5C3A87` (7,817), BURNER `0x6E40B50A40C1db42A85a0E8fe8FF7d9CbFc2D8C1` (7,820) | `burn` checks pause and blocklist |
| Multiplier | `updateMultiplier(m)` (immediate) and `updateMultiplier(m, effectiveAt)` | MULTIPLIER_UPDATER `0x92905e8d0e2301BA143215B8D86D63fFD4188143` (8,675) | Immediate path is a step change with no notice |
| Oracle pause flag | `pauseOracle()` / `unpauseOracle()` | ORACLE_PAUSER `0x7369d100c00F28E45D779ac9d4b1c7afa61e4aBC` (8,638) | Chainlink stops publishing while set. No `OraclePaused` event on SPY/NVDA/AAPL so far |
| Metadata | `setMetadata(name, symbol)` | METADATA_UPDATER `0xcba16C2b9048AF033c5b34E43dd1D47D1358524A` (8,682) | Changes `name()`, which is the EIP-712 domain name, so it also invalidates outstanding permits |

There is **no allowlist**: any non-blocked address may hold and receive Stock Tokens. The docs say only the primary
market (mint/redeem) is permissioned (KYB'd Authorised Participants).

### 3.3 ERC-8056 (A1) and dividends

| Item | Value | Status | Evidence |
|---|---|---|---|
| `uiMultiplier()` | Returns `_newMultiplier` once `block.timestamp >= _effectiveAt`, else the stored multiplier; **no poke needed** | VERIFIED onchain (source + fork) | `ERC20ScaledUIUpgradeable.uiMultiplier()`; fork test `test_phase0_erc8056_scheduledUpdateTakesEffectWithoutPoke`. **A1 holds** |
| `newUIMultiplier()`, `effectiveAt()` | Present; the scheduled values stay readable after they take effect | VERIFIED onchain | reads above; `effectiveAt()` = 1788998430 for NVDA (the last update) |
| `balanceOfUI`, `totalSupplyUI`, `TransferWithScaledUI` | Present | VERIFIED onchain (source) | |
| Scheduling | `updateMultiplier(m, t)` requires `t >= block.timestamp`; `m > 0`; no bound on the jump size | VERIFIED onchain (source) | `_updateUIMultiplier` |
| Cash dividends | Reinvested **via the multiplier** (not airdrop, not USDG) | VERIFIED docs + onchain | oracles page: "dividends are reinvested into the token via the multiplier"; SPY/NVDA/AAPL multipliers rose once each (table above). `/rhj/corporate-actions` lists `CASH_DIVIDEND`, `STOCK_DIVIDEND`, `FORWARD_SPLIT`, `REVERSE_SPLIT` as active types |
| Corporate-action workflow | Robinhood pauses the oracle, stages the multiplier, unpauses: "keeps the token price continuous" | VERIFIED docs only | docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood |

Our `IScaledUIAmount` also declares `UIMultiplierUpdateCancelled`; the live token has no such event (harmless, never
emitted).

## 4. Chainlink

All from `reference-data-directory.vercel.app/feeds-robinhood-mainnet.json` (fetched 2026-09-26; 58 feeds) and read
onchain at latest (fork test log: `docs/phase0/evidence/fork-run.log`, block 73,213,529).

| Feed | Proxy | `description()` | Dec | Heartbeat | Deviation | Aggregator | Latest answer / age at 2026-09-26 ~16:00 UTC |
|---|---|---|---|---|---|---|---|
| SPY | `0x3197…9f6A` | `RHSPY / USD` | 8 | 86,400 s | 0.5% | `0x78BCB218…DEFBAc` | 772.328 / 24.1 h |
| NVDA | `0x379E…9F15` | `RHNVDA / USD` | 8 | 86,400 s | 0.5% | `0xC9d16E4f…DC2a2` | 225.660 / 20.2 h |
| AAPL | `0x6B22…2cD0` | `Robinhood AAPL / USD` | 8 | 86,400 s | 0.5% | `0xBb11A212…44ACb` | 341.453 / 20.3 h |
| USDG/USD | `0x61B7…9aD2` | `USDG / USD` | 8 | 86,400 s | 0.5% | `0x8bEeE350…51c2e` | 0.99993 / 29 min |
| syrupUSDG/USDG | `0xDd19…1cF0` | `syrupUSDG / USDG Exchange Rate` | 18 | 86,400 s | 0.05% | `0xD972eB40…C1012` | 1.01233 |

| Item | Value | Status | Evidence |
|---|---|---|---|
| Aggregator type | OCR2 "DualAggregator" with SVR (`transmitSecondary`); proxy `version()` = 6, `phaseId()` = 1; secondary SVR proxies listed for each feed. Proxy owner `0xeE27…9C52` | VERIFIED onchain | selectors of `0xC9d1…2a2`; Sourcify match |
| Rounds since launch | SPY 146, NVDA 1,106, AAPL 671 (first round 2026-06-21 20:00:43 ET) | VERIFIED onchain | `getRoundData` over all rounds, `sim/data/feeds/*.csv` |
| **PRD issue 1**: price already includes the multiplier | Yes | VERIFIED docs + consistent onchain | Chainlink: "Token Price = Underlying Equity Market Price × Multiplier … Multiplier: Read from the Robinhood token contract via the uiMultiplier() function." Robinhood: "don't apply the multiplier yourself". Data check: the median feed/Yahoo ratio stepped up at each multiplier change (SPY ×1.0022 vs m 1.0017; NVDA ×1.0013 vs 1.0008; AAPL ×1.0013 vs 1.0006; ±0.3% hourly noise, so this is corroboration, not proof) |
| **24/5** (OR-R13, PRD issue 2) | Yes. Updates from Sunday ~20:00 ET through Friday ~20:00 ET, including overnight; none Saturday. Longest gaps 78–81 h (weekends) | VERIFIED docs + onchain | Chainlink: "Sourced from Chainlink's 24/5 equity price feeds … regular, pre-market, post-market, and overnight trading sessions"; "These feeds do not have heartbeats during off-hours." Round histogram in the WS-C report |
| Update rule | 0.5% deviation or 24 h heartbeat (heartbeat only while the market is open). NVDA median gap between rounds 31 min, SPY 12 h. **A price up to 0.5% off can be current** | VERIFIED docs + onchain | feed directory; round data |
| **Pause flag** (PRD issue 4) | `oraclePaused()` on the **token**, set by ORACLE_PAUSER; the feed "stops publishing new prices and holds the last known good value". Advisory, not enforced | VERIFIED docs + onchain (source) | Chainlink Robinhood page; Robinhood oracles page: "The flag is advisory and not enforced on-chain"; `OraclePausable.sol` |
| USDG/USD feed (OR-R4) | Exists. Range since 2026-06-05: 0.99963–1.00041 | VERIFIED onchain | 113 rounds |
| Data Streams | Verifier proxy `0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7` | VERIFIED docs only | docs.robinhood.com/chain/data-streams |

## 5. USDG

| Item | Value | Status | Evidence |
|---|---|---|---|
| Token | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, "Global Dollar", **6 decimals** (A7) | VERIFIED onchain | `decimals()` = 6; fork test |
| Proxy | UUPS (EIP-1967 impl `0x68184C449E1a8f34fA18d289737129FD27B66f8F`, `USDG`, Paxos, solc 0.8.28, Sourcify match). Selectors not in the main contract route to facets through a diamond-style fallback | VERIFIED onchain | impl slot; `getFacet(bytes4)`; 90+ `FacetUpdate` events |
| `permit` (A7) | EIP-2612 `permit` (plus EIP-3009 `transferWithAuthorization`) via facet `0x780d30b6a89BC9Eef953a543aA288c3B05b01309` | VERIFIED onchain (fork) | `UsdgPermit.fork.t.sol` passes: allowance set, nonce +1, replay reverts. **A7 holds** |
| Admin | `defaultAdmin()` = `owner()` = `0xcFA0388f5ddf905FdC08c45c716C15Dc10A14C6F`, 3-hour admin transfer delay (OZ `AccessControlDefaultAdminRules`); admin can upgrade and re-point facets | VERIFIED onchain | `defaultAdminDelay()` = 10,800 |
| **Freeze and wipe** | `freeze(address)`, `freezeBatch`, `wipeFrozenAddress(address)` (asset-protection role); `pause()` | VERIFIED onchain (facet `0x58cab81e…e942` selectors) | A frozen Morpho or `clUSDG` address would lock all USDG collateral in it; `wipeFrozenAddress` burns it |
| Yield | USDG balances do **not** grow: `balanceOf` "excludes unclaimed rewards". Yield is opt-in via registered payout groups and paid from a claim source | VERIFIED onchain (source) | `PaxosTokenClaimableRewards.balanceOf` natspec; claim facet `0xc5dc7ec3…88d7`. Safe as plain Morpho collateral |
| Yield vault for `clUSDG` (CL-R1) | **syrupUSDG** `0x40858070814a57FdF33a613ae84fE0a8b4a874f7` (Maple), 6 decimals, supply 125.68M. **Not ERC-4626 on this chain** (`asset()`, `convertToAssets()` revert); value via Chainlink `syrupUSDG / USDG Exchange Rate` (never decreased in 114 rounds, 1.0000 → 1.01233). **Morpho Vault V2 USDG vaults (ERC-4626): 54 exist**; largest "Steakhouse USDG" `0xBeEff033F34C046626B8D0A041844C5d1A5409dd` with 511.7M USDG `totalAssets`, then "Ethena x Steakhouse USDG" (4.6M) and "NetNet Credit" (1.5M). Their share price falls if an underlying Morpho market realizes bad debt (Morpho Blue lowers `totalSupplyAssets` on bad debt; 4 such events on this chain, §8) | VERIFIED onchain + docs | Maple docs PR #157 (merged 2026-09-16) lists token `0x4085…74f7`, pool `0x01FA…725c`, feed `0xDd19…1cF0`. Can the share price fall? **UNVERIFIED**: Maple loan impairments can lower it on Ethereum; needs Maple's docs on the RH-chain token's rate source |

## 6. DEXs and aggregators (A8, RT-R3, OR-R31)

| Item | Value | Status | Evidence |
|---|---|---|---|
| Uniswap | v2 factory `0x8bCEaA40…937f`, **v3 factory `0x1F7d7550…2EfA`**, QuoterV2 `0x33E885ED…a9e7`, SwapRouter02 `0xCaF681a6…5cB2`, **v4 PoolManager `0x8366a39C…0951`**, StateView `0xF3334192…673B`, UniversalRouter `0x88767899…0904` | VERIFIED docs + code | developers.uniswap.org v2/v3/v4 deployment pages (Robinhood Chain rows) |
| Pools | Thousands of spam pools per stock (SPY: 78 v3, 19 v2, 4,165 v4). Main v3 pools by Stock Token held: NVDA/USDG 0.05% `0xd4EB…14a3` (8,672 NVDA), NVDA/WETH 0.05% `0x62aB…6b6c` (3,178), SPY/WETH 0.05% `0xDDcB…ab5E` (1,724 SPY), SPY/USDG 0.05% `0xa7bB…9167` (170), AAPL/WETH 0.05% `0x8bB3…719f` (522), AAPL/USDG 0.05% `0xaAe0…6d6D` (427) | VERIFIED onchain | `PoolCreated`/`PairCreated`/`Initialize` logs; `balanceOf(pool)` at latest. v4 liquidity per pool not measured (UNVERIFIED; StateView reads needed) |
| 2% depth, Saturday 2026-09-26 15:57 UTC, block 73,207,817 | USD to push price **up** 2% / **down** 2%: NVDA/USDG $1.12M / $1.43M; NVDA/WETH $141k / $113k; SPY/WETH $216k / $180k; SPY/USDG $98k / $126k; AAPL/USDG $97k / $99k; AAPL/WETH $49k / $39k | VERIFIED onchain | QuoterV2 binary search, `sim/phase0/dex_depth.py`, `sim/data/dex_depth.csv`. Weekday comparison: **BLOCKED** on archive RPC (or rerun on a weekday) |
| Other venues | RFQ via 0x, 1inch Fusion, LiFi; propAMM Rialto; Lighter spot order books; Arcus | VERIFIED docs only | building-with-stock-tokens: "Tokenized stocks trade via RFQ at launch"; 0x (2026-07-01): "0x RFQ infrastructure supports Stock Tokens on Robinhood Chain, with USDG as the primary base pair" |
| Callable from a contract (A8) | Uniswap v3/v4 routers and pools: yes (plain onchain calls; the fork tests and QuoterV2 reads use them). Aggregator APIs (0x, 1inch, LiFi, KyberSwap) return offchain quotes; whether their calldata and RFQ fills work with a contract as taker is not checked. Lighter and Arcus order books are not atomic from a contract | Uniswap VERIFIED; 0x/1inch/LiFi **UNVERIFIED** | Needs a fork test with a live 0x quote executed by a contract (requires a 0x API key) |

## 7. Perp venues (Phase 4)

| Venue | Facts | Status | Evidence |
|---|---|---|---|
| Lighter (Robinhood Chain instance) | Contract `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d`. 57 markets incl. perps **SPY (id 26), NVDA (15), AAPL (10)**. Snapshot Sat 2026-09-26: SPY OI 66,427 (≈ $51M), 24h volume $56.6M; NVDA OI 28,102 (≈ $6.3M), $7.6M; AAPL OI 3,639, $1.5M. Spot SPY/USDG $11.9M/24h. Margin fractions: SPY initial 2% / maintenance 1.2%; NVDA, AAPL 5% / 3% | VERIFIED (public API) | `https://api.rh.lighter.xyz/api/v1/orderBookDetails` (fetched 2026-09-26). Nonzero volume on a Saturday shows weekend trading |
| Lighter funding | Hourly history available: `GET /api/v1/fundings?market_id=…&resolution=1h` | VERIFIED (public API) | e.g. market 0 returns hourly `rate` and `direction` |
| Lighter: contract as margin account | `deposit(_to, …)` "Anyone can call deposit on behalf of any address". Trading needs keys registered by the account; whether a contract (EIP-1271) can register them is unknown | VERIFIED docs (Phase 4 task 12, 2026-09-29): keys registered onchain via `changePubKey` (multisig/contract), secure withdrawals only to the owning L1 address; [VERIFY] EIP-1271 + live canary | docs.robinhood.com/chain/lighter-domains; apidocs.lighter.xyz/docs/api-keys; [`docs/phase4/01-perp-venue.md`](../phase4/01-perp-venue.md) |
| Arcus | dYdX team's DEX on Robinhood Chain: "Trade Stock Tokens 24/7", "up to 50x leverage" (2026-07-01). pTokens make perp positions ERC-20 (The Block, 2026-08-25). Listed symbols, weekend pricing and funding history not confirmed | VERIFIED docs only (partial) / UNVERIFIED | arcus.xyz/blog/arcus-x-robinhood-trade-stocks-perpetuals-24-7. pTokens could let a vault hold perp exposure as a token: worth checking in Phase 4 |

## 8. Liquidators

| Item | Value | Status | Evidence |
|---|---|---|---|
| Morpho liquidations | **248** `Liquidate` events from block 6,059,772 to 73,043,137, from **65 distinct callers** | VERIFIED onchain | Morpho logs to block 73,186,137 (`sim/data/raw/morpho_liq.json`) |
| Bad debt | 4 liquidations realized bad debt (blocks 26,776,969; 26,803,224; 28,832,937; 54,225,285) | VERIFIED onchain | e.g. tx `0xc7aae48d…d9b1` |
| Where | 204 of 248 in a single USDG-loan market (collateral `0x63c12667…`); 2 in NVDA-collateral markets | VERIFIED onchain | decoded by market id |
| Liquidators for stock-**loan** markets | None yet (the existing stock-loan markets are empty) | NO (so far) | Lendora's fallback liquidator is required, as the PRD already says |

## 9. What still needs a human or a key

| Item | Blocked on |
|---|---|
| Pinned-block fork runs, weekday DEX depth, historical `slot0` | Archive `ROBINHOOD_RPC_URL` (public RPC keeps minutes of state) |
| Explorer API (contract labels, token holder lists) | `ROBINHOOD_EXPLORER_API_KEY` or a Blockscout session; Sourcify covered source code |
| Testnet facts | `ROBINHOOD_TESTNET_RPC_URL` (public `rpc.testnet.chain.robinhood.com` exists; not checked in this session) |
| Whether the issuer would block DeFi contracts; whether role keys are MPC/multisig | Issuer (outreach is yours) |
| 0x/1inch contract-caller support | API keys + a fork test |

## 10. Testnet (46630), checked 2026-09-27 (Phase 2 task 7)

Read-only checks against the public RPC `https://rpc.testnet.chain.robinhood.com` (Nitro `v3.12.0-rc.3`, same as
mainnet), block ≈ 125,178,000.

| Item | Value | Status | Evidence |
|---|---|---|---|
| Chain id | 46630 | VERIFIED onchain | `eth_chainId` |
| Block time | ≈ 0.14 s (10,000 blocks in 1,426 s) | VERIFIED onchain | block timestamps at latest and latest − 10,000 |
| Finality (SI-R3) | `safe` trails `latest` by ≈ 4.5k blocks, `finalized` by ≈ 6.4k (≈ 15 min) | VERIFIED onchain | block tags at 125,178,318 |
| Archive state | **No** (public RPC): `missing trie node` for old blocks | VERIFIED onchain | `eth_getBalance` at block 1,000,000. The indexer needs an archive RPC for exact historical snapshots (A24) |
| Morpho Blue, AdaptiveCurveIrm, VaultV2Factory, MorphoMarketV1AdapterV2Factory | **Not at the mainnet addresses** (no code) | NO | `eth_getCode` = 0x at each 4663 address. No testnet deployment is listed in Morpho's or Robinhood's docs (read 2026-09-27) |
| USDG, Stock Tokens (SPY, NVDA, AAPL), issuer registry | **Not at the mainnet addresses** | NO | no code. Robinhood's contracts page lists mainnet USDG and WETH only |
| Chainlink Stock Token and USDG feeds | **Not at the mainnet addresses**; none listed for testnet | NO | no code |
| Uniswap v3 factory | not at the mainnet address | NO | no code |
| UniversalRouter `0x8876…0904`, Permit2, Multicall3 `0xcA11…CA11` | present | VERIFIED onchain | code sizes 24,546 / 9,152 / 3,808 |
| WETH | `0x7943e237c7F95DA44E0301572D358911207852Fa` (testnet) | VERIFIED onchain | `symbol()` = WETH |
| CREATE2 deployers | `0x4e59…956C`, `0x914d…43d7` present | VERIFIED onchain | code |
| Faucets (testnet ETH) | faucet.testnet.chain.robinhood.com, QuickNode, Chainlink | VERIFIED docs only | search results 2026-09-27 |

**Consequence for the testnet deployment** (`contracts/script/DeployTestnet.s.sol`): deploy unmodified Morpho Blue,
AdaptiveCurveIrm and the Vault V2 factories from the pinned artifacts (same bytecode as mainnet, LM-R20), mock
Stock Tokens / USDG / feeds / swap aggregator / pools with an **operator gate** (only the deployer, the feed-mirror
keeper and the faucet can move prices, pause or mint), a faucet, 24h timelocks, the lens. The feed-mirror keeper
copies the real mainnet Chainlink rounds (read-only) to the testnet mock feeds, so testnet follows real prices and
the real 24/5 sessions and weekend freezes.
