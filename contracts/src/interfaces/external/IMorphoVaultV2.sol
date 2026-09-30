// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @notice The subset of Morpho Vault V2 (`morpho-org/vault-v2` @ 2025-12-04, 425f6b1, the commit matching the
/// onchain factory) that Lendora calls. Signatures copied from `src/interfaces/IVaultV2.sol`; kept local so our code
/// never compiles Vault V2 sources (they build with their own via-IR profile, see foundry.toml).
interface IVaultV2Min {
    /// @notice Vault asset (wSTOCK).
    // ERC-4626 / ERC-20
    function asset() external view returns (address);
    /// @notice Share decimals.
    function decimals() external view returns (uint8);
    /// @notice Total assets (Vault V2 accounting).
    function totalAssets() external view returns (uint256);
    /// @notice Total shares.
    function totalSupply() external view returns (uint256);
    /// @notice Shares of an account.
    function balanceOf(address) external view returns (uint256);
    /// @notice Approve shares.
    function approve(address spender, uint256 shares) external returns (bool);
    /// @notice Transfer shares with allowance.
    function transferFrom(address from, address to, uint256 shares) external returns (bool);
    /// @notice Deposit assets for shares (ERC-4626).
    function deposit(uint256 assets, address onBehalf) external returns (uint256 shares);
    /// @notice Redeem shares for assets (ERC-4626).
    function redeem(uint256 shares, address receiver, address onBehalf) external returns (uint256 assets);
    /// @notice Withdraw assets (ERC-4626).
    function withdraw(uint256 assets, address receiver, address onBehalf) external returns (uint256 shares);
    /// @notice Assets for `shares` now.
    function previewRedeem(uint256 shares) external view returns (uint256);
    /// @notice Assets for `shares`.
    function convertToAssets(uint256 shares) external view returns (uint256);
    /// @notice EIP-2612 permit on shares.
    function permit(address owner, address spender, uint256 shares, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;

    /// @notice Vault owner (the timelock).
    // Roles and config
    function owner() external view returns (address);
    /// @notice Curator (multisig).
    function curator() external view returns (address);
    /// @notice Whether an account is a sentinel (the guardian).
    function isSentinel(address) external view returns (bool);
    /// @notice Whether an account is an allocator.
    function isAllocator(address) external view returns (bool);
    /// @notice Whether an address is an enabled adapter.
    function isAdapter(address) external view returns (bool);
    /// @notice Number of adapters.
    function adaptersLength() external view returns (uint256);
    /// @notice Liquidity adapter (none, A12).
    function liquidityAdapter() external view returns (address);
    /// @notice Allocation of a cap id.
    function allocation(bytes32 id) external view returns (uint256);
    /// @notice Absolute cap of a cap id.
    function absoluteCap(bytes32 id) external view returns (uint256);
    /// @notice Relative cap of a cap id (U_MAX).
    function relativeCap(bytes32 id) external view returns (uint256);
    /// @notice Timelock duration of a function selector.
    function timelock(bytes4 selector) external view returns (uint256);
    /// @notice Performance fee (WAD).
    function performanceFee() external view returns (uint96);
    /// @notice Performance fee recipient.
    function performanceFeeRecipient() external view returns (address);
    /// @notice Maximum interest rate distributed to shares.
    function maxRate() external view returns (uint64);
    /// @notice forceDeallocate penalty of an adapter (0, A12).
    function forceDeallocatePenalty(address adapter) external view returns (uint256);
    /// @notice Share name.
    function name() external view returns (string memory);
    /// @notice Share symbol.
    function symbol() external view returns (string memory);

    /// @notice Owner: set the owner.
    function setOwner(address newOwner) external;
    /// @notice Owner: set the curator.
    function setCurator(address newCurator) external;
    /// @notice Owner: add or remove a sentinel.
    function setIsSentinel(address account, bool newIsSentinel) external;
    /// @notice Owner: set the name.
    function setName(string memory newName) external;
    /// @notice Owner: set the symbol.
    function setSymbol(string memory newSymbol) external;
    /// @notice Curator: submit a timelocked call.
    function submit(bytes memory data) external;
    /// @notice Curator (timelocked): add or remove an allocator.
    function setIsAllocator(address account, bool newIsAllocator) external;
    /// @notice Curator (timelocked): add an adapter.
    function addAdapter(address account) external;
    /// @notice Curator (timelocked): raise a timelock.
    function increaseTimelock(bytes4 selector, uint256 newDuration) external;
    /// @notice Curator (timelocked): set the performance fee.
    function setPerformanceFee(uint256 newPerformanceFee) external;
    /// @notice Curator (timelocked): set the fee recipient.
    function setPerformanceFeeRecipient(address newPerformanceFeeRecipient) external;
    /// @notice Curator (timelocked): raise an absolute cap.
    function increaseAbsoluteCap(bytes memory idData, uint256 newAbsoluteCap) external;
    /// @notice Curator or sentinel, instant: lower an absolute cap.
    function decreaseAbsoluteCap(bytes memory idData, uint256 newAbsoluteCap) external;
    /// @notice Curator (timelocked): raise a relative cap.
    function increaseRelativeCap(bytes memory idData, uint256 newRelativeCap) external;

    /// @notice Allocator: move idle assets into an adapter (LM-R30).
    // Allocator / sentinel
    function allocate(address adapter, bytes memory data, uint256 assets) external;
    /// @notice Allocator or sentinel: move assets back to idle (LM-R31).
    function deallocate(address adapter, bytes memory data, uint256 assets) external;
    /// @notice Allocator: set the max rate.
    function setMaxRate(uint256 newMaxRate) external;
    /// @notice Accrue interest into totalAssets.
    function accrueInterest() external;
    /// @notice Anyone: deallocate for a withdrawal, paying the penalty in shares (LM-R22).
    function forceDeallocate(address adapter, bytes memory data, uint256 assets, address onBehalf)
        external
        returns (uint256 penaltyShares);

    /// @notice Curator (timelocked): remove an adapter.
    // Selectors used for timelocks (not called directly)
    function removeAdapter(address account) external;
    /// @notice Curator (timelocked): give up a function forever.
    function abdicate(bytes4 selector) external;
    /// @notice Curator (timelocked): set the management fee.
    function setManagementFee(uint256 newManagementFee) external;
    /// @notice Curator (timelocked): set the management fee recipient.
    function setManagementFeeRecipient(address newManagementFeeRecipient) external;
    /// @notice Curator (timelocked): set the forceDeallocate penalty.
    function setForceDeallocatePenalty(address adapter, uint256 newForceDeallocatePenalty) external;
    /// @notice Curator (timelocked): set the receive-shares gate.
    function setReceiveSharesGate(address newReceiveSharesGate) external;
    /// @notice Curator (timelocked): set the send-shares gate.
    function setSendSharesGate(address newSendSharesGate) external;
    /// @notice Curator (timelocked): set the receive-assets gate.
    function setReceiveAssetsGate(address newReceiveAssetsGate) external;
    /// @notice Curator (timelocked): set the send-assets gate.
    function setSendAssetsGate(address newSendAssetsGate) external;
    /// @notice Curator (timelocked): set the adapter registry.
    function setAdapterRegistry(address newAdapterRegistry) external;
}

/// @notice `VaultV2Factory` (official: 0x0FBad98595b0186dA120E41f77C102beb49f803c on chain 4663).
interface IVaultV2FactoryMin {
    /// @notice Whether the factory created `account`.
    function isVaultV2(address account) external view returns (bool);
    /// @notice Create a Vault V2.
    function createVaultV2(address owner, address asset, bytes32 salt) external returns (address);
}

/// @notice `MorphoMarketV1AdapterV2` (subset). `MarketParams` is passed ABI-encoded as bytes where Vault V2 expects it.
interface IMorphoMarketV1AdapterV2Min {
    /// @notice The vault this adapter serves.
    function parentVault() external view returns (address);
    /// @notice Morpho Blue.
    function morpho() external view returns (address);
    /// @notice The adapter cap id.
    function adapterId() external view returns (bytes32);
    /// @notice Assets the adapter holds in Morpho.
    function realAssets() external view returns (uint256);
    /// @notice Morpho supply shares in a market.
    function supplyShares(bytes32 marketId) external view returns (uint256);
    /// @notice Supply assets in a market including accrued interest.
    function expectedSupplyAssets(bytes32 marketId) external view returns (uint256);
    /// @notice Timelock duration of a function selector.
    function timelock(bytes4 selector) external view returns (uint256);
    /// @notice Curator: submit a timelocked call.
    function submit(bytes memory data) external;
    /// @notice Curator (timelocked): raise a timelock.
    function increaseTimelock(bytes4 selector, uint256 newDuration) external;
    /// @notice Set the skim recipient.
    function setSkimRecipient(address newSkimRecipient) external;
    /// @notice Burn supply shares of a market (after a loss).
    function burnShares(bytes32 marketId) external;
    /// @notice Curator (timelocked): give up a function forever.
    function abdicate(bytes4 selector) external;
}

/// @notice `MorphoMarketV1AdapterV2Factory` (official: 0x79370Ed003CE325C088E530d5e8655c99c2993e1 on chain 4663).
interface IMorphoMarketV1AdapterV2FactoryMin {
    /// @notice Morpho Blue.
    function morpho() external view returns (address);
    /// @notice The AdaptiveCurveIrm.
    function adaptiveCurveIrm() external view returns (address);
    /// @notice The adapter of a vault, if created.
    function morphoMarketV1AdapterV2(address parentVault) external view returns (address);
    /// @notice Create the adapter for a vault.
    function createMorphoMarketV1AdapterV2(address parentVault) external returns (address);
}
