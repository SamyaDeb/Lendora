// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";

/// @title Stockline router (docs/prd/05-collateral-router.md §4, RT-R1…R7).
interface IStocklineRouter {
    /// @notice How the router hands `amountIn` to an allowlisted swap target (RT-R3).
    enum SwapMode {
        None, // not allowlisted
        Approve, // approve `amountIn`, call, reset the approval (aggregators)
        Transfer // transfer `amountIn` to the target, then call (Uniswap UniversalRouter with payerIsUser = false)
    }

    /// @notice A swap through an allowlisted target. The router checks balances; it never reads the return data.
    struct Swap {
        address target;
        bytes data;
        uint256 amountIn; // exact input handed to the target
        uint256 minOut; // user-set slippage bound, checked on the balance delta
    }

    /// @notice A listed stock-loan market.
    struct Market {
        address wrapper;
        address vault;
        address adapter;
        MarketParams params;
        uint256 perAddressCapUsd; // WAD USD of debt per address (D8)
        bool listed;
    }

    /// @notice EIP-712 compliance attestation (RT-R2, CP-R3), bound to user, chain (domain) and expiry.
    struct Attestation {
        uint256 expiry;
        bytes signature;
    }

    event Lent(address indexed user, address indexed stock, uint256 assets, uint256 shares, address receiver);
    event Withdrawn(address indexed user, address indexed stock, uint256 shares, uint256 assets, address receiver);
    event Borrowed(address indexed user, address indexed stock, uint256 collateralIn, uint256 borrowed);
    event ShortOpened(
        address indexed user,
        address indexed stock,
        uint256 collateralIn,
        uint256 borrowed,
        uint256 usdgOut,
        bool compound
    );
    event ShortClosed(
        address indexed user, address indexed stock, uint256 repaidAssets, uint256 usdgIn, uint256 collateralOut
    );
    event Repaid(
        address indexed payer, address indexed onBehalf, address indexed stock, uint256 assets, uint256 shares
    );
    event CollateralAdded(address indexed payer, address indexed onBehalf, address indexed stock, uint256 amount);
    event CollateralWithdrawn(address indexed user, address indexed stock, uint256 amount, address receiver);
    event MarketListed(address indexed stock, Market market);
    event MarketDelisted(address indexed stock);
    event CapOverrideSet(address indexed user, address indexed stock, uint256 capUsd);
    event GlobalCapSet(uint256 cap);
    event AttestationSignerSet(address signer);
    event SwapTargetSet(address indexed target, SwapMode mode);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Expired();
    error NotListed(address stock);
    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error GuardTripped(uint256 reasons);
    error HealthTooLow(uint256 healthFactor);
    error PerAddressCapExceeded(uint256 debtUsd, uint256 cap);
    error GlobalCapExceeded(uint256 supply, uint256 cap);
    error BadAttestation();
    error SwapTargetNotAllowed(address target);
    error InsufficientOutput(uint256 out, uint256 minOut);
    error BadMarket();

    function lend(address stock, uint256 amount, uint256 minShares, address receiver, uint256 deadline)
        external
        returns (uint256 shares);
    function withdrawLend(address stock, uint256 shares, uint256 minAssets, address receiver, uint256 deadline)
        external
        returns (uint256 assets);
    function borrow(
        address stock,
        uint256 collateralIn,
        uint256 borrowAmount,
        address receiver,
        Attestation calldata att,
        uint256 deadline
    ) external;
    function openShort(
        address stock,
        uint256 collateralIn,
        uint256 borrowAmount,
        Swap calldata swap,
        bool compound,
        address receiver,
        Attestation calldata att,
        uint256 deadline
    ) external returns (uint256 usdgOut);
    function closeShort(address stock, uint256 usdgIn, Swap calldata swap, address receiver, uint256 deadline)
        external
        returns (uint256 collateralOut);
    function addCollateral(address stock, uint256 amount, address onBehalf, uint256 deadline) external;
    function repay(address stock, uint256 assets, uint256 shares, address onBehalf, uint256 deadline)
        external
        returns (uint256 repaidAssets);
    function withdrawCollateral(address stock, uint256 amount, address receiver, uint256 deadline) external;
}
