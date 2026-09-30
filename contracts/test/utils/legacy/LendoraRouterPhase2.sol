// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {
    IMorpho,
    MarketParams,
    Market,
    Position,
    Authorization,
    Signature
} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/src/libraries/SharesMathLib.sol";
import {MorphoBalancesLib} from "morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";
import {ILendoraRouter} from "../../../src/interfaces/ILendoraRouter.sol";
import {IStockWrapper} from "../../../src/interfaces/IStockWrapper.sol";
import {ICollateralToken} from "../../../src/interfaces/ICollateralToken.sol";
import {ILendoraOracle} from "../../../src/interfaces/ILendoraOracle.sol";
import {IVaultV2Min, IMorphoMarketV1AdapterV2Min} from "../../../src/interfaces/external/IMorphoVaultV2.sol";
import {OracleMath} from "../../../src/libraries/OracleMath.sol";

/// @title LendoraRouterPhase2 (test-only snapshot of the router at 2fbd732, before RT-R8)
/// @notice One-transaction user flows over Morpho Blue, Vault V2, the wrappers and `clUSDG`
/// (docs/prd/05-collateral-router.md §4). Entries (`borrow`, `openShort`) enforce RT-R1 (guard, HF ≥ 1.10 at t + 24h
/// with closure and event buffers, per-address and global caps) and RT-R2 (EIP-712 attestation). Exits (`repay`,
/// `closeShort`, `withdrawCollateral`, `withdrawLend`) and `addCollateral` never need an attestation or a guard check.
/// @dev UUPS behind the timelock (RT-R7); holds configuration only, never user balances between calls (RT-R5); every
/// entry point takes a `deadline` and is reentrancy-guarded (RT-R6). Swaps go only through allowlisted targets, with
/// balance-delta checks; return data is never read (RT-R3). Users authorize the router on Morpho once
/// (`setAuthorization`, or `morphoAuthorizeWithSig` in a `multicall`) and approve tokens with `selfPermit`.
contract LendoraRouterPhase2 is
    ILendoraRouter,
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardTransient,
    Multicall,
    EIP712
{
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using SharesMathLib for uint256;
    using MorphoBalancesLib for IMorpho;

    /// @notice RT-R1 minimum health factor at `t + HORIZON`.
    uint256 public constant HF_MIN_OPEN = 1.1e18;
    uint256 public constant HORIZON = 24 hours;
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256("Attestation(address user,uint256 expiry)");

    IMorpho public immutable MORPHO;
    ICollateralToken public immutable CL_USDG;
    IERC20 public immutable USDG;

    /// @custom:storage-location erc7201:stockline.storage.StocklineRouter
    struct RouterStorage {
        address owner;
        address attestationSigner;
        uint256 globalCap; // clUSDG raw units
        mapping(address stock => Market) markets;
        mapping(address user => mapping(address stock => uint256)) capOverride; // WAD USD
        mapping(address target => SwapMode) swapModes;
    }

    // keccak256(abi.encode(uint256(keccak256("stockline.storage.StocklineRouter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE = 0x808536a3d2e820d9a4e34e38b268326c4a2c404a59f2d879de9ba5e09b033300;

    function _s() private pure returns (RouterStorage storage $) {
        assembly {
            $.slot := STORAGE
        }
    }

    modifier onlyOwner() {
        if (msg.sender != _s().owner) revert NotOwner();
        _;
    }

    modifier beforeDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address morpho, address clUsdg) EIP712("StocklineRouter", "1") {
        if (morpho == address(0) || clUsdg == address(0)) revert ZeroAddress();
        MORPHO = IMorpho(morpho);
        CL_USDG = ICollateralToken(clUsdg);
        USDG = IERC20(ICollateralToken(clUsdg).backing());
        _disableInitializers();
    }

    function initialize(address owner_, address signer, uint256 globalCap_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        RouterStorage storage $ = _s();
        $.owner = owner_;
        $.attestationSigner = signer;
        $.globalCap = globalCap_;
        emit OwnershipTransferred(address(0), owner_);
        emit AttestationSignerSet(signer);
        emit GlobalCapSet(globalCap_);
    }

    // Return values of wrap/unwrap (always equal to the input or revert), Morpho borrow in asset mode (= the input),
    // forceDeallocate (penalty shares, 0) and partially read tuples are intentionally unused (slither.config.json).
    // slither-disable-start unused-return

    // ================================================================== Lender flows

    /// @notice Stock Token → wrap → Vault V2 deposit; `rSTOCK` shares to `receiver` (US-L1).
    function lend(address stock, uint256 amount, uint256 minShares, address receiver, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 shares)
    {
        Market storage m = _listed(stock);
        if (amount == 0) revert ZeroAmount();
        IERC20(stock).safeTransferFrom(msg.sender, address(this), amount);
        _wrap(stock, m.wrapper, amount);
        IERC20(m.wrapper).forceApprove(m.vault, amount);
        shares = IVaultV2Min(m.vault).deposit(amount, receiver);
        if (shares < minShares) revert InsufficientOutput(shares, minShares);
        emit Lent(msg.sender, stock, amount, shares, receiver);
    }

    /// @notice Redeem `shares` of the caller's `rSTOCK` (router needs a share allowance) → unwrap → Stock Token to
    /// `receiver` (US-L3). If the vault's idle balance is short, free market liquidity is first pulled in with
    /// `forceDeallocate` (penalty 0, LM-R22).
    function withdrawLend(address stock, uint256 shares, uint256 minAssets, address receiver, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 assets)
    {
        Market storage m = _configured(stock);
        IVaultV2Min v = IVaultV2Min(m.vault);
        uint256 needed = v.previewRedeem(shares);
        uint256 idle = IERC20(m.wrapper).balanceOf(m.vault);
        if (needed > idle) v.forceDeallocate(m.adapter, abi.encode(m.params), needed - idle, msg.sender);
        assets = v.redeem(shares, address(this), msg.sender);
        if (assets < minAssets) revert InsufficientOutput(assets, minAssets);
        IStockWrapper(m.wrapper).unwrap(assets, receiver);
        emit Withdrawn(msg.sender, stock, shares, assets, receiver);
    }

    // ================================================================== Borrower entries (RT-R1, RT-R2)

    /// @notice USDG → clUSDG collateral → borrow `borrowAmount` wSTOCK → unwrap → Stock Token to `receiver`
    /// (US-B1).
    function borrow(
        address stock,
        uint256 collateralIn,
        uint256 borrowAmount,
        address receiver,
        Attestation calldata att,
        uint256 deadline
    ) external nonReentrant beforeDeadline(deadline) {
        Market storage m = _openChecks(stock, att);
        if (collateralIn > 0) {
            USDG.safeTransferFrom(msg.sender, address(this), collateralIn);
            _addCollateral(m, collateralIn, msg.sender);
        }
        MORPHO.borrow(m.params, borrowAmount, 0, msg.sender, address(this));
        IStockWrapper(m.wrapper).unwrap(borrowAmount, receiver);
        _positionChecks(stock, m, msg.sender);
        emit Borrowed(msg.sender, stock, collateralIn, borrowAmount);
    }

    /// @notice `borrow`, then sell the Stock Token for USDG through an allowlisted target (US-B2). Proceeds go to
    /// `receiver`, or back in as collateral when `compound`. Unsold stock (partial fills) is refunded to `receiver`.
    function openShort(
        address stock,
        uint256 collateralIn,
        uint256 borrowAmount,
        Swap calldata swap,
        bool compound,
        address receiver,
        Attestation calldata att,
        uint256 deadline
    ) external nonReentrant beforeDeadline(deadline) returns (uint256 usdgOut) {
        Market storage m = _openChecks(stock, att);
        if (collateralIn > 0) {
            USDG.safeTransferFrom(msg.sender, address(this), collateralIn);
            _addCollateral(m, collateralIn, msg.sender);
        }
        MORPHO.borrow(m.params, borrowAmount, 0, msg.sender, address(this));
        IStockWrapper(m.wrapper).unwrap(borrowAmount, address(this));
        if (swap.amountIn > borrowAmount) revert InsufficientOutput(borrowAmount, swap.amountIn);
        usdgOut = _swap(IERC20(stock), USDG, swap);
        if (compound) _addCollateral(m, usdgOut, msg.sender);
        else USDG.safeTransfer(receiver, usdgOut);
        _sweep(IERC20(stock), receiver);
        _positionChecks(stock, m, msg.sender);
        emit ShortOpened(msg.sender, stock, collateralIn, borrowAmount, usdgOut, compound);
    }

    // ================================================================== Exits (never attested, never guarded)

    /// @notice Pull `usdgIn` USDG → buy the Stock Token → repay the caller's whole debt by shares (RT-R4) →
    /// withdraw all collateral → unwrap → USDG to `receiver`. Leftover stock and USDG are refunded to `receiver`
    /// (US-B4).
    function closeShort(address stock, uint256 usdgIn, Swap calldata swap, address receiver, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 collateralOut)
    {
        Market storage m = _configured(stock);
        USDG.safeTransferFrom(msg.sender, address(this), usdgIn);
        if (swap.amountIn > usdgIn) revert InsufficientOutput(usdgIn, swap.amountIn);
        uint256 bought = _swap(USDG, IERC20(stock), swap);
        _wrap(stock, m.wrapper, bought);

        Position memory pos = MORPHO.position(m.params.id(), msg.sender);
        uint256 repaid = 0; // stays 0 if there is no debt to repay
        if (pos.borrowShares > 0) {
            IERC20(m.wrapper).forceApprove(address(MORPHO), bought);
            (repaid,) = MORPHO.repay(m.params, 0, pos.borrowShares, msg.sender, "");
            IERC20(m.wrapper).forceApprove(address(MORPHO), 0);
        }
        uint256 leftover = IERC20(m.wrapper).balanceOf(address(this));
        if (leftover > 0) IStockWrapper(m.wrapper).unwrap(leftover, receiver);

        collateralOut = pos.collateral;
        if (collateralOut > 0) {
            MORPHO.withdrawCollateral(m.params, collateralOut, msg.sender, address(this));
            CL_USDG.unwrap(collateralOut, receiver);
        }
        _sweep(USDG, receiver);
        emit ShortClosed(msg.sender, stock, repaid, usdgIn, collateralOut);
    }

    /// @notice USDG → clUSDG → supply as collateral for `onBehalf` (US-B5). Risk-reducing: no attestation, no
    /// guard.
    function addCollateral(address stock, uint256 amount, address onBehalf, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
    {
        Market storage m = _configured(stock);
        if (amount == 0) revert ZeroAmount();
        USDG.safeTransferFrom(msg.sender, address(this), amount);
        _addCollateral(m, amount, onBehalf);
        emit CollateralAdded(msg.sender, onBehalf, stock, amount);
    }

    /// @notice Repay `onBehalf`'s debt with the caller's Stock Tokens: by `assets`, or by `shares` (RT-R4;
    /// `type(uint256).max` = all shares). Exactly one of them is non-zero. Any rounding excess is refunded.
    function repay(address stock, uint256 assets, uint256 shares, address onBehalf, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 repaidAssets)
    {
        Market storage m = _configured(stock);
        if ((assets == 0) == (shares == 0)) revert ZeroAmount();
        uint256 pull = assets;
        if (shares > 0) {
            if (shares == type(uint256).max) shares = MORPHO.position(m.params.id(), onBehalf).borrowShares;
            (,, uint256 totalBorrowAssets, uint256 totalBorrowShares) = MORPHO.expectedMarketBalances(m.params);
            pull = shares.toAssetsUp(totalBorrowAssets, totalBorrowShares);
        }
        IERC20(stock).safeTransferFrom(msg.sender, address(this), pull);
        _wrap(stock, m.wrapper, pull);
        IERC20(m.wrapper).forceApprove(address(MORPHO), pull);
        (repaidAssets,) = MORPHO.repay(m.params, assets, shares, onBehalf, "");
        IERC20(m.wrapper).forceApprove(address(MORPHO), 0);
        if (pull > repaidAssets) IStockWrapper(m.wrapper).unwrap(pull - repaidAssets, msg.sender);
        emit Repaid(msg.sender, onBehalf, stock, repaidAssets, shares);
    }

    /// @notice Withdraw the caller's collateral (`type(uint256).max` = all) → unwrap → USDG to `receiver`.
    function withdrawCollateral(address stock, uint256 amount, address receiver, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
    {
        Market storage m = _configured(stock);
        if (amount == type(uint256).max) amount = MORPHO.position(m.params.id(), msg.sender).collateral;
        if (amount == 0) revert ZeroAmount();
        MORPHO.withdrawCollateral(m.params, amount, msg.sender, address(this));
        CL_USDG.unwrap(amount, receiver);
        emit CollateralWithdrawn(msg.sender, stock, amount, receiver);
    }

    // slither-disable-end unused-return

    // ================================================================== Approval helpers (for multicall)

    /// @notice EIP-2612 permit to this router for the caller (USDG, Stock Tokens, rSTOCK). A failing permit (e.g.
    /// front-run with the same signature) is ignored; the following transfer then checks the allowance.
    function selfPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC20Permit(token).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    /// @notice Submit a Morpho `setAuthorizationWithSig` (anyone may relay it).
    function morphoAuthorizeWithSig(Authorization calldata authorization, Signature calldata signature) external {
        try MORPHO.setAuthorizationWithSig(authorization, signature) {} catch {}
    }

    // ================================================================== Views

    function owner() external view returns (address) {
        return _s().owner;
    }

    function attestationSigner() external view returns (address) {
        return _s().attestationSigner;
    }

    function globalCap() external view returns (uint256) {
        return _s().globalCap;
    }

    function market(address stock) external view returns (Market memory) {
        return _s().markets[stock];
    }

    function swapMode(address target) external view returns (SwapMode) {
        return _s().swapModes[target];
    }

    /// @notice Per-address debt cap for `user` in `stock` (WAD USD): the owner's override if set, else the default.
    function capOf(address user, address stock) public view returns (uint256) {
        uint256 o = _s().capOverride[user][stock];
        return o != 0 ? o : _s().markets[stock].perAddressCapUsd;
    }

    /// @notice Health factor (WAD) of `user` in `stock` with the buffer at `t` (the RT-R1 check uses `now + 24h`).
    function healthFactorAt(address stock, address user, uint256 t) public view returns (uint256) {
        Market storage m = _s().markets[stock];
        Position memory pos = MORPHO.position(m.params.id(), user);
        uint256 borrowed = MORPHO.expectedBorrowAssets(m.params, user);
        uint256 price = ILendoraOracle(m.params.oracle).priceAt(t);
        return OracleMath.healthFactor(pos.collateral, price, m.params.lltv, borrowed);
    }

    /// @notice EIP-712 digest a compliance signer signs for `user` (RT-R2).
    function attestationDigest(address user, uint256 expiry) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, user, expiry)));
    }

    // ================================================================== Owner (timelock)

    /// @notice List a market. Checks the wiring: wrapper of `stock`, loan = wrapper, collateral = clUSDG, a created
    /// Morpho market, the vault's asset and the adapter's parent vault.
    function listMarket(address stock, Market calldata m) external onlyOwner {
        if (
            IStockWrapper(m.wrapper).underlying() != stock || m.params.loanToken != m.wrapper
                || m.params.collateralToken != address(CL_USDG) || MORPHO.market(m.params.id()).lastUpdate == 0
                || IVaultV2Min(m.vault).asset() != m.wrapper
                || IMorphoMarketV1AdapterV2Min(m.adapter).parentVault() != m.vault
                || ILendoraOracle(m.params.oracle).WRAPPER() != m.wrapper
        ) revert BadMarket();
        Market storage s = _s().markets[stock];
        s.wrapper = m.wrapper;
        s.vault = m.vault;
        s.adapter = m.adapter;
        s.params = m.params;
        s.perAddressCapUsd = m.perAddressCapUsd;
        s.listed = true;
        emit MarketListed(stock, m);
    }

    /// @notice Stop new lending and borrowing in `stock`; exits keep working.
    function delistMarket(address stock) external onlyOwner {
        _s().markets[stock].listed = false;
        emit MarketDelisted(stock);
    }

    function setCapOverride(address user, address stock, uint256 capUsd) external onlyOwner {
        _s().capOverride[user][stock] = capUsd;
        emit CapOverrideSet(user, stock, capUsd);
    }

    function setGlobalCap(uint256 cap) external onlyOwner {
        _s().globalCap = cap;
        emit GlobalCapSet(cap);
    }

    function setAttestationSigner(address signer) external onlyOwner {
        _s().attestationSigner = signer;
        emit AttestationSignerSet(signer);
    }

    function setSwapTarget(address target, SwapMode mode) external onlyOwner {
        if (target == address(0) || target == address(MORPHO) || target == address(CL_USDG)) revert ZeroAddress();
        _s().swapModes[target] = mode;
        emit SwapTargetSet(target, mode);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(_s().owner, newOwner);
        _s().owner = newOwner;
    }

    /// @dev RT-R7: upgrades only by the owner (the 48h timelock).
    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ================================================================== Internals

    function _configured(address stock) internal view returns (Market storage m) {
        m = _s().markets[stock];
        if (m.wrapper == address(0)) revert NotListed(stock);
    }

    function _listed(address stock) internal view returns (Market storage m) {
        m = _s().markets[stock];
        if (!m.listed) revert NotListed(stock);
    }

    // slither-disable-start unused-return
    /// @dev RT-R1 guard and RT-R2 attestation, before any state change.
    function _openChecks(address stock, Attestation calldata att) internal view returns (Market storage m) {
        m = _listed(stock);
        uint256 reasons = ILendoraOracle(m.params.oracle).guardReasons();
        if (reasons != 0) revert GuardTripped(reasons);
        address signer = _s().attestationSigner;
        if (signer == address(0) || att.expiry < block.timestamp) revert BadAttestation();
        (address recovered, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(attestationDigest(msg.sender, att.expiry), att.signature);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert BadAttestation();
    }

    /// @dev RT-R1 after the position changed: HF at t + 24h, per-address debt cap, global clUSDG cap.
    function _positionChecks(address stock, Market storage m, address user) internal view {
        uint256 hf = healthFactorAt(stock, user, block.timestamp + HORIZON);
        if (hf < HF_MIN_OPEN) revert HealthTooLow(hf);
        (uint256 answer,) = ILendoraOracle(m.params.oracle).stockAnswer();
        uint256 debtUsd = MORPHO.expectedBorrowAssets(m.params, user) * answer / 1e8; // feeds are 8 dp (01 §4)
        uint256 cap = capOf(user, stock);
        if (debtUsd > cap) revert PerAddressCapExceeded(debtUsd, cap);
        uint256 supply = IERC20(address(CL_USDG)).totalSupply();
        if (supply > _s().globalCap) revert GlobalCapExceeded(supply, _s().globalCap);
    }

    function _wrap(address stock, address wrapper, uint256 amount) internal {
        IERC20(stock).forceApprove(wrapper, amount);
        IStockWrapper(wrapper).wrap(amount, address(this));
    }
    // slither-disable-end unused-return

    function _addCollateral(Market storage m, uint256 amount, address onBehalf) internal {
        USDG.forceApprove(address(CL_USDG), amount);
        CL_USDG.mint(address(this), amount);
        IERC20(address(CL_USDG)).forceApprove(address(MORPHO), amount);
        MORPHO.supplyCollateral(m.params, amount, onBehalf, "");
    }

    /// @dev RT-R3: allowlisted target only; exact input handed over by approval or transfer; output measured by the
    /// balance delta; any approval reset to 0. The target's return data is ignored.
    function _swap(IERC20 tokenIn, IERC20 tokenOut, Swap calldata swap) internal returns (uint256 out) {
        SwapMode mode = _s().swapModes[swap.target];
        if (mode == SwapMode.None) revert SwapTargetNotAllowed(swap.target);
        uint256 before = tokenOut.balanceOf(address(this));
        if (mode == SwapMode.Approve) tokenIn.forceApprove(swap.target, swap.amountIn);
        else tokenIn.safeTransfer(swap.target, swap.amountIn);
        (bool ok, bytes memory ret) = swap.target.call(swap.data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        if (mode == SwapMode.Approve) tokenIn.forceApprove(swap.target, 0);
        out = tokenOut.balanceOf(address(this)) - before;
        if (out < swap.minOut) revert InsufficientOutput(out, swap.minOut);
    }

    function _sweep(IERC20 token, address to) internal {
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) token.safeTransfer(to, bal);
    }
}
