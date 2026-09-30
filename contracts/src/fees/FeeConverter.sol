// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IFeeConverter} from "../interfaces/IFeeConverter.sol";
import {ILendoraOracle} from "../interfaces/ILendoraOracle.sol";
import {IStockWrapper} from "../interfaces/IStockWrapper.sol";
import {IMarketHours} from "../interfaces/IMarketHours.sol";

/// @dev Feed getters of `LendoraOracleBase` (not part of `ILendoraOracle`).
interface IOracleFeeds {
    function STOCK_FEED() external view returns (address);
    function USDG_FEED_ADDRESS() external view returns (address);
}

/// @dev Chainlink `decimals()`.
interface IFeedDecimals {
    function decimals() external view returns (uint8);
}

/// @title FeeConverter
/// @notice Converts one fee recipient's `rSTOCK` fee shares to USDG (FE-R4) and forwards them to that recipient's
/// multisig (`destination`: treasury, or `BackstopReserve` until Phase 5, FE-R3). One instance per recipient; the
/// `FeeSplitter` pays each converter its weight.
/// @dev Keeper-triggered only, and the keeper can neither set the destination nor receive anything: USDG goes to
/// `destination`, set by the owner (the timelock). `convert` runs only while the Chainlink feed session is open
/// (`MarketHours.isOpen`) and the stock oracle's guard is clear, and enforces onchain that `minUsdgOut` is at most
/// `MAX_SLIPPAGE_BPS` below the oracle value (feed price, no buffer; USDG/USD feed) and that the swap delivers it. Swap
/// output is measured by balance delta (return data untrusted), the same `SwapMode` pattern as the router and the
/// liquidator. Weekly / > $1k cadence and US-hours scheduling live in the keeper (`keepers/src/feeConverter`).
contract FeeConverter is IFeeConverter, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @inheritdoc IFeeConverter
    uint256 public constant MAX_SLIPPAGE_BPS = 100;
    uint256 internal constant BPS = 10_000;

    /// @notice The stablecoin every conversion ends in.
    IERC20 public immutable USDG;
    uint8 internal immutable _usdgDecimals;

    /// @inheritdoc IFeeConverter
    address public destination;
    /// @inheritdoc IFeeConverter
    address public keeper;
    /// @inheritdoc IFeeConverter
    mapping(address vault => address oracle) public oracleOf;
    /// @inheritdoc IFeeConverter
    mapping(address target => SwapMode) public swapModes;

    /// @param owner_ The timelock (a deployer during deployment, then handed over).
    /// @param usdg USDG.
    /// @param destination_ Recipient multisig of the converted USDG.
    /// @param keeper_ Fee-converter keeper EOA.
    constructor(address owner_, address usdg, address destination_, address keeper_) Ownable(owner_) {
        if (usdg == address(0) || destination_ == address(0) || keeper_ == address(0)) revert ZeroAddress();
        USDG = IERC20(usdg);
        _usdgDecimals = IERC20Metadata(usdg).decimals();
        destination = destination_;
        keeper = keeper_;
        emit DestinationSet(destination_);
        emit KeeperSet(keeper_);
    }

    // ------------------------------------------------------------------ Owner (timelock)

    /// @inheritdoc IFeeConverter
    function setVault(address vault, address oracle) external onlyOwner {
        if (vault == address(0)) revert ZeroAddress();
        if (oracle != address(0) && IERC4626(vault).asset() != ILendoraOracle(oracle).WRAPPER()) {
            revert BadVault(vault);
        }
        oracleOf[vault] = oracle;
        emit VaultSet(vault, oracle);
    }

    /// @inheritdoc IFeeConverter
    function setSwapTarget(address target, SwapMode mode) external onlyOwner {
        if (target == address(0) || target == address(USDG)) revert ZeroAddress();
        swapModes[target] = mode;
        emit SwapTargetSet(target, mode);
    }

    /// @inheritdoc IFeeConverter
    function setDestination(address destination_) external onlyOwner {
        if (destination_ == address(0)) revert ZeroAddress();
        destination = destination_;
        emit DestinationSet(destination_);
    }

    /// @inheritdoc IFeeConverter
    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @inheritdoc IFeeConverter
    function forwardUnconverted(address token, uint256 amount) external onlyOwner nonReentrant {
        address to = destination;
        IERC20(token).safeTransfer(to, amount);
        emit Forwarded(token, amount, to);
    }

    // ------------------------------------------------------------------ Keeper

    // The swap is measured by the balance delta across the external call on purpose (return data is never trusted);
    // targets are owner-allowlisted and `convert` is nonReentrant, so re-entry can only add USDG to the delta. Vault
    // redeem and wrapper unwrap are measured the same way. Triaged in slither.config.json.
    // slither-disable-start reentrancy-balance,unused-return
    /// @inheritdoc IFeeConverter
    function convert(address vault, uint256 shares, uint256 minUsdgOut, Swap calldata swap)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        if (msg.sender != keeper) revert NotKeeper();
        if (shares == 0) revert ZeroShares();
        ILendoraOracle oracle = ILendoraOracle(oracleOf[vault]);
        if (address(oracle) == address(0)) revert VaultNotSet(vault);
        if (!IMarketHours(oracle.MARKET_HOURS()).isOpen(block.timestamp)) revert MarketClosed();
        uint256 reasons = oracle.guardReasons();
        if (reasons != 0) revert GuardTripped(reasons);
        if (swapModes[swap.target] == SwapMode.None) revert SwapTargetNotAllowed(swap.target);

        uint256 stockIn = _redeemToStock(oracle, vault, shares);
        // FE-R4: at most 1% below the oracle value, enforced here, not by the keeper.
        (uint256 value, uint256 floor) = _quote(oracle, stockIn);
        if (minUsdgOut < floor) revert SlippageTooLoose(minUsdgOut, floor);
        usdgOut = _sell(IERC20(oracle.STOCK_TOKEN()), stockIn, swap);
        if (usdgOut < minUsdgOut) revert InsufficientOutput(usdgOut, minUsdgOut);

        address to = destination;
        USDG.safeTransfer(to, usdgOut);
        emit Converted(vault, shares, stockIn, usdgOut, value, to);
    }

    /// @dev rSTOCK → wSTOCK → Stock Token; returns the raw Stock Token units received (balance deltas).
    function _redeemToStock(ILendoraOracle oracle, address vault, uint256 shares) internal returns (uint256) {
        IStockWrapper wrapper = IStockWrapper(oracle.WRAPPER());
        IERC20 stock = IERC20(oracle.STOCK_TOKEN());
        uint256 wBefore = IERC20(address(wrapper)).balanceOf(address(this));
        IERC4626(vault).redeem(shares, address(this), address(this));
        uint256 wrapped = IERC20(address(wrapper)).balanceOf(address(this)) - wBefore;
        uint256 sBefore = stock.balanceOf(address(this));
        wrapper.unwrap(wrapped, address(this));
        return stock.balanceOf(address(this)) - sBefore;
    }

    /// @dev Pays `amount` of `stock` to the allowlisted target (approve or transfer), calls it, resets the approval;
    /// returns the USDG received (balance delta).
    function _sell(IERC20 stock, uint256 amount, Swap calldata swap) internal returns (uint256) {
        SwapMode mode = swapModes[swap.target];
        uint256 uBefore = USDG.balanceOf(address(this));
        if (mode == SwapMode.Approve) stock.forceApprove(swap.target, amount);
        else stock.safeTransfer(swap.target, amount);
        (bool ok, bytes memory ret) = swap.target.call(swap.data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        if (mode == SwapMode.Approve) stock.forceApprove(swap.target, 0);
        return USDG.balanceOf(address(this)) - uBefore;
    }

    // slither-disable-end reentrancy-balance,unused-return

    // ------------------------------------------------------------------ Views

    /// @inheritdoc IFeeConverter
    function quote(address vault, uint256 stockAmount) external view returns (uint256 value, uint256 floor) {
        address oracle = oracleOf[vault];
        if (oracle == address(0)) revert VaultNotSet(vault);
        return _quote(ILendoraOracle(oracle), stockAmount);
    }

    /// @dev USDG raw = stock raw × P_stock / P_usdg, both feeds in their own decimals (D1: the feed already includes
    /// the multiplier; no buffer). Rounded down; `floor` = value × (1 − 1%), rounded up.
    function _quote(ILendoraOracle oracle, uint256 stockAmount) internal view returns (uint256 value, uint256 floor) {
        // Only the answers are needed; the guard (checked in `convert`) covers their age (slither.config.json).
        // slither-disable-next-line unused-return
        (uint256 stockAns,) = oracle.stockAnswer();
        // slither-disable-next-line unused-return
        (uint256 usdgAns,) = oracle.usdgAnswer();
        uint8 stockFeedDec = IFeedDecimals(IOracleFeeds(address(oracle)).STOCK_FEED()).decimals();
        uint8 usdgFeedDec = IFeedDecimals(IOracleFeeds(address(oracle)).USDG_FEED_ADDRESS()).decimals();
        uint8 stockDec = IERC20Metadata(oracle.STOCK_TOKEN()).decimals();
        value = Math.mulDiv(
            stockAmount * stockAns,
            10 ** (uint256(_usdgDecimals) + usdgFeedDec),
            usdgAns * 10 ** (uint256(stockDec) + stockFeedDec)
        );
        floor = Math.mulDiv(value, BPS - MAX_SLIPPAGE_BPS, BPS, Math.Rounding.Ceil);
    }
}
