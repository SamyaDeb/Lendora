// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";
import {IFeeSplitter} from "../../src/interfaces/IFeeSplitter.sol";
import {IFeeConverter} from "../../src/interfaces/IFeeConverter.sol";
import {FeeConverter} from "../../src/fees/FeeConverter.sol";
import {MockSwapAggregator} from "../mocks/MockSwapAggregator.sol";
import {LocalLendora} from "../utils/LocalLendora.sol";
import {ILendoraRouter} from "../../src/interfaces/ILendoraRouter.sol";

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
contract FeeAccrualTest is LocalLendora {
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
        assertEq(r[0].account, address(core.treasuryConverter), "FE-R4 treasury share converted");
        assertEq(r[0].bps, 5000);
        assertEq(r[1].account, address(core.backstopConverter), "FE-R3 backstop share segregated");
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
        uint256 t = IERC20(address(v)).balanceOf(address(core.treasuryConverter));
        uint256 b = IERC20(address(v)).balanceOf(address(core.backstopConverter));
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

    function test_FE_R4_deployWiresConvertersBehindTheTimelock() public view {
        FeeConverter[2] memory cs = [core.treasuryConverter, core.backstopConverter];
        address[2] memory dests = [c.treasury, c.backstopReserve];
        for (uint256 k; k < 2; k++) {
            assertEq(cs[k].owner(), address(core.timelock));
            assertEq(cs[k].destination(), dests[k]);
            assertEq(cs[k].keeper(), c.feeKeeper);
            assertEq(uint8(cs[k].swapModes(c.swapTarget)), uint8(c.swapMode));
            for (uint256 i; i < 3; i++) {
                assertEq(cs[k].oracleOf(ds[i].vault), address(ds[i].oracle));
            }
        }
    }

    /// @notice 09 acceptance chain on the local stack: accrue → split → both shares converted to USDG and forwarded
    /// to treasury and `BackstopReserve`, each within 1% of the oracle value (FE-R1…R4).
    function test_FE_R1_R4_accrueSplitConvertEndToEnd() public {
        IVaultV2Min v = IVaultV2Min(ds[NVDA].vault);
        _openBorrow();
        vm.warp(block.timestamp + 30 days);
        // Fresh rounds after 30 days (the converter only runs with the guard clear, in an open session).
        (uint256 p,) = ds[NVDA].oracle.stockAnswer();
        m.feeds[NVDA].setAnswer(int256(p));
        m.usdgFeed.setAnswer(1e8);
        ds[NVDA].oracle.poke();
        assertEq(ds[NVDA].oracle.guardReasons(), 0);
        v.accrueInterest();
        core.feeSplitter.distribute(address(v));

        m.dex.setRate(address(_tok(NVDA)), address(m.usdg), p / 100); // oracle price, USDG 6 dp per 1e18 raw
        m.usdg.mint(address(m.dex), 1e15);
        _convertAllAndCheck(core.treasuryConverter, c.treasury);
        _convertAllAndCheck(core.backstopConverter, c.backstopReserve);
    }

    function _convertAllAndCheck(FeeConverter cv, address dest) internal {
        IVaultV2Min v = IVaultV2Min(ds[NVDA].vault);
        uint256 sh = IERC20(address(v)).balanceOf(address(cv));
        uint256 stockIn = v.previewRedeem(sh);
        (uint256 value, uint256 floor) = cv.quote(address(v), stockIn);
        bytes memory data =
            abi.encodeCall(MockSwapAggregator.swap, (address(_tok(NVDA)), address(m.usdg), stockIn, 0, address(cv)));
        vm.prank(c.feeKeeper);
        uint256 out = cv.convert(address(v), sh, floor, IFeeConverter.Swap(address(m.dex), data));
        assertGe(out, floor);
        assertLe(out, value + 1);
        assertEq(IERC20(address(m.usdg)).balanceOf(dest), out, "USDG at the multisig");
        assertEq(IERC20(address(v)).balanceOf(address(cv)), 0);
    }

    function _openBorrow() internal {
        _onboard(borrower, 0, 400_000e6);
        ILendoraRouter.Attestation memory att = _attest(borrower); // before the prank (it is an external call)
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
