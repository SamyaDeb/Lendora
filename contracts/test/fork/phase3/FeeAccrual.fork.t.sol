// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "morpho-blue/src/interfaces/IMorpho.sol";
import {Vm} from "forge-std/Vm.sol";
import {IVaultV2Min} from "../../../src/interfaces/external/IMorphoVaultV2.sol";
import {IStocklineRouter} from "../../../src/interfaces/IStocklineRouter.sol";
import {ForkConfig} from "../../../script/ForkConfig.sol";
import {Phase1ForkBase} from "../phase1/Phase1ForkBase.sol";

/// @notice 09 acceptance (FE-R1, FE-R2) on a fork of Robinhood Chain (4663) with the **live** Vault V2 factory
/// bytecode: the exact deploy logic wires the 10% performance fee to the `FeeSplitter`; 30 days of borrow interest
/// in the NVDA market mint fee shares to the splitter worth `fee × interest`; `distribute` pays treasury and
/// `BackstopReserve` all of them, 50/50. Conversion to USDG is FE-R4 (`FeeConverter.fork.t.sol`).
/// Vault V2 keeps `firstTotalAssets` in transient storage; `isolate` makes each top-level call its own transaction.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract FeeAccrualForkTest is Phase1ForkBase, ForkConfig {
    bytes32 internal constant ACCRUE_SIG = keccak256("AccrueInterest(uint256,uint256,uint256,uint256)");

    address internal deployer = makeAddr("deployer");
    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");
    CoreConfig internal c;
    Core internal core;
    StockDeployment internal nvda;
    StockConfig internal nvdaCfg;
    Vm.Wallet internal attester;

    function setUp() public override {
        super.setUp();
        c = forkCoreConfig(deployer);
        StockConfig[] memory s = forkStocks();
        nvdaCfg = s[1];
        StockConfig[] memory one = new StockConfig[](1);
        one[0] = nvdaCfg;
        deal(nvdaCfg.token, deployer, 2 * SEED, true);
        vm.startPrank(deployer);
        core = _deployCore(c, one);
        nvda = _deployStock(c, core, nvdaCfg);
        core = _finalize(c, core);
        vm.stopPrank();
        attester = vm.createWallet("attester");
        vm.prank(address(core.timelock));
        core.router.setAttestationSigner(attester.addr);

        // Lender supplies 100 NVDA; the allocator moves 90 into the market (U_MAX).
        deal(nvdaCfg.token, lender, 100e18, true);
        vm.startPrank(lender);
        IERC20(nvdaCfg.token).approve(address(nvda.wrapper), 100e18);
        nvda.wrapper.wrap(100e18, lender);
        IERC20(address(nvda.wrapper)).approve(nvda.vault, 100e18);
        IVaultV2Min(nvda.vault).deposit(100e18, lender);
        vm.stopPrank();
        vm.prank(c.allocator);
        IVaultV2Min(nvda.vault).allocate(nvda.adapter, abi.encode(nvda.market), 90e18);
    }

    function test_FE_R1_R2_fork_thirtyDaysAccrualMintsFeeSharesToSplitterAndDistributes() public {
        IVaultV2Min v = IVaultV2Min(nvda.vault);
        assertEq(v.performanceFeeRecipient(), address(core.feeSplitter), "FE-R1 recipient");
        assertEq(v.performanceFee(), 0.1e18, "FE-R1 10%");

        _borrow(50e18);
        v.accrueInterest();
        uint256 before = IERC20(address(v)).balanceOf(address(core.feeSplitter));

        vm.warp(block.timestamp + 30 days);
        vm.recordLogs();
        v.accrueInterest();
        (uint256 prevAssets, uint256 newAssets, uint256 feeShares) = _accrued(address(v));
        uint256 interest = newAssets - prevAssets;
        emit log_named_uint("30d interest (wNVDA raw)", interest);
        emit log_named_uint("fee shares", feeShares);
        assertGt(interest, 0);
        assertGt(feeShares, 0);
        uint256 held = IERC20(address(v)).balanceOf(address(core.feeSplitter));
        assertEq(held - before, feeShares, "fee shares minted to the splitter");
        assertApproxEqAbs(v.convertToAssets(held), interest / 10, 2, "fee shares worth fee x interest");

        core.feeSplitter.distribute(address(v));
        uint256 t = IERC20(address(v)).balanceOf(c.treasury);
        uint256 b = IERC20(address(v)).balanceOf(c.backstopReserve);
        assertEq(t + b, held, "all distributed");
        assertApproxEqAbs(t, b, 1, "Q8 50/50");
        assertEq(IERC20(address(v)).balanceOf(address(core.feeSplitter)), 0);
    }

    function _borrow(uint256 amount) internal {
        (uint256 p,) = nvda.oracle.stockAnswer();
        uint256 collateral = p * (amount / 1e18) * 3 / 100; // 3x the debt value, USDG 6 dp
        deal(USDG, borrower, collateral, true);
        IStocklineRouter.Attestation memory att;
        att.expiry = block.timestamp + 1 days;
        (uint8 sv, bytes32 r, bytes32 s) =
            vm.sign(attester.privateKey, core.router.attestationDigest(borrower, att.expiry));
        att.signature = abi.encodePacked(r, s, sv);
        _freshRound(c.usdgFeed);
        _freshRound(nvdaCfg.feed);
        vm.startPrank(borrower);
        IERC20(USDG).approve(address(core.router), collateral);
        IMorpho(MORPHO).setAuthorization(address(core.router), true);
        core.router.borrow(nvdaCfg.token, collateral, amount, borrower, att, block.timestamp);
        vm.stopPrank();
        vm.clearMockedCalls();
    }

    function _freshRound(address feed) internal {
        (uint80 id, int256 answer,,, uint80 answeredIn) = AggregatorLike(feed).latestRoundData();
        vm.mockCall(
            feed,
            abi.encodeCall(AggregatorLike.latestRoundData, ()),
            abi.encode(id, answer, block.timestamp, block.timestamp, answeredIn)
        );
    }

    function _accrued(address vault) internal returns (uint256 prev, uint256 next, uint256 feeShares) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == vault && logs[i].topics[0] == ACCRUE_SIG) {
                (prev, next, feeShares,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            }
        }
    }
}

interface AggregatorLike {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
