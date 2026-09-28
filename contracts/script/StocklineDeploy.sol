// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {StockWrapper} from "../src/StockWrapper.sol";
import {MarketHours} from "../src/MarketHours.sol";
import {CollateralToken} from "../src/CollateralToken.sol";
import {StocklineOracle} from "../src/oracles/StocklineOracle.sol";
import {StocklineOracleBase} from "../src/oracles/StocklineOracleBase.sol";
import {IStocklineOracle} from "../src/interfaces/IStocklineOracle.sol";
import {IMarketHours} from "../src/interfaces/IMarketHours.sol";
import {VaultV2Ids} from "../src/libraries/VaultV2Ids.sol";
import {
    IVaultV2Min,
    IVaultV2FactoryMin,
    IMorphoMarketV1AdapterV2Min,
    IMorphoMarketV1AdapterV2FactoryMin
} from "../src/interfaces/external/IMorphoVaultV2.sol";
import {CalendarJson} from "./lib/CalendarJson.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {StocklineRouter} from "../src/StocklineRouter.sol";
import {StocklineLiquidator} from "../src/StocklineLiquidator.sol";
import {IStocklineRouter} from "../src/interfaces/IStocklineRouter.sol";
import {ShortInterestLens} from "../src/ShortInterestLens.sol";
import {FeeSplitter} from "../src/fees/FeeSplitter.sol";
import {IFeeSplitter} from "../src/interfaces/IFeeSplitter.sol";
import {FeeConverter} from "../src/fees/FeeConverter.sol";
import {IFeeConverter} from "../src/interfaces/IFeeConverter.sol";

/// @title StocklineDeploy
/// @notice Deployment logic shared by the scripts (anvil, fork) and the fork tests, so tests exercise exactly what the
/// scripts run. Every call is made by the deployer (broadcast in scripts, prank in tests); nothing here broadcasts.
/// Core: TimelockController, MarketHours (calendar pushed, then owned by the timelock), `clUSDG`.
/// Per stock (LM-R10, LM-R20, LM-R23): StockWrapper → StocklineOracle → Morpho market (wSTOCK/clUSDG,
/// AdaptiveCurveIRM,
/// LLTV 77%) seeded against share inflation → Vault V2 `rSTOCK` from the official factory → MorphoMarketV1AdapterV2
/// →
/// caps (absolute = launch cap from D8, relative = U_MAX) → 10% performance fee to the `FeeSplitter` (FE-R1) →
/// maxRate → roles (curator multisig,
/// allocators, sentinel = guardian, owner = timelock) → 48h timelocks on every harmful curator action.
abstract contract StocklineDeploy {
    using MarketParamsLib for MarketParams;

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant LLTV = 0.77e18;
    /// @notice First block the indexer should read (written as `startBlock` when set; Phase 2 testnet deployment).
    string internal _startBlock;
    uint256 internal constant U_MAX = 0.9e18;
    uint256 internal constant PERFORMANCE_FEE = 0.1e18;
    /// @notice Vault V2 `MAX_MAX_RATE` (200% APR): interest reaches the share price at up to this rate.
    uint256 internal constant MAX_RATE = 200e16 / uint256(365 days);
    /// @notice Raw Stock Token units supplied to each market and deposited to each vault for a dead address, so the
    /// first real supplier cannot be front-run by a share-price inflation (Vault V2 and adapter NatSpec).
    uint256 internal constant SEED = 1e12;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct CoreConfig {
        address deployer;
        address morpho;
        address irm;
        address usdg;
        address usdgFeed;
        address vaultFactory;
        address adapterFactory;
        address issuerRegistry; // for the WRAPPER_BLOCKED guard; address(0) = skip
        address sequencerFeed; // OR-R6; address(0) on chain 4663 today
        address owner; // multisig: timelock proposer and executor
        address curator; // multisig
        address guardian; // multisig; vault sentinel
        address allocator; // keeper EOA
        address guardKeeper; // keeper EOA
        address treasury; // multisig: treasury share of the performance fee (Q9)
        address backstopReserve; // multisig: backstop share until Phase 5's BackstopPool (FE-R3, Q9)
        address feeKeeper; // keeper EOA: may only trigger FeeConverter.convert (FE-R4)
        uint256 timelockDelay; // 48h
        address attestationSigner; // RT-R2 compliance signer
        uint256 globalCollateralCap; // clUSDG raw units ($4M at launch, 10-risk)
        address swapTarget; // RT-R3 first allowlisted target (UniversalRouter on 4663, A8)
        IStocklineRouter.SwapMode swapMode;
    }

    struct StockConfig {
        string ticker;
        address token;
        address feed;
        uint64 sigmaWad;
        uint256 launchCapUsd; // whole USD (D8)
        uint256 perAddressCapUsd; // whole USD (D8), used by the router (task 8)
    }

    struct Core {
        TimelockController timelock;
        MarketHours marketHours;
        CollateralToken clUSDG;
        StocklineRouter router; // ERC1967 proxy
        address routerImplementation;
        StocklineLiquidator liquidator;
        ShortInterestLens lens; // Phase 2 (SI-R20, SI-R21)
        FeeSplitter feeSplitter; // Phase 3: every vault's performance fee recipient (FE-R1, FE-R2)
        FeeConverter treasuryConverter; // FE-R4: treasury share → USDG → treasury
        FeeConverter backstopConverter; // FE-R4: backstop share → USDG → BackstopReserve (FE-R3)
    }

    struct StockDeployment {
        StockWrapper wrapper;
        StocklineOracle oracle;
        MarketParams market;
        address vault;
        address adapter;
        uint256 capAssets;
    }

    // ------------------------------------------------------------------ Core

    function _deployCore(CoreConfig memory c, StockConfig[] memory stocks) internal returns (Core memory core) {
        address[] memory ms = new address[](1);
        ms[0] = c.owner;
        core.timelock = new TimelockController(c.timelockDelay, ms, ms, address(0));

        core.marketHours = new MarketHours(c.deployer);
        string memory json = CalendarJson.read();
        core.marketHours.replaceSessionsFrom(0, CalendarJson.sessions(json));
        for (uint256 i; i < stocks.length; i++) {
            IMarketHours.EventWindow[] memory ev = CalendarJson.events(json, stocks[i].ticker);
            if (ev.length > 0) core.marketHours.replaceEventsFrom(stocks[i].token, 0, ev);
        }
        core.marketHours.transferOwnership(address(core.timelock));

        core.clUSDG = new CollateralToken(c.usdg, c.morpho, "Stockline Collateral USDG", "clUSDG");

        // RT-R7: UUPS proxy; the deployer lists markets, then `_finalize` hands it to the timelock.
        core.routerImplementation = address(new StocklineRouter(c.morpho, address(core.clUSDG)));
        core.router = StocklineRouter(
            address(
                new ERC1967Proxy(
                    core.routerImplementation,
                    abi.encodeCall(StocklineRouter.initialize, (c.deployer, c.attestationSigner, c.globalCollateralCap))
                )
            )
        );
        core.clUSDG.setRouter(address(core.router));
        if (c.swapTarget != address(0)) core.router.setSwapTarget(c.swapTarget, c.swapMode);

        // FE-R4 (Q10): one converter per recipient, both shares converted to USDG and forwarded to the multisig. The
        // deployer registers the vaults, then `_finalize` hands them to the timelock.
        core.treasuryConverter = new FeeConverter(c.deployer, c.usdg, c.treasury, c.feeKeeper);
        core.backstopConverter = new FeeConverter(c.deployer, c.usdg, c.backstopReserve, c.feeKeeper);
        // FE-R1…R3: the fee recipient exists before any vault is configured; owned by the timelock from the start.
        core.feeSplitter = new FeeSplitter(
            address(core.timelock), _feeRecipients(address(core.treasuryConverter), address(core.backstopConverter))
        );
    }

    /// @notice Launch fee split (Q8): 5,000 bps treasury, 5,000 bps backstop (FE-R3), each through its converter.
    function _feeRecipients(address treasuryShare, address backstopShare)
        internal
        pure
        returns (IFeeSplitter.Recipient[] memory r)
    {
        r = new IFeeSplitter.Recipient[](2);
        r[0] = IFeeSplitter.Recipient(treasuryShare, 5000);
        r[1] = IFeeSplitter.Recipient(backstopShare, 5000);
    }

    /// @notice After every stock is listed: the router's owner becomes the timelock; the fallback liquidator (holds no
    /// funds) is deployed with the same swap target and handed to the owner multisig.
    function _finalize(CoreConfig memory c, Core memory core) internal returns (Core memory) {
        core.router.transferOwnership(address(core.timelock));
        core.liquidator = new StocklineLiquidator(c.morpho, address(core.clUSDG), c.deployer);
        if (c.swapTarget != address(0)) {
            core.liquidator.setSwapTarget(c.swapTarget, StocklineLiquidator.SwapMode(uint8(c.swapMode)));
        }
        core.liquidator.transferOwnership(c.owner);
        FeeConverter[2] memory convs = [core.treasuryConverter, core.backstopConverter];
        for (uint256 i; i < 2; i++) {
            if (c.swapTarget != address(0)) {
                convs[i].setSwapTarget(c.swapTarget, IFeeConverter.SwapMode(uint8(c.swapMode)));
            }
            convs[i].transferOwnership(address(core.timelock));
        }
        return core;
    }

    /// @notice Phase 2: the stateless `ShortInterestLens` over the listed stocks (SI-R21: list fixed at deployment).
    /// Deployed after `_finalize`, so every Phase 1 address is unchanged; redeploy it to change the list.
    function _deployLens(Core memory core, StockConfig[] memory stocks) internal returns (Core memory) {
        address[] memory tokens = new address[](stocks.length);
        for (uint256 i; i < stocks.length; i++) {
            tokens[i] = stocks[i].token;
        }
        core.lens = new ShortInterestLens(address(core.router), tokens);
        return core;
    }

    // ------------------------------------------------------------------ Per stock

    function _oracleParams(uint64 sigmaWad) internal pure returns (IStocklineOracle.Params memory) {
        return IStocklineOracle.Params({
            zWad: 2.5e18,
            sigmaWad: sigmaWad,
            bMinWad: 0.01e18,
            bMaxWad: 0.2e18,
            rampIn: 4 hours,
            stockHeartbeat: 86_400,
            usdgHeartbeat: 86_400,
            staleGrace: 10 minutes,
            sequencerGrace: 1 hours,
            bandLowWad: 0.5e18,
            bandHighWad: 2e18,
            maxQuietMultiplierStepWad: 0.05e18
        });
    }

    function _deployStock(CoreConfig memory c, Core memory core, StockConfig memory s)
        internal
        returns (StockDeployment memory d)
    {
        require(IERC20(s.token).balanceOf(c.deployer) >= 2 * SEED, "deployer needs 2 * SEED raw stock units");
        d.wrapper = new StockWrapper(s.token, s.ticker, address(0)); // LM-R6: no issuer allowlist (D10 R3)
        d.oracle = new StocklineOracle(
            StocklineOracleBase.Deployment({
                stockFeed: s.feed,
                usdgFeed: c.usdgFeed,
                stockToken: s.token,
                wrapper: address(d.wrapper),
                marketHours: address(core.marketHours),
                owner: address(core.timelock),
                guardian: c.guardian,
                keeper: c.guardKeeper,
                sequencerFeed: c.sequencerFeed,
                blocklist: c.issuerRegistry
            }),
            _oracleParams(s.sigmaWad),
            address(core.clUSDG)
        );

        // LM-R10: the market with the exact launch params.
        d.market = MarketParams({
            loanToken: address(d.wrapper),
            collateralToken: address(core.clUSDG),
            oracle: address(d.oracle),
            irm: c.irm,
            lltv: LLTV
        });
        IMorpho(c.morpho).createMarket(d.market);
        IERC20(s.token).approve(address(d.wrapper), 2 * SEED);
        d.wrapper.wrap(2 * SEED, c.deployer);
        IERC20(address(d.wrapper)).approve(c.morpho, SEED);
        IMorpho(c.morpho).supply(d.market, SEED, 0, DEAD, "");

        // LM-R20: Vault V2 and its market adapter from the official factories.
        d.vault = IVaultV2FactoryMin(c.vaultFactory)
            .createVaultV2(c.deployer, address(d.wrapper), keccak256(bytes(s.ticker)));
        d.adapter = IMorphoMarketV1AdapterV2FactoryMin(c.adapterFactory).createMorphoMarketV1AdapterV2(d.vault);
        (uint256 answer,) = d.oracle.stockAnswer();
        d.capAssets = s.launchCapUsd * 1e18 * 10 ** uint256(_feedDecimals(s.feed)) / answer;
        _configureVault(c, core, s, d);
        core.treasuryConverter.setVault(d.vault, address(d.oracle)); // FE-R4
        core.backstopConverter.setVault(d.vault, address(d.oracle));
        core.router
            .listMarket(
                s.token,
                IStocklineRouter.Market({
                    wrapper: address(d.wrapper),
                    vault: d.vault,
                    adapter: d.adapter,
                    params: d.market,
                    perAddressCapUsd: s.perAddressCapUsd * 1e18,
                    listed: true
                })
            );
    }

    function _configureVault(CoreConfig memory c, Core memory core, StockConfig memory s, StockDeployment memory d)
        internal
    {
        IVaultV2Min v = IVaultV2Min(d.vault);
        v.setName(string.concat("Stockline ", s.ticker));
        v.setSymbol(string.concat("r", s.ticker));
        v.setCurator(c.deployer); // temporary; all timelocks are still 0

        _curate(v, abi.encodeCall(IVaultV2Min.setIsAllocator, (c.allocator, true)));
        _curate(v, abi.encodeCall(IVaultV2Min.setIsAllocator, (c.owner, true)));
        _curate(v, abi.encodeCall(IVaultV2Min.setIsAllocator, (c.deployer, true)));
        _curate(v, abi.encodeCall(IVaultV2Min.addAdapter, (d.adapter)));
        bytes[3] memory ids = [
            VaultV2Ids.adapterIdData(d.adapter),
            VaultV2Ids.collateralIdData(address(core.clUSDG)),
            VaultV2Ids.marketIdData(d.adapter, d.market)
        ];
        for (uint256 i; i < 3; i++) {
            _curate(v, abi.encodeCall(IVaultV2Min.increaseAbsoluteCap, (ids[i], d.capAssets)));
            _curate(v, abi.encodeCall(IVaultV2Min.increaseRelativeCap, (ids[i], U_MAX))); // LM-R23 / LM-R30
        }
        // FE-R1: recipient first (Vault V2 refuses a fee without one), both before `_lockVault` timelocks them (48h).
        _curate(v, abi.encodeCall(IVaultV2Min.setPerformanceFeeRecipient, (address(core.feeSplitter))));
        _curate(v, abi.encodeCall(IVaultV2Min.setPerformanceFee, (PERFORMANCE_FEE)));
        v.setMaxRate(MAX_RATE); // Vault V2 defaults to 0, which would keep interest out of the share price
        // Drop the temporary role, unless the deployer is also a configured allocator (testnet default: one key holds
        // every role); removing it then would strip the real allocator (Phase 2 fix, found by the testnet dry run).
        if (c.deployer != c.allocator && c.deployer != c.owner) {
            _curate(v, abi.encodeCall(IVaultV2Min.setIsAllocator, (c.deployer, false)));
        }

        // Seed the vault for a dead address (share inflation).
        IERC20(address(d.wrapper)).approve(d.vault, SEED);
        v.deposit(SEED, DEAD);

        _lockAdapter(IMorphoMarketV1AdapterV2Min(d.adapter), c.timelockDelay);
        _lockVault(v, c.timelockDelay);

        v.setIsSentinel(c.guardian, true); // LM-R32: guardian = sentinel
        v.setCurator(c.curator);
        v.setOwner(address(core.timelock));
    }

    /// @dev Curator action with the current (zero) timelock: submit, then execute.
    function _curate(IVaultV2Min v, bytes memory data) internal {
        v.submit(data);
        (bool ok, bytes memory ret) = address(v).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// @dev 48h on every curator action that can hurt depositors (Vault V2 decreases, `revoke` and sentinel actions
    /// stay instant). `increaseTimelock` itself goes last.
    function _lockVault(IVaultV2Min v, uint256 delay) internal {
        bytes4[15] memory sels = [
            IVaultV2Min.setIsAllocator.selector,
            IVaultV2Min.addAdapter.selector,
            IVaultV2Min.removeAdapter.selector,
            IVaultV2Min.increaseAbsoluteCap.selector,
            IVaultV2Min.increaseRelativeCap.selector,
            IVaultV2Min.setPerformanceFee.selector,
            IVaultV2Min.setPerformanceFeeRecipient.selector,
            IVaultV2Min.setManagementFee.selector,
            IVaultV2Min.setManagementFeeRecipient.selector,
            IVaultV2Min.setForceDeallocatePenalty.selector,
            IVaultV2Min.setReceiveSharesGate.selector,
            IVaultV2Min.setSendSharesGate.selector,
            IVaultV2Min.setReceiveAssetsGate.selector,
            IVaultV2Min.setSendAssetsGate.selector,
            IVaultV2Min.setAdapterRegistry.selector
        ];
        for (uint256 i; i < sels.length; i++) {
            _curate(v, abi.encodeCall(IVaultV2Min.increaseTimelock, (sels[i], delay)));
        }
        _curate(v, abi.encodeCall(IVaultV2Min.increaseTimelock, (IVaultV2Min.abdicate.selector, delay)));
        _curate(v, abi.encodeCall(IVaultV2Min.increaseTimelock, (IVaultV2Min.increaseTimelock.selector, delay)));
    }

    /// @dev "Before adding the adapter to the vault, its timelocks must be properly set" (adapter NatSpec).
    function _lockAdapter(IMorphoMarketV1AdapterV2Min a, uint256 delay) internal {
        bytes4[4] memory sels = [
            IMorphoMarketV1AdapterV2Min.setSkimRecipient.selector,
            IMorphoMarketV1AdapterV2Min.burnShares.selector,
            IMorphoMarketV1AdapterV2Min.abdicate.selector,
            IMorphoMarketV1AdapterV2Min.increaseTimelock.selector
        ];
        for (uint256 i; i < sels.length; i++) {
            bytes memory data = abi.encodeCall(IMorphoMarketV1AdapterV2Min.increaseTimelock, (sels[i], delay));
            a.submit(data);
            a.increaseTimelock(sels[i], delay);
        }
    }

    function _feedDecimals(address feed) internal view returns (uint8) {
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok, "feed decimals");
        return abi.decode(ret, (uint8));
    }

    // ------------------------------------------------------------------ Address book (LM-R10)

    /// @notice Write the deployment under `key` in packages/sdk/addresses.json ("31337", "fork-4663", "46630"; never
    /// "4663").
    function _writeAddresses(
        string memory key,
        CoreConfig memory c,
        Core memory core,
        StockConfig[] memory stocks,
        StockDeployment[] memory ds,
        string memory extraKey,
        string memory extraJson
    ) internal {
        require(keccak256(bytes(key)) != keccak256("4663"), "never write the real 4663 key from a script");
        string memory chainJson = _chainJson(key, c, core, stocks, ds, extraKey, extraJson);
        VM.writeJson(chainJson, "../packages/sdk/addresses.json", string.concat(".chains.", key));
    }

    /// @notice One chain entry of the address book (the shape of `addresses.json["chains"][key]`).
    function _chainJson(
        string memory key,
        CoreConfig memory c,
        Core memory core,
        StockConfig[] memory stocks,
        StockDeployment[] memory ds,
        string memory extraKey,
        string memory extraJson
    ) internal returns (string memory) {
        string memory obj = string.concat("chain-", key);
        VM.serializeAddress(obj, "morpho", c.morpho);
        VM.serializeAddress(obj, "adaptiveCurveIrm", c.irm);
        VM.serializeAddress(obj, "usdg", c.usdg);
        VM.serializeAddress(obj, "usdgFeed", c.usdgFeed);
        VM.serializeAddress(obj, "timelock", address(core.timelock));
        VM.serializeAddress(obj, "marketHours", address(core.marketHours));
        VM.serializeAddress(obj, "clUSDG", address(core.clUSDG));
        VM.serializeAddress(obj, "router", address(core.router));
        VM.serializeAddress(obj, "routerImplementation", core.routerImplementation);
        VM.serializeAddress(obj, "liquidator", address(core.liquidator));
        if (address(core.lens) != address(0)) VM.serializeAddress(obj, "lens", address(core.lens));
        if (address(core.feeSplitter) != address(0)) {
            VM.serializeAddress(obj, "feeSplitter", address(core.feeSplitter));
            VM.serializeAddress(obj, "treasuryConverter", address(core.treasuryConverter));
            VM.serializeAddress(obj, "backstopConverter", address(core.backstopConverter));
        }
        if (bytes(_startBlock).length > 0) VM.serializeString(obj, "startBlock", _startBlock);
        VM.serializeAddress(obj, "vaultV2Factory", c.vaultFactory);
        VM.serializeAddress(obj, "adapterFactory", c.adapterFactory);
        string memory roles = _rolesJson(string.concat(obj, "-roles"), c);
        VM.serializeString(obj, "roles", roles);
        if (bytes(extraKey).length > 0) VM.serializeString(obj, extraKey, extraJson);

        return VM.serializeString(obj, "stocks", _stocksJson(key, stocks, ds));
    }

    function _rolesJson(string memory o, CoreConfig memory c) internal returns (string memory) {
        VM.serializeAddress(o, "owner", c.owner);
        VM.serializeAddress(o, "curator", c.curator);
        VM.serializeAddress(o, "guardian", c.guardian);
        VM.serializeAddress(o, "allocator", c.allocator);
        VM.serializeAddress(o, "guardKeeper", c.guardKeeper);
        VM.serializeAddress(o, "treasury", c.treasury);
        VM.serializeAddress(o, "feeKeeper", c.feeKeeper);
        return VM.serializeAddress(o, "backstopReserve", c.backstopReserve);
    }

    function _stocksJson(string memory key, StockConfig[] memory stocks, StockDeployment[] memory ds)
        internal
        returns (string memory json)
    {
        string memory o = string.concat("chain-", key, "-stocks");
        for (uint256 i; i < ds.length; i++) {
            json = VM.serializeString(o, stocks[i].ticker, _stockJson(key, stocks[i], ds[i]));
        }
    }

    function _stockJson(string memory key, StockConfig memory s, StockDeployment memory d)
        internal
        returns (string memory)
    {
        string memory o = string.concat(key, "-", s.ticker);
        VM.serializeAddress(o, "stockToken", s.token);
        VM.serializeAddress(o, "feed", s.feed);
        VM.serializeAddress(o, "wrapper", address(d.wrapper));
        VM.serializeAddress(o, "oracle", address(d.oracle));
        VM.serializeAddress(o, "vault", d.vault);
        VM.serializeAddress(o, "adapter", d.adapter);
        VM.serializeBytes32(o, "marketId", Id.unwrap(d.market.id()));
        VM.serializeBytes32(o, "adapterMarketCapId", VaultV2Ids.marketId(d.adapter, d.market));
        VM.serializeUint(o, "lltv", d.market.lltv);
        VM.serializeUint(o, "capAssets", d.capAssets);
        return VM.serializeUint(o, "perAddressCapUsd", s.perAddressCapUsd);
    }
}
