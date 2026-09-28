// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FeeSplitter} from "../../src/fees/FeeSplitter.sol";
import {IFeeSplitter} from "../../src/interfaces/IFeeSplitter.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/// @notice Token that calls back into the splitter from `transfer` (reentrancy probe).
contract ReentrantToken is ERC20 {
    FeeSplitter public splitter;
    bytes public lastRevert;

    constructor() ERC20("Evil", "EVIL") {}

    function arm(FeeSplitter s) external {
        splitter = s;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (address(splitter) != address(0)) {
            FeeSplitter s = splitter;
            splitter = FeeSplitter(address(0)); // one probe per transfer batch
            try s.distribute(address(this)) {}
            catch (bytes memory reason) {
                lastRevert = reason;
            }
        }
        return super.transfer(to, amount);
    }
}

/// @notice Token that refuses transfers to one blocked account (a recipient that reverts).
contract BlockingToken is ERC20 {
    address public blocked;

    constructor(address blocked_) ERC20("Block", "BLK") {
        blocked = blocked_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to != blocked, "blocked");
        super._update(from, to, value);
    }
}

contract FeeSplitterTest is Test {
    FeeSplitter internal splitter;
    MockUSDG internal usdg;
    address internal timelock = makeAddr("timelock");
    address internal treasury = makeAddr("treasury");
    address internal backstop = makeAddr("backstopReserve");

    function setUp() public {
        usdg = new MockUSDG(6);
        splitter = new FeeSplitter(timelock, _two(treasury, 5000, backstop, 5000));
    }

    function _two(address a, uint16 wa, address b, uint16 wb)
        internal
        pure
        returns (IFeeSplitter.Recipient[] memory r)
    {
        r = new IFeeSplitter.Recipient[](2);
        r[0] = IFeeSplitter.Recipient(a, wa);
        r[1] = IFeeSplitter.Recipient(b, wb);
    }

    function _one(address a) internal pure returns (IFeeSplitter.Recipient[] memory r) {
        r = new IFeeSplitter.Recipient[](1);
        r[0] = IFeeSplitter.Recipient(a, 10_000);
    }

    // ------------------------------------------------------------------ FE-R2 configuration

    function test_FE_R2_constructorStoresRecipientsAndOwner() public view {
        IFeeSplitter.Recipient[] memory r = splitter.recipients();
        assertEq(r.length, 2);
        assertEq(r[0].account, treasury);
        assertEq(r[0].bps, 5000);
        assertEq(r[1].account, backstop);
        assertEq(r[1].bps, 5000);
        assertEq(splitter.owner(), timelock);
    }

    function test_FE_R2_onlyOwnerSetsRecipients() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        splitter.setRecipients(_one(treasury));

        vm.expectEmit(address(splitter));
        emit IFeeSplitter.RecipientsSet(_two(backstop, 7500, treasury, 2500));
        vm.prank(timelock);
        splitter.setRecipients(_two(backstop, 7500, treasury, 2500));
        assertEq(splitter.recipients()[0].account, backstop);
        assertEq(splitter.recipients()[0].bps, 7500);
    }

    function test_FE_R2_rejectsBadConfigurations() public {
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(IFeeSplitter.BadWeightSum.selector, 9999));
        splitter.setRecipients(_two(treasury, 5000, backstop, 4999));
        vm.expectRevert(abi.encodeWithSelector(IFeeSplitter.BadWeightSum.selector, 10_001));
        splitter.setRecipients(_two(treasury, 5001, backstop, 5000));
        vm.expectRevert(abi.encodeWithSelector(IFeeSplitter.ZeroWeight.selector, 1));
        splitter.setRecipients(_two(treasury, 10_000, backstop, 0));
        vm.expectRevert(IFeeSplitter.ZeroAddress.selector);
        splitter.setRecipients(_two(address(0), 5000, backstop, 5000));
        vm.expectRevert(abi.encodeWithSelector(IFeeSplitter.DuplicateRecipient.selector, treasury));
        splitter.setRecipients(_two(treasury, 5000, treasury, 5000));
        vm.expectRevert(abi.encodeWithSelector(IFeeSplitter.BadRecipientCount.selector, 0));
        splitter.setRecipients(new IFeeSplitter.Recipient[](0));
        IFeeSplitter.Recipient[] memory nine = new IFeeSplitter.Recipient[](9);
        vm.expectRevert(abi.encodeWithSelector(IFeeSplitter.BadRecipientCount.selector, 9));
        splitter.setRecipients(nine);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(IFeeSplitter.BadWeightSum.selector, 5000));
        new FeeSplitter(timelock, _two(treasury, 2500, backstop, 2500));
    }

    function test_FE_R2_maxRecipientsAccepted() public {
        IFeeSplitter.Recipient[] memory r = new IFeeSplitter.Recipient[](8);
        for (uint256 i; i < 8; i++) {
            r[i] = IFeeSplitter.Recipient(address(uint160(0x1000 + i)), 1250);
        }
        vm.prank(timelock);
        splitter.setRecipients(r);
        usdg.mint(address(splitter), 8_000_007);
        splitter.distribute(address(usdg));
        uint256 sum;
        for (uint256 i; i < 8; i++) {
            uint256 got = usdg.balanceOf(address(uint160(0x1000 + i)));
            assertApproxEqAbs(got, 1_000_000, 1);
            sum += got;
        }
        assertEq(sum, 8_000_007);
    }

    // ------------------------------------------------------------------ FE-R2 / FE-R3 distribution

    function test_FE_R2_R3_distributeSplitsFiftyFiftyToTreasuryAndBackstopReserve() public {
        usdg.mint(address(splitter), 1_000_001);
        vm.expectEmit(address(splitter));
        emit IFeeSplitter.Distributed(address(usdg), 1_000_001);
        vm.expectEmit(address(splitter));
        emit IFeeSplitter.Paid(address(usdg), treasury, 500_000);
        vm.expectEmit(address(splitter));
        emit IFeeSplitter.Paid(address(usdg), backstop, 500_001);
        vm.prank(makeAddr("anyone")); // permissionless
        uint256 amount = splitter.distribute(address(usdg));
        assertEq(amount, 1_000_001);
        assertEq(usdg.balanceOf(treasury), 500_000);
        assertEq(usdg.balanceOf(backstop), 500_001); // FE-R3: segregated from the treasury
        assertEq(usdg.balanceOf(address(splitter)), 0);
    }

    function test_FE_R2_previewMatchesDistribute() public {
        usdg.mint(address(splitter), 12_345);
        uint256[] memory p = splitter.previewDistribute(address(usdg));
        splitter.distribute(address(usdg));
        assertEq(usdg.balanceOf(treasury), p[0]);
        assertEq(usdg.balanceOf(backstop), p[1]);
    }

    function test_FE_R2_zeroBalanceDistributeIsNoOp() public {
        vm.recordLogs();
        assertEq(splitter.distribute(address(usdg)), 0);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_FE_R2_oneWeiGoesToLastRecipient() public {
        usdg.mint(address(splitter), 1);
        splitter.distribute(address(usdg));
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(usdg.balanceOf(backstop), 1);
        assertEq(usdg.balanceOf(address(splitter)), 0);
    }

    function test_FE_R2_revertingRecipientRevertsAll() public {
        BlockingToken t = new BlockingToken(backstop);
        t.mint(address(splitter), 1000);
        vm.expectRevert(bytes("blocked"));
        splitter.distribute(address(t));
        // Nothing paid; the balance stays for a retry after the owner replaces the recipient.
        assertEq(t.balanceOf(treasury), 0);
        assertEq(t.balanceOf(address(splitter)), 1000);
        vm.prank(timelock);
        splitter.setRecipients(_two(treasury, 5000, makeAddr("newReserve"), 5000));
        splitter.distribute(address(t));
        assertEq(t.balanceOf(treasury), 500);
        assertEq(t.balanceOf(makeAddr("newReserve")), 500);
    }

    function test_FE_R2_reentrantTokenCannotDoubleDistribute() public {
        ReentrantToken t = new ReentrantToken();
        t.mint(address(splitter), 1000);
        t.arm(splitter);
        splitter.distribute(address(t));
        assertEq(bytes4(t.lastRevert()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        assertEq(t.balanceOf(treasury), 500);
        assertEq(t.balanceOf(backstop), 500);
        assertEq(t.balanceOf(address(splitter)), 0);
    }

    function testFuzz_FE_R2_splitIsExactAndWithinOneWei(uint256 balance, uint16 w0, uint16 w1, uint16 w2) public {
        balance = bound(balance, 0, type(uint128).max);
        w0 = uint16(bound(w0, 1, 9998));
        w1 = uint16(bound(w1, 1, 9999 - w0));
        w2 = uint16(10_000 - w0 - w1);
        IFeeSplitter.Recipient[] memory r = new IFeeSplitter.Recipient[](3);
        r[0] = IFeeSplitter.Recipient(makeAddr("r0"), w0);
        r[1] = IFeeSplitter.Recipient(makeAddr("r1"), w1);
        r[2] = IFeeSplitter.Recipient(makeAddr("r2"), w2);
        vm.prank(timelock);
        splitter.setRecipients(r);
        usdg.mint(address(splitter), balance);
        splitter.distribute(address(usdg));

        uint256 sum;
        for (uint256 i; i < 3; i++) {
            uint256 got = usdg.balanceOf(r[i].account);
            uint256 exactFloor = balance * r[i].bps / 10_000;
            // No recipient over (or under) its exact share by more than 1 wei.
            assertLe(got, exactFloor + 1, "over share");
            assertGe(got + 1, exactFloor, "under share");
            sum += got;
        }
        assertEq(sum, balance, "sum of transfers = balance");
        assertEq(usdg.balanceOf(address(splitter)), 0);
    }
}
