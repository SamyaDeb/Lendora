// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IMorpho} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MockStockToken} from "../test/mocks/MockStockToken.sol";
import {MockChainlinkAggregator} from "../test/mocks/MockChainlinkAggregator.sol";
import {MockUSDG} from "../test/mocks/MockUSDG.sol";
import {MockAccessControlsRegistry} from "../test/mocks/MockAccessControlsRegistry.sol";
import {MockUniswapV3Pool} from "../test/mocks/MockUniswapV3Pool.sol";
import {MockSwapAggregator} from "../test/mocks/MockSwapAggregator.sol";

/// @notice Stand-ins for everything Robinhood Chain provides, for anvil (chain 31337) only: unmodified Morpho Blue,
/// AdaptiveCurveIrm and the Vault V2 factories from our pinned artifacts, plus mock Stock Tokens (shared issuer
/// registry), Chainlink feeds, USDG, Uniswap v3 pools (TWAP reads) and a swap aggregator (router swaps).
abstract contract LocalMocks {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Mocks {
        address morpho;
        address irm;
        address vaultFactory;
        address adapterFactory;
        MockUSDG usdg;
        MockChainlinkAggregator usdgFeed;
        MockAccessControlsRegistry registry;
        MockSwapAggregator dex;
        MockStockToken[3] tokens;
        MockChainlinkAggregator[3] feeds;
        MockUniswapV3Pool[3] pools;
    }

    string[3] internal TICKERS = ["SPY", "NVDA", "AAPL"];
    /// @dev Latest onchain answers at 2026-09-26 (01-chain-facts §4), 8 dp.
    int256[3] internal PRICES = [int256(772.33e8), int256(225.66e8), int256(341.45e8)];
    /// @dev Uniswap v3 ticks for those prices in stock(18 dp)/USDG(6 dp) pools: floor(log_1.0001(P · 1e-12)).
    int24[3] internal TICKS = [int24(-209_827), int24(-222_132), int24(-217_990)];

    function _deployLocalMocks(address deployer) internal returns (Mocks memory m) {
        m.morpho = VM.deployCode("out/Morpho.sol/Morpho.json", abi.encode(deployer));
        IMorpho(m.morpho).enableIrm(address(0));
        IMorpho(m.morpho).enableLltv(0);
        IMorpho(m.morpho).enableLltv(0.77e18);
        IMorpho(m.morpho).enableLltv(0.625e18);
        m.irm = VM.deployCode("out/AdaptiveCurveIrm.sol/AdaptiveCurveIrm.json", abi.encode(m.morpho));
        IMorpho(m.morpho).enableIrm(m.irm);
        m.vaultFactory = VM.deployCode("out/VaultV2Factory.sol/VaultV2Factory.json");
        m.adapterFactory = VM.deployCode(
            "out/MorphoMarketV1AdapterV2Factory.sol/MorphoMarketV1AdapterV2Factory.json", abi.encode(m.morpho, m.irm)
        );

        m.usdg = new MockUSDG(6);
        m.usdgFeed = new MockChainlinkAggregator(8, "USDG / USD");
        m.usdgFeed.setAnswer(1e8);
        m.registry = new MockAccessControlsRegistry();
        m.dex = new MockSwapAggregator();
        for (uint256 i; i < 3; i++) {
            m.tokens[i] = new MockStockToken(string.concat(TICKERS[i], " Stock Token"), TICKERS[i], 18);
            m.tokens[i].setRegistry(m.registry);
            m.feeds[i] = new MockChainlinkAggregator(8, string.concat("RH", TICKERS[i], " / USD"));
            m.feeds[i].setAnswer(PRICES[i]);
            m.pools[i] = new MockUniswapV3Pool(address(m.tokens[i]), address(m.usdg), 500, TICKS[i]);
            m.tokens[i].mint(deployer, 1000e18);
            // DEX inventory and rates at the feed price, both directions (raw units: stock 18 dp, USDG 6 dp).
            uint256 p = uint256(PRICES[i]);
            m.dex.setRate(address(m.tokens[i]), address(m.usdg), p * 1e6 / 1e8);
            m.dex.setRate(address(m.usdg), address(m.tokens[i]), uint256(1e8) * 1e36 / (p * 1e6));
            m.tokens[i].mint(address(m.dex), 1_000_000e18);
        }
        m.usdg.mint(address(m.dex), 1_000_000_000e6);
        m.usdg.mint(deployer, 10_000_000e6);
    }

    function _mocksJson(Mocks memory m) internal returns (string memory) {
        string memory o = "local-mocks";
        VM.serializeAddress(o, "registry", address(m.registry));
        VM.serializeAddress(o, "swapAggregator", address(m.dex));
        for (uint256 i; i < 3; i++) {
            VM.serializeAddress(o, string.concat(TICKERS[i], "_feed"), address(m.feeds[i]));
            VM.serializeAddress(o, string.concat(TICKERS[i], "_token"), address(m.tokens[i]));
            VM.serializeAddress(o, string.concat(TICKERS[i], "_USDG_pool"), address(m.pools[i]));
        }
        return VM.serializeAddress(o, "usdgFeed", address(m.usdgFeed));
    }
}
