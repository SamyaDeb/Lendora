// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IStrategyManager} from "../interfaces/IStrategyManager.sol";
import {IDeltaNeutralVault} from "../interfaces/IDeltaNeutralVault.sol";
import {IPerpAdapter} from "../interfaces/IPerpAdapter.sol";
import {ILendoraOracle} from "../interfaces/ILendoraOracle.sol";
import {IStockWrapper} from "../interfaces/IStockWrapper.sol";
import {IMarketHours} from "../interfaces/IMarketHours.sol";

/// @dev Feed getters of `LendoraOracleBase` (not part of `ILendoraOracle`), as in `FeeConverter`.
interface IOracleFeedsDN {
    function STOCK_FEED() external view returns (address);
    function USDG_FEED_ADDRESS() external view returns (address);
}

/// @dev Chainlink `decimals()`.
interface IFeedDecimalsDN {
    function decimals() external view returns (uint8);
}

/// @title StrategyManager
/// @notice Custodian and limit-checker of the delta-neutral vault's positions (DN-R2, DN-R3, DN-R6, DN-R8, DN-R10).
/// See `IStrategyManager`.
/// @dev What the operator can't do, whatever it signs: send tokens anywhere but the vault, the adapter, a sleeve's
/// wrapper or `rSTOCK` vault, or an allowlisted swap target (paid exactly the swap input, approval reset after);
/// trade below the oracle price by more than `maxSlippageBps` (≤ 1%) per swap (output measured by balance delta);
/// buy spot above a sleeve's cap, lend above its `maxLendBps`, or add exposure to a killed sleeve or while paused.
/// Residual trust (A40): each swap can lose up to `maxSlippageBps`, and the venue key can trade at bad prices on the
/// venue; both are disclosed in the Phase 4 audit package. Owner = the timelock.
contract StrategyManager is IStrategyManager, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @inheritdoc IStrategyManager
    uint256 public constant MAX_SLIPPAGE_CEILING_BPS = 100;
    /// @notice A short may exceed the sleeve's spot by at most this (bps), where the venue exposes the size onchain.
    uint256 public constant SHORT_OVERHANG_BPS = 500;
    uint256 internal constant BPS = 10_000;

    /// @inheritdoc IStrategyManager
    address public immutable VAULT;
    /// @inheritdoc IStrategyManager
    address public immutable USDG;
    uint8 internal immutable USDG_DECIMALS;

    /// @inheritdoc IStrategyManager
    address public adapter;
    /// @inheritdoc IStrategyManager
    address public operator;
    /// @inheritdoc IStrategyManager
    address public guardian;
    /// @inheritdoc IStrategyManager
    bool public paused;
    /// @inheritdoc IStrategyManager
    uint64 public tradeNonce;
    /// @inheritdoc IStrategyManager
    uint256 public maxSlippageBps;
    /// @inheritdoc IStrategyManager
    mapping(address target => SwapMode) public swapModes;
    Sleeve[] internal _sleeves;
    mapping(address token => bool) internal _isSleeveContract;

    /// @param owner_ Deployer during deployment, then the timelock.
    /// @param vault The `DeltaNeutralVault`.
    /// @param operator_ Rebalancer key.
    /// @param guardian_ Guardian multisig.
    /// @param maxSlippageBps_ Swap floor below the oracle value (≤ 100).
    constructor(address owner_, address vault, address operator_, address guardian_, uint256 maxSlippageBps_)
        Ownable(owner_)
    {
        if (vault == address(0) || operator_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (maxSlippageBps_ > MAX_SLIPPAGE_CEILING_BPS) revert BadParam();
        VAULT = vault;
        USDG = IERC4626(vault).asset();
        USDG_DECIMALS = IERC20Metadata(USDG).decimals();
        operator = operator_;
        guardian = guardian_;
        maxSlippageBps = maxSlippageBps_;
        emit OperatorSet(operator_);
        emit GuardianSet(guardian_);
        emit MaxSlippageSet(maxSlippageBps_);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    /// @dev Unwinding: the operator or the guardian, paused or not.
    modifier onlyOperatorOrGuardian() {
        if (msg.sender != operator && msg.sender != guardian) revert NotOperatorOrGuardian();
        _;
    }

    /// @dev Adding exposure: not while paused.
    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // ================================================================== Operator: funding

    /// @inheritdoc IStrategyManager
    function pullFromVault(uint256 amount) external onlyOperator whenNotPaused nonReentrant {
        IDeltaNeutralVault(VAULT).sendToStrategy(amount);
        emit FundsPulled(amount);
    }

    /// @inheritdoc IStrategyManager
    function returnToVault(uint256 amount) external onlyOperatorOrGuardian nonReentrant {
        IERC20(USDG).safeTransfer(VAULT, amount);
        emit FundsReturned(amount);
    }

    // ================================================================== Spot

    // Swap outputs are measured by balance deltas across the external call on purpose (return data is never trusted);
    // targets are owner-allowlisted and every entry point is nonReentrant (slither.config.json, as FeeConverter).
    // slither-disable-start reentrancy-balance,unused-return
    /// @inheritdoc IStrategyManager
    function buySpot(uint256 id, uint256 usdgIn, uint256 minStockOut, Swap calldata swap)
        external
        onlyOperator
        whenNotPaused
        nonReentrant
        returns (uint256 stockOut)
    {
        Sleeve memory s = _active(id);
        _requireTradable(id, s, true);
        uint256 fair = _usdgToStock(s, usdgIn);
        uint256 floor = Math.mulDiv(fair, BPS - maxSlippageBps, BPS, Math.Rounding.Ceil);
        if (minStockOut < floor) revert SlippageTooLoose(minStockOut, floor);
        stockOut = _swap(IERC20(USDG), IERC20(s.stockToken), usdgIn, swap);
        if (stockOut < minStockOut) revert InsufficientOutput(stockOut, minStockOut);
        IERC20(s.stockToken).forceApprove(s.wrapper, stockOut);
        IStockWrapper(s.wrapper).wrap(stockOut, address(this));
        uint256 value = quote(id, spotUnits(id));
        if (value > s.capUsdg) revert CapExceeded(id, value, s.capUsdg);
        emit SpotBought(id, usdgIn, stockOut, fair);
    }

    /// @inheritdoc IStrategyManager
    function sellSpot(uint256 id, uint256 stockIn, uint256 minUsdgOut, Swap calldata swap)
        external
        onlyOperatorOrGuardian
        nonReentrant
        returns (uint256 usdgOut)
    {
        Sleeve memory s = _sleeve(id);
        _requireTradable(id, s, false);
        uint256 before = IERC20(s.stockToken).balanceOf(address(this));
        IStockWrapper(s.wrapper).unwrap(stockIn, address(this));
        uint256 stock = IERC20(s.stockToken).balanceOf(address(this)) - before;
        uint256 fair = quote(id, stock);
        uint256 floor = Math.mulDiv(fair, BPS - maxSlippageBps, BPS, Math.Rounding.Ceil);
        if (minUsdgOut < floor) revert SlippageTooLoose(minUsdgOut, floor);
        usdgOut = _swap(IERC20(s.stockToken), IERC20(USDG), stock, swap);
        if (usdgOut < minUsdgOut) revert InsufficientOutput(usdgOut, minUsdgOut);
        emit SpotSold(id, stock, usdgOut, fair);
    }

    /// @dev Pays `amountIn` of `tokenIn` to an allowlisted target (approve or transfer), calls it, resets the approval;
    /// returns the `tokenOut` received (balance delta).
    function _swap(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, Swap calldata swap) internal returns (uint256) {
        SwapMode mode = swapModes[swap.target];
        if (mode == SwapMode.None) revert SwapTargetNotAllowed(swap.target);
        uint256 outBefore = tokenOut.balanceOf(address(this));
        if (mode == SwapMode.Approve) tokenIn.forceApprove(swap.target, amountIn);
        else tokenIn.safeTransfer(swap.target, amountIn);
        (bool ok, bytes memory ret) = swap.target.call(swap.data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        if (mode == SwapMode.Approve) tokenIn.forceApprove(swap.target, 0);
        return tokenOut.balanceOf(address(this)) - outBefore;
    }

    // ================================================================== Lending (rSTOCK)

    /// @inheritdoc IStrategyManager
    function lend(uint256 id, uint256 wrapped)
        external
        onlyOperator
        whenNotPaused
        nonReentrant
        returns (uint256 shares)
    {
        Sleeve memory s = _active(id);
        IERC20(s.wrapper).forceApprove(s.rVault, wrapped);
        shares = IERC4626(s.rVault).deposit(wrapped, address(this));
        uint256 spot = spotUnits(id);
        // slither-disable-next-line incorrect-equality
        uint256 lentBps = spot == 0 ? 0 : lentUnits(id) * BPS / spot;
        if (lentBps > s.maxLendBps) revert LendRatioExceeded(id, lentBps, s.maxLendBps);
        emit Lent(id, wrapped, shares);
    }

    /// @inheritdoc IStrategyManager
    function unlend(uint256 id, uint256 shares) external onlyOperatorOrGuardian nonReentrant returns (uint256 wrapped) {
        Sleeve memory s = _sleeve(id);
        uint256 before = IERC20(s.wrapper).balanceOf(address(this));
        IERC4626(s.rVault).redeem(shares, address(this), address(this));
        wrapped = IERC20(s.wrapper).balanceOf(address(this)) - before;
        emit Unlent(id, shares, wrapped);
    }

    // slither-disable-end reentrancy-balance,unused-return

    // ================================================================== Perp

    /// @inheritdoc IStrategyManager
    function depositMargin(uint256 amount) external onlyOperatorOrGuardian nonReentrant {
        address a = adapter;
        IERC20(USDG).forceApprove(a, amount);
        IPerpAdapter(a).depositMargin(amount);
    }

    /// @inheritdoc IStrategyManager
    function requestMarginWithdraw(uint256 amount) external onlyOperatorOrGuardian nonReentrant {
        IPerpAdapter(adapter).requestWithdraw(amount);
    }

    /// @inheritdoc IStrategyManager
    function claimMargin() external nonReentrant returns (uint256) {
        return IPerpAdapter(adapter).claimWithdrawn();
    }

    /// @inheritdoc IStrategyManager
    function adjustShort(uint256 id, int256 sizeDelta, uint256 priceLimit) external nonReentrant {
        Sleeve memory s = _sleeve(id);
        if (sizeDelta < 0) {
            // More exposure: the operator only, sleeve active, not paused, short within the spot (+5%) where readable.
            if (msg.sender != operator) revert NotOperator();
            if (paused) revert Paused();
            if (!s.active) revert SleeveInactive(id);
        } else if (msg.sender != operator && msg.sender != guardian) {
            revert NotOperatorOrGuardian();
        }
        ++tradeNonce; // DN-R14: mint/burn wait for a report that has seen this trade (bumped before the call, CEI)
        IPerpAdapter(adapter).adjustShort(s.perpMarket, sizeDelta, priceLimit);
        if (sizeDelta < 0) {
            (bool readable, uint256 size) = IPerpAdapter(adapter).shortSize(s.perpMarket);
            uint256 maxSize = spotUnits(id) * (BPS + SHORT_OVERHANG_BPS) / BPS;
            if (readable && size > maxSize) revert ShortExceedsSpot(id, size, maxSize);
        }
        emit ShortAdjusted(id, sizeDelta);
    }

    // ================================================================== Guardian

    /// @notice Pause or resume the operator's exposure-increasing actions.
    function setPaused(bool paused_) external onlyGuardian {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice DN-R7: kill a sleeve (guardian or the operator's kill switch). No new exposure; unwinding stays open.
    function killSleeve(uint256 id) external onlyOperatorOrGuardian {
        _sleeve(id);
        _sleeves[id].active = false;
        emit SleeveKilled(id, msg.sender);
    }

    // ================================================================== Owner (timelock)

    /// @notice List a sleeve. Checks the wiring: wrapper of the token, `rSTOCK` vault of the wrapper, the oracle's
    /// wrapper. Launch cap 0 (DN-R6).
    function addSleeve(Sleeve calldata s) external onlyOwner returns (uint256 id) {
        if (
            s.stockToken == address(0) || IStockWrapper(s.wrapper).underlying() != s.stockToken
                || IERC4626(s.rVault).asset() != s.wrapper || ILendoraOracle(s.oracle).WRAPPER() != s.wrapper
        ) revert BadParam();
        if (s.maxLendBps > BPS) revert BadParam();
        if (_isSleeveContract[s.stockToken]) revert SleeveExists(s.stockToken);
        if (
            swapModes[s.stockToken] != SwapMode.None || swapModes[s.wrapper] != SwapMode.None
                || swapModes[s.rVault] != SwapMode.None
        ) revert BadParam();
        _isSleeveContract[s.stockToken] = true;
        _isSleeveContract[s.wrapper] = true;
        _isSleeveContract[s.rVault] = true;
        id = _sleeves.length;
        _sleeves.push(s);
        _sleeves[id].active = true;
        emit SleeveAdded(id, s.stockToken, s.rVault, s.perpMarket);
        emit SleeveCapSet(id, s.capUsdg);
        emit MaxLendSet(id, s.maxLendBps);
    }

    /// @notice DN-R6: a sleeve's spot cap (USDG raw).
    function setSleeveCap(uint256 id, uint256 capUsdg) external onlyOwner {
        _sleeve(id);
        _sleeves[id].capUsdg = SafeCast.toUint128(capUsdg);
        emit SleeveCapSet(id, capUsdg);
    }

    /// @notice DN-R8: a sleeve's max lend ratio (bps).
    function setMaxLendBps(uint256 id, uint256 bps) external onlyOwner {
        _sleeve(id);
        if (bps > BPS) revert BadParam();
        _sleeves[id].maxLendBps = SafeCast.toUint16(bps);
        emit MaxLendSet(id, bps);
    }

    /// @notice Allowlist a DEX (UniversalRouter on 4663, Q4) or remove it (`None`). Never a token or a contract the
    /// strategy holds funds in.
    function setSwapTarget(address target, SwapMode mode) external onlyOwner {
        if (target == address(0) || target == USDG || target == VAULT || target == adapter || _isSleeveContract[target])
        {
            revert BadParam();
        }
        swapModes[target] = mode;
        emit SwapTargetSet(target, mode);
    }

    /// @notice The perp adapter. Replaceable only while the current one holds nothing (no margin, nothing in flight).
    function setAdapter(address adapter_) external onlyOwner {
        if (adapter_ == address(0)) revert ZeroAddress();
        address cur = adapter;
        if (cur != address(0)) {
            IPerpAdapter a = IPerpAdapter(cur);
            if (a.totalDeposited() != a.totalRequested() || a.pending() != 0) revert AdapterLocked();
        }
        if (IPerpAdapter(adapter_).strategy() != address(this) || IPerpAdapter(adapter_).asset() != USDG) {
            revert BadParam();
        }
        if (swapModes[adapter_] != SwapMode.None) revert BadParam();
        adapter = adapter_;
        emit AdapterSet(adapter_);
    }

    /// @notice The rebalancer key.
    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    /// @notice The guardian.
    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Swap floor below the oracle value (≤ 1%).
    function setMaxSlippageBps(uint256 bps) external onlyOwner {
        if (bps > MAX_SLIPPAGE_CEILING_BPS) revert BadParam();
        maxSlippageBps = bps;
        emit MaxSlippageSet(bps);
    }

    // ================================================================== Views

    /// @inheritdoc IStrategyManager
    function sleeveCount() external view returns (uint256) {
        return _sleeves.length;
    }

    /// @inheritdoc IStrategyManager
    function sleeve(uint256 id) external view returns (Sleeve memory) {
        return _sleeve(id);
    }

    /// @inheritdoc IStrategyManager
    function spotUnits(uint256 id) public view returns (uint256) {
        Sleeve memory s = _sleeve(id);
        return
            IERC20(s.stockToken).balanceOf(address(this)) + IERC20(s.wrapper).balanceOf(address(this)) + lentUnits(id);
    }

    /// @inheritdoc IStrategyManager
    function lentUnits(uint256 id) public view returns (uint256) {
        Sleeve memory s = _sleeve(id);
        uint256 shares = IERC20(s.rVault).balanceOf(address(this));
        // slither-disable-next-line incorrect-equality
        return shares == 0 ? 0 : IERC4626(s.rVault).convertToAssets(shares);
    }

    /// @inheritdoc IStrategyManager
    function quote(uint256 id, uint256 stockAmount) public view returns (uint256) {
        // slither-disable-next-line incorrect-equality
        if (stockAmount == 0) return 0;
        Sleeve memory s = _sleeve(id);
        (uint256 stockAns, uint256 usdgAns, uint256 num, uint256 den) = _feeds(s);
        return Math.mulDiv(stockAmount * stockAns, num, usdgAns * den);
    }

    // ================================================================== Internals

    function _sleeve(uint256 id) internal view returns (Sleeve memory) {
        if (id >= _sleeves.length) revert UnknownSleeve(id);
        return _sleeves[id];
    }

    function _active(uint256 id) internal view returns (Sleeve memory s) {
        s = _sleeve(id);
        if (!s.active) revert SleeveInactive(id);
    }

    /// @dev Swaps price against the feed, so the stock oracle's guard must be clear; buying also needs the feed session
    /// open (08 weekend rule: no spot buys while closed; selling stays possible for an emergency top-up).
    function _requireTradable(uint256 id, Sleeve memory s, bool buying) internal view {
        uint256 reasons = ILendoraOracle(s.oracle).guardReasons();
        if (reasons != 0) revert GuardTripped(id, reasons);
        if (buying && !IMarketHours(ILendoraOracle(s.oracle).MARKET_HOURS()).isOpen(block.timestamp)) {
            revert MarketClosed();
        }
    }

    /// @dev Stock raw → USDG raw = amount × P_stock / P_usdg × 10^(usdgDec + usdgFeedDec) / 10^(stockDec +
    /// stockFeedDec) (D1: the feed includes the multiplier; no buffer). Returns the answers and the scale.
    function _feeds(Sleeve memory s)
        internal
        view
        returns (uint256 stockAns, uint256 usdgAns, uint256 num, uint256 den)
    {
        ILendoraOracle o = ILendoraOracle(s.oracle);
        // Only the answers are needed; the guard (checked before trades and by `NavOracle.fresh`) covers their age.
        // slither-disable-next-line unused-return
        (stockAns,) = o.stockAnswer();
        // slither-disable-next-line unused-return
        (usdgAns,) = o.usdgAnswer();
        uint8 stockFeedDec = IFeedDecimalsDN(IOracleFeedsDN(s.oracle).STOCK_FEED()).decimals();
        uint8 usdgFeedDec = IFeedDecimalsDN(IOracleFeedsDN(s.oracle).USDG_FEED_ADDRESS()).decimals();
        uint8 stockDec = IERC20Metadata(s.stockToken).decimals();
        num = 10 ** (uint256(USDG_DECIMALS) + usdgFeedDec);
        den = 10 ** (uint256(stockDec) + stockFeedDec);
    }

    /// @dev USDG raw → the stock raw amount worth it at the feed price.
    function _usdgToStock(Sleeve memory s, uint256 usdg) internal view returns (uint256) {
        (uint256 stockAns, uint256 usdgAns, uint256 num, uint256 den) = _feeds(s);
        return Math.mulDiv(usdg * usdgAns, den, stockAns * num);
    }
}
