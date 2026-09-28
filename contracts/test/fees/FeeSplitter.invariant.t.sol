// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeSplitter} from "../../src/fees/FeeSplitter.sol";
import {IFeeSplitter} from "../../src/interfaces/IFeeSplitter.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/// @notice Random (often invalid) weight changes by the owner, fee inflows and distributions.
contract FeeSplitterHandler is Test {
    FeeSplitter public immutable splitter;
    MockUSDG public immutable token;
    address public immutable owner;
    address[] public pool;
    uint256 public ghostIn; // total minted into the splitter
    uint256 public ghostSetOk;

    constructor(FeeSplitter s, MockUSDG t, address owner_) {
        splitter = s;
        token = t;
        owner = owner_;
        for (uint256 i; i < 8; i++) {
            pool.push(makeAddr(string.concat("recipient", vm.toString(i))));
        }
    }

    function poolLength() external view returns (uint256) {
        return pool.length;
    }

    /// @dev Any weights, valid or not; invalid ones must revert and leave the old set in force.
    function setRecipients(uint256 n, uint256 seed, bool forceValid) external {
        n = bound(n, 0, 9);
        IFeeSplitter.Recipient[] memory r = new IFeeSplitter.Recipient[](n);
        uint256 left = 10_000;
        for (uint256 i; i < n; i++) {
            uint256 w = uint256(keccak256(abi.encode(seed, i))) % 10_001;
            if (forceValid) w = i == n - 1 ? left : bound(w, 1, left - (n - 1 - i));
            if (forceValid) left -= w;
            r[i] = IFeeSplitter.Recipient(pool[(seed % pool.length + i) % pool.length], uint16(w));
        }
        vm.prank(owner);
        try splitter.setRecipients(r) {
            ghostSetOk++;
        } catch {}
    }

    function accrue(uint256 amount) external {
        amount = bound(amount, 0, 1e30);
        token.mint(address(splitter), amount);
        ghostIn += amount;
    }

    function distribute() external {
        splitter.distribute(address(token));
    }
}

contract FeeSplitterInvariantTest is Test {
    FeeSplitter internal splitter;
    MockUSDG internal token;
    FeeSplitterHandler internal handler;
    address internal owner = makeAddr("timelock");

    function setUp() public {
        token = new MockUSDG(18);
        IFeeSplitter.Recipient[] memory r = new IFeeSplitter.Recipient[](2);
        r[0] = IFeeSplitter.Recipient(makeAddr("recipient0"), 5000);
        r[1] = IFeeSplitter.Recipient(makeAddr("recipient1"), 5000);
        splitter = new FeeSplitter(owner, r);
        handler = new FeeSplitterHandler(splitter, token, owner);
        targetContract(address(handler));
    }

    /// @notice FE-R2: the weights always sum to exactly 10,000, whatever the owner tried to set.
    function invariant_FE_R2_weightsSumTo10000() public view {
        IFeeSplitter.Recipient[] memory r = splitter.recipients();
        uint256 sum;
        for (uint256 i; i < r.length; i++) {
            assertGt(r[i].bps, 0);
            assertTrue(r[i].account != address(0));
            sum += r[i].bps;
        }
        assertEq(sum, 10_000);
        assertGt(r.length, 0);
        assertLe(r.length, 8);
    }

    /// @notice FE-R2: nothing is created or lost; what came in is either still held or paid to a recipient.
    function invariant_FE_R2_conservation() public view {
        uint256 paid;
        for (uint256 i; i < handler.poolLength(); i++) {
            paid += token.balanceOf(handler.pool(i));
        }
        assertEq(paid + token.balanceOf(address(splitter)), handler.ghostIn());
    }
}
