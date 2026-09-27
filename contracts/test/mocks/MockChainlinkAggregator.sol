// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {MockGate} from "./MockGate.sol";

import {AggregatorV3Interface} from "../../src/interfaces/external/AggregatorV3Interface.sol";

/// @notice Chainlink feed with full control over answer, timestamps and failure modes. Each `setAnswer*` call starts
/// a new round, so `getRoundData` history is available to tests.
contract MockChainlinkAggregator is AggregatorV3Interface, MockGate {
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
    }

    uint8 public immutable decimals;
    string public description;
    uint256 public constant version = 4;

    uint80 public latestRound;
    mapping(uint80 => Round) internal _rounds;

    bool public reverts;

    error MockFeedReverted();
    error NoDataPresent();

    constructor(uint8 decimals_, string memory description_) {
        decimals = decimals_;
        description = description_;
    }

    /// @notice New round with `updatedAt = block.timestamp`.
    function setAnswer(int256 answer) external gate {
        _push(answer, block.timestamp);
    }

    /// @notice New round with an explicit `updatedAt` (can be in the past to simulate staleness).
    function setAnswerAt(int256 answer, uint256 updatedAt) external gate {
        _push(answer, updatedAt);
    }

    /// @notice Rewrites `updatedAt` of the latest round without changing the answer.
    function setUpdatedAt(uint256 updatedAt) external gate {
        _rounds[latestRound].updatedAt = updatedAt;
    }

    /// @notice Makes every read revert, to test that consumers never propagate a feed revert.
    function setReverts(bool reverts_) external gate {
        reverts = reverts_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestRound);
    }

    function getRoundData(uint80 roundId) public view returns (uint80, int256, uint256, uint256, uint80) {
        if (reverts) revert MockFeedReverted();
        if (roundId == 0 || roundId > latestRound) revert NoDataPresent();
        Round memory r = _rounds[roundId];
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }

    function _push(int256 answer, uint256 updatedAt) internal {
        latestRound++;
        _rounds[latestRound] = Round(answer, updatedAt, updatedAt);
    }
}
