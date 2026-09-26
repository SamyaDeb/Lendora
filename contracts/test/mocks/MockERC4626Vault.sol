// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @notice Share-price stand-in for an `rSTOCK` Vault V2 in oracle tests: 18-decimal shares, settable
/// `convertToAssets(1e18)`.
contract MockERC4626Vault {
    uint256 public assetsPerShare = 1e18;
    uint8 public constant decimals = 18;

    function setAssetsPerShare(uint256 a) external {
        assetsPerShare = a;
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return shares * assetsPerShare / 1e18;
    }
}
