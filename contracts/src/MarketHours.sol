// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMarketHours} from "./interfaces/IMarketHours.sol";

/// @title MarketHours
/// @notice Calendar of Chainlink 24/5 **feed sessions** and per-stock **event windows** (OR-R10…R14).
/// A feed session is a period in which the Stock Token feeds publish (Sunday 20:00 ET → Friday 20:00 ET, minus
/// holidays; D2). The gaps between sessions are closures, which carry the weekend buffer. An event window
/// `{startTs, endTs, bufferWad}` is a scheduled event (earnings; D5): the oracle's event buffer is fully in force from
/// `startTs` and is released on the first good round with `updatedAt >= endTs`.
/// @dev All times are UTC seconds. DST, holidays and early closes are resolved offchain by
/// `packages/sdk/scripts/genSessions.ts`; nothing here does calendar math (OR-R11). The owner is the timelock. Only
/// future entries can be rewritten; any resulting buffer change is bounded by the oracle's `B_MAX` (OR-R8).
contract MarketHours is IMarketHours, Ownable {
    /// @notice Closure length assumed when the next session is unknown (OR-R12).
    uint256 public constant MAX_CLOSURE = 96 hours;
    /// @notice Largest event buffer that can be stored (matches the oracle's hard `B_MAX` cap, OR-R8).
    uint256 public constant MAX_EVENT_BUFFER = 0.2e18;

    Session[] internal _sessions;
    // Written through a storage pointer in replaceEventsFrom; slither misses that (triaged in slither.config.json).
    // slither-disable-next-line uninitialized-state
    mapping(address stock => EventWindow[]) internal _events;

    constructor(address owner_) Ownable(owner_) {}

    // ------------------------------------------------------------------ Owner (timelock)

    /// @notice Replace the sessions from `fromIndex` on (append when `fromIndex == sessionCount()`). Entries being
    /// replaced must not have opened yet. New sessions must be ordered, non-empty and separated by a closure.
    function replaceSessionsFrom(uint256 fromIndex, Session[] calldata newSessions) external onlyOwner {
        uint256 len = _sessions.length;
        if (fromIndex > len) revert BadIndex();
        if (fromIndex < len && _sessions[fromIndex].openTs <= block.timestamp) revert EntryStarted();
        uint256 prevClose = fromIndex == 0 ? 0 : _sessions[fromIndex - 1].closeTs;
        for (uint256 i = len; i > fromIndex; i--) {
            _sessions.pop();
        }
        for (uint256 i; i < newSessions.length; i++) {
            Session calldata s = newSessions[i];
            if (s.openTs >= s.closeTs || s.openTs <= prevClose) revert BadSession(i);
            _sessions.push(s);
            prevClose = s.closeTs;
        }
        emit SessionsReplaced(fromIndex, newSessions.length);
    }

    /// @notice Replace `stock`'s event windows from `fromIndex` on (append when `fromIndex == eventCount(stock)`).
    /// Entries being replaced must not have started. Windows are ordered by `startTs` (strictly increasing).
    function replaceEventsFrom(address stock, uint256 fromIndex, EventWindow[] calldata newEvents) external onlyOwner {
        if (stock == address(0)) revert ZeroAddress();
        EventWindow[] storage list = _events[stock];
        uint256 len = list.length;
        if (fromIndex > len) revert BadIndex();
        if (fromIndex < len && list[fromIndex].startTs <= block.timestamp) revert EntryStarted();
        uint256 prevStart = fromIndex == 0 ? 0 : list[fromIndex - 1].startTs;
        for (uint256 i = len; i > fromIndex; i--) {
            list.pop();
        }
        for (uint256 i; i < newEvents.length; i++) {
            EventWindow calldata e = newEvents[i];
            if (e.startTs <= prevStart || e.endTs < e.startTs || e.bufferWad > MAX_EVENT_BUFFER) revert BadEvent(i);
            list.push(e);
            prevStart = e.startTs;
        }
        emit EventsReplaced(stock, fromIndex, newEvents.length);
    }

    // ------------------------------------------------------------------ Raw access

    function sessionCount() external view returns (uint256) {
        return _sessions.length;
    }

    function sessionAt(uint256 i) external view returns (Session memory) {
        return _sessions[i];
    }

    function eventCount(address stock) external view returns (uint256) {
        return _events[stock].length;
    }

    function eventAt(address stock, uint256 i) external view returns (EventWindow memory) {
        return _events[stock][i];
    }

    /// @notice Close of the last stored session (0 if none). Past it the calendar is exhausted (OR-R12).
    function lastSessionClose() public view returns (uint256) {
        uint256 len = _sessions.length;
        return len == 0 ? 0 : _sessions[len - 1].closeTs;
    }

    // ------------------------------------------------------------------ Views (OR-R10)

    /// @inheritdoc IMarketHours
    function closureWindows(uint256 t)
        public
        view
        returns (uint256 prevClose, uint256 prevReopen, uint256 nextClose, uint256 nextReopen)
    {
        uint256 len = _sessions.length;
        uint256 k = _countClosedBy(t); // sessions with closeTs <= t
        if (k > 0) prevClose = _sessions[k - 1].closeTs;
        if (k < len) {
            prevReopen = _sessions[k].openTs;
            nextClose = _sessions[k].closeTs;
            if (k + 1 < len) nextReopen = _sessions[k + 1].openTs;
        }
    }

    /// @notice Whether the feed session covers `t` (open ≤ t < close).
    function isOpen(uint256 t) public view returns (bool) {
        (, uint256 reopen, uint256 nextClose,) = closureWindows(t);
        return nextClose != 0 && reopen <= t;
    }

    /// @notice The session containing `t`, else the next one; `found` is false past the last session.
    function currentOrNextSession(uint256 t) external view returns (Session memory s, bool found) {
        uint256 k = _countClosedBy(t);
        if (k < _sessions.length) return (_sessions[k], true);
    }

    /// @notice Length of the closure `t` is in, or (while open) of the closure that follows the current session.
    /// `MAX_CLOSURE` when a bound is unknown (before the first or after the last session).
    function closureLength(uint256 t) external view returns (uint256) {
        (uint256 prevClose, uint256 prevReopen, uint256 nextClose, uint256 nextReopen) = closureWindows(t);
        if (nextClose != 0 && prevReopen <= t) {
            return nextReopen == 0 ? MAX_CLOSURE : nextReopen - nextClose; // open
        }
        return (prevClose == 0 || prevReopen == 0) ? MAX_CLOSURE : prevReopen - prevClose;
    }

    /// @notice The event window of `stock` with `startTs <= t <= endTs` (the latest such one).
    function activeEvent(address stock, uint256 t) external view returns (EventWindow memory e, bool found) {
        EventWindow[] storage list = _events[stock];
        uint256 k = _countStartedBy(list, t);
        for (uint256 i = k; i > 0; i--) {
            if (list[i - 1].endTs >= t) return (list[i - 1], true);
        }
    }

    /// @notice The first event window of `stock` with `startTs > t`.
    function nextEvent(address stock, uint256 t) external view returns (EventWindow memory e, bool found) {
        EventWindow[] storage list = _events[stock];
        uint256 k = _countStartedBy(list, t);
        if (k < list.length) return (list[k], true);
    }

    /// @inheritdoc IMarketHours
    function eventWindows(address stock, uint256 x)
        external
        view
        returns (EventWindow memory latest, EventWindow memory previous)
    {
        EventWindow[] storage list = _events[stock];
        uint256 k = _countStartedBy(list, x);
        if (k > 0) latest = list[k - 1];
        if (k > 1) previous = list[k - 2];
    }

    // ------------------------------------------------------------------ Internals

    /// @dev Number of sessions with `closeTs <= t` (binary search; sessions are ordered).
    function _countClosedBy(uint256 t) internal view returns (uint256 lo) {
        uint256 hi = _sessions.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_sessions[mid].closeTs <= t) lo = mid + 1;
            else hi = mid;
        }
    }

    /// @dev Number of events with `startTs <= t`.
    function _countStartedBy(EventWindow[] storage list, uint256 t) internal view returns (uint256 lo) {
        uint256 hi = list.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (list[mid].startTs <= t) lo = mid + 1;
            else hi = mid;
        }
    }
}
