// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title Lendora fee converter surface (docs/prd/09-backstop-fees.md FE-R4).
interface IFeeConverter {
    enum SwapMode {
        None,
        Approve,
        Transfer
    }

    /// @notice One swap of the Stock Token for USDG through an allowlisted target (return data is never trusted).
    struct Swap {
        address target;
        bytes data;
    }

    event Converted(
        address indexed vault,
        uint256 shares,
        uint256 stockIn,
        uint256 usdgOut,
        uint256 oracleValue,
        address destination
    );
    event VaultSet(address indexed vault, address oracle);
    event SwapTargetSet(address indexed target, SwapMode mode);
    event DestinationSet(address destination);
    event KeeperSet(address keeper);
    event Forwarded(address indexed token, uint256 amount, address destination);

    error ZeroAddress();
    error NotKeeper();
    error VaultNotSet(address vault);
    error BadVault(address vault);
    error MarketClosed();
    error GuardTripped(uint256 reasons);
    error SwapTargetNotAllowed(address target);
    error SlippageTooLoose(uint256 minUsdgOut, uint256 floor);
    error InsufficientOutput(uint256 out, uint256 minOut);
    error ZeroShares();

    /// @notice Largest allowed slippage below the oracle value, in bps (FE-R4: 1%).
    function MAX_SLIPPAGE_BPS() external view returns (uint256);
    /// @notice Where every converted USDG goes (owner-set; the keeper cannot change it).
    function destination() external view returns (address);
    /// @notice The only account that may call `convert`.
    function keeper() external view returns (address);
    /// @notice The `LendoraOracle` used to price and gate `vault`'s stock (zero = not convertible).
    function oracleOf(address vault) external view returns (address);
    /// @notice How an allowlisted swap target is paid; `None` = not allowed.
    function swapModes(address target) external view returns (SwapMode);

    /// @notice Keeper: redeem `shares` of `vault` → unwrap → swap the Stock Token for USDG → forward to
    /// `destination`.
    /// Only while the feed session is open and the oracle guard is clear; `minUsdgOut` must be at least the oracle
    /// value of the stock redeemed minus `MAX_SLIPPAGE_BPS`, and the swap must deliver at least `minUsdgOut`.
    function convert(address vault, uint256 shares, uint256 minUsdgOut, Swap calldata swap)
        external
        returns (uint256 usdgOut);
    /// @notice Oracle value (USDG raw) of `stockAmount` raw Stock Token units of `vault`'s stock, and the lowest
    /// `minUsdgOut` `convert` accepts for it.
    function quote(address vault, uint256 stockAmount) external view returns (uint256 value, uint256 floor);

    /// @notice Owner (timelock): make `vault` convertible, priced and gated by `oracle` (`vault.asset() ==
    /// oracle.WRAPPER()`); `address(0)` removes it.
    function setVault(address vault, address oracle) external;
    /// @notice Owner (timelock): allowlist a swap target and how it is paid; `None` removes it.
    function setSwapTarget(address target, SwapMode mode) external;
    /// @notice Owner (timelock): where converted USDG goes.
    function setDestination(address destination_) external;
    /// @notice Owner (timelock): the keeper allowed to call `convert`.
    function setKeeper(address keeper_) external;
    /// @notice Owner (timelock): send `amount` of `token` unconverted to `destination` (exit when a stock cannot be
    /// converted, e.g. after a delisting). Never to any other address.
    function forwardUnconverted(address token, uint256 amount) external;
}
