// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IDeltaNeutralVault} from "../../src/interfaces/IDeltaNeutralVault.sol";
import {DeltaNeutralVault} from "../../src/vault/DeltaNeutralVault.sol";
import {DnVaultBase} from "./DnVaultBase.sol";

/// @notice DN-R1, DN-R5, DN-R6, DN-R9, DN-R12 and CP-R4 on the local deployment with the mock venue.
/// forge-config: default.isolate = true
contract DeltaNeutralVaultTest is DnVaultBase {
    /// @dev Fresh feed rounds for every stock and USDG (mock feeds stamp `updatedAt = now`), then a NAV report.
    function _refresh() internal {
        for (uint256 i; i < 3; i++) {
            (, int256 a,,,) = m.feeds[i].latestRoundData();
            m.feeds[i].setAnswer(a);
        }
        m.usdgFeed.setAnswer(1e8);
        _report();
    }

    // ================================================================== entries

    function test_DN_R6_plainErc4626DepositAndMintNeedAnAttestation() public {
        vm.expectRevert(IDeltaNeutralVault.AttestationRequired.selector);
        vault.deposit(1e6, alice);
        vm.expectRevert(IDeltaNeutralVault.AttestationRequired.selector);
        vault.mint(1e18, alice);
        assertEq(vault.maxMint(alice), 0);
    }

    function test_DN_R6_depositMintsAtTheSharePrice() public {
        uint256 shares = _deposit(alice, 1000e6);
        assertEq(shares, 1000e18, "1 share = 1 USDG at launch (18-dp shares)");
        assertEq(vault.totalAssets(), 1000e6);
        _deposit(bob, 500e6);
        assertEq(vault.balanceOf(bob), 500e18);
        assertEq(vault.sharePrice(), 1e18);
    }

    function test_CP_R3_badOrExpiredAttestationRefused() public {
        m.usdg.mint(alice, 10e6);
        IDeltaNeutralVault.Attestation memory a = _dnAttest(bob); // signed for someone else
        vm.startPrank(alice);
        IERC20(address(m.usdg)).approve(address(vault), 10e6);
        vm.expectRevert(IDeltaNeutralVault.BadAttestation.selector);
        vault.deposit(10e6, alice, a);
        a = _dnAttest(alice);
        a.signature[5] ^= 0x01;
        vm.expectRevert(IDeltaNeutralVault.BadAttestation.selector);
        vault.deposit(10e6, alice, a);
        a = _dnAttest(alice);
        a.signature = hex"1234";
        vm.expectRevert(IDeltaNeutralVault.BadAttestation.selector);
        vault.deposit(10e6, alice, a);
        vm.stopPrank();
        a = _dnAttest(alice);
        vm.warp(a.expiry + 1);
        vm.prank(alice);
        vm.expectRevert(IDeltaNeutralVault.BadAttestation.selector);
        vault.deposit(10e6, alice, a);
    }

    function test_DN_R6_capZeroRefusesEveryDepositAndGuardianLowersTheCap() public {
        vault.setTotalCap(0);
        m.usdg.mint(alice, 10e6);
        IDeltaNeutralVault.Attestation memory a = _dnAttest(alice);
        vm.startPrank(alice);
        IERC20(address(m.usdg)).approve(address(vault), 10e6);
        vm.expectRevert(abi.encodeWithSelector(IDeltaNeutralVault.CapExceeded.selector, 10e6, 0));
        vault.deposit(10e6, alice, a);
        vm.stopPrank();
        assertEq(vault.maxDeposit(alice), 0);
        vault.setTotalCap(100e6);
        assertEq(vault.maxDeposit(alice), 100e6);
        vm.expectRevert(IDeltaNeutralVault.NotGuardian.selector);
        vault.lowerTotalCap(50e6);
        vm.prank(dnGuardian);
        vm.expectRevert(IDeltaNeutralVault.BadParam.selector);
        vault.lowerTotalCap(200e6); // never raise
        vm.prank(dnGuardian);
        vault.lowerTotalCap(50e6);
        assertEq(vault.totalCap(), 50e6);
    }

    function test_DN_R5_noMintOnAStaleNav() public {
        vm.warp(block.timestamp + 16 minutes);
        assertFalse(nav.fresh());
        m.usdg.mint(alice, 10e6);
        IDeltaNeutralVault.Attestation memory a = _dnAttest(alice);
        vm.startPrank(alice);
        IERC20(address(m.usdg)).approve(address(vault), 10e6);
        vm.expectRevert(IDeltaNeutralVault.NavStale.selector);
        vault.deposit(10e6, alice, a);
        vm.stopPrank();
        assertEq(vault.maxDeposit(alice), 0);
    }

    function test_DN_R12_noMintWhileTheFeedSessionIsClosed() public {
        vm.warp(SAT_0919_16Z);
        _refresh(); // fresh report, closed session
        assertTrue(nav.fresh());
        assertFalse(vault.marketOpen());
        m.usdg.mint(alice, 10e6);
        IDeltaNeutralVault.Attestation memory a = _dnAttest(alice);
        vm.startPrank(alice);
        IERC20(address(m.usdg)).approve(address(vault), 10e6);
        vm.expectRevert(IDeltaNeutralVault.MarketClosed.selector);
        vault.deposit(10e6, alice, a);
        vm.stopPrank();
    }

    function test_DN_R6_guardianPausesEntriesOnly() public {
        _deposit(alice, 100e6);
        vm.prank(dnGuardian);
        vault.setDepositsPaused(true);
        m.usdg.mint(bob, 10e6);
        IDeltaNeutralVault.Attestation memory a = _dnAttest(bob);
        vm.startPrank(bob);
        IERC20(address(m.usdg)).approve(address(vault), 10e6);
        vm.expectRevert(IDeltaNeutralVault.DepositsPaused.selector);
        vault.deposit(10e6, bob, a);
        vm.stopPrank();
        assertEq(vault.maxDeposit(bob), 0);
        vm.prank(alice); // CP-R4: exits still work
        vault.withdraw(40e6, alice, alice);
        vm.expectRevert(IDeltaNeutralVault.NotGuardian.selector);
        vault.setDepositsPaused(false);
    }

    function test_zeroAmountsRefused() public {
        IDeltaNeutralVault.Attestation memory a = _dnAttest(alice);
        vm.expectRevert(IDeltaNeutralVault.ZeroAmount.selector);
        vault.deposit(0, alice, a);
        vm.expectRevert(IDeltaNeutralVault.ZeroAmount.selector);
        vault.requestRedeem(0, alice, alice);
        _deposit(alice, 10e6);
        vm.prank(alice);
        vm.expectRevert(IDeltaNeutralVault.ZeroAddress.selector);
        vault.requestRedeem(1, address(0), alice);
    }

    // ================================================================== instant exits

    function test_DN_R1_instantWithdrawUpToIdleWithoutAttestation() public {
        _deposit(alice, 1_000_000e6);
        _build(0, 500_000e6);
        uint256 idle = vault.idleAssets();
        assertEq(vault.instantCapacity(), idle);
        assertEq(vault.maxWithdraw(alice), idle);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IDeltaNeutralVault.ExceedsInstant.selector, idle + 1, idle));
        vault.withdraw(idle + 1, alice, alice);
        uint256 p0 = vault.sharePrice();
        vm.prank(alice);
        vault.withdraw(idle / 2, alice, alice);
        assertApproxEqAbs(vault.sharePrice(), p0, 1e6, "DN share price unchanged by a withdrawal");
        uint256 sh = vault.maxRedeem(alice);
        vm.prank(alice);
        vault.redeem(sh, alice, alice);
        assertApproxEqAbs(IERC20(address(m.usdg)).balanceOf(alice), idle, 2, "all the idle USDG, nothing more");
        assertLe(vault.idleAssets(), 2);
        uint256 rest = vault.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDeltaNeutralVault.ExceedsInstant.selector, vault.previewRedeem(rest), vault.idleAssets()
            )
        );
        vault.redeem(rest, alice, alice);
    }

    function test_DN_R5_R12_instantExitsWaitButRequestsAlwaysWork() public {
        _deposit(alice, 100e6);
        vm.warp(SAT_0919_16Z);
        _refresh();
        assertEq(vault.instantCapacity(), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
        vm.prank(alice);
        vm.expectRevert(IDeltaNeutralVault.MarketClosed.selector);
        vault.withdraw(1e6, alice, alice);
        vm.prank(alice);
        uint256 id = vault.requestRedeem(50e18, alice, alice); // CP-R4: closed session, no attestation
        assertEq(uint8(vault.request(id).status), uint8(IDeltaNeutralVault.RequestStatus.Queued));
        vm.warp(block.timestamp + 20 minutes); // stale NAV too
        assertFalse(nav.fresh());
        vm.prank(alice);
        vm.expectRevert(IDeltaNeutralVault.NavStale.selector);
        vault.redeem(1e18, alice, alice);
        vm.prank(alice);
        vault.requestRedeem(10e18, alice, alice);
        vm.expectRevert(IDeltaNeutralVault.NavStale.selector);
        vault.settle(10);
    }

    // ================================================================== queue

    function test_DN_R1_queueSettlesFifoAtSettlementNavAndClaimsNeverGated() public {
        _deposit(alice, 1_000_000e6);
        _deposit(bob, 100_000e6);
        _build(0, 800_000e6); // idle ≈ 1.1M − 0.76M·… leaves ~ 340k
        vm.prank(alice);
        uint256 a1 = vault.requestRedeem(600_000e18, alice, alice); // more than idle
        vm.prank(bob);
        uint256 b1 = vault.requestRedeem(10_000e18, bob, bob);
        assertEq(vault.escrowedShares(), 610_000e18);
        assertEq(vault.balanceOf(address(vault)), 610_000e18);
        uint256 n = vault.settle(10);
        assertEq(n, 0, "FIFO: bob waits behind alice's unpayable head");
        // Operator raises cash: unwind part of the sleeve.
        vm.startPrank(operator);
        strat.unlend(0, IERC20(ds[0].vault).balanceOf(address(strat)) / 2);
        uint256 w = IERC20(address(ds[0].wrapper)).balanceOf(address(strat));
        strat.sellSpot(0, w, strat.quote(0, w) * 99 / 100 + 1, _sellData(0, w));
        strat.returnToVault(IERC20(address(m.usdg)).balanceOf(address(strat)));
        vm.stopPrank();
        venueCloseProportion(0, w);
        _report();
        n = vault.settle(10);
        assertEq(n, 2);
        (uint256 head, uint256 tail) = vault.queueBounds();
        assertEq(head, 2);
        assertEq(tail, 2);
        IDeltaNeutralVault.Request memory r = vault.request(a1);
        assertEq(uint8(r.status), uint8(IDeltaNeutralVault.RequestStatus.Claimable));
        assertApproxEqRel(r.assets, 600_000e6, 1e15);
        assertEq(vault.reserved(), r.assets + vault.request(b1).assets);
        // Claims work on a stale NAV, a closed session and paused deposits; anyone can push them.
        vm.prank(dnGuardian);
        vault.setDepositsPaused(true);
        vm.warp(SAT_0919_16Z);
        vault.claim(a1);
        assertEq(IERC20(address(m.usdg)).balanceOf(alice), r.assets);
        vm.expectRevert(abi.encodeWithSelector(IDeltaNeutralVault.NotClaimable.selector, a1));
        vault.claim(a1);
        vm.expectRevert(abi.encodeWithSelector(IDeltaNeutralVault.NotClaimable.selector, 99));
        vault.claim(99);
    }

    /// @dev Reduce the sleeve's short by the units just sold, so the report stays hedged.
    function venueCloseProportion(uint256 i, uint256 units) internal {
        vm.prank(operator);
        strat.adjustShort(i, int256(units), 0);
    }

    function test_DN_R1_requestWithAllowanceAndSettlePriceIsFair() public {
        _deposit(alice, 100e6);
        vm.prank(alice);
        vault.approve(bob, 30e18);
        vm.prank(bob);
        uint256 id = vault.requestRedeem(30e18, bob, alice);
        assertEq(vault.request(id).owner, alice);
        assertEq(vault.request(id).receiver, bob);
        vm.prank(bob);
        vm.expectRevert();
        vault.requestRedeem(1e18, bob, alice); // allowance spent
        uint256 p0 = vault.sharePrice();
        vault.settle(1);
        assertApproxEqAbs(vault.sharePrice(), p0, 1, "DN settlement at the NAV keeps the price");
        vault.claim(id);
        assertEq(IERC20(address(m.usdg)).balanceOf(bob), 30e6);
    }

    function test_DN_R1_settleByIs72hOrTheNextUsOpenWhicheverIsLater() public view {
        // Wed 12:00 ET + 72h = Sat 12:00 ET (closed) → Mon 09:30 ET (feed reopens Sun 20:00 ET + 13h30).
        uint64 by = vault.settleByFor(WED_0916_16Z);
        assertEq(by, WED_0916_16Z + 4 days + 21 hours + 30 minutes);
        // Mon 12:00 ET + 72h = Thu 12:00 ET (open): 72h.
        uint256 mon = WED_0916_16Z + 5 days;
        assertEq(vault.settleByFor(mon), mon + 72 hours);
    }

    function test_DN_R1_settleByPastTheCalendar() public view {
        uint256 far = core.marketHours.lastSessionClose() + 1 days;
        assertEq(vault.settleByFor(far), far + 72 hours + core.marketHours.MAX_CLOSURE());
    }

    // ================================================================== fee

    function test_DN_R9_feeIsTenPercentAboveTheHighWaterMark() public {
        _deposit(alice, 1_000_000e6);
        m.usdg.mint(address(vault), 100_000e6); // +10% gain (e.g. funding returned)
        vault.accrueFee();
        uint256 fee = vault.balanceOf(address(core.feeSplitter));
        assertApproxEqRel(vault.convertToAssets(fee), 10_000e6, 1e12, "10% of the 100k gain");
        uint256 hwm = vault.highWaterMark();
        assertApproxEqRel(hwm, 1.09e18, 1e12);
        vault.accrueFee(); // no new gain
        assertEq(vault.balanceOf(address(core.feeSplitter)), fee);
        // A loss then a recovery to the mark: no fee on the recovery.
        vm.prank(address(vault));
        IERC20(address(m.usdg)).transfer(address(0xdead), 50_000e6);
        vault.accrueFee();
        m.usdg.mint(address(vault), 50_000e6);
        vault.accrueFee();
        assertApproxEqAbs(vault.balanceOf(address(core.feeSplitter)), fee, 1e9);
    }

    function test_DN_R9_noFeeOnAStaleNavAndNoneBeforeDeposits() public {
        vault.accrueFee(); // empty vault: nothing
        assertEq(vault.totalSupply(), 0);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(IDeltaNeutralVault.NavStale.selector);
        vault.accrueFee();
    }

    // ================================================================== strategy funding

    function test_DN_R1_sendToStrategyKeepsTheBufferAndServesAnOverdueQueueFirst() public {
        _deposit(alice, 1_000_000e6);
        vm.expectRevert(IDeltaNeutralVault.NotStrategy.selector);
        vault.sendToStrategy(1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeltaNeutralVault.BufferBreached.selector, 49_999e6, 50_000e6));
        strat.pullFromVault(950_001e6);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeltaNeutralVault.BufferBreached.selector, 0, 50_000e6));
        strat.pullFromVault(2_000_000e6);
        vm.prank(operator);
        strat.pullFromVault(950_000e6);
        vm.prank(operator);
        strat.returnToVault(100e6);
        vm.prank(alice);
        uint256 id = vault.requestRedeem(500_000e18, alice, alice);
        vm.warp(vault.request(id).settleBy);
        _refresh();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeltaNeutralVault.QueueOverdue.selector, id));
        strat.pullFromVault(1);
    }

    // ================================================================== admin

    function test_ownerSettersAndOneTimeWiring() public {
        vm.expectRevert(IDeltaNeutralVault.AlreadySet.selector);
        vault.setStrategy(address(1));
        vm.expectRevert(IDeltaNeutralVault.AlreadySet.selector);
        vault.setNavOracle(address(1));
        vm.expectRevert(IDeltaNeutralVault.BadParam.selector);
        vault.setBufferBps(5001);
        vault.setBufferBps(1000);
        assertEq(vault.bufferBps(), 1000);
        vault.setGuardian(bob);
        assertEq(vault.guardian(), bob);
        vault.setFeeRecipient(bob);
        assertEq(vault.feeRecipient(), bob);
        vm.expectRevert(IDeltaNeutralVault.ZeroAddress.selector);
        vault.setGuardian(address(0));
        vm.expectRevert(IDeltaNeutralVault.ZeroAddress.selector);
        vault.setFeeRecipient(address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setTotalCap(1);
    }

    function test_constructorAndWiringChecks() public {
        vm.expectRevert(IDeltaNeutralVault.ZeroAddress.selector);
        new DeltaNeutralVault(IERC20(address(m.usdg)), address(this), address(0), address(1), address(1), address(1), 0);
        vm.expectRevert(IDeltaNeutralVault.BadParam.selector);
        new DeltaNeutralVault(
            IERC20(address(m.usdg)), address(this), address(1), address(1), address(1), address(1), 5001
        );
        DeltaNeutralVault v = new DeltaNeutralVault(
            IERC20(address(m.usdg)), address(this), address(1), address(1), address(1), address(1), 0
        );
        vm.expectRevert(IDeltaNeutralVault.ZeroAddress.selector);
        v.setStrategy(address(0));
        vm.expectRevert(IDeltaNeutralVault.ZeroAddress.selector);
        v.setNavOracle(address(0));
        assertEq(v.decimals(), 18);
        assertEq(v.PERFORMANCE_FEE(), 0.1e18);
        assertEq(v.QUEUE_MIN(), 72 hours);
    }
}
