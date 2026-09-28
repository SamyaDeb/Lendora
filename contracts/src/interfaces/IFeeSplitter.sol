// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title Stockline fee splitter surface (docs/prd/09-backstop-fees.md FE-R2, FE-R3).
interface IFeeSplitter {
    struct Recipient {
        address account;
        uint16 bps; // weight in basis points; all weights sum to 10,000
    }

    event RecipientsSet(Recipient[] recipients);
    event Distributed(address indexed token, uint256 amount);
    event Paid(address indexed token, address indexed account, uint256 amount);

    error ZeroAddress();
    error ZeroWeight(uint256 index);
    error DuplicateRecipient(address account);
    error BadWeightSum(uint256 sum);
    error BadRecipientCount(uint256 count);

    /// @notice Sum every weight must reach (FE-R2).
    function TOTAL_BPS() external view returns (uint256);
    /// @notice Largest number of recipients.
    function MAX_RECIPIENTS() external view returns (uint256);
    /// @notice Current recipients and weights, in payout order.
    function recipients() external view returns (Recipient[] memory);
    /// @notice Owner (timelock): replace every recipient and weight (FE-R2).
    function setRecipients(Recipient[] calldata newRecipients) external;
    /// @notice Permissionless: split this contract's whole balance of `token` by weight (FE-R2).
    function distribute(address token) external returns (uint256 amount);
    /// @notice What `distribute(token)` would pay each recipient now, in `recipients()` order.
    function previewDistribute(address token) external view returns (uint256[] memory amounts);
}
