// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVaultV2Min} from "../../../src/interfaces/external/IMorphoVaultV2.sol";
import {IFeeConverter} from "../../../src/interfaces/IFeeConverter.sol";
import {IMarketHours} from "../../../src/interfaces/IMarketHours.sol";
import {ForkConfig} from "../../../script/ForkConfig.sol";
import {Phase1ForkBase} from "../phase1/Phase1ForkBase.sol";

interface IUniversalRouterMin {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface AggregatorLikeFc {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice FE-R4 on a fork of Robinhood Chain (4663): the deployed treasury `FeeConverter` redeems `rNVDA` fee shares,
/// unwraps and sells NVDA for USDG through the **live** UniversalRouter and NVDA/USDG 0.05% pool
/// (`SwapMode.Transfer`, A15 calldata), within 1% of the Chainlink value, and forwards the USDG to the treasury.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract FeeConverterForkTest is Phase1ForkBase, ForkConfig {
    uint24 internal constant FEE = 500;
    address internal deployer = makeAddr("deployer");
    address internal lender = makeAddr("lender");
    CoreConfig internal c;
    Core internal core;
    StockDeployment internal nvda;
    StockConfig internal nvdaCfg;

    function setUp() public override {
        super.setUp();
        c = forkCoreConfig(deployer);
        nvdaCfg = forkStocks()[1];
        StockConfig[] memory one = new StockConfig[](1);
        one[0] = nvdaCfg;
        deal(nvdaCfg.token, deployer, 2 * SEED, true);
        vm.startPrank(deployer);
        core = _deployCore(c, one);
        nvda = _deployStock(c, core, nvdaCfg);
        core = _finalize(c, core);
        vm.stopPrank();

        // Fee shares at the treasury converter (as FeeSplitter.distribute pays them): 10 NVDA worth, idle in the vault.
        deal(nvdaCfg.token, lender, 10e18, true);
        vm.startPrank(lender);
        IERC20(nvdaCfg.token).approve(address(nvda.wrapper), 10e18);
        nvda.wrapper.wrap(10e18, lender);
        IERC20(address(nvda.wrapper)).approve(nvda.vault, 10e18);
        uint256 sh = IVaultV2Min(nvda.vault).deposit(10e18, lender);
        IERC20(nvda.vault).transfer(address(core.treasuryConverter), sh);
        vm.stopPrank();
    }

    function test_FE_R4_fork_convertThroughLiveUniversalRouter() public {
        _ensureOpenSessionWithFreshRounds();
        IFeeConverter conv = IFeeConverter(address(core.treasuryConverter));
        assertEq(uint8(conv.swapModes(c.swapTarget)), uint8(IFeeConverter.SwapMode.Transfer), "UniversalRouter, Q4");
        uint256 sh = IERC20(nvda.vault).balanceOf(address(conv));
        uint256 stockIn = IVaultV2Min(nvda.vault).previewRedeem(sh);
        (uint256 value, uint256 floor) = conv.quote(nvda.vault, stockIn);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            address(conv), stockIn, uint256(0), abi.encodePacked(nvdaCfg.token, FEE, USDG), false, new uint256[](0)
        );
        bytes memory data = abi.encodeCall(IUniversalRouterMin.execute, (hex"00", inputs, block.timestamp));

        vm.prank(c.feeKeeper);
        uint256 out = conv.convert(nvda.vault, sh, floor, IFeeConverter.Swap(c.swapTarget, data));
        emit log_named_uint("stock in (raw)", stockIn);
        emit log_named_uint("oracle value (USDG raw)", value);
        emit log_named_uint("usdg out (raw)", out);
        assertGe(out, floor, "within 1% of the oracle");
        assertEq(IERC20(USDG).balanceOf(c.treasury), out, "USDG forwarded to the treasury");
        assertEq(IERC20(nvda.vault).balanceOf(address(conv)), 0);
        assertEq(IERC20(nvdaCfg.token).balanceOf(address(conv)), 0);
        assertEq(IERC20(USDG).balanceOf(address(conv)), 0);
    }

    /// @dev The fork is at `latest`; if that is inside a closure, move to the next session. Either way re-serve the
    /// feeds' latest answers as fresh so the guard is clear (the guard itself is covered in test/fees).
    function _ensureOpenSessionWithFreshRounds() internal {
        if (!core.marketHours.isOpen(block.timestamp)) {
            (IMarketHours.Session memory s, bool found) = core.marketHours.currentOrNextSession(block.timestamp);
            require(found, "calendar ends");
            vm.warp(s.openTs + 1 hours);
        }
        _fresh(nvdaCfg.feed);
        _fresh(c.usdgFeed);
        assertEq(nvda.oracle.guardReasons(), 0, "guard clear");
    }

    function _fresh(address feed) internal {
        (uint80 id, int256 answer,,, uint80 answeredIn) = AggregatorLikeFc(feed).latestRoundData();
        vm.mockCall(
            feed,
            abi.encodeCall(AggregatorLikeFc.latestRoundData, ()),
            abi.encode(id, answer, block.timestamp, block.timestamp, answeredIn)
        );
    }
}
