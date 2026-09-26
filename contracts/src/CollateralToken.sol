// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICollateralToken} from "./interfaces/ICollateralToken.sol";

/// @title CollateralToken (`clUSDG`)
/// @notice Gated borrower collateral (docs/prd/05-collateral-router.md §2): wraps exactly one backing asset 1:1
/// (CL-R1). Only the router mints (CL-R2), so new collateral enters through the router's guard, cap and attestation
/// checks. Anyone holding it can `unwrap` at any time (CL-R2, CL-R5), so liquidators are never blocked. Transfers are
/// allowed only to or from Morpho Blue or the router (CL-R3), which stops secondary trading around the router.
/// @dev v1 backs with USDG and `valuePerToken()` is 1.0. A different backing (e.g. an ERC-4626 USDG vault share) is a
/// new deployment of a subclass that overrides `valuePerToken()` with a manipulation-resistant rate (CL-R7); there is
/// no upgrade path. No admin can seize, freeze or pause (CL-R5): the only privileged step is the deployer setting the
/// router once. Paxos can still freeze or wipe the backing held here at the USDG level (verified Phase 0, 01 §5),
/// which this contract cannot prevent; see test/fork/phase1/CollateralTokenFreeze.fork.t.sol.
contract CollateralToken is ERC20, ICollateralToken {
    using SafeERC20 for IERC20;

    IERC20 internal immutable _backing;
    address internal immutable _morpho;
    address internal immutable _deployer;
    uint8 internal immutable _decimals;
    address internal _router;

    /// @param backing_ The backing asset (USDG).
    /// @param morpho_ Morpho Blue, the only market venue this token may move to or from.
    constructor(address backing_, address morpho_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        if (backing_ == address(0) || morpho_ == address(0)) revert ZeroAddress();
        _backing = IERC20(backing_);
        _morpho = morpho_;
        _deployer = msg.sender;
        _decimals = IERC20Metadata(backing_).decimals();
    }

    /// @notice One-time wiring of the router (the router is a proxy whose address never changes, RT-R7).
    function setRouter(address router_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (_router != address(0)) revert RouterAlreadySet();
        if (router_ == address(0)) revert ZeroAddress();
        _router = router_;
        emit RouterSet(router_);
    }

    function decimals() public view override(ERC20, IERC20Metadata) returns (uint8) {
        return _decimals;
    }

    function backing() external view returns (address) {
        return address(_backing);
    }

    function morpho() external view returns (address) {
        return _morpho;
    }

    function router() external view returns (address) {
        return _router;
    }

    /// @inheritdoc ICollateralToken
    function valuePerToken() public view virtual returns (uint256) {
        return 1e18;
    }

    /// @inheritdoc ICollateralToken
    /// @dev Reverts unless exactly `amount` backing arrives, so CL-R6 cannot be broken by a fee or rebase.
    function mint(address to, uint256 amount) external {
        if (msg.sender != _router || _router == address(0)) revert NotRouter();
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        uint256 before = _backing.balanceOf(address(this));
        _backing.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = _backing.balanceOf(address(this)) - before;
        if (received != amount) revert UnexpectedTransferAmount(amount, received);
        _mint(to, amount);
        emit Minted(to, amount);
    }

    /// @inheritdoc ICollateralToken
    function unwrap(uint256 amount, address to) external returns (uint256) {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        _burn(msg.sender, amount);
        _backing.safeTransfer(to, amount);
        emit Unwrapped(msg.sender, to, amount);
        return amount;
    }

    /// @dev CL-R3: a transfer (not a mint or burn) must have Morpho or the router on one side.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            address r = _router;
            if (from != _morpho && to != _morpho && (r == address(0) || (from != r && to != r))) {
                revert TransferNotAllowed(from, to);
            }
        }
        super._update(from, to, value);
    }
}
