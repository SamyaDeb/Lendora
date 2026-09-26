// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {IMetaMorphoV1_1} from "metamorpho/src/interfaces/IMetaMorphoV1_1.sol";
import {MetaMorphoV1_1Factory} from "metamorpho/src/MetaMorphoV1_1Factory.sol";

/// @notice Scaffold check: unmodified Morpho Blue and MetaMorpho v1.1 compile and deploy side by side with our
/// toolchain, and an idle market (no collateral, oracle, IRM or LLTV) can back a vault.
contract MorphoStackSmokeTest is Test {
    using MarketParamsLib for MarketParams;

    function test_scaffold_deploysMorphoBlueAndMetaMorpho() public {
        address owner = makeAddr("owner");
        // Morpho Blue is pinned to 0.8.19; deploy from its compiled artifact rather than importing it.
        IMorpho morpho = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(owner)));
        ERC20Mock asset = new ERC20Mock();

        vm.startPrank(owner);
        morpho.enableIrm(address(0));
        morpho.enableLltv(0);
        vm.stopPrank();

        MarketParams memory idle = MarketParams({
            loanToken: address(asset), collateralToken: address(0), oracle: address(0), irm: address(0), lltv: 0
        });
        morpho.createMarket(idle);

        MetaMorphoV1_1Factory factory = new MetaMorphoV1_1Factory(address(morpho));
        IMetaMorphoV1_1 vault =
            factory.createMetaMorpho(owner, 1 days, address(asset), "Stockline TEST", "rTEST", bytes32(0));

        vm.startPrank(owner);
        vault.submitCap(idle, 1000e18);
        vm.warp(block.timestamp + 1 days); // cap increases always wait out the curator timelock
        vault.acceptCap(idle);
        vm.stopPrank();
        assertEq(vault.config(idle.id()).cap, 1000e18);
        assertEq(address(vault.asset()), address(asset));
        assertEq(vault.symbol(), "rTEST");
        assertTrue(Id.unwrap(idle.id()) != bytes32(0));
    }
}
