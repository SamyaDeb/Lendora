// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Chainlink AggregatorV3Interface (unchanged from chainlink/contracts).
interface AggregatorV3Interface {
    /// @notice Answer decimals (8 for Stock Token and USDG feeds).
    function decimals() external view returns (uint8);
    /// @notice Feed description.
    function description() external view returns (string memory);
    /// @notice Aggregator version.
    function version() external view returns (uint256);
    /// @notice A past round.
    function getRoundData(uint80 _roundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    /// @notice The latest round (answer, updatedAt, …).
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
