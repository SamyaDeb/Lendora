// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {IMorpho, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {IMorphoLiquidateCallback} from "morpho-blue/src/interfaces/IMorphoCallbacks.sol";
import {IStockWrapper} from "./interfaces/IStockWrapper.sol";
import {ICollateralToken} from "./interfaces/ICollateralToken.sol";

/// @title LendoraLiquidator
/// @notice Fallback liquidator for Lendora stock-loan markets (docs/prd/02-architecture.md, 03 LM-R12). One
/// transaction through Morpho's liquidation callback: seize `clUSDG` → unwrap to USDG → buy the Stock Token through
/// an
/// allowlisted target → wrap → repay. Works for any borrower's position, opened through the router or not.
/// @dev Holds nothing after a call: leftovers (USDG profit, excess stock) go to the caller's `recipient`, approvals
/// are exact and reset. Permissionless to call (it holds no funds); the owner only manages the swap-target allowlist.
contract LendoraLiquidator is IMorphoLiquidateCallback, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using TransientSlot for *;

    enum SwapMode {
        None,
        Approve,
        Transfer
    }

    struct Swap {
        address target;
        bytes data;
        uint256 amountIn; // USDG handed to the target (exact input)
        uint256 minOut; // minimum Stock Token received (slippage guard)
    }

    struct Liquidation {
        MarketParams market; // loanToken = wrapper, collateralToken = clUSDG
        address borrower;
        uint256 seizedAssets; // exactly one of seizedAssets / repaidShares is non-zero (Morpho semantics)
        uint256 repaidShares;
        Swap swap;
        uint256 minProfit; // minimum USDG left after repaying (profit guard)
        address recipient;
        uint256 deadline;
    }

    /// @notice Morpho Blue.
    IMorpho public immutable MORPHO;
    /// @notice The collateral token unwrapped in the callback.
    ICollateralToken public immutable CL_USDG;
    /// @notice clUSDG's backing asset, sold for the Stock Token.
    IERC20 public immutable USDG;

    mapping(address target => SwapMode) public swapModes;

    /// @dev Set only while this contract's own `liquidate` is running (callback authentication).
    Swap private _pending;
    bytes32 private constant IN_LIQUIDATION = keccak256("stockline.liquidator.inLiquidation");

    event Liquidated(
        address indexed borrower,
        bytes32 indexed marketId,
        uint256 seized,
        uint256 repaid,
        uint256 profit,
        address recipient
    );
    event SwapTargetSet(address indexed target, SwapMode mode);

    error Expired();
    error NotMorpho();
    error SwapTargetNotAllowed(address target);
    error InsufficientOutput(uint256 out, uint256 minOut);
    error InsufficientProfit(uint256 profit, uint256 minProfit);
    error BadMarket();
    error ZeroAddress();

    constructor(address morpho, address clUsdg, address owner_) Ownable(owner_) {
        if (morpho == address(0) || clUsdg == address(0)) revert ZeroAddress();
        MORPHO = IMorpho(morpho);
        CL_USDG = ICollateralToken(clUsdg);
        USDG = IERC20(ICollateralToken(clUsdg).backing());
    }

    /// @notice Owner: allowlist a swap target and how it is paid (`SwapMode`); `None` removes it.
    function setSwapTarget(address target, SwapMode mode) external onlyOwner {
        if (target == address(0) || target == address(MORPHO) || target == address(CL_USDG)) revert ZeroAddress();
        swapModes[target] = mode;
        emit SwapTargetSet(target, mode);
    }

    /// @notice Liquidate `l.borrower` and send every leftover to `l.recipient`.
    function liquidate(Liquidation calldata l)
        external
        nonReentrant
        returns (uint256 seized, uint256 repaid, uint256 profit)
    {
        if (block.timestamp > l.deadline) revert Expired();
        if (l.market.collateralToken != address(CL_USDG)) revert BadMarket();
        if (l.recipient == address(0)) revert ZeroAddress();
        if (swapModes[l.swap.target] == SwapMode.None) revert SwapTargetNotAllowed(l.swap.target);
        _pending = l.swap;
        IN_LIQUIDATION.asBoolean().tstore(true);
        (seized, repaid) = MORPHO.liquidate(l.market, l.borrower, l.seizedAssets, l.repaidShares, abi.encode(l.market));
        IN_LIQUIDATION.asBoolean().tstore(false);
        delete _pending;

        IERC20 wrapper = IERC20(l.market.loanToken);
        uint256 excess = wrapper.balanceOf(address(this));
        // slither-disable-next-line unused-return
        if (excess > 0) IStockWrapper(address(wrapper)).unwrap(excess, l.recipient);
        profit = USDG.balanceOf(address(this));
        if (profit < l.minProfit) revert InsufficientProfit(profit, l.minProfit);
        if (profit > 0) USDG.safeTransfer(l.recipient, profit);
        emit Liquidated(l.borrower, keccak256(abi.encode(l.market)), seized, repaid, profit, l.recipient);
    }

    // The swap is measured by the balance delta across the external call on purpose (return data is never trusted);
    // the target is owner-allowlisted, `liquidate` is nonReentrant and this callback only runs for Morpho during our
    // own liquidation, so re-entry can only add stock to the delta. Wrapper/clUSDG calls return their input or revert.
    // Triaged in slither.config.json.
    // slither-disable-start reentrancy-balance,unused-return
    /// @inheritdoc IMorphoLiquidateCallback
    /// @dev Called by Morpho after it sent the seized `clUSDG` and before it pulls `repaidAssets` of the wrapper.
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        if (msg.sender != address(MORPHO) || !IN_LIQUIDATION.asBoolean().tload()) revert NotMorpho();
        MarketParams memory m = abi.decode(data, (MarketParams));
        IStockWrapper wrapper = IStockWrapper(m.loanToken);
        IERC20 stock = IERC20(wrapper.underlying());

        uint256 seized = IERC20(address(CL_USDG)).balanceOf(address(this));
        if (seized > 0) CL_USDG.unwrap(seized, address(this));

        Swap memory s = _pending;
        uint256 before = stock.balanceOf(address(this));
        SwapMode mode = swapModes[s.target];
        if (mode == SwapMode.Approve) USDG.forceApprove(s.target, s.amountIn);
        else USDG.safeTransfer(s.target, s.amountIn);
        (bool ok, bytes memory ret) = s.target.call(s.data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        if (mode == SwapMode.Approve) USDG.forceApprove(s.target, 0);
        uint256 bought = stock.balanceOf(address(this)) - before;
        if (bought < s.minOut) revert InsufficientOutput(bought, s.minOut);

        stock.forceApprove(address(wrapper), bought);
        wrapper.wrap(bought, address(this));
        IERC20(address(wrapper)).forceApprove(address(MORPHO), repaidAssets);
    }
    // slither-disable-end reentrancy-balance,unused-return
}
