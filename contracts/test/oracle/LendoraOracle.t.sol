// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LendoraOracle} from "../../src/oracles/LendoraOracle.sol";
import {LendoraOracleBase} from "../../src/oracles/LendoraOracleBase.sol";
import {ILendoraOracle} from "../../src/interfaces/ILendoraOracle.sol";
import {IStockWrapper} from "../../src/interfaces/IStockWrapper.sol";
import {OracleMath} from "../../src/libraries/OracleMath.sol";
import {MockSequencerUptimeFeed} from "../mocks/MockSequencerUptimeFeed.sol";
import {MockChainlinkAggregator} from "../mocks/MockChainlinkAggregator.sol";
import {OracleFixture} from "./OracleFixture.sol";

contract LendoraOracleTest is OracleFixture {
    uint256 internal b48;
    uint256 internal b72;

    function setUp() public override {
        super.setUp();
        b48 = _full(48 hours);
        b72 = _full(72 hours);
    }

    // ================================================================== OR-R1 price math (D1)

    function test_OR_R1_priceFormulaAndScale() public view {
        assertEq(oracle.SCALE_EXP(), 48);
        assertEq(oracle.buffer(), 0, "mid-week, open, fresh round");
        assertEq(oracle.price(), _expectedPrice(100e8, 0));
        assertEq(oracle.price(), 1e46, "1 clUSDG = 0.01 wNVDA at $100, scaled 1e36 * 1e18 / 1e6");
    }

    function test_OR_R1_priceUsesCollateralValueAndUsdgFeed() public {
        clUSDG.setValuePerToken(1.05e18);
        usdgFeed.setAnswer(0.9996e8);
        assertEq(oracle.price(), OracleMath.stockLoanPrice(1.05e18, 0.9996e8, 100e8, 0, 48));
    }

    /// D1: a 4:1 split changes the multiplier but not the feed, so `price()` must not move.
    function test_OR_R1_D1_multiplierNeverEntersPrice() public {
        uint256 before = oracle.price();
        nvda.setUIMultiplier(4e18);
        assertEq(wNVDA.multiplier(), 4e18);
        assertEq(oracle.price(), before);
    }

    function test_OR_R1_priceAtUsesBufferAtT() public view {
        assertEq(oracle.priceAt(CLOSE_0918 + 1 hours), _expectedPrice(100e8, b48));
        assertEq(oracle.priceAt(block.timestamp), oracle.price());
    }

    // ================================================================== OR-R2 never revert, last good answer

    function test_OR_R2_revertingFeedUsesLastGoodAndTrips() public {
        uint256 before = oracle.price();
        stockFeed.setReverts(true);
        assertEq(oracle.price(), before);
        assertTrue(oracle.guardReasons() & oracle.SANITY() != 0);
        oracle.poke(); // poke must not revert either
        (uint256 a,) = oracle.stockAnswer();
        assertEq(a, 100e8);
    }

    function test_OR_R2_zeroAndNegativeAnswersIgnored() public {
        uint256 before = oracle.price();
        stockFeed.setAnswer(0);
        assertEq(oracle.price(), before);
        assertTrue(oracle.guardTripped());
        stockFeed.setAnswer(-5e8);
        assertEq(oracle.price(), before);
        stockFeed.setAnswer(101e8);
        assertEq(oracle.price(), _expectedPrice(101e8, 0));
        assertEq(oracle.guardReasons() & oracle.SANITY(), 0);
    }

    // ================================================================== OR-R7 sanity band (D4)

    /// Replay of the real launch-week incident (sim/data/feeds/NVDA.csv): rounds 1–24 carried answers scaled 1e18
    /// at 8 decimals (prices 10^10 too high). `price()` must not move and the guard must trip; correct rounds then
    /// resume and clear it.
    function test_OR_R7_launchWeek1e18IncidentReplay() public {
        string memory json = vm.readFile("test/vectors/nvda_launch_rounds.json");
        Round[] memory rounds = abi.decode(vm.parseJson(json, ".rounds"), (Round[]));
        assertEq(rounds.length, 40);

        // An oracle deployed before the incident with a sane reference ($203.44, the first correct round's value).
        vm.warp(rounds[0].updatedAt - 60);
        stockFeed.setAnswer(int256(rounds[24].answer));
        usdgFeed.setAnswer(1e8);
        LendoraOracle o = new LendoraOracle(_deployment(), _params(), address(clUSDG));
        uint256 p0 = o.price();

        for (uint256 i; i < 24; i++) {
            vm.warp(rounds[i].updatedAt);
            stockFeed.setAnswerAt(int256(rounds[i].answer), rounds[i].updatedAt);
            usdgFeed.setAnswer(1e8);
            assertGt(rounds[i].answer, 1e17, "incident round is 1e18-scaled");
            assertEq(o.price(), p0, "price() must not move on a 1e18-scaled round");
            assertTrue(o.guardReasons() & o.SANITY() != 0, "guard trips");
            o.poke();
            (uint256 ref,) = o.stockAnswer();
            assertEq(ref, rounds[24].answer, "reference kept");
        }
        for (uint256 i = 24; i < 40; i++) {
            vm.warp(rounds[i].updatedAt);
            stockFeed.setAnswerAt(int256(rounds[i].answer), rounds[i].updatedAt);
            usdgFeed.setAnswer(1e8);
            o.poke();
            assertEq(o.guardReasons() & o.SANITY(), 0, "correct rounds accepted");
            assertEq(o.price(), _expectedPrice(rounds[i].answer, o.buffer()));
        }
    }

    struct Round {
        uint256 answer;
        uint256 updatedAt;
    }

    function test_OR_R7_bandEdges() public {
        stockFeed.setAnswer(200e8); // exactly ×2: accepted
        assertEq(oracle.guardReasons() & oracle.SANITY(), 0);
        stockFeed.setAnswer(200e8 + 1); // just above ×2: rejected
        assertTrue(oracle.guardReasons() & oracle.SANITY() != 0);
        assertEq(oracle.price(), _expectedPrice(100e8, 0));
        stockFeed.setAnswer(50e8); // exactly ×0.5: accepted
        assertEq(oracle.guardReasons() & oracle.SANITY(), 0);
        stockFeed.setAnswer(50e8 - 1);
        assertTrue(oracle.guardReasons() & oracle.SANITY() != 0);
    }

    function test_OR_R7_pokeAdvancesReferenceSoDriftIsFollowed() public {
        // 1.9× then another 1.9× (3.61× overall) is followed round by round when poked.
        stockFeed.setAnswer(190e8);
        oracle.poke();
        stockFeed.setAnswer(361e8);
        assertEq(oracle.guardReasons() & oracle.SANITY(), 0);
        oracle.poke();
        (uint256 ref,) = oracle.stockAnswer();
        assertEq(ref, 361e8);
    }

    function test_OR_R7_absoluteRangeAndOwnerReanchor() public {
        // A genuine 3× move between pokes is rejected by the band until the owner re-anchors.
        stockFeed.setAnswer(300e8);
        oracle.poke();
        assertTrue(oracle.guardReasons() & oracle.SANITY() != 0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        oracle.resetReferences();
        vm.prank(owner);
        oracle.resetReferences();
        assertEq(oracle.guardReasons() & oracle.SANITY(), 0);
        assertEq(oracle.price(), _expectedPrice(300e8, 0));

        // Absolute range: > $1e6 or < $0.01 is rejected even by a re-anchor.
        stockFeed.setAnswer(1e6 * 1e8 + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ILendoraOracle.InsaneAnswer.selector, address(stockFeed)));
        oracle.resetReferences();
    }

    function test_OR_R7_belowOneCentRejectedEvenInsideBand() public {
        stockFeed.setAnswer(0.015e8);
        vm.prank(owner);
        oracle.resetReferences();
        stockFeed.setAnswer(0.009e8); // ×0.6: inside the band, but under $0.01
        assertTrue(oracle.guardReasons() & oracle.SANITY() != 0);
    }

    function test_OR_R7_constructorRejectsInsaneAnswer() public {
        stockFeed.setAnswer(2_082_200_000_000_000_000); // launch-incident scale
        LendoraOracleBase.Deployment memory d = _deployment();
        vm.expectRevert(abi.encodeWithSelector(ILendoraOracle.InsaneAnswer.selector, address(stockFeed)));
        new LendoraOracle(d, _params(), address(clUSDG));
    }

    // ================================================================== OR-R4 USDG/USD

    function test_OR_R4_usdgInsaneOrStaleTripsAndKeepsLastGood() public {
        uint256 before = oracle.price();
        usdgFeed.setAnswer(0.4e8);
        assertEq(oracle.price(), before);
        assertTrue(oracle.guardReasons() & oracle.USDG_FEED() != 0);
        usdgFeed.setAnswer(0.9995e8);
        assertEq(oracle.guardReasons() & oracle.USDG_FEED(), 0);
        vm.warp(block.timestamp + 1 days + 11 minutes);
        stockFeed.setAnswer(P0);
        assertTrue(oracle.guardReasons() & oracle.USDG_FEED() != 0, "USDG feed older than heartbeat + grace");
        (uint256 u,) = oracle.usdgAnswer();
        assertEq(u, 0.9995e8);
    }

    // ================================================================== OR-R3 multiplier guard (D1, D4)

    function test_OR_R3_splitWithoutPauseWindowTripsAndLatches() public {
        uint256 before = oracle.price();
        nvda.updateMultiplier(4e18); // immediate 4:1 split, no oraclePaused window
        assertTrue(oracle.guardReasons() & oracle.MULTIPLIER() != 0);
        vm.expectEmit(address(oracle));
        emit ILendoraOracle.MultiplierObserved(1e18, 4e18, false);
        oracle.poke();
        assertEq(oracle.lastMultiplier(), 4e18);
        assertTrue(oracle.latchedReasons() & oracle.MULTIPLIER() != 0, "latched after poke");
        assertEq(oracle.price(), before, "price unchanged (D1)");
        vm.prank(owner);
        oracle.clearMultiplierGuard();
        assertFalse(oracle.guardTripped());
    }

    /// The brief's replay: a 4:1 split inside an `oraclePaused()` window must not move `price()`. The guard is tripped
    /// while paused (D4) and clears after unpause and a fresh round; the multiplier change itself is accepted.
    function test_OR_R3_R23_splitReplayWithOraclePausedWindow() public {
        uint256 before = oracle.price();
        nvda.pauseOracle();
        assertTrue(oracle.guardReasons() & oracle.ORACLE_PAUSED() != 0);
        oracle.poke(); // keeper sees the pause
        vm.warp(block.timestamp + 30 minutes);
        nvda.updateMultiplier(4e18);
        assertEq(oracle.price(), before);
        assertEq(oracle.guardReasons() & oracle.MULTIPLIER(), 0, "inside the pause window");
        vm.warp(block.timestamp + 30 minutes);
        nvda.unpauseOracle();
        oracle.poke();
        assertEq(oracle.latchedReasons() & oracle.MULTIPLIER(), 0, "accepted");
        assertTrue(oracle.guardReasons() & oracle.ORACLE_PAUSED() != 0, "until a fresh round after the pause");
        assertEq(oracle.price(), before, "feed held its last value");
        vm.warp(block.timestamp + 5 minutes);
        stockFeed.setAnswer(P0); // continuous token price after the split (the feed includes the multiplier)
        usdgFeed.setAnswer(1e8);
        oracle.poke();
        assertFalse(oracle.guardTripped());
        assertEq(oracle.price(), before);
    }

    function test_OR_R3_smallDividendStepIsQuiet() public {
        nvda.updateMultiplier(1.001718e18); // SPY-like dividend reinvestment, no pause window (01 §3.3)
        oracle.poke();
        assertFalse(oracle.guardTripped());
    }

    function test_OR_R3_strictModeTripsOnDividend() public {
        ILendoraOracle.Params memory p = _params();
        p.maxQuietMultiplierStepWad = 0;
        vm.prank(owner);
        oracle.setParams(p);
        nvda.updateMultiplier(1.001718e18);
        assertTrue(oracle.guardReasons() & oracle.MULTIPLIER() != 0);
    }

    function test_OR_R3_outOfBoundsTripsEvenInPauseWindow() public {
        nvda.pauseOracle();
        oracle.poke();
        nvda.setUIMultiplier(10.5e18);
        assertTrue(oracle.guardReasons() & oracle.MULTIPLIER() != 0);
        nvda.setUIMultiplier(0.09e18);
        assertTrue(oracle.guardReasons() & oracle.MULTIPLIER() != 0);
        nvda.setUIMultiplier(0);
        assertTrue(oracle.guardReasons() & oracle.MULTIPLIER() != 0);
    }

    function test_OR_R3_revertingMultiplierTrips() public {
        vm.mockCallRevert(address(wNVDA), abi.encodeWithSelector(IStockWrapper.multiplier.selector), "");
        assertTrue(oracle.guardReasons() & oracle.MULTIPLIER() != 0);
        oracle.poke();
        assertTrue(oracle.latchedReasons() & oracle.MULTIPLIER() != 0);
    }

    // ================================================================== D4 issuer flags

    function test_D4_tokenPauseGlobalPauseAndBlockedWrapperTrip() public {
        nvda.pause();
        assertTrue(oracle.guardReasons() & oracle.TOKEN_PAUSED() != 0);
        nvda.unpause();
        nvda.registry().pause(); // global pause
        assertTrue(oracle.guardReasons() & oracle.TOKEN_PAUSED() != 0);
        nvda.registry().unpause();
        nvda.registry().setBlocked(address(wNVDA), true);
        assertTrue(oracle.guardReasons() & oracle.WRAPPER_BLOCKED() != 0);
        nvda.registry().setBlocked(address(wNVDA), false);
        assertFalse(oracle.guardTripped());
    }

    function test_D4_blocklistUnsetOrRevertingIssuerCalls() public {
        vm.prank(owner);
        oracle.setBlocklist(address(0));
        nvda.registry().setBlocked(address(wNVDA), true);
        assertEq(oracle.guardReasons() & oracle.WRAPPER_BLOCKED(), 0, "check disabled");
        vm.prank(owner);
        oracle.setBlocklist(makeAddr("noCode"));
        assertTrue(oracle.guardReasons() & oracle.WRAPPER_BLOCKED() != 0, "failing registry call trips");
        vm.mockCallRevert(address(nvda), abi.encodeWithSignature("paused()"), "");
        vm.mockCallRevert(address(nvda), abi.encodeWithSignature("oraclePaused()"), "");
        uint256 r = oracle.guardReasons();
        assertTrue(r & oracle.TOKEN_PAUSED() != 0 && r & oracle.ORACLE_PAUSED() != 0);
    }

    // ================================================================== OR-R6 sequencer (D3)

    function test_OR_R6_sequencerFeedOptional() public {
        assertEq(oracle.sequencerFeed(), address(0));
        MockSequencerUptimeFeed seq = new MockSequencerUptimeFeed();
        vm.prank(owner);
        oracle.setSequencerFeed(address(seq));
        seq.setStatus(false, block.timestamp - 2 hours);
        assertEq(oracle.guardReasons() & oracle.SEQUENCER(), 0);
        seq.setStatus(true, block.timestamp);
        assertTrue(oracle.guardReasons() & oracle.SEQUENCER() != 0, "down");
        uint256 before = oracle.price(); // never reverts
        vm.warp(block.timestamp + 10 minutes);
        seq.setStatus(false, block.timestamp);
        stockFeed.setAnswer(P0);
        usdgFeed.setAnswer(1e8);
        assertTrue(oracle.guardReasons() & oracle.SEQUENCER() != 0, "within 1h grace");
        vm.warp(block.timestamp + 1 hours);
        stockFeed.setAnswer(P0);
        usdgFeed.setAnswer(1e8);
        assertEq(oracle.guardReasons() & oracle.SEQUENCER(), 0, "after grace");
        seq.setReverts(true);
        assertTrue(oracle.guardReasons() & oracle.SEQUENCER() != 0, "failing feed trips");
        assertEq(oracle.price(), before);
    }

    // ================================================================== OR-R30 trip / clear, OR-R32 poke

    function test_OR_R30_tripClearPermissionsAndEvents() public {
        uint256 deviation = oracle.DEVIATION();
        uint256 manual = oracle.MANUAL();
        vm.prank(keeper);
        vm.expectEmit(address(oracle));
        emit ILendoraOracle.GuardChanged(deviation, true);
        oracle.trip(deviation);
        assertTrue(oracle.guardTripped());

        vm.prank(keeper);
        vm.expectRevert(ILendoraOracle.BadReason.selector);
        oracle.trip(manual); // keeper cannot use MANUAL
        uint256 l2 = oracle.L2_GAP();
        uint256 stale = oracle.STALE();
        vm.prank(guardian);
        oracle.trip(manual | l2);
        vm.prank(guardian);
        vm.expectRevert(ILendoraOracle.BadReason.selector);
        oracle.trip(stale); // onchain reasons are never set by hand
        vm.expectRevert(ILendoraOracle.Unauthorized.selector);
        oracle.trip(deviation);
        vm.prank(guardian);
        vm.expectRevert(ILendoraOracle.BadReason.selector);
        oracle.clear(0);

        vm.prank(keeper);
        vm.expectEmit(address(oracle));
        emit ILendoraOracle.GuardChanged(deviation, false);
        oracle.clear(deviation);
        vm.prank(guardian);
        oracle.clear(manual | l2);
        assertFalse(oracle.guardTripped());
        assertEq(oracle.emittedReasons(), 0);
    }

    function test_OR_R32_pokeTripsStalenessPermissionlessly() public {
        // Open session, last round Wednesday 12:00 ET; no round for heartbeat + grace.
        vm.warp(block.timestamp + 1 days + 10 minutes);
        usdgFeed.setAnswer(1e8);
        assertEq(oracle.guardReasons(), 0, "exactly heartbeat + grace is not stale");
        vm.warp(block.timestamp + 1);
        usdgFeed.setAnswer(1e8);
        assertEq(oracle.guardReasons(), oracle.STALE());
        uint256 stale = oracle.STALE();
        vm.expectEmit(address(oracle));
        emit ILendoraOracle.GuardChanged(stale, true);
        vm.prank(makeAddr("anyone"));
        oracle.poke();
        stockFeed.setAnswer(P0);
        vm.expectEmit(address(oracle));
        emit ILendoraOracle.GuardChanged(stale, false);
        oracle.poke();
    }

    function test_OR_R32_notStaleWhileClosedAndClockRestartsAtOpen() public {
        _roundAt(CLOSE_0918 - 3 hours, P0); // Friday 17:00 ET
        _warpKeepUsdgFresh(CLOSE_0918 + 30 hours); // Saturday
        assertEq(oracle.guardReasons() & oracle.STALE(), 0, "closed");
        _warpKeepUsdgFresh(OPEN_0920 + 1 hours); // Sunday 21:00 ET, no round yet: 52h since the last one
        assertEq(oracle.guardReasons() & oracle.STALE(), 0, "heartbeat counts from the session open");
        _warpKeepUsdgFresh(OPEN_0920 + 1 days + 10 minutes + 1);
        assertTrue(oracle.guardReasons() & oracle.STALE() != 0);
    }

    // ================================================================== OR-R12 calendar failsafe

    function test_OR_R12_pastLastSessionIsClosedAtMaxClosure() public {
        uint256 last = mh.lastSessionClose();
        _roundAt(last - 5 hours, P0);
        _warpKeepUsdgFresh(last + 1);
        assertTrue(oracle.guardReasons() & oracle.CALENDAR() != 0);
        assertEq(oracle.buffer(), _full(96 hours));
        // Still held a week later (never released without a reopen).
        _roundAt(last + 7 days, P0);
        assertEq(oracle.buffer(), _full(96 hours));
    }

    // ================================================================== OR-R20 closure buffer

    function test_OR_R20_weekendRampHoldReleaseOnFirstFreshRound() public {
        assertApproxEqAbs(b48, 0.0962e18, 0.0001e18, "NVDA b_full for a 48h freeze (10-risk)");
        (, uint256 u) = oracle.stockAnswer();
        assertEq(oracle.bufferAt(FRI_0918_16ET, u), 0, "ramp starts at Friday 16:00 ET");
        assertEq(oracle.bufferAt(FRI_0918_16ET + 2 hours, u), b48 / 2, "linear");
        assertEq(oracle.bufferAt(CLOSE_0918, u), b48, "full at the 20:00 ET freeze");
        assertEq(oracle.bufferAt(CLOSE_0918 + 30 hours, u), b48, "hold");
        assertEq(oracle.bufferAt(OPEN_0920 + 3 hours, u), b48, "no fresh round yet: still held");
        assertEq(oracle.bufferAt(OPEN_0920 + 3 hours, OPEN_0920 + 1 minutes), 0, "released by the first round");
        assertEq(oracle.bufferAt(OPEN_0920 + 3 hours, OPEN_0920 - 1), b48, "a round before the open does not release");

        // Same thing through live state and price().
        _roundAt(CLOSE_0918 - 1 hours, P0);
        assertEq(oracle.price(), _expectedPrice(100e8, b48 * 3 / 4));
        _warpKeepUsdgFresh(CLOSE_0918 + 1 days);
        assertEq(oracle.price(), _expectedPrice(100e8, b48));
        _roundAt(OPEN_0920 + 40, 101e8);
        assertEq(oracle.price(), _expectedPrice(101e8, 0));
    }

    function test_OR_R23_missedSundayAndMondayRoundsKeepBufferOn() public {
        _roundAt(CLOSE_0918 - 1 hours, P0);
        _warpKeepUsdgFresh(OPEN_0920 + 13 hours); // Monday 09:00 ET, no round since Friday
        assertEq(oracle.buffer(), b48);
        _warpKeepUsdgFresh(OPEN_0920 + 20 hours); // Monday 16:00 ET, still none
        assertEq(oracle.buffer(), b48);
        assertEq(oracle.guardReasons() & oracle.STALE(), 0);
        _roundAt(OPEN_0920 + 21 hours, P0);
        assertEq(oracle.buffer(), 0);
    }

    function test_OR_R23_holidayFreezeJuly3IsA72hClosure() public view {
        uint256 u = CLOSE_0702 - 2 hours;
        assertEq(oracle.bufferAt(CLOSE_0702, u), b72, "Thu 20:00 ET freeze before the Fri holiday");
        assertApproxEqAbs(b72, 0.1179e18, 0.0001e18);
        assertEq(oracle.bufferAt(CLOSE_0702 + 60 hours, u), b72);
        assertEq(oracle.bufferAt(OPEN_0705 + 1, OPEN_0705 + 1), 0);
    }

    function test_OR_R23_laborDayThreeDayWeekend() public view {
        uint256 u = CLOSE_0904 - 1 hours;
        assertEq(oracle.bufferAt(CLOSE_0904 - 2 hours, u), b72 / 2);
        assertEq(oracle.bufferAt(OPEN_0907 - 1, u), b72, "Labor Day itself is frozen until 20:00 ET");
    }

    function test_OR_R23_dstWeekClosureIs49h() public view {
        assertEq(OPEN_1101 - CLOSE_1030, 49 hours, "DST ends inside the closure");
        assertEq(oracle.bufferAt(CLOSE_1030, CLOSE_1030 - 1), _full(49 hours));
    }

    function test_OR_R23_goodFriday2027() public view {
        assertEq(OPEN_0328_27 - CLOSE_0325_27, 72 hours);
        assertEq(oracle.bufferAt(CLOSE_0325_27 + 1 days, CLOSE_0325_27 - 1), b72);
    }

    function test_OR_R23_thanksgivingHolidayAndEarlyClose() public view {
        // Wed 20:00 → Thu 20:00 ET (24h), then Fri 17:00 ET early close → Sun 20:00 ET (51h, A9).
        assertEq(OPEN_1126 - CLOSE_1125, 24 hours);
        assertEq(oracle.bufferAt(CLOSE_1125 + 1 hours, CLOSE_1125 - 1), _full(24 hours));
        assertEq(OPEN_1129 - CLOSE_1127, 51 hours);
        // The 3h Friday session sits entirely inside the next ramp: at Friday open the ramp is already 1h in.
        assertEq(oracle.bufferAt(OPEN_1126, OPEN_1126), _rampAt(_full(51 hours), OPEN_1126, CLOSE_1127));
        assertEq(oracle.bufferAt(CLOSE_1127, OPEN_1126), _full(51 hours));
    }

    function _rampAt(uint256 full, uint256 t, uint256 start) internal pure returns (uint256) {
        if (t + 4 hours <= start) return 0;
        return full * (t + 4 hours - start) / (4 hours);
    }

    // ================================================================== OR-R14 event windows (D5)

    function test_OR_R14_eventRampHoldRelease() public {
        uint64 end = uint64(WED_0916_16Z + 1 days + 4 hours); // Thu 16:00 ET
        uint64 start = end - 1 hours;
        _pushEvent(start, end, 0.1e18);
        (, uint256 u) = oracle.stockAnswer();
        assertEq(oracle.bufferAt(start - 4 hours, u), 0);
        assertEq(oracle.bufferAt(start - 1 hours, u), 0.075e18);
        assertEq(oracle.bufferAt(start, u), 0.1e18);
        assertEq(oracle.bufferAt(end + 2 hours, u), 0.1e18, "held until a round at/after endTs");
        assertEq(oracle.bufferAt(end + 2 hours, end - 1), 0.1e18, "a pre-release round does not release");
        assertEq(oracle.bufferAt(end + 2 hours, end), 0, "released by the first round at endTs");
    }

    function test_OR_R14_eventAndWeekendTakeTheMax() public {
        // An event releasing Friday 19:00 ET with 12% overlaps the weekend ramp (9.62%).
        uint64 end = uint64(CLOSE_0918 - 1 hours);
        _pushEvent(end - 2 hours, end, 0.12e18);
        (, uint256 u) = oracle.stockAnswer();
        assertEq(oracle.bufferAt(end, u), 0.12e18);
        assertEq(oracle.bufferAt(CLOSE_0918 + 1 hours, end + 1), b48, "event released, weekend holds");
    }

    function test_OR_R14_eventBufferClampedToBMax() public {
        _pushEvent(uint64(block.timestamp + 5 hours), uint64(block.timestamp + 6 hours), 0.2e18);
        ILendoraOracle.Params memory p = _params();
        p.bMaxWad = 0.15e18;
        vm.prank(owner);
        oracle.setParams(p);
        assertEq(oracle.bufferAt(block.timestamp + 5 hours, block.timestamp), 0.15e18);
    }

    /// The brief's NVDA scenario: a +26% single-round earnings jump (NVDA 2023-05-25) with the 10% event buffer in
    /// force. The jump round releases the buffer, so `price()` drops 1 − 1.10/1.26 = 12.7% < 17.29% (OR-R8), and a
    /// position that was at the limit becomes liquidatable but stays solvent. Without the event buffer the same jump
    /// drops `price()` 20.6% and leaves bad debt.
    function test_OR_R23_nvdaEarningsGap26PctWithEventBuffer() public {
        uint64 end = uint64(WED_0916_16Z + 1 days + 4 hours + 20 minutes); // Thu 16:20 ET print
        _pushEvent(end - 1 hours, end, 0.1e18);
        uint256 lltv = 0.77e18;
        uint256 collateral = 1500e6; // $1,500 clUSDG

        // Borrower holds 10.395 wNVDA of debt at $100: LTV 69.3% unbuffered...
        uint256 borrowed = 10.395e18;
        emit log_named_decimal_uint("LTV at open (no buffer)", _ltv(collateral, borrowed), 18);
        // ...ramp-in makes the effective LTV climb; at full event buffer it is at 76.2%.
        _roundAt(end - 3 hours, P0);
        emit log_named_decimal_uint("LTV mid ramp", _ltv(collateral, borrowed), 18);
        _roundAt(end - 1 minutes, P0);
        uint256 ltvBefore = _ltv(collateral, borrowed);
        emit log_named_decimal_uint("LTV with 10% event buffer", ltvBefore, 18);
        assertLt(ltvBefore, lltv, "healthy just before the print");
        uint256 pBefore = oracle.price();

        _roundAt(end, 126e8); // +26% in one round at the print
        uint256 pAfter = oracle.price();
        uint256 ltvAfter = _ltv(collateral, borrowed);
        emit log_named_decimal_uint("LTV after +26% (buffer released)", ltvAfter, 18);
        emit log_named_decimal_uint("price() step", (pBefore - pAfter) * 1e18 / pBefore, 18);
        assertEq(oracle.buffer(), 0, "the jump round releases the event buffer");
        assertGe(pAfter * 1e18, pBefore * _lltvTimesLif(lltv) / 1e18, "within Morpho's instant-drop bound");
        assertGt(ltvAfter, lltv, "liquidatable");
        assertLt(ltvAfter * _lif(lltv) / 1e18, 1e18, "solvent: collateral covers debt plus incentive, no bad debt");

        // Counterfactual: no event buffer (weekday, overnightMode on).
        uint256 noBufferStep = 1e18 - uint256(1e18) * 100 / 126;
        assertGt(noBufferStep, 1e18 - _lltvTimesLif(lltv), "breaks the 17.29% bound");
        uint256 ltvNoBuffer = 0.762e18 * 126 / 100;
        assertGt(ltvNoBuffer * _lif(lltv) / 1e18, 1e18, "bad debt without the event buffer");
    }

    function _ltv(uint256 collateral, uint256 borrowed) internal view returns (uint256) {
        return borrowed * 1e18 / (collateral * oracle.price() / 1e36); // debt / collateral value, in loan units
    }

    function _lif(uint256 lltv) internal pure returns (uint256) {
        // Morpho: min(1.15, 1 / (1 − 0.3·(1 − LLTV)))
        uint256 lif = uint256(1e36) / (1e18 - 0.3e18 * (1e18 - lltv) / 1e18);
        return lif > 1.15e18 ? 1.15e18 : lif;
    }

    function _lltvTimesLif(uint256 lltv) internal pure returns (uint256) {
        return lltv * _lif(lltv) / 1e18;
    }

    // ================================================================== OR-R8 instant-drop property

    /// Any change of the buffer within [0, B_MAX] moves `price()` down by less than 1 − LLTV·LIF (17.29% at 77%).
    function testFuzz_OR_R8_anyBufferStepWithinMorphoBound(uint256 b1, uint256 b2, uint256 p, uint256 u) public pure {
        b1 = bound(b1, 0, 0.2e18);
        b2 = bound(b2, 0, 0.2e18);
        p = bound(p, 1e6, 1e14);
        u = bound(u, 0.5e8, 2e8);
        uint256 before = OracleMath.stockLoanPrice(1e18, u, p, b1, 48);
        uint256 after_ = OracleMath.stockLoanPrice(1e18, u, p, b2, 48);
        assertGe(after_ * 1e18, before * _lltvTimesLif(0.77e18));
    }

    /// Through the live oracle: from any time in the calendar, one block later (≤ 10 s), after any mix of Lendora
    /// actions (guardian floor raise, calendar/event push, parameter change within limits, multiplier change), with
    /// the feed unchanged, `price()` never drops by more than Morpho's bound.
    function testFuzz_OR_R8_liveTransitionsWithinMorphoBound(
        uint256 t,
        uint256 dt,
        uint256 floorWad,
        uint256 eventBuf,
        uint256 eventLead,
        uint256 sigma,
        uint256 m,
        uint8 actions
    ) public {
        t = bound(t, 1_782_086_400, mh.lastSessionClose() + 10 days);
        _roundAt(t, P0);
        uint256 before = oracle.price();

        if (actions & 1 != 0) {
            vm.prank(guardian);
            try oracle.raiseBufferFloor(bound(floorWad, 1, 0.2e18)) {} catch {}
        }
        if (actions & 2 != 0) {
            uint64 start = uint64(t + bound(eventLead, 0, 5 hours));
            _pushEvent(start, start + 1 hours, uint64(bound(eventBuf, 0, 0.2e18)));
        }
        if (actions & 4 != 0) {
            ILendoraOracle.Params memory p = _params();
            p.sigmaWad = uint64(bound(sigma, 0.05e18, 3e18));
            uint256 since = oracle.lastSigmaUpdate();
            vm.warp((t > since ? t : since) + 8 days); // OR-R21 weekly limit
            vm.prank(owner);
            oracle.setParams(p);
            vm.warp(t);
        }
        if (actions & 8 != 0) nvda.setUIMultiplier(bound(m, 0.01e18, 100e18));
        vm.warp(t + bound(dt, 0, 10));
        uint256 after_ = oracle.price();
        assertGe(after_ * 1e18, before * _lltvTimesLif(0.77e18));
    }

    // ================================================================== OR-R5 roles and params

    function test_OR_R5_onlyOwnerSetters() public {
        ILendoraOracle.Params memory p = _params();
        vm.startPrank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        oracle.setParams(p);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        oracle.setBufferFloor(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        oracle.setGuardian(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        oracle.setKeeper(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        oracle.clearMultiplierGuard();
        vm.stopPrank();

        vm.startPrank(owner);
        oracle.setGuardian(makeAddr("g2"));
        oracle.setKeeper(makeAddr("k2"));
        vm.stopPrank();
        assertEq(oracle.guardian(), makeAddr("g2"));
        assertEq(oracle.keeper(), makeAddr("k2"));
    }

    function test_OR_R5_R8_paramValidation() public {
        ILendoraOracle.Params memory p = _params();
        vm.startPrank(owner);
        p.bMaxWad = 0.2e18 + 1;
        vm.expectRevert(ILendoraOracle.BadParams.selector);
        oracle.setParams(p); // OR-R8 hard cap
        p = _params();
        p.bMinWad = 0.3e18;
        vm.expectRevert(ILendoraOracle.BadParams.selector);
        oracle.setParams(p);
        p = _params();
        p.bandLowWad = 1e18;
        vm.expectRevert(ILendoraOracle.BadParams.selector);
        oracle.setParams(p);
        p = _params();
        p.bandHighWad = 1e18;
        vm.expectRevert(ILendoraOracle.BadParams.selector);
        oracle.setParams(p);
        p = _params();
        p.rampIn = 0;
        vm.expectRevert(ILendoraOracle.BadParams.selector);
        oracle.setParams(p);
        p = _params();
        p.maxQuietMultiplierStepWad = 0.6e18;
        vm.expectRevert(ILendoraOracle.BadParams.selector);
        oracle.setParams(p);
        vm.stopPrank();
    }

    function test_OR_R21_sigmaAtMostWeekly() public {
        ILendoraOracle.Params memory p = _params();
        p.sigmaWad = 0.6e18;
        vm.prank(owner);
        vm.expectRevert(ILendoraOracle.SigmaUpdateTooSoon.selector);
        oracle.setParams(p);
        p.sigmaWad = _params().sigmaWad; // other params can change any time
        p.zWad = 2.33e18;
        vm.prank(owner);
        oracle.setParams(p);
        vm.warp(block.timestamp + 7 days);
        p.sigmaWad = 0.6e18;
        vm.prank(owner);
        oracle.setParams(p);
        assertEq(oracle.params().sigmaWad, 0.6e18);
        assertEq(oracle.lastSigmaUpdate(), block.timestamp);
    }

    function test_OR_R5_guardianCanOnlyRaiseFloor() public {
        vm.expectRevert(ILendoraOracle.Unauthorized.selector);
        oracle.raiseBufferFloor(0.05e18);
        vm.startPrank(guardian);
        oracle.raiseBufferFloor(0.05e18);
        assertEq(oracle.buffer(), 0.05e18);
        vm.expectRevert(ILendoraOracle.FloorNotRaised.selector);
        oracle.raiseBufferFloor(0.04e18);
        vm.expectRevert(ILendoraOracle.FloorNotRaised.selector);
        oracle.raiseBufferFloor(0.2e18 + 1);
        vm.stopPrank();
        vm.startPrank(owner);
        vm.expectRevert(ILendoraOracle.BadParams.selector);
        oracle.setBufferFloor(0.3e18);
        oracle.setBufferFloor(0.01e18);
        assertEq(oracle.bufferFloor(), 0.01e18);
        ILendoraOracle.Params memory p = _params();
        oracle.setBufferFloor(0.2e18);
        p.bMaxWad = 0.1e18;
        oracle.setParams(p);
        vm.stopPrank();
        assertEq(oracle.bufferFloor(), 0.1e18, "floor follows a lower bMax");
    }

    function test_constructor_rejectsZeroAddressesAndBadDecimals() public {
        LendoraOracleBase.Deployment memory d = _deployment();
        d.marketHours = address(0);
        vm.expectRevert(ILendoraOracle.ZeroAddress.selector);
        new LendoraOracle(d, _params(), address(clUSDG));
        LendoraOracleBase.Deployment memory ok = _deployment();
        vm.expectRevert(ILendoraOracle.ZeroAddress.selector);
        new LendoraOracle(ok, _params(), address(0));
        MockChainlinkAggregator weird = new MockChainlinkAggregator(0, "0dp");
        weird.setAnswer(100);
        d = _deployment();
        d.stockFeed = address(weird);
        vm.mockCall(address(clUSDG), abi.encodeWithSignature("decimals()"), abi.encode(uint8(60)));
        vm.expectRevert(LendoraOracle.BadDecimals.selector);
        new LendoraOracle(d, _params(), address(clUSDG));
    }

    function test_views() public view {
        assertEq(oracle.STOCK_TOKEN(), address(nvda));
        assertEq(oracle.WRAPPER(), address(wNVDA));
        assertEq(oracle.MARKET_HOURS(), address(mh));
        assertEq(oracle.COLLATERAL(), address(clUSDG));
        assertEq(oracle.params().rampIn, 4 hours);
        assertFalse(oracle.guardTripped());
    }
}
