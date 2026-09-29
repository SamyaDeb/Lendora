// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {DeployMainnet} from "./DeployMainnet.s.sol";

/// @notice The launcher's `--dry-run` (Part D): the exact `DeployMainnet` deployment on a **local anvil fork of 4663**,
/// without the owner's go. It refuses any node that is not anvil (asked over RPC, so a real 4663 endpoint is refused
/// even with a `--broadcast`), refuses to run when `I_HAVE_THE_OWNERS_GO` is set (a real launch uses `DeployMainnet`),
/// and writes `deployments/<LAUNCH_OUT>.json` (default `4663-dry-run`), never `deployments/4663.json`.
///
///   LAUNCH_DRY_RUN=1 LAUNCH_OUT=4663-dry-run forge script script/DeployMainnetDryRun.s.sol \
///     --rpc-url http://127.0.0.1:<anvil fork of 4663> --broadcast --unlocked --sender <deployer>
contract DeployMainnetDryRun is DeployMainnet {
    /// @dev Entry: `--sig "runDryRun()"` (plain `run()` is `DeployMainnet.run`, which still needs the owner's go).
    function runDryRun() external {
        string memory out = vm.envOr("LAUNCH_OUT", string("4663-dry-run"));
        refuseUnlessAnvilDryRun(
            block.chainid,
            string(vm.rpc("web3_clientVersion", "[]")),
            vm.envOr("LAUNCH_DRY_RUN", string("")),
            vm.envOr("I_HAVE_THE_OWNERS_GO", string("")),
            out
        );
        _launch(msg.sender, out);
    }

    /// @notice The dry run's entry rules. Public so tests can prove every refusal.
    function refuseUnlessAnvilDryRun(
        uint256 chainId,
        string memory clientVersion,
        string memory dryRun,
        string memory go,
        string memory out
    ) public pure {
        require(chainId == 4663, "DeployMainnetDryRun: an anvil fork of 4663 only");
        require(_contains(clientVersion, "anvil"), "DeployMainnetDryRun: the node is not anvil (a real 4663 RPC?)");
        require(keccak256(bytes(dryRun)) == keccak256("1"), "DeployMainnetDryRun: set LAUNCH_DRY_RUN=1");
        require(
            bytes(go).length == 0, "DeployMainnetDryRun: I_HAVE_THE_OWNERS_GO is set; a real launch uses DeployMainnet"
        );
        require(keccak256(bytes(out)) != keccak256("4663"), "DeployMainnetDryRun: LAUNCH_OUT=4663 is the real output");
    }

    function _contains(string memory s, string memory sub) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(sub);
        if (b.length > a.length) return false;
        for (uint256 i; i + b.length <= a.length; i++) {
            bool ok = true;
            for (uint256 k; k < b.length && ok; k++) {
                // case-insensitive ASCII
                bytes1 x = a[i + k];
                if (x >= 0x41 && x <= 0x5A) x = bytes1(uint8(x) + 32);
                ok = x == b[k];
            }
            if (ok) return true;
        }
        return false;
    }
}
