// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IScaledUIAmount} from "../../src/interfaces/external/IScaledUIAmount.sol";
import {IHolderAllowlist} from "../../src/interfaces/IHolderAllowlist.sol";

/// @notice Test Stock Token: raw-balance ERC-20 with an ERC-8056 multiplier and knobs for behaviour Phase 0 has not
/// yet ruled out (issuer allowlist, fee-on-transfer). Mint/burn and all setters are open: test use only.
contract MockStockToken is ERC20, IScaledUIAmount, IHolderAllowlist {
    uint256 internal constant WAD = 1e18;

    uint8 internal immutable _decimals;

    uint256 internal _uiMultiplier = WAD;
    uint256 public newUIMultiplier = WAD;
    uint256 public effectiveAt;

    bool public allowlistEnabled;
    mapping(address => bool) public allowed;

    /// @notice Skim taken from every non-mint/burn transfer, in basis points. Real Stock Tokens have none (A2).
    uint256 public transferFeeBps;

    error NotAllowed(address account);
    error EffectiveInPast();

    event TransferWithUIAmount(address indexed from, address indexed to, uint256 amount, uint256 uiAmount);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
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
        if (effectiveAt_ < block.timestamp) revert EffectiveInPast();
        uint256 current = uiMultiplier();
        _uiMultiplier = current; // settle any update that already took effect
        newUIMultiplier = multiplier_;
        effectiveAt = effectiveAt_;
        emit UIMultiplierUpdated(current, multiplier_, effectiveAt_);
    }

    /// @notice Shorthand for an immediate multiplier change.
    function setUIMultiplier(uint256 multiplier_) external {
        uint256 current = uiMultiplier();
        _uiMultiplier = multiplier_;
        newUIMultiplier = multiplier_;
        effectiveAt = 0;
        emit UIMultiplierUpdated(current, multiplier_, block.timestamp);
    }

    function cancelUIMultiplierUpdate() external {
        require(block.timestamp < effectiveAt, "not pending");
        emit UIMultiplierUpdateCancelled(newUIMultiplier, effectiveAt);
        newUIMultiplier = _uiMultiplier;
        effectiveAt = 0;
    }

    // ---------------------------------------------------------------- Test knobs

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    /// @notice Live signature (`Stock.adminBurn`): burns from any address with no pause or blocklist check (D10 R1).
    function adminBurn(address from, uint256 amount) external {
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
        if (from != address(0) && to != address(0)) emit TransferWithUIAmount(from, to, value, toUIAmount(value));
    }
}
