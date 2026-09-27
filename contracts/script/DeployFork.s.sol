// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkConfig} from "./ForkConfig.sol";

/// @notice Stockline deployment **simulated** on a fork of Robinhood Chain (4663) with the live Morpho Blue, Vault V2
/// factories, Stock Tokens, Chainlink feeds and USDG. Writes `packages/sdk/addresses.json` under "fork-4663".
/// It refuses to broadcast: Phase 1 never sends a transaction to mainnet or testnet.
///
///   forge script script/DeployFork.s.sol --fork-url $ROBINHOOD_RPC_URL --sender <any address> --skip-simulation
/// (`--skip-simulation`: the seed amounts are funded with a fork-only prank that forge's replay step cannot see.)
contract DeployFork is Script, ForkConfig {
    function run() external {
        require(block.chainid == 4663, "DeployFork runs on a fork of chain 4663 only");
        require(
            !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) && !vm.isContext(VmSafe.ForgeContext.ScriptResume),
            "never broadcast to Robinhood Chain from Phase 1"
        );
        address deployer = msg.sender;
        CoreConfig memory c = forkCoreConfig(deployer);
        StockConfig[] memory stocks = forkStocks();
        address[3] memory holders = forkStockHolders();
        for (uint256 i; i < stocks.length; i++) {
            vm.prank(holders[i]); // fork simulation only: fund the seed amounts
            IERC20(stocks[i].token).transfer(deployer, 2 * SEED);
        }

        vm.startBroadcast(deployer);
        Core memory core = _deployCore(c, stocks);
        StockDeployment[] memory ds = new StockDeployment[](stocks.length);
        for (uint256 i; i < stocks.length; i++) {
            ds[i] = _deployStock(c, core, stocks[i]);
        }
        core = _finalize(c, core);
        core = _deployLens(core, stocks);
        vm.stopBroadcast();
        _writeAddresses("fork-4663", c, core, stocks, ds, "forkBlock", vm.toString(block.number));
    }
}
