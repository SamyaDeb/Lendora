// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {INavOracle} from "../../src/interfaces/INavOracle.sol";
import {NavOracle} from "../../src/vault/NavOracle.sol";
import {StrategyManager} from "../../src/vault/StrategyManager.sol";
import {DnVaultBase} from "./DnVaultBase.sol";

/// @notice DN-R4 (NAV components, signed perp equity, second signer above 1%) and DN-R5 (max age, guards).
contract NavOracleTest is DnVaultBase {
    function _one(INavOracle.Report memory r, Vm.Wallet memory w) internal view returns (bytes[] memory s) {
        s = new bytes[](1);
        s[0] = _sign(w, r);
    }

    function _two(INavOracle.Report memory r) internal view returns (bytes[] memory s) {
        s = new bytes[](2);
        s[0] = _sign(signerA, r);
        s[1] = _sign(signerB, r);
    }

    function test_DN_R4_navIsCashPlusSpotPlusPerp() public {
        _deposit(alice, 1_000_000e6);
        _build(1, 400_000e6);
        uint256 spot = strat.quote(1, strat.spotUnits(1));
        assertEq(nav.spotValue(), spot);
        (, uint256 eq) = venue.onchainEquity();
        assertEq(nav.perpValue(), eq);
        assertEq(nav.nav(), vault.idleAssets() + IERC20(address(m.usdg)).balanceOf(address(strat)) + spot + eq);
        assertApproxEqAbs(nav.nav(), 1_000_000e6, 10);
    }

    function test_DN_R4_hedgedSleeveNavBarelyMovesWithThePrice() public {
        _deposit(alice, 1_000_000e6);
        _build(1, 1_000_000e6 * 95 / 100);
        uint256 n0 = nav.nav();
        _setPrice(1, PRICES[1] * 110 / 100);
        vm.warp(block.timestamp + 1);
        _report();
        assertApproxEqRel(nav.nav(), n0, 0.001e18, "DN-R2: +10% price, NAV within 0.1%");
    }

    function test_DN_R4_oneSignerUpToOnePercentTwoAbove() public {
        _deposit(alice, 1_000_000e6);
        _build(1, 400_000e6);
        INavOracle.Report memory r = nav.lastReport();
        assertEq(r.tradeNonce, strat.tradeNonce(), "the last report saw the build's trade");
        uint256 t = vm.getBlockTimestamp(); // via-IR coverage builds re-read block.timestamp after a warp
        vm.warp(t + 60);
        r.timestamp = uint64(t + 60);
        r.equity += 9000e6; // +0.9% of NAV
        nav.submit(r, _one(r, signerA));
        vm.warp(t + 120);
        r.timestamp = uint64(t + 120);
        r.equity += 11_000e6; // +1.1%
        bytes[] memory sg1 = _one(r, signerB);
        vm.expectRevert(abi.encodeWithSelector(INavOracle.NeedsSecondSigner.selector, 109));
        nav.submit(r, sg1);
        nav.submit(r, _two(r));
        assertEq(nav.lastReport().equity, r.equity);
    }

    function test_DN_R4_signaturesMustBeDistinctAllowedAndSorted() public {
        INavOracle.Report memory r = _currentReport();
        vm.warp(block.timestamp + 1);
        r.timestamp = uint64(block.timestamp);
        bytes[] memory s = new bytes[](2);
        s[0] = _sign(signerA, r);
        s[1] = _sign(signerA, r);
        vm.expectRevert(INavOracle.DuplicateSigner.selector);
        nav.submit(r, s);
        s[0] = _sign(signerB, r);
        s[1] = _sign(signerA, r);
        vm.expectRevert(INavOracle.DuplicateSigner.selector); // unsorted
        nav.submit(r, s);
        Vm.Wallet memory mallory = vm.createWallet("mallory");
        bytes[] memory sg2 = _one(r, mallory);
        vm.expectRevert(INavOracle.BadSignature.selector);
        nav.submit(r, sg2);
        vm.expectRevert(INavOracle.BadSignature.selector);
        nav.submit(r, new bytes[](0));
        s = new bytes[](1);
        s[0] = hex"00";
        vm.expectRevert(INavOracle.BadSignature.selector);
        nav.submit(r, s);
        nav.setSigner(signerA.addr, false);
        bytes[] memory sg3 = _one(r, signerA);
        vm.expectRevert(INavOracle.BadSignature.selector);
        nav.submit(r, sg3);
        vm.expectRevert(INavOracle.ZeroAddress.selector);
        nav.setSigner(address(0), true);
    }

    function test_DN_R5_reportTimingRules() public {
        INavOracle.Report memory r = _currentReport();
        bytes[] memory sg4 = _one(r, signerA);
        vm.expectRevert(abi.encodeWithSelector(INavOracle.NotNewer.selector, r.timestamp, r.timestamp));
        nav.submit(r, sg4);
        r.timestamp = uint64(block.timestamp + 1);
        bytes[] memory sg5 = _one(r, signerA);
        vm.expectRevert(abi.encodeWithSelector(INavOracle.FutureReport.selector, r.timestamp));
        nav.submit(r, sg5);
        vm.warp(block.timestamp + 20 minutes);
        r.timestamp = uint64(block.timestamp - 16 minutes);
        bytes[] memory sg6 = _one(r, signerA);
        vm.expectRevert(abi.encodeWithSelector(INavOracle.StaleReport.selector, r.timestamp));
        nav.submit(r, sg6);
    }

    function test_DN_R4_aReportCannotClaimFlowsTheAdapterHasNotMade() public {
        INavOracle.Report memory r = _currentReport();
        vm.warp(block.timestamp + 1);
        r.timestamp = uint64(block.timestamp);
        r.deposited = venue.totalDeposited() + 1;
        bytes[] memory sg7 = _two(r);
        vm.expectRevert(INavOracle.BadReport.selector);
        nav.submit(r, sg7);
        r.deposited = 0;
        r.requested = venue.totalRequested() + 1;
        bytes[] memory sg8 = _two(r);
        vm.expectRevert(INavOracle.BadReport.selector);
        nav.submit(r, sg8);
    }

    function test_DN_R4_flowsSinceTheReportCountOnceAndPendingWithdrawalsStayInNav() public {
        _deposit(alice, 1_000_000e6);
        vm.prank(operator);
        strat.pullFromVault(300_000e6);
        uint256 n0 = nav.nav();
        vm.prank(operator);
        strat.depositMargin(200_000e6); // not in the report yet: counted from the adapter's total
        assertEq(nav.nav(), n0, "deposit moves value, not NAV");
        venue.setWithdrawDelay(1 hours);
        vm.prank(operator);
        strat.requestMarginWithdraw(50_000e6);
        assertEq(nav.nav(), n0, "requested margin counts as pending");
        vm.warp(block.timestamp + 1);
        _report(); // the report now includes both flows
        assertEq(nav.nav(), n0, "no double count after the report");
        vm.warp(block.timestamp + 1 hours);
        strat.claimMargin();
        assertEq(nav.nav(), n0, "claim moves pending into strategy USDG");
        assertGt(nav.reportAge(), 0);
    }

    function test_DN_R5_freshnessMaxAgeAndGuards() public {
        assertTrue(nav.fresh());
        vm.warp(block.timestamp + 15 minutes + 1);
        assertFalse(nav.fresh());
        _report();
        assertTrue(nav.fresh());
        _deposit(alice, 100_000e6);
        _build(1, 50_000e6);
        vm.prank(guardian);
        ds[1].oracle.trip(1);
        assertFalse(nav.fresh(), "a tripped guard on a held sleeve");
        vm.prank(guardian);
        ds[0].oracle.trip(1);
        vm.prank(guardian);
        ds[1].oracle.clear(1);
        assertTrue(nav.fresh(), "a tripped guard on an empty sleeve does not matter");
        nav.setMaxAge(1 hours, 5 minutes);
        assertEq(nav.maxAgeOpen(), 1 hours);
        vm.expectRevert(INavOracle.BadMaxAge.selector);
        nav.setMaxAge(1 hours, 16 minutes); // DN-R5 ceiling
        vm.expectRevert(INavOracle.BadMaxAge.selector);
        nav.setMaxAge(2 hours, 5 minutes);
        vm.expectRevert(INavOracle.BadMaxAge.selector);
        nav.setMaxAge(0, 5 minutes);
    }

    function test_noAdapterMeansNoPerpSideAndNoReports() public {
        StrategyManager s2 = new StrategyManager(address(this), address(vault), operator, dnGuardian, 100);
        NavOracle n2 = new NavOracle(address(this), address(vault), address(s2), 15 minutes, 15 minutes);
        assertEq(n2.perpValue(), 0);
        assertEq(n2.reportAge(), type(uint256).max);
        assertFalse(n2.fresh());
        INavOracle.Report memory r;
        r.timestamp = uint64(block.timestamp);
        vm.expectRevert(INavOracle.ZeroAddress.selector);
        n2.submit(r, new bytes[](0));
        vm.expectRevert(INavOracle.ZeroAddress.selector);
        new NavOracle(address(this), address(0), address(s2), 1, 1);
    }

    function test_venueLossFloorsPerpAtZero() public {
        _deposit(alice, 1_000_000e6);
        _build(1, 400_000e6);
        _setPrice(1, PRICES[1] * 150 / 100); // +50%: the short loses more than its margin
        venue.liquidate();
        vm.warp(block.timestamp + 1);
        _report();
        assertEq(nav.perpValue(), 0, "margin lost, never negative");
        assertLe(nav.perpValue(), 400_000e6 * 95 / 400, "loss bounded by the margin share (08 gate)");
    }

    function test_DN_R14_navStaysHedgedBetweenReports() public {
        _deposit(alice, 1_000_000e6);
        _build(1, 950_000e6);
        uint256 n0 = nav.nav();
        _setPrice(1, PRICES[1] * 105 / 100); // +5%, no new report
        assertApproxEqRel(nav.nav(), n0, 0.001e18, "spot gain offset by the marked short loss");
        _setPrice(1, PRICES[1] * 95 / 100); // -5%
        assertApproxEqRel(nav.nav(), n0, 0.001e18);
    }

    function test_DN_R14_aPerpTradeWaitsForAReportThatSawIt() public {
        _deposit(alice, 1_000_000e6);
        _build(1, 400_000e6);
        assertTrue(nav.fresh());
        vm.prank(operator);
        strat.adjustShort(1, 1e18, 0); // buy back 1 unit
        assertFalse(nav.fresh(), "DN-R14: stale until a report sees the trade");
        vm.warp(vm.getBlockTimestamp() + 1);
        INavOracle.Report memory r = _currentReport();
        r.tradeNonce -= 1;
        bytes[] memory sg = _two(r);
        vm.expectRevert(abi.encodeWithSelector(INavOracle.TradeNotReported.selector, r.tradeNonce, r.tradeNonce + 1));
        nav.submit(r, sg);
        r = _currentReport();
        r.shortSizes = new uint256[](2);
        sg = _two(r);
        vm.expectRevert(INavOracle.BadReport.selector);
        nav.submit(r, sg);
        _report();
        assertTrue(nav.fresh());
        assertEq(nav.refQuote(1), strat.quote(1, 1e18));
    }
}
