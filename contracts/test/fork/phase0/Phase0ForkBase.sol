// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Robinhood Stock Token (verified source: Sourcify 4663/0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2, `Stock`).
interface IRobinhoodStock is IERC20 {
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
    function balanceOfUI(address) external view returns (uint256);
    function paused() external view returns (bool);
    function tokenPaused() external view returns (bool);
    function oraclePaused() external view returns (bool);
    function pause() external;
    function unpause() external;
    function pauseOracle() external;
    function updateMultiplier(uint256 newMultiplier, uint256 effectiveAt_) external;
    function adminBurn(address from, uint256 amount) external;
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
    function decimals() external view returns (uint8);
}

/// @notice Robinhood `AccessControlsRegistry` (Sourcify 4663/0xe10b6f6B275de231345c20D14Ab812db62151b00). It is also
/// the UpgradeableBeacon for every Stock Token.
interface IAccessControlsRegistry {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function isBlocked(address) external view returns (bool);
    function blockAccounts(address[] calldata) external;
    function unblockAccounts(address[] calldata) external;
    function pause() external;
    function paused() external view returns (bool);
    function implementation() external view returns (address);
}

/// @notice Shared setup for Phase 0 fork tests (docs/phase0/02-fork-validation.md).
/// @dev Every test skips cleanly when `ROBINHOOD_RPC_URL` is unset, so default CI stays offline. The fork is pinned to
/// `FORK_BLOCK`; `PHASE0_FORK_BLOCK` overrides it (0 = latest), because the public RPC is not an archive node and
/// only serves state for the last few thousand blocks. Read-only: nothing here broadcasts.
abstract contract Phase0ForkBase is Test {
    uint256 internal constant CHAIN_ID = 4663;
    /// @dev Pinned block for the recorded Phase 0 run (2026-09-26). Needs an archive RPC once it ages out.
    uint256 internal constant FORK_BLOCK = 73_213_529;

    // Tokens (docs.robinhood.com/chain/contracts + api.robinhood.com/rhj/assets, checked onchain).
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;

    // Morpho (docs.morpho.org addresses page, checked onchain).
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant ADAPTIVE_CURVE_IRM = 0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1;

    // Chainlink proxies (reference-data-directory feeds-robinhood-mainnet.json, checked onchain).
    address internal constant FEED_SPY = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address internal constant FEED_NVDA = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant FEED_AAPL = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;
    address internal constant FEED_USDG = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;

    // USDG holder used as a funding source (the Uniswap v3 NVDA/USDG 0.05% pool). USDG balances are share-based,
    // so `deal` is not used for USDG.
    address internal constant USDG_WHALE = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;

    // Issuer role holders, from RoleGranted events on the registry (re-asserted with hasRole in each test).
    address internal constant BLOCKER = 0x913cA87347391218e5De2C17c5A0AEba8B0b28fD;
    address internal constant TOKEN_PAUSER = 0xFCcF56B674113d9C4eb0F9B3370930ceD9E6Ab23;
    address internal constant GLOBAL_PAUSER = 0xe7BCB188254Bc6eBBfF63014DfED4cD4A024F22A;
    address internal constant ADMIN_BURNER = 0x957B6de6525C63349f7619743Ef1E0ad93cd74D4;
    address internal constant MULTIPLIER_UPDATER = 0x92905e8d0e2301BA143215B8D86D63fFD4188143;

    bytes32 internal constant BLOCKER_ROLE = keccak256("BLOCKER_ROLE");
    bytes32 internal constant TOKEN_PAUSER_ROLE = keccak256("TOKEN_PAUSER_ROLE");
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 internal constant ADMIN_BURNER_ROLE = keccak256("ADMIN_BURNER_ROLE");
    bytes32 internal constant MULTIPLIER_UPDATER_ROLE = keccak256("MULTIPLIER_UPDATER_ROLE");

    uint256 internal forkBlock;

    function setUp() public virtual {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 pinned = vm.envOr("PHASE0_FORK_BLOCK", FORK_BLOCK);
        if (pinned == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pinned);
        forkBlock = block.number;
        assertEq(block.chainid, CHAIN_ID, "not Robinhood Chain");
        emit log_named_uint("fork block", forkBlock);
        emit log_named_uint("fork timestamp", block.timestamp);
    }

    function _stocks() internal pure returns (address[3] memory) {
        return [SPY, NVDA, AAPL];
    }

    function _fundUsdg(address to, uint256 amount) internal {
        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(to, amount);
    }
}
