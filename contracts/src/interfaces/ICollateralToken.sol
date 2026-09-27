// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Gated borrower collateral `clUSDG` (docs/prd/05-collateral-router.md §2, CL-R1…R7).
interface ICollateralToken is IERC20Metadata {
    event RouterSet(address router);
    event Minted(address indexed to, uint256 amount);
    event Unwrapped(address indexed from, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NotRouter();
    error NotDeployer();
    error RouterAlreadySet();
    error TransferNotAllowed(address from, address to);
    error UnexpectedTransferAmount(uint256 expected, uint256 received);

    /// @notice The single backing asset (USDG for v1), fixed at deployment (CL-R1).
    function backing() external view returns (address);
    /// @notice Morpho Blue (a permitted transfer counterparty, CL-R3).
    function morpho() external view returns (address);
    /// @notice The only minter (CL-R2).
    function router() external view returns (address);
    /// @notice USD value per whole token in WAD, before the USDG/USD feed (CL-R4). 1e18 for USDG.
    function valuePerToken() external view returns (uint256);
    /// @notice Router-only: pulls `amount` backing from the router and mints 1:1 to `to` (CL-R2).
    function mint(address to, uint256 amount) external;
    /// @notice Anyone: burns `amount` and returns the backing 1:1 to `to` (CL-R2, CL-R5).
    function unwrap(uint256 amount, address to) external returns (uint256);
}
