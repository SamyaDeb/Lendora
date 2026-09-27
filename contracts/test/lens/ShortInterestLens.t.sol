// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {IIrm} from "morpho-blue/src/interfaces/IIrm.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";
import {LocalStockline} from "../utils/LocalStockline.sol";
import {ShortInterestLens} from "../../src/ShortInterestLens.sol";
import {IShortInterestLens} from "../../src/interfaces/IShortInterestLens.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";

/// @notice SI-R20 (values accrued to block.timestamp) and SI-R21 (stateless, list fixed at deployment) on the full
/// local deployment (script/StocklineDeploy.sol with mocks).
contract ShortInterestLensTest is LocalStockline {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    ShortInterestLens internal lens;
    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");
    uint256 internal constant NVDA = 1;

    function setUp() public override {
        super.setUp();
        core = _deployLens(core, _stockConfigs());
        lens = core.lens;
        _onboard(borrower, 0, 1_000_000e6);
        // Liquidity: a direct Morpho supply (permissionless) plus a vault deposit that stays idle.
        m.tokens[NVDA].mint(lender, 1100e18);
        vm.startPrank(lender);
        m.tokens[NVDA].approve(address(ds[NVDA].wrapper), type(uint256).max);
        ds[NVDA].wrapper.wrap(1000e18, lender);
        IERC20(address(ds[NVDA].wrapper)).approve(m.morpho, type(uint256).max);
        IMorpho(m.morpho).supply(ds[NVDA].market, 1000e18, 0, lender, "");
        m.tokens[NVDA].approve(address(core.router), type(uint256).max);
        core.router.lend(address(m.tokens[NVDA]), 100e18, 0, lender, block.timestamp);
        vm.stopPrank();
    }

    function _stockConfigs() internal view returns (StockConfig[] memory s) {
        s = new StockConfig[](3);
        s[0] = StockConfig("SPY", address(m.tokens[0]), address(m.feeds[0]), 0.17e18, 1_000_000, 75_000);
        s[1] = StockConfig("NVDA", address(m.tokens[1]), address(m.feeds[1]), 0.52e18, 1_000_000, 250_000);
        s[2] = StockConfig("AAPL", address(m.tokens[2]), address(m.feeds[2]), 0.28e18, 250_000, 35_000);
    }

    function _borrowNvda(uint256 amount) internal {
        IStocklineRouter.Attestation memory att = _attest(borrower); // before the prank: _attest makes a view call
        vm.prank(borrower);
        core.router.borrow(address(m.tokens[NVDA]), 100_000e6, amount, borrower, att, block.timestamp);
    }

    // ------------------------------------------------------------------ SI-R21

    function test_SI_R21_listFixedAtDeploymentAndNoMutableState() public view {
        address[] memory s = lens.stocks();
        assertEq(s.length, 3);
        for (uint256 i; i < 3; i++) {
            assertEq(s[i], address(m.tokens[i]));
        }
        assertEq(address(lens.ROUTER()), address(core.router));
        assertEq(address(lens.MORPHO()), m.morpho);
    }

    function test_SI_R21_rejectsUnknownStocksAndZeroRouter() public {
        address[] memory bad = new address[](1);
        bad[0] = makeAddr("notListed");
        vm.expectRevert(abi.encodeWithSelector(ShortInterestLens.UnknownStock.selector, bad[0]));
        new ShortInterestLens(address(core.router), bad);
        vm.expectRevert(ShortInterestLens.ZeroAddress.selector);
        new ShortInterestLens(address(0), bad);
        vm.expectRevert(abi.encodeWithSelector(ShortInterestLens.UnknownStock.selector, bad[0]));
        lens.snapshot(bad[0]);
    }

    function test_SI_R21_redeployableWithASubset() public {
        address[] memory one = new address[](1);
        one[0] = address(m.tokens[NVDA]);
        ShortInterestLens l2 = new ShortInterestLens(address(core.router), one);
        assertEq(l2.snapshotAll().length, 1);
        assertEq(abi.encode(l2.snapshot(one[0])), abi.encode(lens.snapshot(one[0])));
    }

    // ------------------------------------------------------------------ SI-R20

    function test_SI_R20_freshMarketCountsSeedSupplyAndVaultIdle() public view {
        IShortInterestLens.StockSnapshot memory s = lens.snapshot(address(m.tokens[0]));
        // DeployLocal seeds 1e12 into the market (dead address) and 1e12 into the vault (idle).
        assertEq(s.stockToken, address(m.tokens[0]));
        s = lens.snapshot(address(m.tokens[0])); // SPY: untouched by setUp
        assertEq(s.suppliedShares, 2e12);
        assertEq(s.borrowedShares, 0);
        assertEq(s.utilizationWad, 0);
        assertGt(s.borrowRatePerSecWad, 0); // AdaptiveCurveIrm curve at 0% utilization
        assertTrue(s.marketOpen);
        assertFalse(s.guardTripped);
        assertEq(s.bufferWad, 0);
    }

    function test_SI_R20_accruesInterestToBlockTimestamp() public {
        _borrowNvda(100e18);
        MarketParams memory p = ds[NVDA].market;
        Market memory stored = IMorpho(m.morpho).market(p.id());
        vm.warp(block.timestamp + 30 days);
        IShortInterestLens.StockSnapshot memory s = lens.snapshot(address(m.tokens[NVDA]));
        (uint256 sa,, uint256 ba,) = IMorpho(m.morpho).expectedMarketBalances(p);
        assertGt(ba, stored.totalBorrowAssets, "interest accrued");
        assertEq(s.borrowedShares, ba); // multiplier 1.0
        uint256 idle = IERC20(ds[NVDA].wrapper).balanceOf(ds[NVDA].vault);
        assertEq(s.suppliedShares, sa + idle);
        assertEq(idle, 100e18 + 1e12); // the router deposit stays idle (no allocation) and counts as supplied
        assertEq(s.utilizationWad, ba * 1e18 / sa);
        assertEq(s.borrowRatePerSecWad, IIrm(p.irm).borrowRateView(p, stored));
    }

    function test_SI_R20_sharesAreAfterTheMultiplier() public {
        _borrowNvda(50e18);
        IShortInterestLens.StockSnapshot memory before = lens.snapshot(address(m.tokens[NVDA]));
        m.tokens[NVDA].setUIMultiplier(1.5e18); // e.g. a 3:2 split: wrapped units unchanged, shares × 1.5
        IShortInterestLens.StockSnapshot memory afterSplit = lens.snapshot(address(m.tokens[NVDA]));
        assertEq(afterSplit.borrowedShares, before.borrowedShares * 3 / 2);
        assertEq(afterSplit.suppliedShares, before.suppliedShares * 3 / 2);
        assertEq(afterSplit.utilizationWad, before.utilizationWad);
    }

    function test_SI_R20_reportsGuardBufferAndSession() public {
        vm.prank(guardian);
        ds[NVDA].oracle.trip(1); // MANUAL
        assertTrue(lens.snapshot(address(m.tokens[NVDA])).guardTripped);
        assertFalse(lens.snapshot(address(m.tokens[0])).guardTripped);
        // Sat 2026-09-19 16:00Z: the 24/5 feed is closed and the weekend buffer is held.
        vm.warp(WED_0916_16Z + 3 days);
        IShortInterestLens.StockSnapshot memory s = lens.snapshot(address(m.tokens[0]));
        assertFalse(s.marketOpen);
        assertGt(s.bufferWad, 0.03e18); // SPY 48h b_full ≈ 3.1%
    }

    function test_SI_R20_snapshotAllMatchesSnapshotInOrder() public {
        _borrowNvda(10e18);
        IShortInterestLens.StockSnapshot[] memory all = lens.snapshotAll();
        assertEq(all.length, 3);
        for (uint256 i; i < 3; i++) {
            assertEq(abi.encode(all[i]), abi.encode(lens.snapshot(address(m.tokens[i]))));
        }
        assertGt(all[NVDA].borrowedShares, 0);
        assertEq(all[0].borrowedShares, 0);
    }

    function testFuzz_SI_R20_borrowedNeverExceedsSuppliedAndUtilizationBounded(uint96 amount, uint32 elapsed) public {
        uint256 borrow = bound(uint256(amount), 1e15, 290e18); // HF ≥ 1.18 at $225.66 with $100k collateral
        _borrowNvda(borrow);
        vm.warp(block.timestamp + bound(uint256(elapsed), 0, 365 days));
        IShortInterestLens.StockSnapshot memory s = lens.snapshot(address(m.tokens[NVDA]));
        assertLe(s.borrowedShares, s.suppliedShares);
        assertLe(s.utilizationWad, 1e18);
        assertGe(s.borrowedShares, borrow);
    }
}
