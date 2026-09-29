// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployMainnetDryRun} from "../../script/DeployMainnetDryRun.s.sol";

/// @notice Part D: the launcher's dry-run entry refuses everything but a gated anvil fork of 4663 without the go.
contract DeployMainnetDryRunTest is Test {
    DeployMainnetDryRun internal s = new DeployMainnetDryRun();
    string internal constant ANVIL = '"anvil/v1.5.1"';

    function test_MN_R4_dryRunRefusesARealNodeTheGoAndTheRealOutput() public {
        s.refuseUnlessAnvilDryRun(4663, ANVIL, "1", "", "4663-dry-run"); // the only accepted shape
        vm.expectRevert(bytes("DeployMainnetDryRun: an anvil fork of 4663 only"));
        s.refuseUnlessAnvilDryRun(46_630, ANVIL, "1", "", "4663-dry-run");
        vm.expectRevert(bytes("DeployMainnetDryRun: the node is not anvil (a real 4663 RPC?)"));
        s.refuseUnlessAnvilDryRun(4663, '"Nitro/v3.7.0-stable"', "1", "", "4663-dry-run");
        vm.expectRevert(bytes("DeployMainnetDryRun: set LAUNCH_DRY_RUN=1"));
        s.refuseUnlessAnvilDryRun(4663, ANVIL, "", "", "4663-dry-run");
        vm.expectRevert(bytes("DeployMainnetDryRun: I_HAVE_THE_OWNERS_GO is set; a real launch uses DeployMainnet"));
        s.refuseUnlessAnvilDryRun(4663, ANVIL, "1", "1", "4663-dry-run");
        vm.expectRevert(bytes("DeployMainnetDryRun: LAUNCH_OUT=4663 is the real output"));
        s.refuseUnlessAnvilDryRun(4663, ANVIL, "1", "", "4663");
        s.refuseUnlessAnvilDryRun(4663, '"Anvil/v1.5.1"', "1", "", "x"); // case-insensitive
    }

    function test_MN_R4_plainRunIsStillDeployMainnetAndNeedsTheGo() public {
        vm.chainId(4663);
        vm.expectRevert(
            bytes("MN-R4: DeployMainnet refuses chain 4663 without I_HAVE_THE_OWNERS_GO=1 (the owner's go, launch log)")
        );
        s.run();
    }
}
