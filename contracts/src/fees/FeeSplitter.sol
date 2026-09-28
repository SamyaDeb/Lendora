// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IFeeSplitter} from "../interfaces/IFeeSplitter.sol";

/// @title FeeSplitter
/// @notice Receives the `rSTOCK` vaults' 10% performance fee (FE-R1: Vault V2 `performanceFeeRecipient`) and splits
/// any ERC-20 it holds between fixed recipients by weight (FE-R2). Until the Phase 5 `BackstopPool` exists, the
/// backstop share goes to a segregated `BackstopReserve` multisig, directly or through its `FeeConverter` (FE-R3).
/// @dev The owner is the timelock (48h on mainnet): recipients and weights change only through it. No upgrade path.
/// Rounding: recipient `i` gets `floor(bal·cum_i / 10⁴) − floor(bal·cum_{i−1} / 10⁴)` where `cum_i` is the
/// running
/// weight sum, so the payouts add up to the whole balance (it ends at 0) and each is within 1 wei of its exact share;
/// the last recipient takes the final rounding step (A32). A recipient whose transfer reverts makes the whole
/// `distribute` revert (nothing is paid, the balance stays for the next call); the owner replaces that recipient.
contract FeeSplitter is IFeeSplitter, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @inheritdoc IFeeSplitter
    uint256 public constant TOTAL_BPS = 10_000;
    /// @inheritdoc IFeeSplitter
    uint256 public constant MAX_RECIPIENTS = 8;

    Recipient[] internal _recipients;

    /// @param owner_ The timelock.
    /// @param initial Recipients and weights (FE-R2: sum 10,000).
    constructor(address owner_, Recipient[] memory initial) Ownable(owner_) {
        _setRecipients(initial);
    }

    /// @inheritdoc IFeeSplitter
    function recipients() external view returns (Recipient[] memory) {
        return _recipients;
    }

    /// @inheritdoc IFeeSplitter
    function setRecipients(Recipient[] calldata newRecipients) external onlyOwner {
        _setRecipients(newRecipients);
    }

    /// @inheritdoc IFeeSplitter
    /// @dev FE-R2. Zero balance is a no-op (no event). Reverts if any recipient's transfer reverts (revert-all).
    function distribute(address token) external nonReentrant returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        // Zero balance is a no-op; a donation can only make it non-zero (triaged in slither.config.json).
        // slither-disable-next-line incorrect-equality
        if (amount == 0) return 0;
        uint256[] memory amounts = _split(amount);
        emit Distributed(token, amount);
        for (uint256 i; i < amounts.length; i++) {
            if (amounts[i] > 0) {
                address account = _recipients[i].account;
                IERC20(token).safeTransfer(account, amounts[i]);
                emit Paid(token, account, amounts[i]);
            }
        }
    }

    /// @inheritdoc IFeeSplitter
    function previewDistribute(address token) external view returns (uint256[] memory) {
        return _split(IERC20(token).balanceOf(address(this)));
    }

    function _split(uint256 amount) internal view returns (uint256[] memory amounts) {
        uint256 n = _recipients.length;
        amounts = new uint256[](n);
        uint256 cum = 0;
        uint256 paid = 0;
        for (uint256 i; i < n; i++) {
            cum += _recipients[i].bps;
            uint256 upTo = Math.mulDiv(amount, cum, TOTAL_BPS);
            amounts[i] = upTo - paid;
            paid = upTo;
        }
    }

    /// @dev FE-R2: 1..MAX_RECIPIENTS distinct non-zero accounts, non-zero weights, sum exactly TOTAL_BPS.
    function _setRecipients(Recipient[] memory rs) internal {
        uint256 n = rs.length;
        if (n == 0 || n > MAX_RECIPIENTS) revert BadRecipientCount(n);
        uint256 sum = 0;
        for (uint256 i; i < n; i++) {
            if (rs[i].account == address(0)) revert ZeroAddress();
            if (rs[i].bps == 0) revert ZeroWeight(i);
            for (uint256 j; j < i; j++) {
                if (rs[j].account == rs[i].account) revert DuplicateRecipient(rs[i].account);
            }
            sum += rs[i].bps;
        }
        if (sum != TOTAL_BPS) revert BadWeightSum(sum);
        delete _recipients;
        for (uint256 i; i < n; i++) {
            _recipients.push(rs[i]);
        }
        emit RecipientsSet(rs);
    }
}
