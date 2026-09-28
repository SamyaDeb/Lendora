// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStrategyManager} from "../../src/interfaces/IStrategyManager.sol";
import {StrategyManager} from "../../src/vault/StrategyManager.sol";
import {MockPerpVenue} from "../mocks/MockPerpVenue.sol";
import {MockPayFirstSwap} from "../mocks/MockPayFirstSwap.sol";
import {MockSwapAggregator} from "../mocks/MockSwapAggregator.sol";
import {DnVaultBase} from "./DnVaultBase.sol";

/// @notice DN-R2, DN-R3, DN-R6, DN-R7, DN-R8, DN-R10: the operator trades only inside the limits; unwinding is always
/// open to the operator and the guardian.
/// forge-config: default.isolate = true
contract StrategyManagerTest is DnVaultBase {
    function setUp() public override {
        super.setUp();
        _deposit(alice, 1_000_000e6);
        vm.prank(operator);
        strat.pullFromVault(900_000e6);
    }

    function _buy(uint256 i, uint256 usdgIn) internal returns (uint256) {
        uint256 minOut = _minOut(strat.quote(i, 1e18), usdgIn);
        IStrategyManager.Swap memory sw = _buyData(i, usdgIn);
        vm.prank(operator);
        return strat.buySpot(i, usdgIn, minOut, sw);
    }

    // ================================================================== DN-R10: swaps

    function test_DN_R10_buyFloorIsTheOraclePriceLessOnePercent() public {
        uint256 fair = 100_000e6 * 1e18 / strat.quote(1, 1e18);
        IStrategyManager.Swap memory sw = _buyData(1, 100_000e6);
        vm.prank(operator);
        vm.expectRevert(); // SlippageTooLoose: 2% below fair
        strat.buySpot(1, 100_000e6, fair * 98 / 100, sw);
        uint256 got = _buy(1, 100_000e6);
        assertApproxEqRel(got, fair, 1e12);
        assertEq(IERC20(address(ds[1].wrapper)).balanceOf(address(strat)), got, "wrapped");
        assertEq(IERC20(address(m.usdg)).allowance(address(strat), address(m.dex)), 0, "approval reset");
    }

    function test_DN_R10_aDexPayingLessThanTheFloorReverts() public {
        m.dex.setFeeBps(200); // the DEX now pays 2% less than the oracle
        uint256 usdgIn = 10_000e6;
        uint256 minOut = _minOut(strat.quote(1, 1e18), usdgIn);
        vm.prank(operator);
        vm.expectRevert(); // InsufficientOutput (mock) or the strategy's own check
        strat.buySpot(1, usdgIn, minOut, _buyData(1, usdgIn));
    }

    function test_DN_R10_outputIsMeasuredNotReported() public {
        // The DEX lies about its output and sends it elsewhere: the balance delta is 0.
        uint256 usdgIn = 10_000e6;
        IStrategyManager.Swap memory sw = IStrategyManager.Swap(
            address(m.dex),
            abi.encodeWithSignature(
                "swap(address,address,uint256,uint256,address)", address(m.usdg), address(m.tokens[1]), usdgIn, 0, bob
            )
        );
        uint256 minOut = _minOut(strat.quote(1, 1e18), usdgIn);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IStrategyManager.InsufficientOutput.selector, 0, minOut));
        strat.buySpot(1, usdgIn, minOut, sw);
    }

    function test_DN_R10_onlyAllowlistedTargetsAndNeverAHoldingContract() public {
        IStrategyManager.Swap memory sw = _buyData(1, 1e6);
        sw.target = bob;
        uint256 minOut = _minOut(strat.quote(1, 1e18), 1e6);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IStrategyManager.SwapTargetNotAllowed.selector, bob));
        strat.buySpot(1, 1e6, minOut, sw);
        address[6] memory forbidden = [
            address(m.usdg), address(vault), address(venue), address(m.tokens[0]), address(ds[0].wrapper), ds[0].vault
        ];
        for (uint256 i; i < forbidden.length; i++) {
            vm.expectRevert(IStrategyManager.BadParam.selector);
            strat.setSwapTarget(forbidden[i], IStrategyManager.SwapMode.Approve);
        }
        vm.expectRevert(IStrategyManager.BadParam.selector);
        strat.setSwapTarget(address(0), IStrategyManager.SwapMode.Approve);
        // Transfer mode (UniversalRouter pattern) pays first; removing a target works.
        MockPayFirstSwap pf = new MockPayFirstSwap();
        strat.setSwapTarget(address(pf), IStrategyManager.SwapMode.Transfer);
        assertEq(uint8(strat.swapModes(address(pf))), uint8(IStrategyManager.SwapMode.Transfer));
        strat.setSwapTarget(address(pf), IStrategyManager.SwapMode.None);
    }

    function test_DN_R10_operatorHasNoPathToItself() public {
        _buy(1, 100_000e6);
        vm.startPrank(operator);
        strat.lend(1, 1e18);
        strat.depositMargin(10_000e6);
        strat.adjustShort(1, -1e18, 0);
        strat.returnToVault(1e6);
        vm.stopPrank();
        assertEq(IERC20(address(m.usdg)).balanceOf(operator), 0);
        assertEq(IERC20(address(ds[1].wrapper)).balanceOf(operator), 0);
        assertEq(IERC20(ds[1].vault).balanceOf(operator), 0);
        assertEq(IERC20(address(m.tokens[1])).balanceOf(operator), 0);
    }

    function test_DN_R10_sellFloorAndGuardianSellsWhilePaused() public {
        uint256 got = _buy(1, 100_000e6);
        vm.prank(dnGuardian);
        strat.setPaused(true);
        uint256 v = strat.quote(1, got);
        IStrategyManager.Swap memory sw = _sellData(1, got);
        vm.prank(dnGuardian);
        vm.expectRevert(); // 2% below the oracle
        strat.sellSpot(1, got, v * 98 / 100, sw);
        vm.prank(bob);
        vm.expectRevert(IStrategyManager.NotOperatorOrGuardian.selector);
        strat.sellSpot(1, got, v, sw);
        vm.prank(dnGuardian);
        uint256 out = strat.sellSpot(1, got, v * 99 / 100 + 1, sw);
        assertApproxEqAbs(out, v, 2);
    }

    function test_DN_R10_tradesNeedAClearGuardAndBuysAnOpenSession() public {
        vm.prank(guardian);
        ds[1].oracle.trip(1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IStrategyManager.GuardTripped.selector, 1, 1));
        strat.buySpot(1, 1e6, 0, _buyData(1, 1e6));
        vm.prank(guardian);
        ds[1].oracle.clear(1);
        vm.warp(SAT_0919_16Z);
        m.feeds[1].setAnswer(PRICES[1]);
        m.usdgFeed.setAnswer(1e8);
        vm.prank(operator);
        vm.expectRevert(IStrategyManager.MarketClosed.selector);
        strat.buySpot(1, 1e6, 0, _buyData(1, 1e6));
    }

    // ================================================================== DN-R6, DN-R8

    function test_DN_R6_sleeveCapBoundsSpot() public {
        strat.setSleeveCap(1, 50_000e6);
        uint256 minOut = _minOut(strat.quote(1, 1e18), 60_000e6);
        IStrategyManager.Swap memory sw = _buyData(1, 60_000e6);
        vm.prank(operator);
        vm.expectRevert();
        strat.buySpot(1, 60_000e6, minOut, sw);
        _buy(1, 40_000e6);
        strat.setSleeveCap(1, 0); // launch cap 0 (Q11)
        minOut = _minOut(strat.quote(1, 1e18), 1e6);
        sw = _buyData(1, 1e6);
        vm.prank(operator);
        vm.expectRevert();
        strat.buySpot(1, 1e6, minOut, sw);
    }

    function test_DN_R8_lendRatioBounded() public {
        uint256 got = _buy(1, 100_000e6);
        strat.setMaxLendBps(1, 5000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IStrategyManager.LendRatioExceeded.selector, 1, 5999, 5000)); // rSTOCK
        // rounds down
        strat.lend(1, got * 6 / 10);
        vm.prank(operator);
        uint256 shares = strat.lend(1, got / 2);
        assertApproxEqAbs(strat.lentUnits(1), got / 2, 2);
        vm.prank(dnGuardian);
        strat.unlend(1, shares);
        assertEq(strat.lentUnits(1), 0);
        vm.expectRevert(IStrategyManager.BadParam.selector);
        strat.setMaxLendBps(1, 10_001);
    }

    // ================================================================== DN-R3, DN-R7: perp and kill switch

    function test_DN_R3_marginPathReturnsOnlyToTheStrategy() public {
        vm.prank(operator);
        strat.depositMargin(100_000e6);
        assertEq(venue.totalDeposited(), 100_000e6);
        venue.setWithdrawDelay(1 hours);
        vm.prank(dnGuardian);
        strat.requestMarginWithdraw(40_000e6);
        assertEq(venue.pending(), 40_000e6);
        assertEq(strat.claimMargin(), 0, "not matured");
        vm.warp(block.timestamp + 1 hours);
        uint256 before = IERC20(address(m.usdg)).balanceOf(address(strat));
        vm.prank(bob); // anyone can pull matured margin home
        assertEq(strat.claimMargin(), 40_000e6);
        assertEq(IERC20(address(m.usdg)).balanceOf(address(strat)), before + 40_000e6);
        vm.prank(bob);
        vm.expectRevert(IStrategyManager.NotOperatorOrGuardian.selector);
        strat.depositMargin(1);
    }

    function test_DN_R7_killSwitchStopsNewExposureButNotTheUnwind() public {
        uint256 got = _buy(1, 100_000e6);
        vm.startPrank(operator);
        strat.depositMargin(40_000e6);
        strat.adjustShort(1, -int256(got), 0);
        strat.killSleeve(1);
        vm.expectRevert(abi.encodeWithSelector(IStrategyManager.SleeveInactive.selector, 1));
        strat.buySpot(1, 1e6, 0, _buyData(1, 1e6));
        vm.expectRevert(abi.encodeWithSelector(IStrategyManager.SleeveInactive.selector, 1));
        strat.lend(1, 1);
        vm.expectRevert(abi.encodeWithSelector(IStrategyManager.SleeveInactive.selector, 1));
        strat.adjustShort(1, -1, 0);
        strat.adjustShort(1, int256(got), 0); // close
        uint256 v = strat.quote(1, got);
        IStrategyManager.Swap memory sw = _sellData(1, got);
        strat.sellSpot(1, got, v * 99 / 100 + 1, sw);
        vm.stopPrank();
        assertFalse(strat.sleeve(1).active);
        (, uint256 size) = venue.shortSize(keccak256("NVDA"));
        assertEq(size, 0);
        vm.prank(bob);
        vm.expectRevert(IStrategyManager.NotOperatorOrGuardian.selector);
        strat.killSleeve(0);
    }

    function test_DN_R2_shortCannotExceedSpotAndOnlyTheOperatorAddsIt() public {
        uint256 got = _buy(1, 100_000e6);
        vm.prank(operator);
        strat.depositMargin(40_000e6);
        vm.prank(operator);
        vm.expectRevert(); // ShortExceedsSpot (+5% overhang max)
        strat.adjustShort(1, -int256(got * 106 / 100), 0);
        vm.prank(dnGuardian);
        vm.expectRevert(IStrategyManager.NotOperator.selector);
        strat.adjustShort(1, -1, 0);
        vm.prank(dnGuardian);
        strat.setPaused(true);
        vm.prank(operator);
        vm.expectRevert(IStrategyManager.Paused.selector);
        strat.adjustShort(1, -1, 0);
        vm.prank(bob);
        vm.expectRevert(IStrategyManager.NotOperatorOrGuardian.selector);
        strat.adjustShort(1, 1, 0);
    }

    function test_pauseBlocksExposureOnly() public {
        vm.prank(bob);
        vm.expectRevert(IStrategyManager.NotGuardian.selector);
        strat.setPaused(true);
        vm.prank(dnGuardian);
        strat.setPaused(true);
        vm.startPrank(operator);
        vm.expectRevert(IStrategyManager.Paused.selector);
        strat.pullFromVault(1);
        vm.expectRevert(IStrategyManager.Paused.selector);
        strat.buySpot(1, 1, 0, _buyData(1, 1));
        vm.expectRevert(IStrategyManager.Paused.selector);
        strat.lend(1, 1);
        strat.depositMargin(1e6); // a top-up is always allowed
        strat.returnToVault(1e6);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(IStrategyManager.NotOperator.selector);
        strat.pullFromVault(1);
    }

    // ================================================================== owner

    function test_addSleeveChecksTheWiring() public {
        IStrategyManager.Sleeve memory s = strat.sleeve(0);
        vm.expectRevert(abi.encodeWithSelector(IStrategyManager.SleeveExists.selector, s.stockToken));
        strat.addSleeve(s);
        s.rVault = ds[1].vault; // wrong vault for the wrapper
        vm.expectRevert(IStrategyManager.BadParam.selector);
        strat.addSleeve(s);
        s = strat.sleeve(0);
        s.maxLendBps = 10_001;
        vm.expectRevert(IStrategyManager.BadParam.selector);
        strat.addSleeve(s);
        vm.expectRevert(abi.encodeWithSelector(IStrategyManager.UnknownSleeve.selector, 7));
        strat.sleeve(7);
        assertEq(strat.sleeveCount(), 3);
    }

    function test_adapterReplaceableOnlyWhenFlat() public {
        MockPerpVenue other = new MockPerpVenue(address(m.usdg), address(strat));
        vm.prank(operator);
        strat.depositMargin(1e6);
        vm.expectRevert(IStrategyManager.AdapterLocked.selector);
        strat.setAdapter(address(other));
        vm.prank(operator);
        strat.requestMarginWithdraw(1e6);
        vm.expectRevert(IStrategyManager.AdapterLocked.selector);
        strat.setAdapter(address(other)); // still pending
        strat.claimMargin();
        MockPerpVenue wrong = new MockPerpVenue(address(m.usdg), bob);
        vm.expectRevert(IStrategyManager.BadParam.selector);
        strat.setAdapter(address(wrong));
        strat.setAdapter(address(other));
        assertEq(strat.adapter(), address(other));
        vm.expectRevert(IStrategyManager.ZeroAddress.selector);
        strat.setAdapter(address(0));
    }

    function test_ownerSetters() public {
        strat.setOperator(bob);
        assertEq(strat.operator(), bob);
        strat.setGuardian(bob);
        assertEq(strat.guardian(), bob);
        strat.setMaxSlippageBps(50);
        assertEq(strat.maxSlippageBps(), 50);
        vm.expectRevert(IStrategyManager.BadParam.selector);
        strat.setMaxSlippageBps(101);
        vm.expectRevert(IStrategyManager.ZeroAddress.selector);
        strat.setOperator(address(0));
        vm.expectRevert(IStrategyManager.ZeroAddress.selector);
        strat.setGuardian(address(0));
        vm.expectRevert(IStrategyManager.ZeroAddress.selector);
        new StrategyManager(address(this), address(vault), address(0), bob, 100);
        vm.expectRevert(IStrategyManager.BadParam.selector);
        new StrategyManager(address(this), address(vault), bob, bob, 101);
        assertEq(strat.quote(0, 0), 0);
        assertEq(strat.MAX_SLIPPAGE_CEILING_BPS(), 100);
    }

    function test_DN_R10_transferModePaysFirstAndSwapRevertsBubble() public {
        MockPayFirstSwap pf = new MockPayFirstSwap();
        pf.setRate(address(m.usdg), address(m.tokens[1]), uint256(1e8) * 1e36 / (uint256(PRICES[1]) * 1e6));
        m.tokens[1].mint(address(pf), 1000e18);
        strat.setSwapTarget(address(pf), IStrategyManager.SwapMode.Transfer);
        uint256 minOut = _minOut(strat.quote(1, 1e18), 10_000e6);
        IStrategyManager.Swap memory sw = IStrategyManager.Swap(
            address(pf),
            abi.encodeCall(MockPayFirstSwap.swap, (address(m.usdg), address(m.tokens[1]), 10_000e6, address(strat)))
        );
        vm.prank(operator);
        uint256 got = strat.buySpot(1, 10_000e6, minOut, sw);
        assertGe(got, minOut);
        // A reverting target: the revert data bubbles up unchanged.
        m.dex.setRate(address(m.usdg), address(m.tokens[1]), 0);
        IStrategyManager.Swap memory bad = _buyData(1, 1e6);
        uint256 min2 = _minOut(strat.quote(1, 1e18), 1e6);
        vm.prank(operator);
        vm.expectRevert(MockSwapAggregator.NoRate.selector);
        strat.buySpot(1, 1e6, min2, bad);
    }
}
