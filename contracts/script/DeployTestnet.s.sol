// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {StocklineDeploy} from "./StocklineDeploy.sol";
import {LocalMocks} from "./LocalMocks.sol";
import {IStocklineRouter} from "../src/interfaces/IStocklineRouter.sol";
import {StocklineFaucet} from "../testnet/StocklineFaucet.sol";
import {MockGate} from "../test/mocks/MockGate.sol";

/// @notice Stockline on Robinhood Chain **testnet (46630)** (Phase 2 task 7). Testnet has none of Morpho Blue, Vault
/// V2, USDG, Stock Tokens or Chainlink at the mainnet addresses (checked 2026-09-27, docs/phase0/01-chain-facts.md
/// §10),
/// so it deploys the unmodified Morpho Blue, AdaptiveCurveIrm and Vault V2 factories from the pinned artifacts plus
/// mocks, then the same Stockline deployment as mainnet with **24h** timelocks (02 roles), the lens and a faucet.
/// Every mock is gated: only operators (deployer, feed-mirror keeper, faucet) can move prices, pause or mint.
///
///   Dry run on a local fork (no broadcast to the testnet):
///     anvil --fork-url https://rpc.testnet.chain.robinhood.com &
///     TESTNET_GO=fork-dry-run STOCKLINE_ATTESTATION_SIGNER=0x… forge script script/DeployTestnet.s.sol \
///       --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender <anvil account>
///   Testnet (only after the owner's go; key from env, never in the repo):
///     TESTNET_GO=yes STOCKLINE_ATTESTATION_SIGNER=0x… forge script script/DeployTestnet.s.sol \
///       --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast --slow --private-key $TESTNET_DEPLOYER_KEY
contract DeployTestnet is Script, StocklineDeploy, LocalMocks {
    function run() external {
        require(block.chainid == 46_630, "DeployTestnet is for Robinhood Chain testnet (46630) only");
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            bytes32 go = keccak256(bytes(vm.envOr("TESTNET_GO", string(""))));
            require(
                go == keccak256("yes") || go == keccak256("fork-dry-run"),
                "set TESTNET_GO=yes only after the go-ahead (TESTNET_GO=fork-dry-run on a local fork)"
            );
        }
        address deployer = msg.sender;
        uint256 startBlock = block.number;
        vm.startBroadcast(deployer);
        Mocks memory m = _deployLocalMocks(deployer);
        CoreConfig memory c = configForTestnet(deployer, m);
        StockConfig[] memory stocks = stocksForTestnet(m);
        Core memory core = _deployCore(c, stocks);
        StockDeployment[] memory ds = new StockDeployment[](stocks.length);
        for (uint256 i; i < stocks.length; i++) {
            ds[i] = _deployStock(c, core, stocks[i]);
        }
        core = _finalize(c, core);
        core = _deployLens(core, stocks);
        StocklineFaucet faucet = _faucetAndGates(deployer, m);
        vm.stopBroadcast();

        _startBlock = vm.toString(startBlock);
        vm.serializeAddress("local-mocks", "faucet", address(faucet));
        _writeAddresses("46630", c, core, stocks, ds, "mocks", _mocksJson(m));
    }

    function configForTestnet(address deployer, Mocks memory m) public view returns (CoreConfig memory c) {
        c = CoreConfig({
            deployer: deployer,
            morpho: m.morpho,
            irm: m.irm,
            usdg: address(m.usdg),
            usdgFeed: address(m.usdgFeed),
            vaultFactory: m.vaultFactory,
            adapterFactory: m.adapterFactory,
            issuerRegistry: address(m.registry),
            sequencerFeed: address(0),
            owner: vm.envOr("STOCKLINE_OWNER", deployer),
            curator: vm.envOr("STOCKLINE_CURATOR", deployer),
            guardian: vm.envOr("STOCKLINE_GUARDIAN", deployer),
            allocator: vm.envOr("STOCKLINE_ALLOCATOR", deployer),
            guardKeeper: vm.envOr("STOCKLINE_GUARD_KEEPER", deployer),
            feeSplitter: vm.envOr(
                "STOCKLINE_FEE_SPLITTER", address(uint160(uint256(keccak256("stockline.placeholder.feeSplitter"))))
            ),
            timelockDelay: 24 hours, // 02: 48h on mainnet, 24h on testnet
            attestationSigner: vm.envAddress("STOCKLINE_ATTESTATION_SIGNER"), // the compliance service's key
            globalCollateralCap: 4_000_000e6,
            swapTarget: address(m.dex),
            swapMode: IStocklineRouter.SwapMode.Approve
        });
    }

    /// @notice Launch set and D8 parameters, on the mock tokens and feeds.
    function stocksForTestnet(Mocks memory m) public pure returns (StockConfig[] memory s) {
        s = new StockConfig[](3);
        s[0] = StockConfig("SPY", address(m.tokens[0]), address(m.feeds[0]), 0.17e18, 1_000_000, 75_000);
        s[1] = StockConfig("NVDA", address(m.tokens[1]), address(m.feeds[1]), 0.52e18, 1_000_000, 250_000);
        s[2] = StockConfig("AAPL", address(m.tokens[2]), address(m.feeds[2]), 0.28e18, 250_000, 35_000);
    }

    /// @dev Faucet (10 of each stock, 50k USDG per address per day) and the operator gates on every mock.
    function _faucetAndGates(address deployer, Mocks memory m) internal returns (StocklineFaucet faucet) {
        faucet = new StocklineFaucet(deployer, 1 days);
        address feedKeeper = vm.envOr("STOCKLINE_FEED_KEEPER", deployer);
        for (uint256 i; i < 3; i++) {
            faucet.setDrip(address(m.tokens[i]), 10e18);
            _gate(address(m.tokens[i]), deployer, feedKeeper, address(faucet));
            _gate(address(m.feeds[i]), deployer, feedKeeper, address(0));
            _gate(address(m.pools[i]), deployer, feedKeeper, address(0));
        }
        faucet.setDrip(address(m.usdg), 50_000e6);
        _gate(address(m.usdg), deployer, feedKeeper, address(faucet));
        _gate(address(m.usdgFeed), deployer, feedKeeper, address(0));
        _gate(address(m.dex), deployer, feedKeeper, address(0));
        _gate(address(m.registry), deployer, feedKeeper, address(0));
    }

    function _gate(address mock, address deployer, address keeper, address faucet) internal {
        MockGate(mock).setOperator(deployer, true);
        if (keeper != deployer) MockGate(mock).setOperator(keeper, true);
        if (faucet != address(0)) MockGate(mock).setOperator(faucet, true);
        MockGate(mock).setGated(true);
    }
}
