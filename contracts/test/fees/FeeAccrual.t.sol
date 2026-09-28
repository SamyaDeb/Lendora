// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";
import {IFeeSplitter} from "../../src/interfaces/IFeeSplitter.sol";
import {LocalStockline} from "../utils/LocalStockline.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";

/// @dev Vault V2 functions outside the frozen `IVaultV2Min` (src/interfaces/external is audit-frozen).
interface IVaultV2Extra {
    function managementFee() external view returns (uint96);
    function revoke(bytes calldata data) external;
}

/// @notice FE-R1 on the local deployment (the fork version with live Vault V2 bytecode is
/// test/fork/phase3/FeeAccrual.fork.t.sol): the deploy wires every vault's 10% performance fee to the `FeeSplitter`
/// before the timelocks lock it; 30 days of borrow interest mint fee shares to the splitter; `distribute` pays
/// treasury and `BackstopReserve` exactly `fee × interest` between them.
/// Vault V2 keeps `firstTotalAssets` in transient storage (once per transaction); `isolate` runs every top-level call
/// as its own transaction, as on a real chain (same as test/router).
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract FeeAccrualTest is LocalStockline {
    bytes32 internal constant ACCRUE_SIG = keccak256("AccrueInterest(uint256,uint256,uint256,uint256)");
    uint256 internal constant NVDA = 1;

    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");

    function setUp() public override {
        super.setUp();
        _onboard(lender, 4000e18, 0);
        _lendAndAllocate(NVDA, lender, 2000e18);
    }

    function test_FE_R1_deployWiresFeeToSplitterBehindTheTimelock() public view {
        assertEq(core.feeSplitter.owner(), address(core.timelock), "FE-R2 weights only through the timelock");
        IFeeSplitter.Recipient[] memory r = core.feeSplitter.recipients();
        assertEq(r.length, 2);
        assertEq(r[0].account, c.treasury);
        assertEq(r[0].bps, 5000);
        assertEq(r[1].account, c.backstopReserve, "FE-R3 backstop share segregated");
        assertEq(r[1].bps, 5000);
        for (uint256 i; i < 3; i++) {
            IVaultV2Min v = IVaultV2Min(ds[i].vault);
            assertEq(v.performanceFee(), 0.1e18, "FE-R1 10%");
            assertEq(v.performanceFeeRecipient(), address(core.feeSplitter), "FE-R1 recipient");
            assertEq(IVaultV2Extra(address(v)).managementFee(), 0, "no management fee");
            assertEq(v.timelock(IVaultV2Min.setPerformanceFee.selector), 48 hours, "FE-R1 fee changes timelocked");
            assertEq(v.timelock(IVaultV2Min.setPerformanceFeeRecipient.selector), 48 hours);
        }
    }

    function test_FE_R1_R2_thirtyDaysOfInterestSplitExactly() public {
        IVaultV2Min v = IVaultV2Min(ds[NVDA].vault);
        _openBorrow();

        v.accrueInterest();
        uint256 splitterSharesBefore = IERC20(address(v)).balanceOf(address(core.feeSplitter));
        vm.warp(block.timestamp + 30 days);
        vm.recordLogs();
        v.accrueInterest();
        (uint256 prevAssets, uint256 newAssets, uint256 feeShares) = _accrued(address(v));
        uint256 interest = newAssets - prevAssets;
        assertGt(interest, 0, "borrowers paid interest");
        assertGt(feeShares, 0, "fee shares minted");
        assertEq(IERC20(address(v)).balanceOf(address(core.feeSplitter)) - splitterSharesBefore, feeShares);

        // Fee shares are worth fee × interest (Vault V2 rounds both down: within a few wei of assets).
        uint256 feeAssets = v.convertToAssets(IERC20(address(v)).balanceOf(address(core.feeSplitter)));
        assertApproxEqAbs(feeAssets, interest / 10, 2, "fee = 10% of interest");

        core.feeSplitter.distribute(address(v));
        uint256 t = IERC20(address(v)).balanceOf(c.treasury);
        uint256 b = IERC20(address(v)).balanceOf(c.backstopReserve);
        assertEq(t + b, splitterSharesBefore + feeShares, "every fee share distributed");
        assertApproxEqAbs(t, b, 1, "50/50 (Q8)");
        assertEq(IERC20(address(v)).balanceOf(address(core.feeSplitter)), 0);
    }

    /// @notice The "turn fees on later" path for vaults deployed with a placeholder recipient (testnet 46630): the
    /// curator submits `setPerformanceFeeRecipient(splitter)`, it cannot execute before the vault timelock, the
    /// sentinel can revoke it, and after the delay anyone executes it (calldata: packages/sdk vault actions).
    function test_FE_R1_recipientSwitchThroughVaultTimelock() public {
        IVaultV2Min v = IVaultV2Min(ds[NVDA].vault);
        _openBorrow(); // while the feed is fresh; interest accrues through the timelock wait
        address newSplitter = makeAddr("newSplitter");
        bytes memory data = abi.encodeCall(IVaultV2Min.setPerformanceFeeRecipient, (newSplitter));

        vm.expectRevert();
        v.submit(data); // only the curator
        vm.prank(c.curator);
        v.submit(data);
        vm.expectRevert();
        v.setPerformanceFeeRecipient(newSplitter); // TimelockNotExpired
        vm.prank(c.guardian);
        IVaultV2Extra(address(v)).revoke(data); // sentinel veto
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        v.setPerformanceFeeRecipient(newSplitter); // DataNotTimelocked after the revoke

        vm.prank(c.curator);
        v.submit(data);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(makeAddr("anyone"));
        v.setPerformanceFeeRecipient(newSplitter);
        assertEq(v.performanceFeeRecipient(), newSplitter);

        vm.warp(block.timestamp + 7 days);
        v.accrueInterest();
        assertGt(IERC20(address(v)).balanceOf(newSplitter), 0, "fees now accrue to the new recipient");
    }

    function _openBorrow() internal {
        _onboard(borrower, 0, 400_000e6);
        IStocklineRouter.Attestation memory att = _attest(borrower); // before the prank (it is an external call)
        vm.prank(borrower);
        core.router.borrow(address(_tok(NVDA)), 300_000e6, 500e18, borrower, att, block.timestamp);
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
