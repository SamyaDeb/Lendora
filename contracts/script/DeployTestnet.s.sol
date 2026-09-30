// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {DnVaultDeploy} from "./DnVaultDeploy.sol";
import {LocalMocks} from "./LocalMocks.sol";
import {ILendoraRouter} from "../src/interfaces/ILendoraRouter.sol";
import {LendoraFaucet} from "../testnet/LendoraFaucet.sol";
import {MockGate} from "../test/mocks/MockGate.sol";

/// @notice Lendora on Robinhood Chain **testnet (46630)** (Phase 2 task 7). Testnet has none of Morpho Blue, Vault
/// V2, USDG, Stock Tokens or Chainlink at the mainnet addresses (checked 2026-09-27, docs/phase0/01-chain-facts.md
/// §10),
/// so it deploys the unmodified Morpho Blue, AdaptiveCurveIrm and Vault V2 factories from the pinned artifacts plus
/// mocks, then the same Lendora deployment as mainnet with **24h** timelocks (02 roles), the lens and a faucet.
/// Every mock is gated: only operators (deployer, feed-mirror keeper, faucet) can move prices, pause or mint.
/// Phase 4: the delta-neutral vault on the (gated) mock perp venue with **every cap at 0** (Q11) — raising a cap is a
/// timelocked owner action taken only after the sim gate and the risk owner's signature (and the owner's say-so).
///
///   Dry run on a local fork (no broadcast to the testnet):
///     anvil --fork-url https://rpc.testnet.chain.robinhood.com &
///     TESTNET_GO=fork-dry-run LENDORA_ATTESTATION_SIGNER=0x… forge script script/DeployTestnet.s.sol \
///       --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender <anvil account>
///   Testnet (only after the owner's go; key from env, never in the repo):
///     TESTNET_GO=yes LENDORA_ATTESTATION_SIGNER=0x… forge script script/DeployTestnet.s.sol \
///       --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast --slow --private-key $TESTNET_DEPLOYER_KEY
contract DeployTestnet is Script, DnVaultDeploy, LocalMocks {
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
        LendoraFaucet faucet = _faucetAndGates(deployer, m);
        DnDeployment memory dn = deployDnTestnet(c, core, stocks, ds);
        vm.stopBroadcast();

        _startBlock = vm.toString(startBlock);
        vm.serializeAddress("local-mocks", "faucet", address(faucet));
        _writeAddresses("46630", c, core, stocks, ds, "mocks", _mocksJson(m));
        _writeDn("46630", dn);
    }

    /// @notice Phase 4 on testnet: mock venue (gated), caps 0. Operator and NAV signers from env (default: deployer;
    /// a second signer only if `LENDORA_NAV_SIGNER_2` is set).
    function deployDnTestnet(
        CoreConfig memory c,
        Core memory core,
        StockConfig[] memory stocks,
        StockDeployment[] memory ds
    ) public returns (DnDeployment memory dn) {
        address s2 = vm.envOr("LENDORA_NAV_SIGNER_2", address(0));
        address[] memory signers = new address[](s2 == address(0) ? 1 : 2);
        signers[0] = vm.envOr("LENDORA_NAV_SIGNER_1", c.deployer);
        if (s2 != address(0)) signers[1] = s2;
        dn = _deployDnVault(
            _dnConfig(c, core, vm.envOr("LENDORA_DN_OPERATOR", c.deployer), signers, true, 0),
            _dnSleeves(stocks, ds, new uint128[](stocks.length))
        );
        _gate(dn.adapter, c.deployer, vm.envOr("LENDORA_FEED_KEEPER", c.deployer), address(0));
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
            owner: vm.envOr("LENDORA_OWNER", deployer),
            curator: vm.envOr("LENDORA_CURATOR", deployer),
            guardian: vm.envOr("LENDORA_GUARDIAN", deployer),
            allocator: vm.envOr("LENDORA_ALLOCATOR", deployer),
            guardKeeper: vm.envOr("LENDORA_GUARD_KEEPER", deployer),
            treasury: vm.envOr("LENDORA_TREASURY", deployer),
            backstopReserve: vm.envOr(
                "LENDORA_BACKSTOP_RESERVE", address(uint160(uint256(keccak256("lendora.placeholder.backstopReserve"))))
            ),
            feeKeeper: vm.envOr("LENDORA_FEE_KEEPER", deployer),
            timelockDelay: 24 hours, // 02: 48h on mainnet, 24h on testnet
            attestationSigner: vm.envAddress("LENDORA_ATTESTATION_SIGNER"), // the compliance service's key
            globalCollateralCap: 4_000_000e6,
            swapTarget: address(m.dex),
            swapMode: ILendoraRouter.SwapMode.Approve
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
    function _faucetAndGates(address deployer, Mocks memory m) internal returns (LendoraFaucet faucet) {
        faucet = new LendoraFaucet(deployer, 1 days);
        address feedKeeper = vm.envOr("LENDORA_FEED_KEEPER", deployer);
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
