# Lendora architecture

This document describes the system as it is implemented in this repository. Names in the diagrams are the real
contract, function, package and service names. Requirement ids (RT-R1, OR-R20, DN-R5, ...) refer to the PRD in
[`docs/prd/`](prd/README.md), which holds the full specification.

- [1. System context](#1-system-context)
- [2. Smart contract architecture](#2-smart-contract-architecture)
- [3. Core user flows](#3-core-user-flows)
- [4. Data and price flow](#4-data-and-price-flow)
- [5. Deployment and infrastructure](#5-deployment-and-infrastructure)

## 1. System context

```mermaid
flowchart TB
    user["User wallet"]
    subgraph offchain["Offchain (this repo)"]
        web["web: Next.js app"]
        compliance["compliance: attestation signer"]
        api["api: REST + WebSocket"]
        indexer["indexer: Ponder"]
        pg[("Postgres")]
        redis[("Redis")]
        keepers["keepers: allocator, guard, liquidator,<br/>fee-converter, alerts, monitor,<br/>dn-rebalancer, nav-reporter, nav-cosigner"]
    end
    subgraph chain["Robinhood Chain"]
        lendora["Lendora contracts<br/>LendoraRouter, StockWrapper, CollateralToken,<br/>LendoraOracle, MarketHours, LendoraLiquidator,<br/>FeeSplitter, FeeConverter, DeltaNeutralVault"]
        morpho["Morpho Blue"]
        vaultv2["Morpho Vault V2 + MorphoMarketV1AdapterV2"]
        chainlink["Chainlink feeds (stock/USD, USDG/USD)"]
        stocks["Stock Tokens, USDG"]
        dex["DEX / Uniswap UniversalRouter"]
    end
    sanctions["Sanctions provider<br/>(Chainalysis or TRM)"]
    pager["PagerDuty / Opsgenie,<br/>Telegram, email, webhooks"]
    perp["Perp venue (Lighter)"]

    user --> web
    web -- "transactions (wagmi/viem)" --> lendora
    web -- "/api/compliance proxy" --> compliance
    web -- "REST / WS" --> api
    compliance --> sanctions
    compliance -- "EIP-712 attestation" --> web
    lendora --> morpho
    lendora --> vaultv2
    lendora --> chainlink
    lendora --> stocks
    lendora --> dex
    vaultv2 --> morpho
    indexer -- "events" --> chain
    indexer --> pg
    api --> pg
    api --> redis
    keepers -- "reads and keeper txs" --> chain
    keepers --> pg
    keepers --> pager
    keepers -. "DN vault only" .-> perp
```

Lendora is a thin layer over unmodified Morpho Blue and Morpho Vault V2. The contracts add a stock wrapper, a gated
collateral token, a market-hours-aware oracle, a router for one-transaction flows, and fee and vault contracts. The
offchain side has three parts. The compliance signer issues the EIP-712 attestation the router requires for new
positions. The Ponder indexer and the API publish market and short-interest data. The keepers run the operational
loops: vault allocation, oracle guard, fallback liquidation, fee conversion, alerts, monitoring, and the
delta-neutral vault's rebalancing and NAV reports.

## 2. Smart contract architecture

### 2.1 Inheritance and interfaces

```mermaid
classDiagram
    direction LR
    class LendoraRouter {
        -RouterStorage erc7201
        +lend()
        +withdrawLend()
        +borrow()
        +openShort()
        +closeShort()
        +repay()
        +addCollateral()
        +withdrawCollateral()
        +listMarket()
        +setAttestationSigner()
    }
    class LendoraOracleBase {
        <<abstract>>
        +price()
        +priceAt()
        +guardReasons()
        +poke()
        +trip()
        +clear()
        +raiseBufferFloor()
        +setParams()
    }
    class LendoraOracle
    class ReceiptCollateralOracle
    class StockWrapper {
        +wrap()
        +unwrap()
        +backingShortfall()
    }
    class CollateralToken {
        +mint()
        +unwrap()
        +setRouter()
    }
    class LendoraLiquidator {
        +liquidate()
        +onMorphoLiquidate()
    }
    class DeltaNeutralVault {
        +deposit(assets, receiver, att)
        +requestRedeem()
        +settle()
        +claim()
        +sendToStrategy()
        +accrueFee()
    }
    class NavOracle {
        +submit(Report, signatures)
        +nav()
    }
    class StrategyManager {
        +buySpot()
        +sellSpot()
        +lend()
        +unlend()
        +depositMargin()
        +adjustShort()
    }

    ILendoraRouter <|.. LendoraRouter
    UUPSUpgradeable <|-- LendoraRouter
    Initializable <|-- LendoraRouter
    ReentrancyGuardTransient <|-- LendoraRouter
    Multicall <|-- LendoraRouter
    EIP712 <|-- LendoraRouter
    ILendoraOracle <|.. LendoraOracleBase
    IOracle <|-- ILendoraOracle
    Ownable <|-- LendoraOracleBase
    LendoraOracleBase <|-- LendoraOracle
    LendoraOracleBase <|-- ReceiptCollateralOracle
    ERC20 <|-- StockWrapper
    ERC20 <|-- CollateralToken
    IMorphoLiquidateCallback <|.. LendoraLiquidator
    ERC4626 <|-- DeltaNeutralVault
    EIP712 <|-- NavOracle
    IPerpAdapter <.. StrategyManager : drives
    MarketHours <.. LendoraOracleBase : reads sessions
    OracleMath <.. LendoraOracleBase : uses
    OracleMath <.. LendoraRouter : uses
```

`LendoraRouter` is the only upgradeable contract (UUPS). It keeps its configuration in the ERC-7201 namespace
`stockline.storage.StocklineRouter`. That string predates the rename, and changing it would move the router's
storage. Both Morpho oracles share `LendoraOracleBase` (feed checks, closure/event buffer, guard). `OracleMath` holds
the pure price and health-factor math, which `packages/sdk/src/math/oracle.ts` mirrors operation for operation.
Other than the router, the Lendora contracts are plain `Ownable` or immutable.

### 2.2 Composition per listed stock

```mermaid
flowchart LR
    stock["Stock Token (e.g. NVDA)"] -- "wrap / unwrap" --> wrapper["StockWrapper wNVDA"]
    usdg["USDG"] -- "mint / unwrap (router only)" --> cl["CollateralToken clUSDG"]
    oracle["LendoraOracle (per stock)"] --> feeds["Chainlink stock/USD + USDG/USD"]
    oracle --> mh["MarketHours"]
    subgraph morpho["Morpho Blue market (immutable)"]
        mkt["loan = wNVDA<br/>collateral = clUSDG<br/>oracle = LendoraOracle<br/>IRM = AdaptiveCurveIrm<br/>LLTV = 77%"]
    end
    wrapper --> mkt
    cl --> mkt
    oracle --> mkt
    vault["Vault V2 rNVDA (lender receipt)"] -- "MorphoMarketV1AdapterV2" --> mkt
    vault -- "10% performance fee" --> fs["FeeSplitter"]
    fs -- "50%" --> tc["FeeConverter (treasury)"]
    fs -- "50%" --> bc["FeeConverter (backstop)"]
    router["LendoraRouter"] --> vault
    router --> mkt
    router --> wrapper
    router --> cl
    lens["ShortInterestLens"] -. reads .-> router
    lens -. reads .-> mkt
    lens -. reads .-> vault
    rmkt["Receipt market (G5, optional):<br/>loan = USDG, collateral = rNVDA,<br/>oracle = ReceiptCollateralOracle"] -. collateral .-> vault
```

`LendoraDeploy._deployStock` deploys one `StockWrapper`, one `LendoraOracle`, one Morpho market, one Vault V2 from
the official `VaultV2Factory` and one `MorphoMarketV1AdapterV2` for each stock. Lenders hold Vault V2 shares
(`rSTOCK`), and the vault allocates between idle and the Morpho market. Borrowers post `clUSDG`, a USDG wrapper that
only the router can mint, which means every new position has passed the router's checks. Performance fees go through
`FeeSplitter` to two `FeeConverter`s, which swap them to USDG for the treasury and the backstop reserve.

### 2.3 Access control

```mermaid
flowchart TB
    msig["Owner multisig"] --> tl["TimelockController<br/>(48h mainnet, 24h testnet)"]
    tl -- "owner" --> router["LendoraRouter<br/>listMarket, caps, signer, upgrade"]
    tl -- "owner" --> oracle["LendoraOracle / ReceiptCollateralOracle<br/>setParams, setGuardian, setKeeper"]
    tl -- "owner" --> mh["MarketHours<br/>replaceSessionsFrom, replaceEventsFrom"]
    tl -- "owner" --> dn["DeltaNeutralVault, StrategyManager, NavOracle"]
    tl -- "owner" --> fees["FeeSplitter, FeeConverter"]
    curator["Curator multisig"] -- "Vault V2 timelocked actions" --> v2["Vault V2 rSTOCK"]
    allocator["Allocator keeper"] -- "allocate / deallocate" --> v2
    guardian["Guardian multisig (= Vault V2 sentinel)"] -- "trip, raiseBufferFloor" --> oracle
    guardian -- "deallocate, lower caps" --> v2
    guardian -- "pause deposits, lower cap" --> dn
    guard["Guard keeper"] -- "poke, trip / clear offchain reasons" --> oracle
    signer["Compliance signer key"] -- "attestations checked by" --> router
    navkeys["NAV reporter + independent co-signer"] -- "submit" --> navo["NavOracle"]
    op["DN operator (dn-rebalancer)"] -- "buySpot, lend, adjustShort, ..." --> sm["StrategyManager"]
    feek["Fee keeper"] -- "convert" --> fees
```

The timelock owns every Lendora contract and each Vault V2 (`VerifyRoles.s.sol` checks the role wiring after a
deploy). The guardian can only reduce risk: trip the oracle guard, raise the buffer floor, deallocate, lower caps,
pause vault deposits. The keeper keys are narrow: the allocator moves liquidity inside a vault, the guard keeper trips
or clears reasons it detects offchain, and the DN operator acts within `StrategyManager` limits (sleeve caps, max
slippage, max lend share). Morpho markets are immutable, so no role can change a live market's LLTV, IRM or oracle.

## 3. Core user flows

### 3.1 Lend a stock

```mermaid
sequenceDiagram
    actor L as Lender
    participant R as LendoraRouter
    participant W as StockWrapper
    participant V as Vault V2 (rSTOCK)
    participant K as Allocator keeper
    participant M as Morpho Blue
    L->>R: lend(stock, amount, minShares, receiver, deadline)
    R->>W: wrap(amount)
    R->>V: deposit(amount, receiver)
    V-->>L: rSTOCK shares
    K->>V: allocate(adapter, ...) up to the utilization cap
    V->>M: supply wSTOCK
    Note over L,M: withdrawLend: redeem shares, forceDeallocate if idle is short, unwrap to the Stock Token
```

Lending needs no attestation. The router wraps the Stock Token, deposits it into the stock's Vault V2 and sends the
`rSTOCK` shares to the receiver, with `minShares` as the slippage bound. The allocator keeper, not the user
transaction, moves idle liquidity into the Morpho market, keeping utilization under `U_MAX` (90%). `withdrawLend`
calls `forceDeallocate` when the vault's idle balance cannot cover the redemption.

### 3.2 Borrow or open a short

```mermaid
sequenceDiagram
    actor B as Borrower
    participant Web as web
    participant C as compliance
    participant R as LendoraRouter
    participant O as LendoraOracle
    participant CL as CollateralToken (clUSDG)
    participant M as Morpho Blue
    participant W as StockWrapper
    participant D as Swap target (allowlisted)
    B->>Web: open short
    Web->>C: POST /v1/compliance/attest (via /api/compliance proxy)
    C->>C: geo, sanctions screen, accepted terms
    C-->>Web: EIP-712 Attestation(user, expiry) signature
    B->>R: openShort(stock, collateralIn, borrowAmount, swap, compound, receiver, att, deadline)
    R->>O: guardReasons() must be 0
    R->>R: recover attestation signer
    R->>CL: mint(collateralIn) from USDG
    R->>M: supplyCollateral(onBehalf = borrower)
    R->>M: borrow(borrowAmount, onBehalf = borrower)
    R->>W: unwrap to the Stock Token
    R->>D: sell Stock Token for USDG (balance-delta checked)
    R->>O: priceAt(now + 24h)
    R->>R: HF at t+24h >= 1.10, per-address cap, global clUSDG cap
    R-->>B: USDG proceeds (or compounded as collateral)
```

New positions (`borrow`, `openShort`) must pass two checks before any state changes. The oracle guard has to be
clear, and the caller needs a valid attestation from the configured signer (`_openChecks`). After the position is
built, `_positionChecks` requires a health factor of at least 1.10 at the oracle price 24 hours ahead, which already
includes any weekend or event buffer, and checks the per-address and global caps. `borrow` is the same flow without
the swap. The user authorizes the router on Morpho once (`setAuthorization`, or `morphoAuthorizeWithSig` inside a
`multicall`).

### 3.3 Close a short or repay

```mermaid
sequenceDiagram
    actor B as Borrower
    participant R as LendoraRouter
    participant D as Swap target
    participant W as StockWrapper
    participant M as Morpho Blue
    participant CL as clUSDG
    B->>R: closeShort(stock, usdgIn, swap, receiver, deadline)
    R->>D: buy the Stock Token with USDG
    R->>W: wrap
    R->>M: repay(all borrowShares, onBehalf = borrower)
    R->>M: withdrawCollateral(all)
    R->>CL: unwrap to USDG
    R-->>B: USDG collateral, leftover Stock Token
```

Exits (`closeShort`, `repay`, `withdrawCollateral`, `withdrawLend`) never need an attestation or a guard check, so
users can always leave, including during weekends and when the guard is tripped. `addCollateral` is a rescue top-up.
It also needs no attestation, but it only works for positions that already have debt (`NoDebtPosition`), so new
exposure always goes through the attested entries.

### 3.4 Liquidation

```mermaid
sequenceDiagram
    participant K as liquidator keeper
    participant LQ as LendoraLiquidator
    participant M as Morpho Blue
    participant CL as clUSDG
    participant D as Swap target
    participant W as StockWrapper
    K->>K: scan Borrow events, compute health factors
    K->>LQ: liquidate(Liquidation{market, borrower, seizedAssets, swap, minProfit, ...})
    LQ->>M: liquidate(market, borrower, seized, shares, data)
    M-->>LQ: seized clUSDG
    M->>LQ: onMorphoLiquidate(repaidAssets, data)
    LQ->>CL: unwrap to USDG
    LQ->>D: buy the Stock Token
    LQ->>W: wrap, approve Morpho for repaidAssets
    M->>LQ: pull repaid wSTOCK
    LQ-->>K: USDG profit to recipient (>= minProfit)
```

Liquidations are standard Morpho Blue liquidations, open to any liquidator. `LendoraLiquidator` is the protocol's
fallback. Inside Morpho's callback it unwraps the seized `clUSDG`, buys the Stock Token through an allowlisted target,
wraps it and repays. A transient-storage flag (`IN_LIQUIDATION`) makes sure the callback only runs during the
contract's own call. The contract holds nothing after a call.

### 3.5 Delta-neutral vault (USDG Earn)

```mermaid
sequenceDiagram
    actor U as Depositor
    participant V as DeltaNeutralVault
    participant N as NavOracle
    participant S as StrategyManager
    participant P as Perp adapter
    participant RB as dn-rebalancer
    participant NR as nav-reporter
    participant CS as nav-cosigner
    U->>V: deposit(assets, receiver, attestation)
    V->>N: nav() fresh? session open? within totalCap?
    V-->>U: sEARN shares
    RB->>V: sendToStrategy(amount)
    RB->>S: buySpot, lend (Vault V2), depositMargin, adjustShort
    S->>P: depositMargin / adjustShort
    NR->>P: read venue equity and short sizes (offchain)
    NR->>CS: POST /cosign (when the move needs two signers)
    NR->>N: submit(Report, signatures)
    U->>V: requestRedeem(shares) (escrow)
    Note over V: settle(maxCount): FIFO at the NAV of settlement (permissionless)
    U->>V: claim(id)
```

`DeltaNeutralVault` is an ERC-4626 vault over USDG, priced at `NavOracle.nav()`. Deposits require the router's
compliance attestation, a fresh NAV, an open feed session and room under `totalCap`. `StrategyManager` holds the
spot, lent and perp legs and enforces per-sleeve limits. The venue's perp equity cannot be read onchain, so NAV comes
from EIP-712 reports. A report that moves the NAV by more than 1% needs two distinct signers: the nav-reporter plus
an independent co-signer. Exits are instant up to the idle USDG, or go through the `requestRedeem` / `settle` /
`claim` queue. The only `IPerpAdapter` in the repo is `MockPerpVenue`, which the testnet deploy uses.

## 4. Data and price flow

```mermaid
flowchart LR
    subgraph feeds["Price inputs"]
        cl["Chainlink stock/USD<br/>(multiplier already applied)"]
        cu["Chainlink USDG/USD"]
        mh["MarketHours<br/>sessions + event windows"]
    end
    subgraph oracle["LendoraOracle"]
        chk["checks: answer > 0, in abs range,<br/>in [0.5x, 2x] of last good,<br/>heartbeat + staleGrace"]
        buf["buffer b = max(closure behind, closure ahead,<br/>event windows, guardian floor), capped at bMax"]
        px["price = valuePerToken * usdg * 10^scale<br/>/ (stock * (1 + b))"]
        guard["guardReasons bitmask: MANUAL, DEVIATION,<br/>STALE, SANITY, USDG_FEED, SEQUENCER, CALENDAR, ..."]
    end
    cl --> chk
    cu --> chk
    mh --> buf
    chk --> px
    buf --> px
    px --> morpho["Morpho Blue: liquidations,<br/>borrow limits"]
    px --> router["LendoraRouter: HF at t+24h"]
    guard --> router
    twap["DEX pool TWAP"] --> gk["guard keeper"]
    cl --> gk
    gk -- "poke / trip / clear" --> guard
    fm["feed-mirror (testnet only)"] -- "copies mainnet rounds" --> cl

    chain["Chain events: Morpho, Vault V2, Router,<br/>Oracle, FeeSplitter, DN contracts"] --> idx["indexer (Ponder)"]
    idx --> pg[("Postgres: market, position,<br/>snapshot, rollup, fee_day, dn_nav, ...")]
    pg --> api["api /v1/markets, /v1/positions,<br/>/v1/vault/*, /v1/protocol/revenue"]
    pg --> mon["monitor"]
    api --> web["web"]
    lens["ShortInterestLens (onchain view)"] --> web
```

`LendoraOracle` combines the Chainlink stock and USDG feeds with a closure/event buffer. When the stock's feed session
is closed (weekends, holidays, overnight) or an earnings window is near, the buffer lowers the collateral value by up
to `bMax` (20%). It ramps in over `rampIn` (4h) before a closure. A feed failure never makes the price revert: the
oracle falls back to the last good answer and trips the guard, which blocks new entries but leaves exits and
liquidations working. Onchain events flow through the Ponder indexer into Postgres, which serves the public API, the
short-interest dashboard and the monitor. `ShortInterestLens` gives the same per-stock numbers straight from chain.

## 5. Deployment and infrastructure

```mermaid
flowchart TB
    subgraph local["Local (scripts/dev.sh, docker-compose.yml)"]
        anvil["anvil :8545 + DeployLocal"]
        lpg[("postgres:16")]
        lredis[("redis:7")]
        lsvc["compliance, indexer, api, web, keepers"]
    end
    subgraph contracts["Foundry deploy scripts (contracts/script)"]
        dl["DeployLocal.s.sol (31337)"]
        dt["DeployTestnet / DeployTestnetFees /<br/>DeployTestnetVault (46630)"]
        df["DeployFork.s.sol (fork of 4663)"]
        dm["DeployMainnet.s.sol + VerifyRoles.s.sol (4663)"]
    end
    launch["packages/launch<br/>scripts/mainnet-launch.sh"] --> dm
    dl & dt & df & dm -- "write" --> addr["packages/sdk/addresses.json"]
    subgraph svc["Railway (infra/railway/*.json), one image infra/Dockerfile, SERVICE=..."]
        s1["indexer, reconcile (cron)"]
        s2["api, compliance"]
        s3["allocator, guard, liquidator, fee-converter"]
        s4["alerts, monitor"]
        s5["dn-rebalancer, nav-reporter, nav-cosigner"]
        s6["feed-mirror, venue-mirror (testnet)"]
    end
    webimg["web: infra/web.Dockerfile<br/>(behind Vercel or Cloudflare for geo headers)"]
    addr --> svc
    addr --> webimg
    ci["GitHub Actions: ci.yml (forge fmt/build/test,<br/>pnpm typecheck/lint/test, e2e, lighthouse),<br/>fork-tests.yml"]
```

Contracts are deployed with Foundry scripts, which write addresses into `packages/sdk/addresses.json`, the single
source every service reads. Every backend service is built from one image (`infra/Dockerfile`), selected by `SERVICE`,
and has a Railway config-as-code file with a health check. The web app has its own image. Mainnet goes only through
`scripts/mainnet-launch.sh` (`packages/launch`): gates, environment and Safe checks, a fork rehearsal, a
typed-confirmation broadcast, then `VerifyRoles`. According to `infra/README.md`, no hosted services are deployed
yet. The contracts are live on Robinhood Chain testnet (46630). Mainnet has not been deployed.
