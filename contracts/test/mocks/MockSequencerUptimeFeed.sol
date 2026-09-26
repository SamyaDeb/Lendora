// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @notice Chainlink L2 Sequencer Uptime Feed stand-in (OR-R6). Semantics as documented by Chainlink: `answer` 0 = up,
/// 1 = down; `startedAt` = when the status last changed. None exists on Robinhood Chain (D3); this lets the oracle's
/// optional slot be tested.
contract MockSequencerUptimeFeed {
    uint80 public roundId;
    int256 public answer;
    uint256 public startedAt;
    bool public reverts;

    error MockFeedReverted();

    constructor() {
        roundId = 1;
        startedAt = block.timestamp;
    }

    /// @notice Record a status change at `changedAt`.
    function setStatus(bool down, uint256 changedAt) external {
        roundId++;
        answer = down ? int256(1) : int256(0);
        startedAt = changedAt;
    }

    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    function decimals() external pure returns (uint8) {
        return 0;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (reverts) revert MockFeedReverted();
        return (roundId, answer, startedAt, startedAt, roundId);
    }
}
