// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Phase0ForkBase} from "../phase0/Phase0ForkBase.sol";

/// @notice Shared setup for Phase 1 fork tests. Same pattern as Phase 0: every test skips cleanly when
/// `ROBINHOOD_RPC_URL` is unset. Phase 1 forks at **latest** by default because the public RPC is not an archive node;
/// `PHASE1_FORK_BLOCK=<n>` pins a block (needs an archive RPC). Nothing here broadcasts.
abstract contract Phase1ForkBase is Phase0ForkBase {
    function setUp() public virtual override {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 pinned = vm.envOr("PHASE1_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pinned);
        forkBlock = block.number;
        assertEq(block.chainid, CHAIN_ID, "not Robinhood Chain");
        emit log_named_uint("fork block", forkBlock);
        emit log_named_uint("fork timestamp", block.timestamp);
    }
}
