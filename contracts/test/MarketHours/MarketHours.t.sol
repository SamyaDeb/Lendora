// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MarketHours} from "../../src/MarketHours.sol";
import {IMarketHours} from "../../src/interfaces/IMarketHours.sol";
import {CalendarJson} from "../../script/lib/CalendarJson.sol";

contract MarketHoursTest is Test {
    MarketHours internal mh;
    address internal owner = makeAddr("timelock");
    address internal stock = makeAddr("NVDA");

    // A synthetic week: sessions [100,200), [300,400), [500,600).
    function _sessions() internal pure returns (IMarketHours.Session[] memory s) {
        s = new IMarketHours.Session[](3);
        s[0] = IMarketHours.Session(100, 200);
        s[1] = IMarketHours.Session(300, 400);
        s[2] = IMarketHours.Session(500, 600);
    }

    function setUp() public {
        mh = new MarketHours(owner);
        vm.prank(owner);
        mh.replaceSessionsFrom(0, _sessions());
    }

    // ------------------------------------------------------------------ OR-R10 views

    function test_OR_R10_isOpenBoundaries() public view {
        assertFalse(mh.isOpen(99));
        assertTrue(mh.isOpen(100));
        assertTrue(mh.isOpen(199));
        assertFalse(mh.isOpen(200), "close is exclusive");
        assertFalse(mh.isOpen(250));
        assertTrue(mh.isOpen(300));
        assertFalse(mh.isOpen(600));
        assertFalse(mh.isOpen(10_000));
    }

    function test_OR_R10_closureWindows() public view {
        (uint256 pc, uint256 pr, uint256 nc, uint256 nr) = mh.closureWindows(50); // before the first session
        assertEq(abi.encode(pc, pr, nc, nr), abi.encode(0, 100, 200, 300));
        (pc, pr, nc, nr) = mh.closureWindows(150); // open
        assertEq(abi.encode(pc, pr, nc, nr), abi.encode(0, 100, 200, 300));
        (pc, pr, nc, nr) = mh.closureWindows(250); // closed between sessions
        assertEq(abi.encode(pc, pr, nc, nr), abi.encode(200, 300, 400, 500));
        (pc, pr, nc, nr) = mh.closureWindows(550); // last session: next reopen unknown
        assertEq(abi.encode(pc, pr, nc, nr), abi.encode(400, 500, 600, 0));
        (pc, pr, nc, nr) = mh.closureWindows(700); // exhausted
        assertEq(abi.encode(pc, pr, nc, nr), abi.encode(600, 0, 0, 0));
    }

    function test_OR_R10_currentOrNextSession() public view {
        (IMarketHours.Session memory s, bool found) = mh.currentOrNextSession(150);
        assertTrue(found);
        assertEq(s.openTs, 100);
        (s, found) = mh.currentOrNextSession(250);
        assertEq(s.openTs, 300);
        (s, found) = mh.currentOrNextSession(600);
        assertFalse(found);
    }

    function test_OR_R10_OR_R12_closureLength() public view {
        assertEq(mh.closureLength(150), 100, "open: length of the closure after this session");
        assertEq(mh.closureLength(250), 100, "closed: current closure");
        assertEq(mh.closureLength(550), mh.MAX_CLOSURE(), "open in the last session: next unknown");
        assertEq(mh.closureLength(50), mh.MAX_CLOSURE(), "before the first session");
        assertEq(mh.closureLength(601), mh.MAX_CLOSURE(), "OR-R12 failsafe: past the last session");
        assertEq(mh.lastSessionClose(), 600);
    }

    function test_OR_R12_emptyCalendarIsClosedWithMaxClosure() public {
        MarketHours empty = new MarketHours(owner);
        assertFalse(empty.isOpen(block.timestamp));
        assertEq(empty.closureLength(block.timestamp), empty.MAX_CLOSURE());
        assertEq(empty.lastSessionClose(), 0);
        (uint256 pc, uint256 pr, uint256 nc, uint256 nr) = empty.closureWindows(1);
        assertEq(pc + pr + nc + nr, 0);
    }

    function testFuzz_OR_R10_isOpenMatchesLinearScan(uint256 t) public view {
        t = bound(t, 0, 800);
        IMarketHours.Session[] memory s = _sessions();
        bool expected;
        for (uint256 i; i < s.length; i++) {
            if (s[i].openTs <= t && t < s[i].closeTs) expected = true;
        }
        assertEq(mh.isOpen(t), expected);
    }

    // ------------------------------------------------------------------ OR-R11 pushes

    function test_OR_R11_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        mh.replaceSessionsFrom(3, new IMarketHours.Session[](0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        mh.replaceEventsFrom(stock, 0, new IMarketHours.EventWindow[](0));
    }

    function test_OR_R11_appendAndValidate() public {
        IMarketHours.Session[] memory s = new IMarketHours.Session[](1);
        s[0] = IMarketHours.Session(600, 700); // touches the previous close: no closure
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.BadSession.selector, 0));
        mh.replaceSessionsFrom(3, s);
        s[0] = IMarketHours.Session(800, 800);
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.BadSession.selector, 0));
        mh.replaceSessionsFrom(3, s);
        vm.expectRevert(IMarketHours.BadIndex.selector);
        mh.replaceSessionsFrom(4, s);
        s[0] = IMarketHours.Session(700, 800);
        vm.expectEmit(address(mh));
        emit IMarketHours.SessionsReplaced(3, 1);
        mh.replaceSessionsFrom(3, s);
        vm.stopPrank();
        assertEq(mh.sessionCount(), 4);
        assertEq(mh.sessionAt(3).closeTs, 800);
    }

    function test_OR_R11_onlyFutureSessionsCanBeRewritten() public {
        vm.warp(350); // session 1 has opened
        IMarketHours.Session[] memory s = new IMarketHours.Session[](1);
        s[0] = IMarketHours.Session(450, 470);
        vm.startPrank(owner);
        vm.expectRevert(IMarketHours.EntryStarted.selector);
        mh.replaceSessionsFrom(1, s);
        // Session 2 (opens at 500) can be replaced, e.g. an unscheduled closure day.
        mh.replaceSessionsFrom(2, s);
        vm.stopPrank();
        assertEq(mh.sessionCount(), 3);
        assertEq(mh.sessionAt(2).openTs, 450);
        assertFalse(mh.isOpen(550));
    }

    // ------------------------------------------------------------------ OR-R14 events

    function _event(uint64 start, uint64 end, uint64 b) internal pure returns (IMarketHours.EventWindow[] memory e) {
        e = new IMarketHours.EventWindow[](1);
        e[0] = IMarketHours.EventWindow(start, end, b);
    }

    function test_OR_R14_eventsViews() public {
        IMarketHours.EventWindow[] memory e = new IMarketHours.EventWindow[](2);
        e[0] = IMarketHours.EventWindow(1000, 1100, 0.1e18);
        e[1] = IMarketHours.EventWindow(2000, 2000, 0.08e18);
        vm.prank(owner);
        mh.replaceEventsFrom(stock, 0, e);
        assertEq(mh.eventCount(stock), 2);
        assertEq(mh.eventAt(stock, 1).startTs, 2000);

        (IMarketHours.EventWindow memory a, bool found) = mh.activeEvent(stock, 1050);
        assertTrue(found);
        assertEq(a.bufferWad, 0.1e18);
        (, found) = mh.activeEvent(stock, 1101);
        assertFalse(found);
        (a, found) = mh.activeEvent(stock, 2000);
        assertTrue(found);
        (, found) = mh.activeEvent(stock, 999);
        assertFalse(found);

        (a, found) = mh.nextEvent(stock, 1050);
        assertEq(a.startTs, 2000);
        (, found) = mh.nextEvent(stock, 2000);
        assertFalse(found);

        (IMarketHours.EventWindow memory latest, IMarketHours.EventWindow memory prev) = mh.eventWindows(stock, 2500);
        assertEq(latest.startTs, 2000);
        assertEq(prev.startTs, 1000);
        (latest, prev) = mh.eventWindows(stock, 1500);
        assertEq(latest.startTs, 1000);
        assertEq(prev.startTs, 0);
        (latest,) = mh.eventWindows(makeAddr("SPY"), 1500);
        assertEq(latest.startTs, 0, "SPY has no events");
    }

    function test_OR_R14_eventValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(IMarketHours.ZeroAddress.selector);
        mh.replaceEventsFrom(address(0), 0, _event(1, 2, 0));
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.BadEvent.selector, 0));
        mh.replaceEventsFrom(stock, 0, _event(10, 9, 0.1e18)); // end before start
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.BadEvent.selector, 0));
        mh.replaceEventsFrom(stock, 0, _event(10, 20, 0.2e18 + 1)); // above MAX_EVENT_BUFFER (OR-R8)
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.BadEvent.selector, 0));
        mh.replaceEventsFrom(stock, 0, _event(0, 20, 0.1e18)); // startTs must be > 0
        vm.expectRevert(IMarketHours.BadIndex.selector);
        mh.replaceEventsFrom(stock, 1, _event(10, 20, 0.1e18));
        mh.replaceEventsFrom(stock, 0, _event(1000, 1100, 0.1e18));
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.BadEvent.selector, 0));
        mh.replaceEventsFrom(stock, 1, _event(1000, 1200, 0.1e18)); // not strictly after the previous start
        vm.warp(1000);
        vm.expectRevert(IMarketHours.EntryStarted.selector);
        mh.replaceEventsFrom(stock, 0, _event(1500, 1600, 0.1e18));
        mh.replaceEventsFrom(stock, 1, _event(1500, 1600, 0.1e18)); // append still fine
        vm.stopPrank();
        assertEq(mh.eventCount(stock), 2);
    }

    function test_OR_R14_futureEventCanBeMovedOrCancelled() public {
        vm.startPrank(owner);
        mh.replaceEventsFrom(stock, 0, _event(1000, 1100, 0.1e18));
        mh.replaceEventsFrom(stock, 0, _event(1200, 1300, 0.1e18)); // earnings date moved
        assertEq(mh.eventAt(stock, 0).startTs, 1200);
        mh.replaceEventsFrom(stock, 0, new IMarketHours.EventWindow[](0)); // cancelled
        vm.stopPrank();
        assertEq(mh.eventCount(stock), 0);
    }

    // ------------------------------------------------------------------ Generated calendar (OR-R11)

    function test_OR_R11_generatedCalendarLoadsAndMatchesKnownDates() public {
        string memory json = CalendarJson.read();
        MarketHours real = new MarketHours(owner);
        IMarketHours.Session[] memory s = CalendarJson.sessions(json);
        IMarketHours.EventWindow[] memory nvda = CalendarJson.events(json, "NVDA");
        assertEq(CalendarJson.events(json, "SPY").length, 0);
        vm.startPrank(owner);
        real.replaceSessionsFrom(0, s);
        real.replaceEventsFrom(stock, 0, nvda);
        vm.stopPrank();
        assertGt(s.length, 70);

        assertTrue(real.isOpen(1_789_516_800), "Wed 2026-09-16 00:00Z (Tue 20:00 ET overnight) is open");
        assertFalse(real.isOpen(1_789_819_200), "Sat 2026-09-19 12:00Z is closed");
        assertEq(real.closureLength(1_789_819_200), 48 hours);
        assertFalse(real.isOpen(1_783_094_400), "2026-07-03 (holiday) is closed");
        assertEq(real.closureLength(1_783_094_400), 72 hours, "Thu 20:00 -> Sun 20:00 ET");
        assertFalse(real.isOpen(1_788_796_800), "Labor Day 2026-09-07 16:00Z closed");
        assertTrue(real.isOpen(1_788_840_000), "Labor Day 2026-09-08 04:00Z open (from 20:00 ET)");
        (IMarketHours.EventWindow memory a, bool found) = real.activeEvent(stock, 1_794_949_200);
        assertTrue(found);
        assertEq(a.bufferWad, 0.1e18);
    }
}
