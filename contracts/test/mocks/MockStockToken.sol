// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IScaledUIAmount} from "../../src/interfaces/external/IScaledUIAmount.sol";
import {IHolderAllowlist} from "../../src/interfaces/IHolderAllowlist.sol";
import {MockAccessControlsRegistry} from "./MockAccessControlsRegistry.sol";

/// @notice Test Stock Token: raw-balance ERC-20 with an ERC-8056 multiplier and the issuer powers of the live Robinhood
/// `Stock` implementation (Sourcify 4663/0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2; docs/phase0/01-chain-facts.md
/// §3):
/// per-token and global pause (`IsPaused()`), a registry blocklist (`Blocked(account)`), `adminBurn`, the advisory
/// `oraclePaused()` flag and EIP-2612 `permit` (version "1"). Check order and errors copy the live modifiers:
/// `onlyNotPaused` first, then `onlyNotBlocked` on each party. Extra knobs (allowlist, fee-on-transfer) cover behavior
/// the live token does not have. Mint/burn and all setters are open: test use only.
contract MockStockToken is ERC20, ERC20Permit, IScaledUIAmount, IHolderAllowlist {
    uint256 internal constant WAD = 1e18;

    uint8 internal immutable _decimals;

    uint256 internal _uiMultiplier = WAD;
    uint256 public newUIMultiplier = WAD;
    uint256 public effectiveAt;

    /// @notice Registry holding the blocklist and the global pause. Created per token; tokens can share one.
    MockAccessControlsRegistry public registry;
    bool public tokenPaused;
    bool public oraclePaused;

    bool public allowlistEnabled;
    mapping(address => bool) public allowed;

    /// @notice Skim taken from every non-mint/burn transfer, in basis points. Real Stock Tokens have none (A2).
    uint256 public transferFeeBps;

    error NotAllowed(address account);
    error EffectiveInPast();
    /// @dev Live `AccessControlled.Blocked` and `Stock.IsPaused`.
    error Blocked(address account);
    error IsPaused();

    event TransferWithScaledUI(address indexed from, address indexed to, uint256 value, uint256 uiValue);
    event Paused();
    event Unpaused();
    event OraclePaused();
    event OracleUnpaused();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) ERC20Permit(name_) {
        _decimals = decimals_;
        registry = new MockAccessControlsRegistry();
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ---------------------------------------------------------------- Issuer surface (live signatures)

    // slither-disable-next-line naming-convention
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address) {
        return address(registry);
    }

    /// @notice Per-token pause or the registry's global pause, like `Stock.paused()`.
    function paused() public view returns (bool) {
        return tokenPaused || registry.paused();
    }

    function pause() external {
        tokenPaused = true;
        emit Paused();
    }

    function unpause() external {
        tokenPaused = false;
        emit Unpaused();
    }

    function pauseOracle() external {
        oraclePaused = true;
        emit OraclePaused();
    }

    function unpauseOracle() external {
        oraclePaused = false;
        emit OracleUnpaused();
    }

    /// @notice Burns from any address with no pause or blocklist check, like `Stock.adminBurn` (D10 R1).
    function adminBurn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    /// @notice Immediate multiplier change, like `Stock.updateMultiplier(uint256)`.
    function updateMultiplier(uint256 newMultiplier) external onlyNotPaused {
        _schedule(newMultiplier, block.timestamp);
    }

    /// @notice Scheduled multiplier change, like `Stock.updateMultiplier(uint256,uint256)`.
    function updateMultiplier(uint256 newMultiplier, uint256 effectiveAt_) external onlyNotPaused {
        _schedule(newMultiplier, effectiveAt_);
    }

    /// @notice Point this token at a shared registry (global pause and blocklist across tokens).
    function setRegistry(MockAccessControlsRegistry registry_) external {
        registry = registry_;
    }

    modifier onlyNotPaused() {
        if (paused()) revert IsPaused();
        _;
    }

    modifier onlyNotBlocked(address account) {
        if (registry.isBlocked(account)) revert Blocked(account);
        _;
    }

    function transfer(address to, uint256 value)
        public
        override
        onlyNotPaused
        onlyNotBlocked(to)
        onlyNotBlocked(msg.sender)
        returns (bool)
    {
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value)
        public
        override
        onlyNotPaused
        onlyNotBlocked(from)
        onlyNotBlocked(to)
        onlyNotBlocked(msg.sender)
        returns (bool)
    {
        return super.transferFrom(from, to, value);
    }

    function approve(address spender, uint256 value)
        public
        override
        onlyNotPaused
        onlyNotBlocked(spender)
        onlyNotBlocked(msg.sender)
        returns (bool)
    {
        return super.approve(spender, value);
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        public
        override
        onlyNotPaused
        onlyNotBlocked(owner)
        onlyNotBlocked(spender)
        onlyNotBlocked(msg.sender)
    {
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    // ---------------------------------------------------------------- ERC-8056

    function uiMultiplier() public view returns (uint256) {
        return (effectiveAt != 0 && block.timestamp >= effectiveAt) ? newUIMultiplier : _uiMultiplier;
    }

    function balanceOfUI(address account) external view returns (uint256) {
        return toUIAmount(balanceOf(account));
    }

    function totalSupplyUI() external view returns (uint256) {
        return toUIAmount(totalSupply());
    }

    function toUIAmount(uint256 rawAmount) public view returns (uint256) {
        return Math.mulDiv(rawAmount, uiMultiplier(), WAD);
    }

    function fromUIAmount(uint256 uiAmount) public view returns (uint256) {
        return Math.mulDiv(uiAmount, WAD, uiMultiplier());
    }

    /// @notice Schedule a corporate action. `effectiveAt_ == block.timestamp` applies it immediately.
    function scheduleUIMultiplier(uint256 multiplier_, uint256 effectiveAt_) external {
        _schedule(multiplier_, effectiveAt_);
    }

    /// @notice Shorthand for an immediate multiplier change.
    function setUIMultiplier(uint256 multiplier_) external {
        uint256 current = uiMultiplier();
        _uiMultiplier = multiplier_;
        newUIMultiplier = multiplier_;
        effectiveAt = 0;
        emit UIMultiplierUpdated(current, multiplier_, block.timestamp);
    }

    /// @dev EIP-draft only; the live token has no cancel path.
    function cancelUIMultiplierUpdate() external {
        require(block.timestamp < effectiveAt, "not pending");
        emit UIMultiplierUpdateCancelled(newUIMultiplier, effectiveAt);
        newUIMultiplier = _uiMultiplier;
        effectiveAt = 0;
    }

    function _schedule(uint256 multiplier_, uint256 effectiveAt_) internal {
        if (effectiveAt_ < block.timestamp) revert EffectiveInPast();
        uint256 current = uiMultiplier();
        _uiMultiplier = current; // settle any update that already took effect
        newUIMultiplier = multiplier_;
        effectiveAt = effectiveAt_;
        emit UIMultiplierUpdated(current, multiplier_, effectiveAt_);
    }

    // ---------------------------------------------------------------- Test knobs

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function setAllowlistEnabled(bool enabled) external {
        allowlistEnabled = enabled;
    }

    function setAllowed(address account, bool isAllowed_) external {
        allowed[account] = isAllowed_;
    }

    function setTransferFeeBps(uint256 bps) external {
        require(bps <= 10_000, "bps");
        transferFeeBps = bps;
    }

    // ---------------------------------------------------------------- IHolderAllowlist

    function isAllowed(address account) public view returns (bool) {
        return !allowlistEnabled || allowed[account];
    }

    // ---------------------------------------------------------------- Internals

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && !isAllowed(from)) revert NotAllowed(from);
        if (to != address(0) && !isAllowed(to)) revert NotAllowed(to);

        if (transferFeeBps != 0 && from != address(0) && to != address(0)) {
            uint256 fee = value * transferFeeBps / 10_000;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
        emit TransferWithScaledUI(from, to, value, toUIAmount(value));
    }
}
