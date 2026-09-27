// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {IOracle} from "morpho-blue/src/interfaces/IOracle.sol";

/// @title Stockline oracle surface (docs/prd/04-oracle.md). Both oracles implement it.
interface IStocklineOracle is IOracle {
    /// @notice Buffer and guard parameters (all WAD unless noted). Changed only by the owner (timelock).
    struct Params {
        uint64 zWad; // z-score, e.g. 2.5e18
        uint64 sigmaWad; // annualized volatility, e.g. 0.52e18 (OR-R21: at most weekly)
        uint64 bMinWad; // B_MIN
        uint64 bMaxWad; // B_MAX, ≤ MAX_BUFFER = 20% (OR-R8)
        uint32 rampIn; // seconds, 4h at launch
        uint32 stockHeartbeat; // seconds, 86 400 (feed heartbeat while open)
        uint32 usdgHeartbeat; // seconds, 86 400
        uint32 staleGrace; // seconds, 10 min
        uint32 sequencerGrace; // seconds, 1h (OR-R6)
        uint64 bandLowWad; // OR-R7 lower band, 0.5e18
        uint64 bandHighWad; // OR-R7 upper band, 2e18
        uint64 maxQuietMultiplierStepWad; // OR-R3 proposal: 0.05e18 (0 = strict D1)
    }

    event GuardChanged(uint256 indexed reason, bool tripped);
    event ParamsSet(Params params);
    event BufferFloorSet(uint256 floorWad);
    event RoleSet(bytes32 indexed role, address account);
    event SequencerFeedSet(address feed);
    event BlocklistSet(address registry);
    event ReferenceUpdated(address indexed feed, uint256 answer, uint256 updatedAt);
    event MultiplierObserved(uint256 previous, uint256 current, bool accepted);

    error ZeroAddress();
    error BadParams();
    error SigmaUpdateTooSoon();
    error Unauthorized();
    error BadReason();
    error InsaneAnswer(address feed);
    error FloorNotRaised();

    /// @notice Morpho IOracle price with the buffer in force now; never reverts (OR-R2).
    function price() external view returns (uint256);
    /// @notice `price()` with the buffer evaluated at `t` (current feed answers, no new rounds assumed).
    function priceAt(uint256 t) external view returns (uint256);
    /// @notice Buffer (WAD) at `t` if the last good stock round was at `lastGoodUpdatedAt` (OR-R20).
    function bufferAt(uint256 t, uint256 lastGoodUpdatedAt) external view returns (uint256);
    /// @notice Buffer in force now.
    function buffer() external view returns (uint256);
    /// @notice Whether any guard reason is set (OR-R30).
    function guardTripped() external view returns (bool);
    /// @notice Bitmask of latched and live guard reasons (OR-R30).
    function guardReasons() external view returns (uint256);
    /// @notice Permissionless: record the latest good rounds, latch or clear onchain reasons, emit GuardChanged
    /// (OR-R32).
    function poke() external;
    /// @notice The stock feed answer in use (raw feed decimals) and its `updatedAt` (OR-R2, OR-R7).
    function stockAnswer() external view returns (uint256 answer, uint256 updatedAt);
    /// @notice Last good USDG/USD answer (8 dp) and its updatedAt.
    function usdgAnswer() external view returns (uint256 answer, uint256 updatedAt);
    /// @notice The Stock Token priced.
    function STOCK_TOKEN() external view returns (address);
    /// @notice The StockWrapper that is the market loan token.
    function WRAPPER() external view returns (address);
    /// @notice The feed calendar (OR-R10).
    function MARKET_HOURS() external view returns (address);
    /// @notice Buffer, heartbeat, band and multiplier parameters (OR-R5).
    function params() external view returns (Params memory);
}
