// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IDeltaNeutralVault} from "../interfaces/IDeltaNeutralVault.sol";
import {INavOracle} from "../interfaces/INavOracle.sol";
import {IMarketHours} from "../interfaces/IMarketHours.sol";

/// @dev The router's attestation views (RT-R2): the vault accepts the same compliance attestation.
interface IAttestationSource {
    function attestationDigest(address user, uint256 expiry) external view returns (bytes32);
    function attestationSigner() external view returns (address);
}

/// @title DeltaNeutralVault ("USDG Earn")
/// @notice ERC-4626 over USDG for the delta-neutral strategy (docs/prd/08-delta-neutral-vault.md). Priced at
/// `NavOracle.nav()`; the strategy's positions are held by the `StrategyManager` and the perp adapter, the cash buffer
/// here.
/// - **Entries** (DN-R6, CP-R3): `deposit(assets, receiver, attestation)` only; the plain ERC-4626 `deposit`/`mint`
///   revert. Needs the router's compliance attestation for the caller, a fresh NAV (DN-R5), the feed session open
///   (DN-R12), deposits not paused, and NAV + assets within `totalCap` (0 at launch).
/// - **Exits** (DN-R1, CP-R4): ERC-4626 `withdraw`/`redeem` are instant up to the idle USDG while the NAV is fresh and
///   the session open (never gated by attestation or pause). `requestRedeem` always works: shares go into escrow and
///   settle FIFO at the NAV of their settlement (`settle`, permissionless, fresh NAV and open session only), then
///   `claim` pays them at any time. The deadline shown is max(72h, next US open).
/// - **No mint or burn on a stale NAV** (DN-R5) or while the session is closed (DN-R12: spot would be marked at a
/// frozen feed while the perp marks live, sim §4.1).
/// - **Fee** (DN-R9): 10% of the gain above the share-price high-water mark, minted as shares to `feeRecipient`
///   (the `FeeSplitter`); no management fee.
/// @dev Shares have 18 decimals (`_decimalsOffset` = 12 over USDG's 6), which also blunts share-price inflation. Owner
/// = the timelock (48h mainnet): caps, recipients, buffer; the guardian can pause deposits and lower the cap at once.
contract DeltaNeutralVault is IDeltaNeutralVault, ERC4626, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @inheritdoc IDeltaNeutralVault
    uint256 public constant PERFORMANCE_FEE = 0.1e18;
    /// @inheritdoc IDeltaNeutralVault
    uint256 public constant QUEUE_MIN = 72 hours;
    /// @notice NYSE opens 13h30 after the Chainlink 24/5 feed reopens (20:00 ET → 09:30 ET, DST-independent).
    uint256 public constant US_OPEN_AFTER_FEED_OPEN = 13.5 hours;
    /// @notice Largest cash buffer the owner can require, bps of NAV.
    uint256 public constant MAX_BUFFER_BPS = 5000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint8 internal constant OFFSET = 12;

    /// @notice Source of compliance attestations (the `StocklineRouter` proxy).
    IAttestationSource public immutable ATTESTATION_SOURCE;
    /// @notice Feed-session calendar (`MarketHours`).
    IMarketHours public immutable MARKET_HOURS;

    /// @notice The NAV oracle (set once).
    INavOracle public navOracle;
    /// @notice The strategy manager (set once): the only account that may take idle USDG.
    address public strategy;
    /// @notice Guardian multisig: pauses deposits, lowers the cap.
    address public guardian;
    /// @notice DN-R9 fee recipient (the `FeeSplitter`).
    address public feeRecipient;
    /// @inheritdoc IDeltaNeutralVault
    uint256 public totalCap;
    /// @notice Cash buffer the vault keeps when funding the strategy, bps of NAV (DN-R1, `c`).
    uint256 public bufferBps;
    /// @notice Guardian switch for entries only.
    bool public depositsPaused;
    /// @inheritdoc IDeltaNeutralVault
    uint256 public highWaterMark;
    /// @inheritdoc IDeltaNeutralVault
    uint256 public reserved;
    /// @inheritdoc IDeltaNeutralVault
    uint256 public escrowedShares;

    mapping(uint256 id => Request) internal _requests;
    uint256 internal _head;
    uint256 internal _tail;

    /// @param usdg USDG (the asset).
    /// @param owner_ Deployer during deployment, then the timelock.
    /// @param attestationSource The router (its attestation signer and EIP-712 domain).
    /// @param marketHours `MarketHours`.
    /// @param guardian_ Guardian multisig.
    /// @param feeRecipient_ `FeeSplitter`.
    /// @param bufferBps_ Cash buffer, bps of NAV (500 = `c` 5%).
    constructor(
        IERC20 usdg,
        address owner_,
        address attestationSource,
        address marketHours,
        address guardian_,
        address feeRecipient_,
        uint256 bufferBps_
    ) ERC20("Stockline USDG Earn", "sEARN") ERC4626(usdg) Ownable(owner_) {
        if (
            address(usdg) == address(0) || attestationSource == address(0) || marketHours == address(0)
                || guardian_ == address(0) || feeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (bufferBps_ > MAX_BUFFER_BPS) revert BadParam();
        ATTESTATION_SOURCE = IAttestationSource(attestationSource);
        MARKET_HOURS = IMarketHours(marketHours);
        guardian = guardian_;
        feeRecipient = feeRecipient_;
        bufferBps = bufferBps_;
        highWaterMark = WAD;
        emit GuardianSet(guardian_);
        emit FeeRecipientSet(feeRecipient_);
        emit BufferSet(bufferBps_);
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    // ================================================================== Entries

    /// @notice Disabled: deposits need an attestation (`deposit(assets, receiver, att)`).
    function deposit(uint256, address) public pure override returns (uint256) {
        revert AttestationRequired();
    }

    /// @notice Disabled: deposits need an attestation (`deposit(assets, receiver, att)`).
    function mint(uint256, address) public pure override returns (uint256) {
        revert AttestationRequired();
    }

    /// @inheritdoc IDeltaNeutralVault
    function deposit(uint256 assets, address receiver, Attestation calldata att)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        _checkAttestation(msg.sender, att);
        if (depositsPaused) revert DepositsPaused();
        _requireLive();
        _accrueFee();
        uint256 ta = totalAssets();
        if (ta + assets > totalCap) revert CapExceeded(ta + assets, totalCap);
        shares = _convertToShares(assets, Math.Rounding.Floor);
        // slither-disable-next-line incorrect-equality
        if (shares == 0) revert ZeroAmount(); // dust deposit
        _deposit(msg.sender, receiver, assets, shares);
    }

    // ================================================================== Exits

    /// @notice Instant withdrawal of `assets` USDG, up to `instantCapacity()` (fresh NAV, open session).
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        _requireLive();
        _accrueFee();
        uint256 cap = Math.min(idleAssets(), _convertToAssets(balanceOf(owner_), Math.Rounding.Floor));
        if (assets > cap) revert ExceedsInstant(assets, cap);
        shares = _convertToShares(assets, Math.Rounding.Ceil);
        _withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    /// @notice Instant redemption of `shares`, if their value fits `instantCapacity()`.
    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        _requireLive();
        _accrueFee();
        assets = _convertToAssets(shares, Math.Rounding.Floor);
        uint256 idle = idleAssets();
        if (assets > idle) revert ExceedsInstant(assets, idle);
        _withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    /// @inheritdoc IDeltaNeutralVault
    function requestRedeem(uint256 shares, address receiver, address owner_)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (msg.sender != owner_) _spendAllowance(owner_, msg.sender, shares);
        _transfer(owner_, address(this), shares);
        escrowedShares += shares;
        id = _tail++;
        uint64 settleBy = settleByFor(block.timestamp);
        _requests[id] = Request({
            owner: owner_,
            receiver: receiver,
            shares: SafeCast.toUint128(shares),
            assets: 0,
            requestedAt: SafeCast.toUint64(block.timestamp),
            settleBy: settleBy,
            status: RequestStatus.Queued
        });
        emit RedeemRequested(id, owner_, receiver, shares, settleBy);
    }

    /// @inheritdoc IDeltaNeutralVault
    function settle(uint256 maxCount) external nonReentrant returns (uint256 settled) {
        _requireLive();
        _accrueFee();
        uint256 head = _head;
        uint256 tail = _tail;
        while (settled < maxCount && head < tail) {
            Request storage r = _requests[head];
            uint256 assets = _convertToAssets(r.shares, Math.Rounding.Floor);
            if (assets > idleAssets()) break; // FIFO: the head waits for cash, nothing behind it jumps ahead
            _burn(address(this), r.shares);
            escrowedShares -= r.shares;
            reserved += assets;
            r.assets = SafeCast.toUint128(assets);
            r.status = RequestStatus.Claimable;
            emit RedeemSettled(head, r.shares, assets);
            unchecked {
                ++head;
                ++settled;
            }
        }
        _head = head;
    }

    /// @inheritdoc IDeltaNeutralVault
    function claim(uint256 id) external nonReentrant returns (uint256 assets) {
        Request storage r = _requests[id];
        if (r.status != RequestStatus.Claimable) revert NotClaimable(id);
        r.status = RequestStatus.Claimed;
        assets = r.assets;
        reserved -= assets;
        IERC20(asset()).safeTransfer(r.receiver, assets);
        emit Claimed(id, r.receiver, assets);
    }

    // ================================================================== Strategy and fee

    /// @inheritdoc IDeltaNeutralVault
    function sendToStrategy(uint256 amount) external nonReentrant {
        if (msg.sender != strategy) revert NotStrategy();
        uint256 head = _head;
        if (head < _tail && _requests[head].settleBy <= block.timestamp) revert QueueOverdue(head);
        uint256 idle = idleAssets();
        uint256 minIdle = Math.mulDiv(totalAssets(), bufferBps, BPS, Math.Rounding.Ceil);
        if (amount > idle || idle - amount < minIdle) {
            revert BufferBreached(amount > idle ? 0 : idle - amount, minIdle);
        }
        IERC20(asset()).safeTransfer(msg.sender, amount);
        emit SentToStrategy(amount);
    }

    /// @inheritdoc IDeltaNeutralVault
    function accrueFee() external nonReentrant {
        if (!navOracle.fresh()) revert NavStale();
        _accrueFee();
    }

    /// @dev DN-R9: mint fee shares worth 10% of the gain above the high-water mark, then raise the mark. Only on a
    /// fresh NAV (every caller has checked).
    function _accrueFee() internal {
        uint256 supply = totalSupply();
        // slither-disable-next-line incorrect-equality
        if (supply == 0) return; // empty vault: nothing to charge (sentinel, not a balance check)
        uint256 ta = totalAssets();
        uint256 price = _price(ta, supply);
        uint256 hwm = highWaterMark;
        if (price <= hwm) return;
        uint256 gain = Math.mulDiv(price - hwm, supply, WAD * 10 ** OFFSET);
        uint256 feeAssets = Math.mulDiv(gain, PERFORMANCE_FEE, WAD);
        uint256 feeShares = 0;
        if (feeAssets > 0 && feeAssets < ta) {
            feeShares = Math.mulDiv(feeAssets, supply + 10 ** OFFSET, ta + 1 - feeAssets);
            _mint(feeRecipient, feeShares);
        }
        uint256 newHwm = _price(ta, supply + feeShares);
        highWaterMark = newHwm > hwm ? newHwm : hwm;
        emit FeeAccrued(feeShares, price, highWaterMark);
    }

    /// @dev USDG per share, WAD, with ERC-4626's virtual share and asset.
    function _price(uint256 ta, uint256 supply) internal pure returns (uint256) {
        return Math.mulDiv(ta + 1, WAD * 10 ** OFFSET, supply + 10 ** OFFSET);
    }

    // ================================================================== Owner (timelock) and guardian

    /// @notice One-time wiring at deployment.
    function setStrategy(address strategy_) external onlyOwner {
        if (strategy != address(0)) revert AlreadySet();
        if (strategy_ == address(0)) revert ZeroAddress();
        strategy = strategy_;
        emit StrategySet(strategy_);
    }

    /// @notice One-time wiring at deployment.
    function setNavOracle(address oracle) external onlyOwner {
        if (address(navOracle) != address(0)) revert AlreadySet();
        if (oracle == address(0)) revert ZeroAddress();
        navOracle = INavOracle(oracle);
        emit NavOracleSet(oracle);
    }

    /// @notice DN-R6: set the total cap (timelocked through the owner).
    function setTotalCap(uint256 cap) external onlyOwner {
        totalCap = cap;
        emit TotalCapSet(cap);
    }

    /// @notice Guardian: lower the total cap at once (never raise).
    function lowerTotalCap(uint256 cap) external onlyGuardian {
        if (cap >= totalCap) revert BadParam();
        totalCap = cap;
        emit TotalCapSet(cap);
    }

    /// @notice Guardian: pause or resume entries (exits are never paused).
    function setDepositsPaused(bool paused_) external onlyGuardian {
        depositsPaused = paused_;
        emit DepositsPausedSet(paused_);
    }

    /// @notice Owner: the guardian.
    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Owner: the fee recipient.
    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    /// @notice Owner: the cash buffer (bps of NAV, ≤ 50%).
    function setBufferBps(uint256 bps) external onlyOwner {
        if (bps > MAX_BUFFER_BPS) revert BadParam();
        bufferBps = bps;
        emit BufferSet(bps);
    }

    // ================================================================== Views

    /// @notice NAV in USDG raw units (`NavOracle.nav()`).
    function totalAssets() public view override returns (uint256) {
        return navOracle.nav();
    }

    /// @inheritdoc IDeltaNeutralVault
    function idleAssets() public view returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        return bal > reserved ? bal - reserved : 0;
    }

    /// @inheritdoc IDeltaNeutralVault
    function instantCapacity() external view returns (uint256) {
        return _live() ? idleAssets() : 0;
    }

    /// @inheritdoc IDeltaNeutralVault
    function request(uint256 id) external view returns (Request memory) {
        return _requests[id];
    }

    /// @inheritdoc IDeltaNeutralVault
    function queueBounds() external view returns (uint256 head, uint256 tail) {
        return (_head, _tail);
    }

    /// @inheritdoc IDeltaNeutralVault
    function sharePrice() external view returns (uint256) {
        return _price(totalAssets(), totalSupply());
    }

    /// @inheritdoc IDeltaNeutralVault
    function marketOpen() public view returns (bool) {
        return MARKET_HOURS.isOpen(block.timestamp);
    }

    /// @inheritdoc IDeltaNeutralVault
    function settleByFor(uint256 t) public view returns (uint64) {
        uint256 t72 = t + QUEUE_MIN;
        if (MARKET_HOURS.isOpen(t72)) return SafeCast.toUint64(t72);
        // Only the reopen of the closure at t72 is needed; 0 = calendar exhausted (IMarketHours sentinel).
        // slither-disable-next-line unused-return
        (, uint256 reopen,,) = MARKET_HOURS.closureWindows(t72);
        // slither-disable-next-line incorrect-equality
        if (reopen == 0) return SafeCast.toUint64(t72 + MARKET_HOURS.MAX_CLOSURE());
        return SafeCast.toUint64(Math.max(t72, reopen + US_OPEN_AFTER_FEED_OPEN));
    }

    /// @notice 0 unless entries are possible now; else the room under the cap.
    function maxDeposit(address) public view override returns (uint256) {
        if (depositsPaused || !_live()) return 0;
        uint256 ta = totalAssets();
        return ta >= totalCap ? 0 : totalCap - ta;
    }

    /// @notice Always 0: `mint` is disabled (attested `deposit` only).
    function maxMint(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Instant withdrawal limit of `owner_` (0 while the NAV is stale or the session closed).
    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (!_live()) return 0;
        return Math.min(idleAssets(), _convertToAssets(balanceOf(owner_), Math.Rounding.Floor));
    }

    /// @notice Instant redemption limit of `owner_` in shares.
    function maxRedeem(address owner_) public view override returns (uint256) {
        if (!_live()) return 0;
        return Math.min(balanceOf(owner_), _convertToShares(idleAssets(), Math.Rounding.Floor));
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return OFFSET;
    }

    // ================================================================== Internals

    function _live() internal view returns (bool) {
        return navOracle.fresh() && marketOpen();
    }

    /// @dev DN-R5 and DN-R12: mint and burn only at a fresh NAV while the feed session is open.
    function _requireLive() internal view {
        if (!navOracle.fresh()) revert NavStale();
        if (!marketOpen()) revert MarketClosed();
    }

    /// @dev RT-R2 attestation of `user`, signed by the router's attestation signer in the router's domain.
    function _checkAttestation(address user, Attestation calldata att) internal view {
        if (att.expiry < block.timestamp) revert BadAttestation();
        bytes32 digest = ATTESTATION_SOURCE.attestationDigest(user, att.expiry);
        // slither-disable-next-line unused-return
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, att.signature);
        if (
            err != ECDSA.RecoverError.NoError || signer == address(0)
                || signer != ATTESTATION_SOURCE.attestationSigner()
        ) {
            revert BadAttestation();
        }
    }
}
