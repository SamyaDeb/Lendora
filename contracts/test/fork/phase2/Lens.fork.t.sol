// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {IIrm} from "morpho-blue/src/interfaces/IIrm.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";
import {ForkConfig} from "../../../script/ForkConfig.sol";
import {Phase1ForkBase} from "../phase1/Phase1ForkBase.sol";
import {IShortInterestLens} from "../../../src/interfaces/IShortInterestLens.sol";
import {IMarketHours} from "../../../src/interfaces/IMarketHours.sol";

/// @notice SI-R20 / SI-R21 on a fork of Robinhood Chain: the lens over the simulated deployment (live Morpho Blue,
/// AdaptiveCurveIrm, Vault V2 factories, Stock Tokens with their live multipliers, Chainlink feeds) equals the
/// contracts' own views. Skips without `ROBINHOOD_RPC_URL`.
contract LensForkTest is Phase1ForkBase, ForkConfig {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    address internal deployer = makeAddr("deployer");
    address internal lender = makeAddr("lender");
    Core internal core;
    StockDeployment[] internal ds;
    StockConfig[] internal cfg;

    function setUp() public override {
        super.setUp();
        CoreConfig memory c = forkCoreConfig(deployer);
        StockConfig[] memory s = forkStocks();
        for (uint256 i; i < s.length; i++) {
            cfg.push(s[i]);
            deal(s[i].token, deployer, 2 * SEED, true);
        }
        vm.startPrank(deployer);
        core = _deployCore(c, s);
        for (uint256 i; i < s.length; i++) {
            ds.push(_deployStock(c, core, s[i]));
        }
        core = _finalize(c, core);
        core = _deployLens(core, s);
        vm.stopPrank();
    }

    function _assertMatchesChain(uint256 i, IShortInterestLens.StockSnapshot memory s) internal view {
        StockDeployment memory d = ds[i];
        (uint256 sa,, uint256 ba,) = IMorpho(MORPHO).expectedMarketBalances(d.market);
        uint256 idle = IERC20(address(d.wrapper)).balanceOf(d.vault);
        assertEq(s.stockToken, cfg[i].token);
        assertEq(s.suppliedShares, d.wrapper.underlyingEquivalent(sa + idle), "supplied after the live multiplier");
        assertEq(s.borrowedShares, d.wrapper.underlyingEquivalent(ba));
        assertEq(s.utilizationWad, sa == 0 ? 0 : ba * 1e18 / sa);
        Market memory stored = IMorpho(MORPHO).market(d.market.id());
        assertEq(s.borrowRatePerSecWad, IIrm(ADAPTIVE_CURVE_IRM).borrowRateView(d.market, stored), "live IRM");
        assertEq(s.bufferWad, d.oracle.buffer());
        assertEq(s.guardTripped, d.oracle.guardTripped());
        assertEq(s.marketOpen, IMarketHours(address(core.marketHours)).isOpen(block.timestamp));
    }

    function test_SI_R20_fork_snapshotAllEqualsLiveViews() public view {
        IShortInterestLens.StockSnapshot[] memory all = core.lens.snapshotAll();
        assertEq(all.length, 3);
        for (uint256 i; i < 3; i++) {
            _assertMatchesChain(i, all[i]);
            assertGt(ds[i].wrapper.multiplier(), 1e18, "live dividend multipliers are > 1 (01 s3)");
        }
    }

    function test_SI_R20_fork_supplyAndAccrualAfterAMonth() public {
        uint256 i = 1; // NVDA
        deal(cfg[i].token, lender, 100e18, true);
        vm.startPrank(lender);
        IERC20(cfg[i].token).approve(address(ds[i].wrapper), type(uint256).max);
        ds[i].wrapper.wrap(100e18, lender);
        IERC20(address(ds[i].wrapper)).approve(MORPHO, type(uint256).max);
        IMorpho(MORPHO).supply(ds[i].market, 100e18, 0, lender, "");
        vm.stopPrank();
        _assertMatchesChain(i, core.lens.snapshot(cfg[i].token));
        vm.warp(block.timestamp + 30 days);
        _assertMatchesChain(i, core.lens.snapshot(cfg[i].token));
    }
}
