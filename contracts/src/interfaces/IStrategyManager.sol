// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title Delta-neutral strategy manager (docs/prd/08-delta-neutral-vault.md DN-R2, DN-R3, DN-R6, DN-R8, DN-R10).
/// @notice Holds the vault's spot (Stock Token, wSTOCK, `rSTOCK`) and USDG in transit, and drives the perp adapter.
/// The operator trades only inside limits: allowlisted swap targets, listed sleeves, per-sleeve spot caps, a maximum
/// lend ratio, and an onchain price floor on every swap. Funds can only move to the vault, the adapter, a sleeve's
/// wrapper or `rSTOCK` vault, or an allowlisted swap target (DN-R10). The guardian can pause the operator and kill a
/// sleeve; unwinding (sell, unlend, close, reclaim margin, return to the vault) stays available to both, paused or not.
interface IStrategyManager {
    enum SwapMode {
        None,
        Approve,
        Transfer
    }

    /// @notice One swap through an allowlisted target; output is measured by balance delta (return data untrusted).
    struct Swap {
        address target;
        bytes data;
    }

    /// @notice A single-stock sleeve.
    struct Sleeve {
        address stockToken;
        address wrapper; // wSTOCK
        address rVault; // Stockline Vault V2 `rSTOCK`
        address oracle; // StocklineOracle of the stock (feed price, guard, market hours)
        bytes32 perpMarket; // venue market id
        uint128 capUsdg; // DN-R6: max spot value, USDG raw (0 at launch)
        uint16 maxLendBps; // DN-R8: max share of the sleeve's spot lent through rSTOCK
        bool active; // false once killed (DN-R7): no new exposure
    }

    event SleeveAdded(uint256 indexed id, address stockToken, address rVault, bytes32 perpMarket);
    event SleeveCapSet(uint256 indexed id, uint256 capUsdg);
    event MaxLendSet(uint256 indexed id, uint256 maxLendBps);
    event SleeveKilled(uint256 indexed id, address by);
    event SwapTargetSet(address indexed target, SwapMode mode);
    event OperatorSet(address operator);
    event GuardianSet(address guardian);
    event PausedSet(bool paused);
    event MaxSlippageSet(uint256 bps);
    event AdapterSet(address adapter);
    event FundsPulled(uint256 amount);
    event FundsReturned(uint256 amount);
    event SpotBought(uint256 indexed id, uint256 usdgIn, uint256 stockOut, uint256 fairStockOut);
    event SpotSold(uint256 indexed id, uint256 stockIn, uint256 usdgOut, uint256 fairUsdgOut);
    event Lent(uint256 indexed id, uint256 wrapped, uint256 shares);
    event Unlent(uint256 indexed id, uint256 shares, uint256 wrapped);
    event ShortAdjusted(uint256 indexed id, int256 sizeDelta);

    error ZeroAddress();
    error NotOperator();
    error NotGuardian();
    error NotOperatorOrGuardian();
    error Paused();
    error UnknownSleeve(uint256 id);
    error SleeveInactive(uint256 id);
    error SleeveExists(address stockToken);
    error SwapTargetNotAllowed(address target);
    error SlippageTooLoose(uint256 minOut, uint256 floor);
    error InsufficientOutput(uint256 out, uint256 minOut);
    error CapExceeded(uint256 id, uint256 value, uint256 cap);
    error LendRatioExceeded(uint256 id, uint256 lentBps, uint256 maxBps);
    error GuardTripped(uint256 id, uint256 reasons);
    error MarketClosed();
    error BadParam();
    error ShortExceedsSpot(uint256 id, uint256 size, uint256 maxSize);
    error AdapterLocked();

    /// @notice Hard ceiling on `maxSlippageBps` (1%).
    function MAX_SLIPPAGE_CEILING_BPS() external view returns (uint256);
    /// @notice The vault this strategy serves.
    function VAULT() external view returns (address);
    /// @notice USDG.
    function USDG() external view returns (address);
    /// @notice The perp adapter (owns the venue account).
    function adapter() external view returns (address);
    /// @notice Strategy operator (rebalancer key): trades inside the limits.
    function operator() external view returns (address);
    /// @notice Guardian multisig: pause, kill a sleeve, unwind.
    function guardian() external view returns (address);
    /// @notice Whether the operator's exposure-increasing actions are paused.
    function paused() external view returns (bool);
    /// @notice Largest allowed price shortfall of a swap vs the oracle value, bps.
    function maxSlippageBps() external view returns (uint256);
    /// @notice Incremented by every perp trade sent through `adjustShort`; a NAV report must have seen it (DN-R14).
    function tradeNonce() external view returns (uint64);
    /// @notice Number of sleeves.
    function sleeveCount() external view returns (uint256);
    /// @notice Sleeve `id`.
    function sleeve(uint256 id) external view returns (Sleeve memory);
    /// @notice Payment mode of an allowlisted swap target (`None` = not allowed).
    function swapModes(address target) external view returns (SwapMode);

    /// @notice Operator: take `amount` USDG from the vault (the vault keeps its cash buffer).
    function pullFromVault(uint256 amount) external;
    /// @notice Operator or guardian: send `amount` USDG back to the vault.
    function returnToVault(uint256 amount) external;
    /// @notice Operator: buy the sleeve's Stock Token with `usdgIn` and wrap it. `minStockOut` may be at most
    /// `maxSlippageBps` below the oracle-fair amount; the spot value must stay within the sleeve cap.
    function buySpot(uint256 id, uint256 usdgIn, uint256 minStockOut, Swap calldata swap) external returns (uint256);
    /// @notice Operator or guardian: unwrap `stockIn` wSTOCK and sell it for USDG, with the same floor.
    function sellSpot(uint256 id, uint256 stockIn, uint256 minUsdgOut, Swap calldata swap) external returns (uint256);
    /// @notice Operator: lend `wrapped` wSTOCK through the sleeve's `rSTOCK` vault, within `maxLendBps`.
    function lend(uint256 id, uint256 wrapped) external returns (uint256 shares);
    /// @notice Operator or guardian: redeem `shares` of `rSTOCK` for wSTOCK.
    function unlend(uint256 id, uint256 shares) external returns (uint256 wrapped);
    /// @notice Operator or guardian: post `amount` USDG as venue margin (a top-up is always allowed).
    function depositMargin(uint256 amount) external;
    /// @notice Operator or guardian: ask the venue to return `amount` of margin (to the adapter, then here).
    function requestMarginWithdraw(uint256 amount) external;
    /// @notice Anyone: move matured venue withdrawals from the adapter to this contract.
    function claimMargin() external returns (uint256);
    /// @notice Operator: change the sleeve's short by `sizeDelta` (negative = more short, needs an active sleeve);
    /// guardian: reduce only.
    function adjustShort(uint256 id, int256 sizeDelta, uint256 priceLimit) external;

    /// @notice Stock Token units the strategy holds for a sleeve: loose + wrapped + `rSTOCK` redeemable value.
    function spotUnits(uint256 id) external view returns (uint256);
    /// @notice Of which lent through `rSTOCK` (redeemable value in wSTOCK).
    function lentUnits(uint256 id) external view returns (uint256);
    /// @notice USDG value of `stockAmount` of the sleeve's stock at the feed price (no buffer).
    function quote(uint256 id, uint256 stockAmount) external view returns (uint256);
}
