// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title Short-interest lens (docs/prd/07-short-interest.md §3, SI-R20, SI-R21). Interface exactly as specified.
interface IShortInterestLens {
    struct StockSnapshot {
        address stockToken;
        uint256 suppliedShares; // 1e18, after multiplier
        uint256 borrowedShares; // 1e18, after multiplier
        uint256 utilizationWad; // 1e18 = 100%
        uint256 borrowRatePerSecWad;
        uint256 bufferWad; // current weekend buffer
        bool marketOpen;
        bool guardTripped;
    }

    function snapshot(address stockToken) external view returns (StockSnapshot memory);
    function snapshotAll() external view returns (StockSnapshot[] memory);
}
