// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CollateralToken} from "../../src/CollateralToken.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

contract CollateralTokenHandler is Test {
    CollateralToken public immutable cl;
    MockUSDG public immutable usdg;
    address public immutable router;
    address public immutable morpho;
    address[] public holders;
    uint256 public ghostDonated;
    uint256 public ghostMinted;
    uint256 public ghostUnwrapped;

    constructor(CollateralToken cl_, MockUSDG usdg_, address router_, address morpho_) {
        cl = cl_;
        usdg = usdg_;
        router = router_;
        morpho = morpho_;
        holders.push(makeAddr("h0"));
        holders.push(makeAddr("h1"));
        holders.push(morpho_);
        holders.push(router_);
    }

    function mint(uint256 who, uint256 amount) external {
        amount = bound(amount, 1, 1e15);
        usdg.mint(router, amount);
        vm.prank(router);
        cl.mint(holders[who % holders.length], amount);
        ghostMinted += amount;
    }

    function unwrap(uint256 who, uint256 amount, uint256 to) external {
        address h = holders[who % holders.length];
        uint256 bal = cl.balanceOf(h);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(h);
        cl.unwrap(amount, holders[to % holders.length]);
        ghostUnwrapped += amount;
    }

    /// Transfers that CL-R3 allows (one side is Morpho or the router).
    function move(uint256 from, uint256 to, uint256 amount, bool viaMorpho) external {
        address f = holders[from % holders.length];
        address t = viaMorpho ? morpho : router;
        if (f == t) t = holders[to % 2];
        uint256 bal = cl.balanceOf(f);
        amount = bound(amount, 0, bal);
        vm.prank(f);
        cl.transfer(t, amount);
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1e12);
        usdg.mint(address(cl), amount);
        ghostDonated += amount;
    }
}

/// @notice CL-R6: the backing held always covers the supply (exactly, plus donations), under fuzzed flows.
contract CollateralTokenInvariantTest is Test {
    CollateralToken internal cl;
    MockUSDG internal usdg;
    CollateralTokenHandler internal handler;

    function setUp() public {
        usdg = new MockUSDG(6);
        address router = makeAddr("router");
        address morpho = makeAddr("morpho");
        cl = new CollateralToken(address(usdg), morpho, "clUSDG", "clUSDG");
        cl.setRouter(router);
        vm.prank(router);
        usdg.approve(address(cl), type(uint256).max);
        handler = new CollateralTokenHandler(cl, usdg, router, morpho);
        targetContract(address(handler));
    }

    function invariant_CL_R6_fullyBacked() public view {
        assertGe(usdg.balanceOf(address(cl)), cl.totalSupply());
    }

    function invariant_CL_R6_exactBacking() public view {
        assertEq(usdg.balanceOf(address(cl)), cl.totalSupply() + handler.ghostDonated());
        assertEq(cl.totalSupply(), handler.ghostMinted() - handler.ghostUnwrapped());
    }
}
