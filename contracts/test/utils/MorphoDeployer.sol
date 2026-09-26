// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IMorpho} from "morpho-blue/src/interfaces/IMorpho.sol";

/// @notice Deploys the unmodified Morpho Blue v1.0.0 core, compiled with solc 0.8.19 via `MorphoArtifacts.sol`.
/// @dev Loads the artifact from disk rather than by name so filtered runs (`--mc`, `--mp`), which only compile a
/// subset of files, still find it. Requires one full `forge build` first.
library MorphoDeployer {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function deploy(address owner) internal returns (IMorpho) {
        return IMorpho(vm.deployCode("out/Morpho.sol/Morpho.json", abi.encode(owner)));
    }
}
