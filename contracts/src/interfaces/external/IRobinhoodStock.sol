// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Robinhood Stock Token surface Stockline reads (Sourcify 4663/0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2,
/// `src/Stock.sol`, `src/OraclePausable.sol`). Signatures copied from the verified source.
interface IRobinhoodStock {
    /// @notice Per-token pause OR the registry's global pause.
    function paused() external view returns (bool);
    /// @notice Per-token pause flag only.
    function tokenPaused() external view returns (bool);
    /// @notice Advisory flag set around corporate actions; Chainlink holds the last value while it is set (D4).
    function oraclePaused() external view returns (bool);
    /// @notice The issuer registry holding the blocklist and global pause.
    // slither-disable-next-line naming-convention
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
}

/// @notice Robinhood `AccessControlsRegistry` (Sourcify 4663/0xe10b6f6B275de231345c20D14Ab812db62151b00): roles,
/// blocklist and global pause for every Stock Token.
interface IAccessControlsRegistry {
    /// @notice Whether `account` is on the issuer blocklist.
    function isBlocked(address account) external view returns (bool);
    /// @notice Global pause flag.
    function paused() external view returns (bool);
}
