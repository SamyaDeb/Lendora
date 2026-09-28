// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPerpAdapter} from "../../src/interfaces/IPerpAdapter.sol";
import {MockGate} from "./MockGate.sol";

interface IAggregatorAnswer {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

/// @title MockPerpVenue
/// @notice Venue and adapter in one, for tests, the devnet and testnet 46630 (Phase 4, Q11: the testnet vault uses
/// the mock venue only). Isolated per market: shorts only, marked at a Chainlink-style feed (the testnet's mirrored
/// mock feeds, so the mark follows real prices), hourly-style funding pushed by an operator, maintenance margin and
/// liquidation, a withdrawal delay and a **withdrawal-halt switch** for the 72h stress (08 gate). Equity is readable
/// onchain; the NAV still uses signed reports (as with a real venue). USDG only; margin returns only to the strategy.
/// @dev Units: sizes in base units 1e18, prices 1e18 USD, margin in USDG raw (6 dp). Unrealized PnL in USD 1e18 is
/// converted to USDG raw at 1 USD = 1 USDG (the venue's quote asset).
contract MockPerpVenue is IPerpAdapter, MockGate {
    using SafeERC20 for IERC20;

    struct Market {
        address feed;
        uint256 mmfWad; // maintenance margin fraction
        uint256 imfWad; // initial margin fraction
        uint256 size; // short size, 1e18
        uint256 entry; // average entry price, 1e18
    }

    struct Withdrawal {
        uint256 amount;
        uint256 readyAt;
    }

    /// @inheritdoc IPerpAdapter
    address public immutable strategy;
    /// @inheritdoc IPerpAdapter
    address public immutable asset;
    uint256 internal constant WAD = 1e18;
    /// @notice USDG raw per 1e18 USD.
    uint256 internal constant USD_TO_RAW = 1e12;

    /// @notice Free collateral plus realized PnL and funding, USDG raw (can go negative → int).
    int256 public collateral;
    mapping(bytes32 => Market) public markets;
    bytes32[] public marketIds;
    /// @inheritdoc IPerpAdapter
    uint256 public totalDeposited;
    /// @inheritdoc IPerpAdapter
    uint256 public totalRequested;
    Withdrawal[] internal _withdrawals;
    uint256 internal _nextWithdrawal;
    /// @notice Seconds before a requested withdrawal matures.
    uint256 public withdrawDelay;
    /// @notice Stress switch: while true nothing matures and nothing is claimed.
    bool public withdrawalsHalted;
    /// @notice Liquidation penalty, fraction of the notional (WAD).
    uint256 public liquidationPenaltyWad = 0.01e18;

    event MarketListed(bytes32 indexed market, address feed, uint256 mmfWad, uint256 imfWad);
    event FundingApplied(bytes32 indexed market, int256 rateWad, int256 payment);
    event Liquidated(bytes32 indexed market, uint256 size, int256 equityAfter);
    event HaltSet(bool halted);

    error UnknownMarket(bytes32 market);
    error PriceLimit(uint256 mark, uint256 limit);
    error InsufficientMargin(int256 equity, uint256 required);
    error NotLiquidatable(int256 equity, uint256 maintenance);
    error ReduceTooMuch(uint256 size, uint256 reduce);

    constructor(address usdg, address strategy_) {
        asset = usdg;
        strategy = strategy_;
    }

    modifier onlyStrategy() {
        if (msg.sender != strategy) revert NotStrategy();
        _;
    }

    // ------------------------------------------------------------------ Operator (gated on testnet)

    function listMarket(bytes32 market, address feed, uint256 mmfWad, uint256 imfWad) external gate {
        if (markets[market].feed == address(0)) marketIds.push(market);
        markets[market].feed = feed;
        markets[market].mmfWad = mmfWad;
        markets[market].imfWad = imfWad;
        emit MarketListed(market, feed, mmfWad, imfWad);
    }

    /// @notice Apply one funding period: shorts receive `rateWad × notional` when positive (longs pay).
    function applyFunding(bytes32 market, int256 rateWad) public gate returns (int256 payment) {
        Market storage m = _market(market);
        uint256 notional = m.size * mark(market) / WAD;
        payment = int256(notional / USD_TO_RAW) * rateWad / int256(WAD);
        collateral += payment;
        emit FundingApplied(market, rateWad, payment);
    }

    function setWithdrawalsHalted(bool halted) external gate {
        withdrawalsHalted = halted;
        emit HaltSet(halted);
    }

    function setWithdrawDelay(uint256 delay) external gate {
        withdrawDelay = delay;
    }

    // ------------------------------------------------------------------ IPerpAdapter (strategy only)

    /// @inheritdoc IPerpAdapter
    function depositMargin(uint256 amount) external onlyStrategy {
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        collateral += int256(amount);
        totalDeposited += amount;
        emit MarginDeposited(amount, totalDeposited);
    }

    /// @inheritdoc IPerpAdapter
    function requestWithdraw(uint256 amount) external onlyStrategy {
        if (amount == 0) revert ZeroAmount();
        int256 eq = equityRaw() - int256(amount);
        uint256 im = initialMargin();
        if (eq < int256(im)) revert InsufficientMargin(eq, im);
        collateral -= int256(amount);
        totalRequested += amount;
        _withdrawals.push(Withdrawal(amount, block.timestamp + withdrawDelay));
        emit WithdrawalRequested(amount, totalRequested);
    }

    /// @inheritdoc IPerpAdapter
    function claimWithdrawn() external returns (uint256 amount) {
        if (withdrawalsHalted) return 0;
        uint256 i = _nextWithdrawal;
        uint256 n = _withdrawals.length;
        while (i < n && _withdrawals[i].readyAt <= block.timestamp) {
            amount += _withdrawals[i].amount;
            delete _withdrawals[i];
            i++;
        }
        _nextWithdrawal = i;
        if (amount > 0) {
            IERC20(asset).safeTransfer(strategy, amount);
            emit MarginClaimed(amount);
        }
    }

    /// @inheritdoc IPerpAdapter
    function adjustShort(bytes32 market, int256 sizeDelta, uint256 priceLimit) external onlyStrategy {
        Market storage m = _market(market);
        uint256 p = mark(market);
        if (sizeDelta < 0) {
            if (priceLimit != 0 && p < priceLimit) revert PriceLimit(p, priceLimit); // selling: at least the limit
            uint256 add = uint256(-sizeDelta);
            m.entry = (m.entry * m.size + p * add) / (m.size + add);
            m.size += add;
            uint256 im = initialMargin();
            int256 eq = equityRaw();
            if (eq < int256(im)) revert InsufficientMargin(eq, im);
        } else if (sizeDelta > 0) {
            if (priceLimit != 0 && p > priceLimit) revert PriceLimit(p, priceLimit); // buying back: at most the limit
            uint256 cut = uint256(sizeDelta);
            if (cut > m.size) revert ReduceTooMuch(m.size, cut);
            collateral += _pnl(m.entry, p, cut);
            m.size -= cut;
            if (m.size == 0) m.entry = 0;
        }
        emit ShortAdjusted(market, sizeDelta, m.size);
    }

    // ------------------------------------------------------------------ Liquidation (anyone)

    /// @notice Close every short at the mark when equity < maintenance; the penalty is taken from what is left.
    function liquidate() external {
        int256 eq = equityRaw();
        uint256 mm = maintenanceMargin();
        if (eq >= int256(mm)) revert NotLiquidatable(eq, mm);
        uint256 penalty;
        for (uint256 i; i < marketIds.length; i++) {
            Market storage m = markets[marketIds[i]];
            if (m.size == 0) continue;
            uint256 p = mark(marketIds[i]);
            collateral += _pnl(m.entry, p, m.size);
            penalty += m.size * p / WAD * liquidationPenaltyWad / WAD / USD_TO_RAW;
            emit Liquidated(marketIds[i], m.size, collateral);
            m.size = 0;
            m.entry = 0;
        }
        collateral -= int256(penalty);
        if (collateral < 0) collateral = 0; // the venue's insurance absorbs bad debt; the vault loses its margin
    }

    // ------------------------------------------------------------------ Views

    /// @notice Mark price of `market`, 1e18 USD (the feed's answer).
    function mark(bytes32 market) public view returns (uint256) {
        Market storage m = _market(market);
        (, int256 a,,,) = IAggregatorAnswer(m.feed).latestRoundData();
        return uint256(a) * 10 ** (18 - IAggregatorAnswer(m.feed).decimals());
    }

    /// @notice Equity, USDG raw (signed).
    function equityRaw() public view returns (int256 eq) {
        eq = collateral;
        for (uint256 i; i < marketIds.length; i++) {
            Market storage m = markets[marketIds[i]];
            if (m.size > 0) eq += _pnl(m.entry, mark(marketIds[i]), m.size);
        }
    }

    function maintenanceMargin() public view returns (uint256 r) {
        for (uint256 i; i < marketIds.length; i++) {
            Market storage m = markets[marketIds[i]];
            r += m.size * mark(marketIds[i]) / WAD * m.mmfWad / WAD / USD_TO_RAW;
        }
    }

    function initialMargin() public view returns (uint256 r) {
        for (uint256 i; i < marketIds.length; i++) {
            Market storage m = markets[marketIds[i]];
            r += m.size * mark(marketIds[i]) / WAD * m.imfWad / WAD / USD_TO_RAW;
        }
    }

    /// @notice Equity / maintenance margin, WAD (max if no position).
    function marginRatio() external view returns (uint256) {
        uint256 mm = maintenanceMargin();
        int256 eq = equityRaw();
        if (mm == 0) return type(uint256).max;
        return eq <= 0 ? 0 : uint256(eq) * WAD / mm;
    }

    /// @inheritdoc IPerpAdapter
    function pending() external view returns (uint256 p) {
        for (uint256 i = _nextWithdrawal; i < _withdrawals.length; i++) {
            p += _withdrawals[i].amount;
        }
    }

    /// @inheritdoc IPerpAdapter
    function onchainEquity() external view returns (bool, uint256) {
        int256 eq = equityRaw();
        return (true, eq > 0 ? uint256(eq) : 0);
    }

    /// @inheritdoc IPerpAdapter
    function shortSize(bytes32 market) external view returns (bool, uint256) {
        return (true, markets[market].size);
    }

    function _market(bytes32 market) internal view returns (Market storage m) {
        m = markets[market];
        if (m.feed == address(0)) revert UnknownMarket(market);
    }

    /// @dev Short PnL of `size` from `entry` to `p`, USDG raw.
    function _pnl(uint256 entry, uint256 p, uint256 size) internal pure returns (int256) {
        return (int256(entry) - int256(p)) * int256(size) / int256(WAD) / int256(USD_TO_RAW);
    }
}
