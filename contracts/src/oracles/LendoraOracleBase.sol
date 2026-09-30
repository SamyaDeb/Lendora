// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ILendoraOracle} from "../interfaces/ILendoraOracle.sol";
import {IMarketHours} from "../interfaces/IMarketHours.sol";
import {IStockWrapper} from "../interfaces/IStockWrapper.sol";
import {AggregatorV3Interface} from "../interfaces/external/AggregatorV3Interface.sol";
import {IRobinhoodStock, IAccessControlsRegistry} from "../interfaces/external/IRobinhoodStock.sol";
import {OracleMath} from "../libraries/OracleMath.sol";

/// @title LendoraOracleBase
/// @notice Shared feed handling, closure/event buffer and guard for Lendora's Morpho oracles (docs/prd/04-oracle.md).
/// - Feeds (OR-R2, OR-R4, OR-R7): the latest Chainlink round is used only if it is positive, inside the absolute range
///   and inside [bandLow, bandHigh] of the stored last good answer; otherwise the last good answer is used and the
///   guard trips. Nothing on the price path reverts on feed conditions.
/// - Buffer (OR-R20, OR-R14): max of the closure behind `t`, the closure ahead of `t`, up to two event windows and the
///   guardian floor, capped at `bMax ≤ 20%` (OR-R8).
/// - Guard (OR-R30…R32, OR-R3, OR-R6, D4): live reasons are evaluated in the views, so `guardTripped()` is right even
/// if nobody has poked; `poke()` records references and latches and emits `GuardChanged` for every change.
/// @dev The multiplier never enters any price (D1). Owner = timelock (OR-R5); the guardian can only raise the buffer
/// floor or trip; the keeper can trip/clear the reasons it detects offchain.
abstract contract LendoraOracleBase is ILendoraOracle, Ownable {
    // ------------------------------------------------------------------ Guard reasons (bitmask)

    /// @notice Guard reason bit: guardian manual trip.
    uint256 public constant MANUAL = 1 << 0;
    /// @notice Guard reason bit: DEX deviation (keeper).
    uint256 public constant DEVIATION = 1 << 1;
    /// @notice Guard reason bit: L2 block gap (keeper, OR-R6).
    uint256 public constant L2_GAP = 1 << 2;
    /// @notice Guard reason bit: stale feed while open.
    uint256 public constant STALE = 1 << 3;
    /// @notice Guard reason bit: stock round rejected by the band (OR-R7).
    uint256 public constant SANITY = 1 << 4;
    /// @notice Guard reason bit: USDG round rejected or stale.
    uint256 public constant USDG_FEED = 1 << 5;
    /// @notice Guard reason bit: the token's oraclePaused() (D4).
    uint256 public constant ORACLE_PAUSED = 1 << 6;
    /// @notice Guard reason bit: token or global pause (D4).
    uint256 public constant TOKEN_PAUSED = 1 << 7;
    /// @notice Guard reason bit: wrapper blocklisted (D4).
    uint256 public constant WRAPPER_BLOCKED = 1 << 8;
    /// @notice Guard reason bit: unaccepted multiplier change (OR-R3).
    uint256 public constant MULTIPLIER = 1 << 9;
    /// @notice Guard reason bit: sequencer down or in grace (OR-R6).
    uint256 public constant SEQUENCER = 1 << 10;
    /// @notice Guard reason bit: past the stored calendar (OR-R12).
    uint256 public constant CALENDAR = 1 << 11;

    /// @notice Reasons the keeper may set or clear (detected offchain: DEX deviation, L2 block gaps).
    uint256 public constant KEEPER_REASONS = DEVIATION | L2_GAP;
    /// @notice Reasons the guardian may set or clear.
    uint256 public constant GUARDIAN_REASONS = MANUAL | DEVIATION | L2_GAP;

    // ------------------------------------------------------------------ Hard limits

    uint256 internal constant WAD = 1e18;
    /// @notice Hard cap on any buffer: a 0 → 20% step lowers `price()` by 16.7% < 17.29% (OR-R8).
    uint256 public constant MAX_BUFFER = 0.2e18;
    /// @notice OR-R7 absolute range of the stock price, USD in WAD.
    uint256 public constant MIN_STOCK_PRICE = 0.01e18;
    /// @notice Absolute upper bound of a sane stock price (WAD USD, OR-R7).
    uint256 public constant MAX_STOCK_PRICE = 1e6 * 1e18;
    /// @notice OR-R4 absolute range of USDG/USD, WAD.
    uint256 public constant MIN_USDG_PRICE = 0.5e18;
    /// @notice Absolute upper bound of a sane USDG price (WAD).
    uint256 public constant MAX_USDG_PRICE = 2e18;
    /// @notice OR-R3 multiplier bounds per change.
    uint256 public constant MIN_MULTIPLIER_RATIO = 0.1e18;
    /// @notice Largest accepted multiplier ratio (10x, OR-R3).
    uint256 public constant MAX_MULTIPLIER_RATIO = 10e18;
    /// @notice OR-R21: σ changes at most weekly.
    uint256 public constant SIGMA_UPDATE_INTERVAL = 7 days;

    // ------------------------------------------------------------------ Immutables

    /// @notice Chainlink Stock Token feed.
    AggregatorV3Interface public immutable STOCK_FEED;
    /// @notice Chainlink USDG/USD feed.
    AggregatorV3Interface public immutable USDG_FEED_ADDRESS;
    /// @notice The Stock Token priced.
    address public immutable STOCK_TOKEN;
    /// @notice The StockWrapper (market loan token).
    address public immutable WRAPPER;
    /// @notice The feed calendar.
    address public immutable MARKET_HOURS;
    uint256 internal immutable _stockToWad;
    uint256 internal immutable _usdgToWad;

    // ------------------------------------------------------------------ Storage

    struct Reference {
        uint128 answer; // raw feed units
        uint64 updatedAt;
    }

    Params internal _params;
    /// @notice Guardian (may trip/clear MANUAL, DEVIATION, L2_GAP and raise the floor).
    address public guardian;
    /// @notice Guard keeper (DEVIATION, L2_GAP).
    address public keeper;
    /// @notice Optional sequencer uptime feed (address(0) on 4663, OR-R6).
    address public sequencerFeed;
    /// @notice Issuer registry for WRAPPER_BLOCKED.
    address public blocklist;
    /// @notice Guardian-raised buffer floor (WAD).
    uint256 public bufferFloor;
    /// @notice When σ last changed (OR-R21).
    uint256 public lastSigmaUpdate;

    Reference internal _stockRef;
    Reference internal _usdgRef;
    /// @notice Multiplier last observed by poke() (OR-R3).
    uint256 public lastMultiplier;
    /// @notice Latched reasons: set by trip() or poke() (MULTIPLIER), cleared by clear() / the owner.
    uint256 public latchedReasons;
    /// @notice Reasons as of the last `GuardChanged` emission.
    uint256 public emittedReasons;
    /// @notice Last time `poke()` saw `oraclePaused()`; the pause reason persists until a good round after it (D4).
    uint256 public oraclePausedSeenAt;
    /// @notice `oraclePaused()` was seen since the last accepted multiplier change (OR-R3 pause window).
    bool public pauseWindowSeen;

    struct Deployment {
        address stockFeed;
        address usdgFeed;
        address stockToken;
        address wrapper;
        address marketHours;
        address owner;
        address guardian;
        address keeper;
        address sequencerFeed; // address(0) = disabled (OR-R6)
        address blocklist; // issuer registry for isBlocked(wrapper), address(0) = skip
    }

    constructor(Deployment memory d, Params memory p) Ownable(d.owner) {
        if (
            d.stockFeed == address(0) || d.usdgFeed == address(0) || d.stockToken == address(0)
                || d.wrapper == address(0) || d.marketHours == address(0)
        ) revert ZeroAddress();
        STOCK_FEED = AggregatorV3Interface(d.stockFeed);
        USDG_FEED_ADDRESS = AggregatorV3Interface(d.usdgFeed);
        STOCK_TOKEN = d.stockToken;
        WRAPPER = d.wrapper;
        MARKET_HOURS = d.marketHours;
        _stockToWad = 10 ** (18 - AggregatorV3Interface(d.stockFeed).decimals());
        _usdgToWad = 10 ** (18 - AggregatorV3Interface(d.usdgFeed).decimals());
        guardian = d.guardian;
        keeper = d.keeper;
        sequencerFeed = d.sequencerFeed;
        blocklist = d.blocklist;
        _setParams(p);

        _anchor(STOCK_FEED, true);
        _anchor(USDG_FEED_ADDRESS, false);
        lastMultiplier = IStockWrapper(d.wrapper).multiplier();
    }

    // ------------------------------------------------------------------ Views: feeds

    /// @inheritdoc ILendoraOracle
    function stockAnswer() public view returns (uint256 answer, uint256 updatedAt) {
        (answer, updatedAt,) = _readStock();
    }

    /// @inheritdoc ILendoraOracle
    function usdgAnswer() public view returns (uint256 answer, uint256 updatedAt) {
        (answer, updatedAt,) = _readUsdg();
    }

    /// @notice Buffer, heartbeat, band and multiplier parameters (OR-R5).
    function params() external view returns (Params memory) {
        return _params;
    }

    // ------------------------------------------------------------------ Views: buffer (OR-R20)

    /// @inheritdoc ILendoraOracle
    function buffer() external view returns (uint256) {
        (, uint256 u) = stockAnswer();
        return bufferAt(block.timestamp, u);
    }

    /// @inheritdoc ILendoraOracle
    function bufferAt(uint256 t, uint256 lastGoodUpdatedAt) public view returns (uint256 b) {
        Params memory p = _params;
        b = _max(bufferFloor, _closureBuffer(p, t, lastGoodUpdatedAt));
        // Event windows whose ramp has started by t (the latest one and the one before it).
        (IMarketHours.EventWindow memory e1, IMarketHours.EventWindow memory e0) =
            IMarketHours(MARKET_HOURS).eventWindows(STOCK_TOKEN, t + p.rampIn);
        b = _max(b, _eventBuffer(e1, p, t, lastGoodUpdatedAt));
        b = _max(b, _eventBuffer(e0, p, t, lastGoodUpdatedAt));
        if (b > p.bMaxWad) b = p.bMaxWad;
    }

    // `== 0` below are sentinels for unknown calendar bounds, not balance checks (triaged in slither.config.json).
    // slither-disable-start incorrect-equality
    /// @dev Max of the closure behind `t` (or the unknown one before the first / after the last session, held until
    /// the first good round at or after the reopen) and the ramp-in towards the closure ahead of `t`.
    function _closureBuffer(Params memory p, uint256 t, uint256 u) internal view returns (uint256) {
        (uint256 prevClose, uint256 prevReopen, uint256 nextClose, uint256 nextReopen) =
            IMarketHours(MARKET_HOURS).closureWindows(t);
        uint256 behind = _closureWindow(p, prevClose, prevReopen, t, u);
        if (nextClose == 0) return behind;
        return _max(behind, _closureWindow(p, nextClose, nextReopen, t, u));
    }

    /// @dev One closure `[close, reopen]`; an unknown bound (0) means `MAX_CLOSURE` long and, for `reopen`, never
    /// released.
    function _closureWindow(Params memory p, uint256 close, uint256 reopen, uint256 t, uint256 u)
        internal
        view
        returns (uint256)
    {
        uint256 len = (close == 0 || reopen == 0) ? IMarketHours(MARKET_HOURS).MAX_CLOSURE() : reopen - close;
        return OracleMath.windowBuffer(_full(p, len), close, reopen, p.rampIn, t, u);
    }

    // slither-disable-end incorrect-equality

    // ------------------------------------------------------------------ Views: guard (OR-R30)

    /// @inheritdoc ILendoraOracle
    function guardTripped() external view returns (bool) {
        return guardReasons() != 0;
    }

    /// @inheritdoc ILendoraOracle
    function guardReasons() public view returns (uint256) {
        return latchedReasons | liveReasons();
    }

    /// @notice Reasons derived from current onchain state (no latches).
    // slither-disable-start incorrect-equality,unused-return
    function liveReasons() public view returns (uint256 r) {
        Params memory p = _params;
        (, uint256 u, bool rejected) = _readStock();
        if (rejected) r |= SANITY;
        (, uint256 uu, bool rejectedU) = _readUsdg();
        if (rejectedU || block.timestamp > uu + p.usdgHeartbeat + p.staleGrace) r |= USDG_FEED;

        (, uint256 reopen, uint256 nextClose,) = IMarketHours(MARKET_HOURS).closureWindows(block.timestamp);
        if (nextClose == 0) {
            r |= CALENDAR; // OR-R12: past the last stored session
        } else if (reopen <= block.timestamp && block.timestamp > _max(u, reopen) + p.stockHeartbeat + p.staleGrace) {
            r |= STALE; // open, and no good round within heartbeat + grace of max(last round, session open)
        }

        bool oraclePaused = _oraclePaused();
        if (oraclePaused || (oraclePausedSeenAt != 0 && u <= oraclePausedSeenAt)) r |= ORACLE_PAUSED;
        if (_tokenPaused()) r |= TOKEN_PAUSED;
        if (_wrapperBlocked()) r |= WRAPPER_BLOCKED;
        (bool changed, bool accepted,) = _multiplierCheck(oraclePaused);
        if (changed && !accepted) r |= MULTIPLIER;
        if (_sequencerDown(p)) r |= SEQUENCER;
    }

    // slither-disable-end incorrect-equality,unused-return

    // ------------------------------------------------------------------ Permissionless (OR-R32)

    /// @inheritdoc ILendoraOracle
    function poke() external {
        _advance(STOCK_FEED, true);
        _advance(USDG_FEED_ADDRESS, false);
        bool oraclePaused = _oraclePaused();
        if (oraclePaused) {
            oraclePausedSeenAt = block.timestamp;
            pauseWindowSeen = true;
        }
        (bool changed, bool accepted, uint256 m) = _multiplierCheck(oraclePaused);
        if (changed) {
            emit MultiplierObserved(lastMultiplier, m, accepted);
            if (!accepted) latchedReasons |= MULTIPLIER;
            lastMultiplier = m;
            pauseWindowSeen = false;
        }
        _syncEvents();
    }

    // ------------------------------------------------------------------ Keeper and guardian (OR-R30, OR-R5)

    /// @notice Trip offchain-detected reasons. Keeper: DEVIATION, L2_GAP. Guardian: also MANUAL.
    function trip(uint256 reasons) external {
        _checkReasonAuth(reasons);
        latchedReasons |= reasons;
        _syncEvents();
    }

    /// @notice Clear offchain-detected reasons. Same permissions as `trip`.
    function clear(uint256 reasons) external {
        _checkReasonAuth(reasons);
        latchedReasons &= ~reasons;
        _syncEvents();
    }

    /// @notice Guardian: raise the buffer floor (never lower it; bounded by `bMax`, OR-R5, OR-R8).
    function raiseBufferFloor(uint256 floorWad) external {
        if (msg.sender != guardian) revert Unauthorized();
        if (floorWad <= bufferFloor || floorWad > _params.bMaxWad) revert FloorNotRaised();
        bufferFloor = floorWad;
        emit BufferFloorSet(floorWad);
    }

    // ------------------------------------------------------------------ Owner (timelock)

    /// @notice Owner (timelock): set parameters; σ at most once per SIGMA_UPDATE_INTERVAL (OR-R21), B_MAX ≤ 20%
    /// (OR-R8).
    function setParams(Params calldata p) external onlyOwner {
        if (p.sigmaWad != _params.sigmaWad && block.timestamp < lastSigmaUpdate + SIGMA_UPDATE_INTERVAL) {
            revert SigmaUpdateTooSoon();
        }
        _setParams(p);
        if (bufferFloor > p.bMaxWad) bufferFloor = p.bMaxWad;
    }

    /// @notice Set the floor to any value up to `bMax` (the only way to lower it).
    function setBufferFloor(uint256 floorWad) external onlyOwner {
        if (floorWad > _params.bMaxWad) revert BadParams();
        bufferFloor = floorWad;
        emit BufferFloorSet(floorWad);
    }

    /// @notice Owner: set the guardian (2-of-4 multisig).
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit RoleSet("guardian", guardian_);
    }

    /// @notice Owner: set the guard keeper.
    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit RoleSet("keeper", keeper_);
    }

    /// @notice OR-R6: set or remove (address(0)) the sequencer uptime feed.
    function setSequencerFeed(address feed) external onlyOwner {
        sequencerFeed = feed;
        emit SequencerFeedSet(feed);
    }

    /// @notice Owner: set the issuer registry read for WRAPPER_BLOCKED (D4).
    function setBlocklist(address registry) external onlyOwner {
        blocklist = registry;
        emit BlocklistSet(registry);
    }

    /// @notice OR-R3: confirm a multiplier change that tripped the guard.
    function clearMultiplierGuard() external onlyOwner {
        latchedReasons &= ~MULTIPLIER;
        _syncEvents();
    }

    /// @notice OR-R7: re-anchor both references to the latest rounds after a genuine move beyond the band. The
    /// absolute ranges still apply.
    function resetReferences() external onlyOwner {
        _anchor(STOCK_FEED, true);
        _anchor(USDG_FEED_ADDRESS, false);
        _syncEvents();
    }

    // ------------------------------------------------------------------ Internals: feeds

    /// @dev Latest round (no revert): (ok, answer, updatedAt). ok is false if the call fails, returns malformed data
    /// (e.g. no code at the address) or the answer is ≤ 0. Low-level so nothing can bubble up (OR-R2).
    function _latest(address feed) internal view returns (bool, uint256, uint256) {
        (bool success, bytes memory data) =
            feed.staticcall(abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector));
        if (!success || data.length < 160) return (false, 0, 0);
        (, int256 a,, uint256 u,) = abi.decode(data, (uint80, int256, uint256, uint256, uint80));
        if (a <= 0) return (false, 0, 0);
        return (true, uint256(a), u);
    }

    /// @dev `target.fn(args)` returning bool, fail-closed: a failing or malformed call reads as `true` (trips the
    /// guard).
    function _flag(address target, bytes memory callData) internal view returns (bool) {
        (bool success, bytes memory data) = target.staticcall(callData);
        if (!success || data.length < 32) return true;
        return abi.decode(data, (uint256)) != 0;
    }

    function _sane(uint256 a, uint256 ref, bool isStock) internal view returns (bool) {
        uint256 wadPrice = a * (isStock ? _stockToWad : _usdgToWad);
        (uint256 lo, uint256 hi) = isStock ? (MIN_STOCK_PRICE, MAX_STOCK_PRICE) : (MIN_USDG_PRICE, MAX_USDG_PRICE);
        if (wadPrice < lo || wadPrice > hi) return false;
        if (ref == 0) return true;
        return a * WAD >= ref * _params.bandLowWad && a * WAD <= ref * _params.bandHighWad;
    }

    /// @dev The answer in use: the latest round if it passes OR-R7 against the stored reference, else the reference.
    function _read(AggregatorV3Interface feed, Reference memory ref, bool isStock)
        internal
        view
        returns (uint256 answer, uint256 updatedAt, bool rejected)
    {
        (bool ok, uint256 a, uint256 u) = _latest(address(feed));
        if (ok && a <= type(uint128).max && _sane(a, ref.answer, isStock)) return (a, u, false);
        return (ref.answer, ref.updatedAt, true);
    }

    function _readStock() internal view returns (uint256, uint256, bool) {
        return _read(STOCK_FEED, _stockRef, true);
    }

    function _readUsdg() internal view returns (uint256, uint256, bool) {
        return _read(USDG_FEED_ADDRESS, _usdgRef, false);
    }

    function _advance(AggregatorV3Interface feed, bool isStock) internal {
        Reference memory ref = isStock ? _stockRef : _usdgRef;
        (uint256 a, uint256 u, bool rejected) = _read(feed, ref, isStock);
        if (rejected || (a == ref.answer && u == ref.updatedAt)) return;
        _store(feed, isStock, a, u);
    }

    function _anchor(AggregatorV3Interface feed, bool isStock) internal {
        (bool ok, uint256 a, uint256 u) = _latest(address(feed));
        if (!ok || a > type(uint128).max || !_sane(a, 0, isStock)) revert InsaneAnswer(address(feed));
        _store(feed, isStock, a, u);
    }

    function _store(AggregatorV3Interface feed, bool isStock, uint256 a, uint256 u) internal {
        Reference memory r = Reference(uint128(a), uint64(u));
        if (isStock) _stockRef = r;
        else _usdgRef = r;
        emit ReferenceUpdated(address(feed), a, u);
    }

    // ------------------------------------------------------------------ Internals: issuer flags and sequencer

    function _oraclePaused() internal view returns (bool) {
        return _flag(STOCK_TOKEN, abi.encodeWithSelector(IRobinhoodStock.oraclePaused.selector));
    }

    function _tokenPaused() internal view returns (bool) {
        return _flag(STOCK_TOKEN, abi.encodeWithSelector(IRobinhoodStock.paused.selector));
    }

    function _wrapperBlocked() internal view returns (bool) {
        if (blocklist == address(0)) return false;
        return _flag(blocklist, abi.encodeWithSelector(IAccessControlsRegistry.isBlocked.selector, WRAPPER));
    }

    /// @dev OR-R6: Chainlink uptime feed semantics (answer 0 = up, `startedAt` = last status change). Fail-closed.
    function _sequencerDown(Params memory p) internal view returns (bool) {
        if (sequencerFeed == address(0)) return false;
        (bool success, bytes memory data) =
            sequencerFeed.staticcall(abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector));
        if (!success || data.length < 160) return true;
        (, int256 status, uint256 startedAt,,) = abi.decode(data, (uint80, int256, uint256, uint256, uint80));
        return status != 0 || block.timestamp < startedAt + p.sequencerGrace;
    }

    /// @dev OR-R3: (changed, accepted, current). A change is accepted if within [0.1×, 10×] and either small
    /// (≤ maxQuietMultiplierStep) or inside an `oraclePaused()` window (now, or seen by poke since the last change).
    function _multiplierCheck(bool oraclePausedNow) internal view returns (bool, bool, uint256) {
        (bool success, bytes memory data) =
            WRAPPER.staticcall(abi.encodeWithSelector(IStockWrapper.multiplier.selector));
        if (!success || data.length < 32) return (true, false, lastMultiplier);
        uint256 m = abi.decode(data, (uint256));
        uint256 last = lastMultiplier;
        if (m == last) return (false, true, m);
        if (m == 0) return (true, false, m);
        uint256 ratio = m * WAD / last;
        if (ratio < MIN_MULTIPLIER_RATIO || ratio > MAX_MULTIPLIER_RATIO) return (true, false, m);
        uint256 step = ratio > WAD ? ratio - WAD : WAD - ratio;
        return (true, step <= _params.maxQuietMultiplierStepWad || oraclePausedNow || pauseWindowSeen, m);
    }

    // ------------------------------------------------------------------ Internals: misc

    function _setParams(Params memory p) internal {
        if (
            p.bMaxWad > MAX_BUFFER || p.bMinWad > p.bMaxWad || p.rampIn == 0 || p.stockHeartbeat == 0
                || p.usdgHeartbeat == 0 || p.bandLowWad == 0 || p.bandLowWad >= WAD || p.bandHighWad <= WAD
                || p.maxQuietMultiplierStepWad > 0.5e18 || p.zWad == 0 || p.sigmaWad == 0
        ) revert BadParams();
        if (p.sigmaWad != _params.sigmaWad) lastSigmaUpdate = block.timestamp;
        _params = p;
        emit ParamsSet(p);
    }

    function _full(Params memory p, uint256 closureSeconds) internal pure returns (uint256) {
        return OracleMath.fullBuffer(p.zWad, p.sigmaWad, p.bMinWad, p.bMaxWad, closureSeconds);
    }

    // slither-disable-next-line incorrect-equality
    function _eventBuffer(IMarketHours.EventWindow memory e, Params memory p, uint256 t, uint256 u)
        internal
        pure
        returns (uint256)
    {
        if (e.startTs == 0) return 0;
        uint256 full = e.bufferWad > p.bMaxWad ? p.bMaxWad : e.bufferWad;
        return OracleMath.windowBuffer(full, e.startTs, e.endTs, p.rampIn, t, u);
    }

    function _checkReasonAuth(uint256 reasons) internal view {
        if (reasons == 0) revert BadReason();
        if (msg.sender == guardian) {
            if (reasons & ~GUARDIAN_REASONS != 0) revert BadReason();
        } else if (msg.sender == keeper) {
            if (reasons & ~KEEPER_REASONS != 0) revert BadReason();
        } else {
            revert Unauthorized();
        }
    }

    /// @dev Emit `GuardChanged(reason, tripped)` for every bit that changed since the last emission.
    function _syncEvents() internal {
        uint256 current = guardReasons();
        uint256 changed = current ^ emittedReasons;
        if (changed == 0) return;
        emittedReasons = current;
        for (uint256 bit = 1; bit <= CALENDAR; bit <<= 1) {
            if (changed & bit != 0) emit GuardChanged(bit, current & bit != 0);
        }
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
