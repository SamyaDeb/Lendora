// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @notice The subset of Morpho Vault V2 (`morpho-org/vault-v2` @ 2025-12-04, 425f6b1, the commit matching the
/// onchain factory) that Stockline calls. Signatures copied from `src/interfaces/IVaultV2.sol`; kept local so our code
/// never compiles Vault V2 sources (they build with their own via-IR profile, see foundry.toml).
interface IVaultV2Min {
    // ERC-4626 / ERC-20
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
    function totalAssets() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address spender, uint256 shares) external returns (bool);
    function transferFrom(address from, address to, uint256 shares) external returns (bool);
    function deposit(uint256 assets, address onBehalf) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address onBehalf) external returns (uint256 assets);
    function withdraw(uint256 assets, address receiver, address onBehalf) external returns (uint256 shares);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function permit(address owner, address spender, uint256 shares, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;

    // Roles and config
    function owner() external view returns (address);
    function curator() external view returns (address);
    function isSentinel(address) external view returns (bool);
    function isAllocator(address) external view returns (bool);
    function isAdapter(address) external view returns (bool);
    function adaptersLength() external view returns (uint256);
    function liquidityAdapter() external view returns (address);
    function allocation(bytes32 id) external view returns (uint256);
    function absoluteCap(bytes32 id) external view returns (uint256);
    function relativeCap(bytes32 id) external view returns (uint256);
    function timelock(bytes4 selector) external view returns (uint256);
    function performanceFee() external view returns (uint96);
    function performanceFeeRecipient() external view returns (address);
    function maxRate() external view returns (uint64);
    function forceDeallocatePenalty(address adapter) external view returns (uint256);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);

    function setOwner(address newOwner) external;
    function setCurator(address newCurator) external;
    function setIsSentinel(address account, bool newIsSentinel) external;
    function setName(string memory newName) external;
    function setSymbol(string memory newSymbol) external;
    function submit(bytes memory data) external;
    function setIsAllocator(address account, bool newIsAllocator) external;
    function addAdapter(address account) external;
    function increaseTimelock(bytes4 selector, uint256 newDuration) external;
    function setPerformanceFee(uint256 newPerformanceFee) external;
    function setPerformanceFeeRecipient(address newPerformanceFeeRecipient) external;
    function increaseAbsoluteCap(bytes memory idData, uint256 newAbsoluteCap) external;
    function decreaseAbsoluteCap(bytes memory idData, uint256 newAbsoluteCap) external;
    function increaseRelativeCap(bytes memory idData, uint256 newRelativeCap) external;

    // Allocator / sentinel
    function allocate(address adapter, bytes memory data, uint256 assets) external;
    function deallocate(address adapter, bytes memory data, uint256 assets) external;
    function setMaxRate(uint256 newMaxRate) external;
    function accrueInterest() external;
    function forceDeallocate(address adapter, bytes memory data, uint256 assets, address onBehalf)
        external
        returns (uint256 penaltyShares);

    // Selectors used for timelocks (not called directly)
    function removeAdapter(address account) external;
    function abdicate(bytes4 selector) external;
    function setManagementFee(uint256 newManagementFee) external;
    function setManagementFeeRecipient(address newManagementFeeRecipient) external;
    function setForceDeallocatePenalty(address adapter, uint256 newForceDeallocatePenalty) external;
    function setReceiveSharesGate(address newReceiveSharesGate) external;
    function setSendSharesGate(address newSendSharesGate) external;
    function setReceiveAssetsGate(address newReceiveAssetsGate) external;
    function setSendAssetsGate(address newSendAssetsGate) external;
    function setAdapterRegistry(address newAdapterRegistry) external;
}

/// @notice `VaultV2Factory` (official: 0x0FBad98595b0186dA120E41f77C102beb49f803c on chain 4663).
interface IVaultV2FactoryMin {
    function isVaultV2(address account) external view returns (bool);
    function createVaultV2(address owner, address asset, bytes32 salt) external returns (address);
}

/// @notice `MorphoMarketV1AdapterV2` (subset). `MarketParams` is passed ABI-encoded as bytes where Vault V2 expects it.
interface IMorphoMarketV1AdapterV2Min {
    function parentVault() external view returns (address);
    function morpho() external view returns (address);
    function adapterId() external view returns (bytes32);
    function realAssets() external view returns (uint256);
    function supplyShares(bytes32 marketId) external view returns (uint256);
    function expectedSupplyAssets(bytes32 marketId) external view returns (uint256);
    function timelock(bytes4 selector) external view returns (uint256);
    function submit(bytes memory data) external;
    function increaseTimelock(bytes4 selector, uint256 newDuration) external;
    function setSkimRecipient(address newSkimRecipient) external;
    function burnShares(bytes32 marketId) external;
    function abdicate(bytes4 selector) external;
}

/// @notice `MorphoMarketV1AdapterV2Factory` (official: 0x79370Ed003CE325C088E530d5e8655c99c2993e1 on chain 4663).
interface IMorphoMarketV1AdapterV2FactoryMin {
    function morpho() external view returns (address);
    function adaptiveCurveIrm() external view returns (address);
    function morphoMarketV1AdapterV2(address parentVault) external view returns (address);
    function createMorphoMarketV1AdapterV2(address parentVault) external returns (address);
}
