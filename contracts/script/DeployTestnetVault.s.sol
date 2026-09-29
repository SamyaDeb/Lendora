// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {DnVaultDeploy} from "./DnVaultDeploy.sol";
import {IStrategyManager} from "../src/interfaces/IStrategyManager.sol";
import {MockGate} from "../test/mocks/MockGate.sol";

/// @notice Phase 4 on the **existing** testnet (46630) deployment, which predates it (Part C step 1): the
/// `DeltaNeutralVault`, `StrategyManager`, `NavOracle` and a gated `MockPerpVenue` (marks at the testnet's mirrored
/// mock feeds), **every cap at 0** (Q11), owned by the testnet timelock (24h). Reads everything from the address book.
///
///   Rehearsal on a local fork (no broadcast to the testnet):
///     anvil --fork-url https://rpc.testnet.chain.robinhood.com &
///     TESTNET_GO=fork-dry-run forge script script/DeployTestnetVault.s.sol --rpc-url http://127.0.0.1:8545 \
///       --broadcast --unlocked --sender <testnet deployer>
///   Testnet (only after the owner's "go testnet"; key from env, never in the repo):
///     TESTNET_GO=yes forge script script/DeployTestnetVault.s.sol --rpc-url $ROBINHOOD_TESTNET_RPC_URL \
///       --broadcast --slow --private-key $TESTNET_DEPLOYER_KEY
/// Output: `deployments/fork-46630-dn.json`; on `TESTNET_GO=yes` also `addresses.json["46630"].dnVault`.
contract DeployTestnetVault is Script, DnVaultDeploy {
    string internal constant BOOK = "../packages/sdk/addresses.json";
    string internal constant C = ".chains.46630.";
    string internal constant FORK_FEES = "deployments/fork-46630-fees.json";

    function run() external returns (DnDeployment memory dn) {
        require(block.chainid == 46_630, "DeployTestnetVault is for Robinhood Chain testnet (46630) only");
        bytes32 go = keccak256(bytes(vm.envOr("TESTNET_GO", string(""))));
        bool live = go == keccak256("yes");
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            require(
                live || go == keccak256("fork-dry-run"),
                "set TESTNET_GO=yes only after the go-ahead (TESTNET_GO=fork-dry-run on a local fork)"
            );
        }
        string memory j = vm.readFile(BOOK);
        (DnConfig memory c, DnSleeveConfig[] memory sl) = configFromBook(j, msg.sender, feeRecipient(j, !live));
        vm.startBroadcast(msg.sender);
        dn = _deployDnVault(c, sl);
        address feedKeeper = vm.envOr("STOCKLINE_FEED_KEEPER", msg.sender);
        MockGate(dn.adapter).setOperator(msg.sender, true);
        if (feedKeeper != msg.sender) MockGate(dn.adapter).setOperator(feedKeeper, true);
        MockGate(dn.adapter).setGated(true);
        vm.stopBroadcast();
        vm.writeJson(_dnJson("46630", dn), "deployments/fork-46630-dn.json");
        if (live) vm.writeJson(_dnJson("46630", dn), BOOK, string.concat(C, "dnVault"));
    }

    /// @notice DN-R9: the vault's fee recipient is the `FeeSplitter`: from the address book once `DeployTestnetFees`
    /// ran with `TESTNET_GO=yes`, or (fork rehearsal only) from that script's fork output. Refused otherwise: the
    /// testnet entry predates the fee contracts and has no treasury role to fall back to.
    function feeRecipient(string memory j, bool forkRehearsal) public view returns (address) {
        if (vm.keyExistsJson(j, string.concat(C, "feeSplitter"))) {
            return vm.parseJsonAddress(j, string.concat(C, "feeSplitter"));
        }
        if (forkRehearsal && vm.isFile(FORK_FEES)) return vm.parseJsonAddress(vm.readFile(FORK_FEES), ".feeSplitter");
        revert("DeployTestnetVault: no FeeSplitter in the address book: run DeployTestnetFees first (DN-R9)");
    }

    /// @notice The DN config and sleeves (caps 0) from the 46630 address-book entry. Public for the fork rehearsal.
    function configFromBook(string memory j, address deployer, address feeRecipient_)
        public
        view
        returns (DnConfig memory c, DnSleeveConfig[] memory sl)
    {
        address s2 = vm.envOr("STOCKLINE_NAV_SIGNER_2", address(0));
        address[] memory signers = new address[](s2 == address(0) ? 1 : 2);
        signers[0] = vm.envOr("STOCKLINE_NAV_SIGNER_1", deployer);
        if (s2 != address(0)) signers[1] = s2;
        c = DnConfig({
            deployer: deployer,
            usdg: vm.parseJsonAddress(j, string.concat(C, "usdg")),
            attestationSource: vm.parseJsonAddress(j, string.concat(C, "router")),
            marketHours: vm.parseJsonAddress(j, string.concat(C, "marketHours")),
            timelock: vm.parseJsonAddress(j, string.concat(C, "timelock")),
            guardian: vm.parseJsonAddress(j, string.concat(C, "roles.guardian")),
            operator: vm.envOr("STOCKLINE_DN_OPERATOR", deployer),
            feeRecipient: feeRecipient_,
            navSigners: signers,
            swapTarget: vm.parseJsonAddress(j, string.concat(C, "mocks.swapAggregator")),
            swapMode: IStrategyManager.SwapMode.Approve,
            mockVenue: true,
            totalCap: 0
        });
        string[] memory tickers = vm.parseJsonKeys(j, string.concat(C, "stocks"));
        sl = new DnSleeveConfig[](tickers.length);
        for (uint256 i; i < tickers.length; i++) {
            string memory b = string.concat(C, "stocks.", tickers[i], ".");
            bool spy = keccak256(bytes(tickers[i])) == keccak256("SPY");
            sl[i] = DnSleeveConfig({
                ticker: tickers[i],
                stockToken: vm.parseJsonAddress(j, string.concat(b, "stockToken")),
                wrapper: vm.parseJsonAddress(j, string.concat(b, "wrapper")),
                rVault: vm.parseJsonAddress(j, string.concat(b, "vault")),
                oracle: vm.parseJsonAddress(j, string.concat(b, "oracle")),
                capUsdg: 0,
                mmfWad: spy ? 0.012e18 : 0.03e18,
                imfWad: spy ? 0.02e18 : 0.05e18
            });
        }
    }
}
