// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {MainnetConfig} from "./MainnetConfig.sol";

/// @notice Stockline on Robinhood Chain **mainnet (4663)** (Phase 3 task 7, mainnet-launch §3). No mocks: the live
/// Morpho Blue, Vault V2 factories, Stock Tokens, USDG, Chainlink feeds and UniversalRouter; every role from
/// `STOCKLINE_*` env with no default; checks MN-R1…MN-R3 before the first transaction.
///
/// **It refuses to run on chain 4663 at all (even a simulation) unless `I_HAVE_THE_OWNERS_GO=1`**, which is set only
/// after the owner's written go is in the launch log (mainnet-launch §0 gates all ✅). Rehearsals use the fork test
/// (`test/fork/phase3/DeployMainnet.fork.t.sol`) or the anvil test (`test/deploy/DeployMainnet.t.sol`) instead.
///
///   export STOCKLINE_OWNER=… STOCKLINE_CURATOR=… STOCKLINE_GUARDIAN=… STOCKLINE_ALLOCATOR=…
///   export STOCKLINE_GUARD_KEEPER=… STOCKLINE_TREASURY=… STOCKLINE_BACKSTOP_RESERVE=…
///   export STOCKLINE_FEE_KEEPER=… STOCKLINE_ATTESTATION_SIGNER=…
///   I_HAVE_THE_OWNERS_GO=1 forge script script/DeployMainnet.s.sol --rpc-url $ROBINHOOD_RPC_URL \
///     --broadcast --slow --verify --sender <fresh deployer> <hardware-wallet or remote-signer flags>
///
/// The deployer must hold 2 × SEED raw units (2e12, i.e. 0.000002 shares) of each launch Stock Token. Output:
/// `deployments/4663.json` (address-book shape), copied by hand into `packages/sdk/addresses.json["4663"]` after
/// `VerifyRoles` passes.
contract DeployMainnet is Script, MainnetConfig {
    function run() external {
        _refuseWithoutGo(block.chainid, vm.envOr("I_HAVE_THE_OWNERS_GO", string("")));
        address deployer = msg.sender;
        CoreConfig memory c = mainnetCoreConfig(deployer, mainnetRolesFromEnv());
        StockConfig[] memory stocks = mainnetStocks();
        _assertMainnetConfig(c, stocks, d8Targets());

        vm.startBroadcast(deployer);
        (Core memory core, StockDeployment[] memory ds) = _deployMainnet(c, stocks);
        vm.stopBroadcast();

        string memory json = _chainJson("4663-deploy", c, core, stocks, ds, "deployBlock", vm.toString(block.number));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }

    /// @notice MN-R4: chain 4663 only, and only with `I_HAVE_THE_OWNERS_GO=1`. Public so tests can prove the refusal.
    function refuseWithoutGo(uint256 chainId, string memory go) external pure {
        _refuseWithoutGo(chainId, go);
    }

    function _refuseWithoutGo(uint256 chainId, string memory go) internal pure {
        require(chainId == 4663, "DeployMainnet is for Robinhood Chain mainnet (4663) only");
        require(
            keccak256(bytes(go)) == keccak256("1"),
            "MN-R4: DeployMainnet refuses chain 4663 without I_HAVE_THE_OWNERS_GO=1 (the owner's go, launch log)"
        );
    }
}
