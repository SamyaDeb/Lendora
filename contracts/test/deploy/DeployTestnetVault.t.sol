// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployTestnetVault} from "../../script/DeployTestnetVault.s.sol";
import {DnVaultDeploy} from "../../script/DnVaultDeploy.sol";

/// @notice Part C rehearsal finding (Phase 4): `DeployTestnetVault` read the fee recipient from
/// `roles.treasury`, which the 46630 book never had, so the script could not run on the real testnet entry. The DN fee
/// goes to the `FeeSplitter` (DN-R9): from the book once `DeployTestnetFees` ran live, from the fork rehearsal's output
/// on a fork, otherwise refused.
contract DeployTestnetVaultTest is Test {
    DeployTestnetVault internal s;
    string internal book;
    address internal constant DEPLOYER = 0x3394d7Be60302c9649c6E5A3c7fC7b989f521348;

    function setUp() public {
        s = new DeployTestnetVault();
        book = vm.readFile("../packages/sdk/addresses.json");
    }

    function test_DN_R9_testnetFeeRecipientIsTheFeeSplitterOrRefused() public {
        // The committed 46630 entry predates the fee contracts: live, this must stop, not pick a placeholder.
        vm.expectRevert(
            bytes("DeployTestnetVault: no FeeSplitter in the address book: run DeployTestnetFees first (DN-R9)")
        );
        s.feeRecipient(book, false);
        // After a live DeployTestnetFees the book carries it.
        address splitter = makeAddr("splitter");
        string memory withFees = vm.serializeAddress("b", "feeSplitter", splitter);
        withFees = string.concat('{"chains":{"46630":', withFees, "}}");
        assertEq(s.feeRecipient(withFees, false), splitter);
    }

    function test_Q11_testnetDnConfigHasCapsZeroAndTheMockVenue() public {
        address splitter = makeAddr("splitter");
        (DnVaultDeploy.DnConfig memory c, DnVaultDeploy.DnSleeveConfig[] memory sl) =
            s.configFromBook(book, DEPLOYER, splitter, s.testnetCap(0)); // the default: no owner cap
        assertEq(c.totalCap, 0);
        assertTrue(c.mockVenue);
        assertEq(c.feeRecipient, splitter);
        assertEq(c.timelock, vm.parseJsonAddress(book, ".chains.46630.timelock"));
        assertEq(sl.length, 3);
        for (uint256 i; i < sl.length; i++) {
            assertEq(sl[i].capUsdg, 0);
        }
    }

    function test_A49_ownerTestnetCapOpensTotalAndSleevesBounded() public {
        (DnVaultDeploy.DnConfig memory c, DnVaultDeploy.DnSleeveConfig[] memory sl) =
            s.configFromBook(book, DEPLOYER, makeAddr("splitter"), s.testnetCap(1_000_000));
        assertEq(c.totalCap, 1_000_000e6);
        for (uint256 i; i < sl.length; i++) {
            assertEq(sl[i].capUsdg, 1_000_000e6);
        }
        vm.expectRevert(bytes("A49: testnet DN cap above 10M test USDG"));
        s.testnetCap(10_000_001);
    }
}
