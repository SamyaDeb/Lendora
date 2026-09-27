// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {StocklineDeploy} from "./StocklineDeploy.sol";
import {IStocklineRouter} from "../src/interfaces/IStocklineRouter.sol";

/// @notice Robinhood Chain (4663) configuration for fork runs, read from packages/sdk/external-addresses.json (the
/// Phase 0 verified address book). Role holders are placeholders (labeled, keyless addresses) unless set by env.
abstract contract ForkConfig is StocklineDeploy {
    Vm private constant VM_ = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string internal constant EXTERNAL = "../packages/sdk/external-addresses.json";

    function _ext(string memory key) internal view returns (address) {
        return VM_.parseJsonAddress(VM_.readFile(EXTERNAL), string.concat(".4663.", key));
    }

    function _placeholder(string memory name) internal pure returns (address) {
        return address(uint160(uint256(keccak256(bytes(string.concat("stockline.placeholder.", name))))));
    }

    function forkCoreConfig(address deployer) public view returns (CoreConfig memory c) {
        c = CoreConfig({
            deployer: deployer,
            morpho: _ext("morpho.morpho"),
            irm: _ext("morpho.adaptiveCurveIrm"),
            usdg: _ext("tokens.USDG"),
            usdgFeed: _ext("chainlink.USDG.proxy"),
            vaultFactory: _ext("morpho.vaultV2Factory"),
            adapterFactory: _ext("morpho.morphoMarketV1AdapterV2Factory"),
            issuerRegistry: _ext("stockTokenAdmin.accessControlsRegistry"),
            sequencerFeed: address(0), // none on chain 4663 (D3)
            owner: VM_.envOr("STOCKLINE_OWNER", _placeholder("owner")),
            curator: VM_.envOr("STOCKLINE_CURATOR", _placeholder("curator")),
            guardian: VM_.envOr("STOCKLINE_GUARDIAN", _placeholder("guardian")),
            allocator: VM_.envOr("STOCKLINE_ALLOCATOR", _placeholder("allocator")),
            guardKeeper: VM_.envOr("STOCKLINE_GUARD_KEEPER", _placeholder("guardKeeper")),
            feeSplitter: VM_.envOr("STOCKLINE_FEE_SPLITTER", _placeholder("feeSplitter")),
            timelockDelay: 48 hours,
            attestationSigner: VM_.envOr("STOCKLINE_ATTESTATION_SIGNER", _placeholder("attestationSigner")),
            globalCollateralCap: 4_000_000e6,
            swapTarget: _ext("uniswap.universalRouter"),
            swapMode: IStocklineRouter.SwapMode.Transfer
        });
    }

    /// @notice Launch set and parameters (D8, 10-risk): σ 5y, launch cap and per-address cap in USD.
    function forkStocks() public view returns (StockConfig[] memory s) {
        s = new StockConfig[](3);
        s[0] = StockConfig("SPY", _ext("stockTokens.SPY"), _ext("chainlink.SPY.proxy"), 0.17e18, 1_000_000, 75_000);
        s[1] = StockConfig("NVDA", _ext("stockTokens.NVDA"), _ext("chainlink.NVDA.proxy"), 0.52e18, 1_000_000, 250_000);
        s[2] = StockConfig("AAPL", _ext("stockTokens.AAPL"), _ext("chainlink.AAPL.proxy"), 0.28e18, 250_000, 35_000);
    }

    /// @notice Largest known holders (Uniswap v3 pools) used to fund the seed amounts in fork simulations only.
    function forkStockHolders() public view returns (address[3] memory) {
        return [
            _ext("uniswapV3Pools.SPY_WETH_500"),
            _ext("uniswapV3Pools.NVDA_USDG_500"),
            _ext("uniswapV3Pools.AAPL_USDG_500")
        ];
    }
}
