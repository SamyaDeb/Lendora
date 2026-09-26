// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title Feed-session and event-window calendar (docs/prd/04-oracle.md §2, OR-R10…R14).
interface IMarketHours {
    /// @notice A period in which the Chainlink 24/5 feed publishes, UTC seconds, `openTs < closeTs`.
    struct Session {
        uint64 openTs;
        uint64 closeTs;
    }

    /// @notice A scheduled event for one stock (D5). The event buffer ramps in before `startTs`, holds, and is released
    /// on the first good feed round with `updatedAt >= endTs` (the earliest a round can carry the event).
    struct EventWindow {
        uint64 startTs;
        uint64 endTs;
        uint64 bufferWad;
    }

    event SessionsReplaced(uint256 fromIndex, uint256 count);
    event EventsReplaced(address indexed stock, uint256 fromIndex, uint256 count);

    error BadIndex();
    error EntryStarted();
    error BadSession(uint256 i);
    error BadEvent(uint256 i);
    error ZeroAddress();

    /// @notice The closure behind `t` and the one ahead of it, as needed by the oracle buffer (OR-R20).
    /// @return prevClose Close of the last session with `closeTs <= t` (0: none, i.e. before the first session).
    /// @return prevReopen Open of the first session with `closeTs > t` (0: calendar exhausted).
    /// @return nextClose Close of that session (0: calendar exhausted).
    /// @return nextReopen Open of the session after it (0: unknown, treated as `MAX_CLOSURE` away).
    function closureWindows(uint256 t)
        external
        view
        returns (uint256 prevClose, uint256 prevReopen, uint256 nextClose, uint256 nextReopen);

    /// @notice The latest event window of `stock` with `startTs <= x`, and the one before it (zero structs if none).
    function eventWindows(address stock, uint256 x)
        external
        view
        returns (EventWindow memory latest, EventWindow memory previous);

    function isOpen(uint256 t) external view returns (bool);
    function lastSessionClose() external view returns (uint256);
    function MAX_CLOSURE() external view returns (uint256);
}
