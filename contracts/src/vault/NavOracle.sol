// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {INavOracle} from "../interfaces/INavOracle.sol";
import {IDeltaNeutralVault} from "../interfaces/IDeltaNeutralVault.sol";
import {IStrategyManager} from "../interfaces/IStrategyManager.sol";
import {IPerpAdapter} from "../interfaces/IPerpAdapter.sol";
import {IStocklineOracle} from "../interfaces/IStocklineOracle.sol";

/// @title NavOracle
/// @notice The delta-neutral vault's NAV (DN-R4, DN-R14) and its freshness (DN-R5). See `INavOracle`.
/// @dev Perp equity is not readable onchain on the target venue (A41), so it comes from EIP-712 reports by allowed
/// signers (the NAV reporter keeper and a second, independent key). A report is valid only if it is newer than the
/// last one, not in the future, within the current max age, has seen the strategy's latest onchain perp trade, and
/// claims no flow the adapter hasn't made. **Between reports** the short leg is marked to the Chainlink price move
/// since the report with the reported sizes (the feed value is recorded at acceptance), so the NAV stays hedged: spot
/// and short move together (DN-R14; without it a price move between reports would shift share prices by spot × move).
/// A report that moves the perp side by more than 1% of NAV against that marked estimate needs two distinct signers,
/// and so does any single-signed report once the single-signed moves since the last co-signed report add up to more
/// than 1% (one key can't walk the NAV with a chain of small reports).
/// Owner = the timelock: signers and max ages.
contract NavOracle is INavOracle, EIP712, Ownable {
    /// @inheritdoc INavOracle
    uint256 public constant SECOND_SIGNER_BPS = 100;
    /// @notice DN-R5: the max report age while the market is closed can't exceed 15 minutes.
    uint256 public constant MAX_AGE_CLOSED_CEILING = 15 minutes;
    /// @notice Ceiling for the max age while the market is open.
    uint256 public constant MAX_AGE_OPEN_CEILING = 1 hours;
    /// @notice EIP-712 type of a report.
    bytes32 public constant REPORT_TYPEHASH = keccak256(
        "Report(uint256 equity,uint256 deposited,uint256 requested,uint64 tradeNonce,uint64 timestamp,uint256[] shortSizes)"
    );
    uint256 internal constant BPS = 10_000;
    uint256 internal constant UNIT = 1e18;

    /// @notice The vault priced by this oracle.
    IDeltaNeutralVault public immutable VAULT;
    /// @notice The vault's strategy manager (spot, USDG in transit, adapter).
    IStrategyManager public immutable STRATEGY;
    /// @notice USDG.
    IERC20 public immutable USDG;

    /// @inheritdoc INavOracle
    mapping(address signer => bool) public isSigner;
    /// @notice Max report age while the feed session is open, seconds.
    uint256 public maxAgeOpen;
    /// @notice Max report age while the feed session is closed, seconds (DN-R5: ≤ 15 min).
    uint256 public maxAgeClosed;
    Report internal _last;
    /// @inheritdoc INavOracle
    mapping(uint256 sleeve => uint256) public refQuote;
    /// @inheritdoc INavOracle
    uint256 public unconfirmedMoveBps;

    /// @param owner_ Deployer during deployment, then the timelock.
    /// @param vault The vault.
    /// @param strategy The strategy manager.
    /// @param maxAgeOpen_ Max report age while open (≤ 1h).
    /// @param maxAgeClosed_ Max report age while closed (≤ 15 min, DN-R5).
    constructor(address owner_, address vault, address strategy, uint256 maxAgeOpen_, uint256 maxAgeClosed_)
        EIP712("Stockline NavOracle", "1")
        Ownable(owner_)
    {
        if (vault == address(0) || strategy == address(0)) revert ZeroAddress();
        VAULT = IDeltaNeutralVault(vault);
        STRATEGY = IStrategyManager(strategy);
        USDG = IERC20(IStrategyManager(strategy).USDG());
        _setMaxAge(maxAgeOpen_, maxAgeClosed_);
    }

    // ================================================================== Reports

    /// @inheritdoc INavOracle
    function submit(Report calldata r, bytes[] calldata signatures) external {
        uint64 last = _last.timestamp;
        if (r.timestamp > block.timestamp) revert FutureReport(r.timestamp);
        if (r.timestamp <= last) revert NotNewer(r.timestamp, last);
        if (block.timestamp - r.timestamp > _maxAge()) revert StaleReport(r.timestamp);
        IPerpAdapter a = IPerpAdapter(STRATEGY.adapter());
        if (address(a) == address(0)) revert ZeroAddress();
        uint256 n = STRATEGY.sleeveCount();
        if (r.deposited > a.totalDeposited() || r.requested > a.totalRequested() || r.shortSizes.length != n) {
            revert BadReport();
        }
        uint64 nonce = STRATEGY.tradeNonce();
        if (r.tradeNonce != nonce) revert TradeNotReported(r.tradeNonce, nonce);

        uint256 signers = _verify(r, signatures);
        uint256 navNext = _checkMove(r, a, signers);
        _last = r;
        for (uint256 i; i < n; i++) {
            refQuote[i] = STRATEGY.quote(i, UNIT);
        }
        emit Reported(r.equity, r.deposited, r.requested, r.timestamp, navNext, signers);
    }

    /// @dev DN-R4: a report moving the perp side by more than 1% of NAV against the marked estimate needs 2 signers;
    /// single-signed moves accumulate in `unconfirmedMoveBps` (also capped at 1%) until a co-signed report resets it.
    /// Returns the NAV with the report.
    function _checkMove(Report calldata r, IPerpAdapter a, uint256 signers) internal returns (uint256) {
        uint256 estimate = _perp(a);
        uint256 next = _flows(r.equity, r.deposited, r.requested, a); // its sizes are priced now
        uint256 base = _base();
        uint256 navEstimate = base + estimate;
        uint256 diff = next > estimate ? next - estimate : estimate - next;
        // slither-disable-next-line incorrect-equality
        uint256 moveBps = navEstimate == 0 ? (diff == 0 ? 0 : BPS) : diff * BPS / navEstimate;
        if (signers < 2) {
            moveBps += unconfirmedMoveBps;
            if (moveBps > SECOND_SIGNER_BPS) revert NeedsSecondSigner(moveBps);
            unconfirmedMoveBps = moveBps;
        } else {
            unconfirmedMoveBps = 0;
        }
        return base + next;
    }

    /// @dev Distinct allowed signers over the report digest; returns their count (≥ 1).
    function _verify(Report calldata r, bytes[] calldata signatures) internal view returns (uint256 n) {
        n = signatures.length;
        if (n == 0) revert BadSignature();
        bytes32 digest = reportDigest(r);
        address prev = address(0);
        for (uint256 i; i < n; i++) {
            // slither-disable-next-line unused-return
            (address s, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signatures[i]);
            if (err != ECDSA.RecoverError.NoError || !isSigner[s]) revert BadSignature();
            // Strictly increasing addresses: distinct signers without a set in storage.
            if (s <= prev) revert DuplicateSigner();
            prev = s;
        }
    }

    // ================================================================== Owner (timelock)

    /// @notice Allow or remove a report signer.
    function setSigner(address signer, bool allowed) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        isSigner[signer] = allowed;
        emit SignerSet(signer, allowed);
    }

    /// @notice Max report ages (open ≤ 1h, closed ≤ 15 min).
    function setMaxAge(uint256 open, uint256 closed) external onlyOwner {
        _setMaxAge(open, closed);
    }

    function _setMaxAge(uint256 open, uint256 closed) internal {
        if (open == 0 || closed == 0 || open > MAX_AGE_OPEN_CEILING || closed > MAX_AGE_CLOSED_CEILING) {
            revert BadMaxAge();
        }
        maxAgeOpen = open;
        maxAgeClosed = closed;
        emit MaxAgeSet(open, closed);
    }

    // ================================================================== Views

    /// @inheritdoc INavOracle
    function nav() external view returns (uint256) {
        return _base() + _perp(IPerpAdapter(STRATEGY.adapter()));
    }

    /// @inheritdoc INavOracle
    function fresh() external view returns (bool) {
        if (_last.timestamp == 0 || block.timestamp - _last.timestamp > _maxAge()) return false;
        if (_last.tradeNonce != STRATEGY.tradeNonce()) return false;
        uint256 n = STRATEGY.sleeveCount();
        for (uint256 i; i < n; i++) {
            IStrategyManager.Sleeve memory s = STRATEGY.sleeve(i);
            // A tripped stock oracle guard (stale or insane feed, issuer pause, …) means the spot mark can't be
            // trusted.
            if (IStocklineOracle(s.oracle).guardReasons() != 0 && STRATEGY.spotUnits(i) > 0) return false;
        }
        return true;
    }

    /// @inheritdoc INavOracle
    function reportAge() external view returns (uint256) {
        return _last.timestamp == 0 ? type(uint256).max : block.timestamp - _last.timestamp;
    }

    /// @inheritdoc INavOracle
    function lastReport() external view returns (Report memory) {
        return _last;
    }

    /// @inheritdoc INavOracle
    function perpValue() external view returns (uint256) {
        return _perp(IPerpAdapter(STRATEGY.adapter()));
    }

    /// @inheritdoc INavOracle
    function spotValue() public view returns (uint256 v) {
        uint256 n = STRATEGY.sleeveCount();
        for (uint256 i; i < n; i++) {
            uint256 units = STRATEGY.spotUnits(i);
            if (units > 0) v += STRATEGY.quote(i, units);
        }
    }

    /// @inheritdoc INavOracle
    function reportDigest(Report calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    REPORT_TYPEHASH,
                    r.equity,
                    r.deposited,
                    r.requested,
                    r.tradeNonce,
                    r.timestamp,
                    keccak256(abi.encodePacked(r.shortSizes))
                )
            )
        );
    }

    /// @dev Everything but the perp side: vault idle USDG, strategy USDG, spot.
    function _base() internal view returns (uint256) {
        return VAULT.idleAssets() + USDG.balanceOf(address(STRATEGY)) + spotValue();
    }

    /// @dev Perp side now: the last report's equity and flows, marked to the feed move since it (DN-R14).
    function _perp(IPerpAdapter a) internal view returns (uint256) {
        if (address(a) == address(0)) return 0; // no venue wired (mainnet until a live adapter is verified)
        Report storage r = _last;
        uint256 plus = r.equity + (a.totalDeposited() - r.deposited) + a.pending();
        uint256 minus = a.totalRequested() - r.requested;
        uint256 n = r.shortSizes.length;
        for (uint256 i; i < n; i++) {
            uint256 size = r.shortSizes[i];
            if (size == 0) continue;
            uint256 nowQ = STRATEGY.quote(i, UNIT);
            uint256 refQ = refQuote[i];
            // A short gains when the price falls.
            if (nowQ < refQ) plus += size * (refQ - nowQ) / UNIT;
            else minus += size * (nowQ - refQ) / UNIT;
        }
        return plus > minus ? plus - minus : 0; // a venue account can't be worth less than nothing to the vault
    }

    /// @dev A report's perp value at the current prices (no mark adjustment: its sizes are priced now).
    function _flows(uint256 equity, uint256 deposited, uint256 requested, IPerpAdapter a)
        internal
        view
        returns (uint256)
    {
        uint256 plus = equity + (a.totalDeposited() - deposited) + a.pending();
        uint256 minus = a.totalRequested() - requested;
        return plus > minus ? plus - minus : 0;
    }

    function _maxAge() internal view returns (uint256) {
        return VAULT.marketOpen() ? maxAgeOpen : maxAgeClosed;
    }
}
