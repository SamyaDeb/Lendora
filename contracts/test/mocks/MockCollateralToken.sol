// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal `clUSDG` stand-in for oracle tests: 6 decimals and a settable `valuePerToken()` (CL-R4).
contract MockCollateralToken is ERC20 {
    uint256 public valuePerToken = 1e18;

    constructor() ERC20("Stockline Collateral USDG", "clUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setValuePerToken(uint256 v) external {
        valuePerToken = v;
    }
}
