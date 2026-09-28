// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, Id, MarketParams, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {MainnetConfig} from "../../script/MainnetConfig.sol";
import {DeployMainnet} from "../../script/DeployMainnet.s.sol";
import {VerifyRoles} from "../../script/VerifyRoles.s.sol";
import {LocalMocks} from "../../script/LocalMocks.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";
import {StocklineLiquidator} from "../../src/StocklineLiquidator.sol";
import {IFeeSplitter} from "../../src/interfaces/IFeeSplitter.sol";
import {VaultV2Ids} from "../../src/libraries/VaultV2Ids.sol";
import {MockSafe} from "../mocks/MockSafe.sol";
import {MockPayFirstSwap} from "../mocks/MockPayFirstSwap.sol";

/// @notice Task 7 rehearsal without an RPC: the exact mainnet configuration (roles, 48h timelocks, caps at 25% of D8,
/// `Transfer` swap mode, no sequencer feed) deployed on anvil with Safe-like placeholder multisigs and mocks for the
/// chain's externals, then `VerifyRoles` and the Phase 1 lifecycle flows against it. The fork test
/// (`test/fork/phase3/DeployMainnet.fork.t.sol`) runs the same flow on a fork of 4663 when `ROBINHOOD_RPC_URL` is set.
/// Vault V2 caches `firstTotalAssets` per transaction, so each call runs as its own transaction (as on chain).
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract DeployMainnetTest is Test, MainnetConfig, LocalMocks {
    using MarketParamsLib for MarketParams;

    uint256 internal constant WED = 1_789_574_400; // Wed 2026-09-16 12:00 ET
    uint256 internal constant NVDA = 1;

    Mocks internal m;
    Roles internal roles;
    CoreConfig internal c;
    StockConfig[] internal stocks;
    Core internal core;
    StockDeployment[] internal ds;
    MockPayFirstSwap internal dex;
    Vm.Wallet internal signer;
    VerifyRoles internal verifier;
    DnRoles internal dnRoles = DnRoles({
        operator: makeAddr("kms.dnOperator"), navSigner1: makeAddr("kms.nav1"), navSigner2: makeAddr("kms.nav2")
    });
    DnDeployment internal dn;

    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.warp(WED);
        m = _deployLocalMocks(address(this));
        signer = vm.createWallet("kms.attestationSigner");
        roles = Roles({
            owner: address(new MockSafe(4, 7, "owner")),
            curator: address(new MockSafe(3, 5, "curator")),
            guardian: address(new MockSafe(2, 4, "guardian")),
            allocator: makeAddr("kms.allocator"),
            guardKeeper: makeAddr("kms.guardKeeper"),
            treasury: address(new MockSafe(2, 3, "treasury")),
            backstopReserve: address(new MockSafe(2, 3, "backstopReserve")),
            feeKeeper: makeAddr("kms.feeKeeper"),
            attestationSigner: signer.addr
        });
        dex = new MockPayFirstSwap();
        c = _rehearsalConfig(roles);
        StockConfig[] memory s = _rehearsalStocks();
        for (uint256 i; i < s.length; i++) {
            stocks.push(s[i]);
        }
        _assertMainnetConfig(c, s, d8Targets());
        (Core memory core_, StockDeployment[] memory ds_) = _deployMainnet(c, s);
        core = core_;
        for (uint256 i; i < ds_.length; i++) {
            ds.push(ds_[i]);
        }
        _assertDnRoles(c, dnRoles);
        dn = _deployMainnetDn(c, core_, s, ds_, dnRoles);
        verifier = new VerifyRoles();
        _fundDex();
    }

    // ------------------------------------------------------------------ MN-R1…R4: the script refuses bad configs

    function test_MN_R4_refusesMainnetWithoutTheOwnersGo() public {
        DeployMainnet d = new DeployMainnet();
        vm.expectRevert(
            bytes("MN-R4: DeployMainnet refuses chain 4663 without I_HAVE_THE_OWNERS_GO=1 (the owner's go, launch log)")
        );
        d.refuseWithoutGo(4663, "");
        vm.expectRevert(
            bytes("MN-R4: DeployMainnet refuses chain 4663 without I_HAVE_THE_OWNERS_GO=1 (the owner's go, launch log)")
        );
        d.refuseWithoutGo(4663, "yes");
        vm.expectRevert(bytes("DeployMainnet is for Robinhood Chain mainnet (4663) only"));
        d.refuseWithoutGo(46_630, "1");
        vm.expectRevert(bytes("DeployMainnet is for Robinhood Chain mainnet (4663) only"));
        d.refuseWithoutGo(31_337, "1");
        d.refuseWithoutGo(4663, "1"); // the only accepted combination
    }

    function test_MN_R4_runRefusesOnAnvilAndWithoutGo() public {
        DeployMainnet d = new DeployMainnet();
        vm.expectRevert(bytes("DeployMainnet is for Robinhood Chain mainnet (4663) only"));
        d.run();
        vm.chainId(4663);
        vm.setEnv("I_HAVE_THE_OWNERS_GO", "0");
        vm.expectRevert(
            bytes("MN-R4: DeployMainnet refuses chain 4663 without I_HAVE_THE_OWNERS_GO=1 (the owner's go, launch log)")
        );
        d.run();
    }

    function test_MN_R1_refusesZeroDuplicateDeployerAndPlaceholderRoles() public {
        CoreConfig memory x = _rehearsalConfig(roles);
        x.feeKeeper = address(0);
        _expectBad(x, "MN-R1: role feeKeeper is address(0)");

        x = _rehearsalConfig(roles);
        x.guardKeeper = x.allocator; // A27: one key for two roles
        _expectBad(x, "MN-R1: roles allocator and guardKeeper are the same address (A27)");

        x = _rehearsalConfig(roles);
        x.curator = x.owner; // the runbook's old "curator == owner Safe" is refused too
        _expectBad(x, "MN-R1: roles owner and curator are the same address (A27)");

        x = _rehearsalConfig(roles);
        x.attestationSigner = address(this);
        _expectBad(x, "MN-R1: role attestationSigner is the deployer");

        x = _rehearsalConfig(roles);
        x.treasury = _placeholder("treasury");
        _expectBad(x, "MN-R1: role treasury is a placeholder address");
    }

    function test_MN_R2_refusesEoaAndWeakMultisigs() public {
        CoreConfig memory x = _rehearsalConfig(roles);
        x.backstopReserve = makeAddr("eoa-looking backstop");
        _expectBad(x, "MN-R2: backstopReserve must be a deployed multisig, not an EOA");

        x = _rehearsalConfig(roles);
        x.owner = address(new MockSafe(3, 7, "weak-owner"));
        _expectBad(x, "MN-R2: owner multisig threshold too low");

        x = _rehearsalConfig(roles);
        x.guardian = address(new MockSafe(2, 3, "small-guardian"));
        _expectBad(x, "MN-R2: guardian multisig has too few signers");

        x = _rehearsalConfig(roles);
        x.treasury = address(new MockSafe(1, 3, "1-of-3"));
        _expectBad(x, "MN-R2: treasury multisig threshold too low");

        x = _rehearsalConfig(roles);
        x.curator = address(dex); // a contract without Safe views
        _expectBad(x, "MN-R2: curator multisig threshold too low");
    }

    function test_MN_R3_refusesNonLaunchParameters() public {
        CoreConfig memory x = _rehearsalConfig(roles);
        x.timelockDelay = 24 hours;
        _expectBad(x, "MN-R3: timelock must be 48h");

        x = _rehearsalConfig(roles);
        x.sequencerFeed = makeAddr("feed");
        _expectBad(x, "MN-R3: no sequencer feed on 4663");

        x = _rehearsalConfig(roles);
        x.swapMode = IStocklineRouter.SwapMode.Approve;
        _expectBad(x, "MN-R3: swap mode must be Transfer (Q4)");

        x = _rehearsalConfig(roles);
        x.globalCollateralCap = 8_000_000e6;
        _expectBad(x, "MN-R3: global clUSDG cap must be $4M");

        StockConfig[] memory s = _rehearsalStocks();
        s[2].launchCapUsd = 250_000; // AAPL at the full D8 target instead of 25%
        vm.expectRevert(bytes("MN-R3: AAPL launch cap must be 25% of the D8 target"));
        this.assertConfigExternal(_rehearsalConfig(roles), s);
    }

    function test_MN_R3_launchCapsAre25PercentOfD8() public view {
        assertEq(stocks[0].launchCapUsd, 250_000, "SPY");
        assertEq(stocks[1].launchCapUsd, 250_000, "NVDA");
        assertEq(stocks[2].launchCapUsd, 62_500, "AAPL");
        (uint256 p,) = ds[NVDA].oracle.stockAnswer();
        assertApproxEqRel(ds[NVDA].capAssets * p / 1e8, 250_000e18, 1e12, "NVDA vault cap = $250k in wSTOCK");
        assertEq(core.router.capOf(alice, address(m.tokens[NVDA])), 250_000e18, "per-address cap unchanged (D8)");
    }

    // ------------------------------------------------------------------ MN-R5: VerifyRoles

    function test_MN_R5_verifyRolesPassesOnTheMainnetConfig() public view {
        VerifyRoles.Check[] memory cs = verifier.verify(_deployment(), _expected());
        uint256 failed = verifier.printTable(cs);
        assertEq(failed, 0, "every check passes");
        assertGt(cs.length, 60, "roles, timelock, core, fees and 3 stocks x 17 checks");
    }

    function test_MN_R5_verifyRolesReadsTheWrittenAddressBook() public {
        string memory json = _chainJson("rehearsal", c, core, stocks, ds, "", "");
        vm.writeJson(json, "deployments/rehearsal-31337.json");
        VerifyRoles.Deployment memory d = verifier.loadDeployment("deployments/rehearsal-31337.json");
        vm.removeFile("deployments/rehearsal-31337.json");
        assertEq(d.router, address(core.router));
        assertEq(d.stocks.length, 3);
        VerifyRoles.Check[] memory cs = verifier.verify(d, _expected());
        assertEq(verifier.printTable(cs), 0);
    }

    function test_MN_R5_verifyRolesFlagsDrift() public {
        VerifyRoles.Expected memory e = _expected();
        e.roles.attestationSigner = makeAddr("someone else");
        e.deployer = roles.allocator;
        VerifyRoles.Check[] memory cs = verifier.verify(_deployment(), e);
        assertTrue(_failed(cs, "router: attestationSigner"));
        assertTrue(_failed(cs, "roles: none is the deployer"));
        assertTrue(_failed(cs, "NVDA vault: deployer is not allocator or sentinel"));
        assertFalse(_failed(cs, "router: owner == timelock"));

        // A vault whose owner moved off the timelock is caught.
        vm.prank(address(core.timelock));
        IVaultV2Min(ds[NVDA].vault).setOwner(makeAddr("thief"));
        cs = verifier.verify(_deployment(), _expected());
        assertTrue(_failed(cs, "NVDA vault: owner == timelock"));
        assertFalse(_failed(cs, "SPY vault: owner == timelock"));
    }

    // ------------------------------------------------------------------ Phase 1 lifecycle on the mainnet config

    function test_MN_R5_lifecycle_lendBorrowRepayWithdraw() public {
        _lend(NVDA, 100e18);
        _onboard(alice, 20_000e6);
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        core.router.borrow(address(m.tokens[NVDA]), 5000e6, 10e18, alice, att, block.timestamp);
        assertEq(m.tokens[NVDA].balanceOf(alice), 10e18, "borrowed Stock Tokens");

        // CP-R4: exits need nothing, even with the guard tripped by the guardian Safe.
        vm.prank(roles.guardian);
        ds[NVDA].oracle.trip(1);
        vm.startPrank(alice);
        m.tokens[NVDA].approve(address(core.router), type(uint256).max);
        core.router.repay(address(m.tokens[NVDA]), 0, type(uint256).max, alice, block.timestamp);
        core.router.withdrawCollateral(address(m.tokens[NVDA]), type(uint256).max, alice, block.timestamp);
        vm.stopPrank();
        Position memory p = IMorpho(m.morpho).position(ds[NVDA].market.id(), alice);
        assertEq(p.borrowShares, 0);
        assertEq(p.collateral, 0);

        uint256 shares = IERC20(ds[NVDA].vault).balanceOf(lender);
        IVaultV2Min v = IVaultV2Min(ds[NVDA].vault);
        uint256 allocated = v.allocation(_adapterMarketId(NVDA));
        vm.prank(roles.allocator);
        v.deallocate(ds[NVDA].adapter, abi.encode(ds[NVDA].market), allocated);
        vm.prank(lender);
        core.router.withdrawLend(address(m.tokens[NVDA]), shares, 0, lender, block.timestamp);
        assertGe(m.tokens[NVDA].balanceOf(lender), 100e18, "lender gets principal back (+ interest)");
    }

    function test_MN_R5_lifecycle_shortThroughPayFirstSwap() public {
        _lend(NVDA, 100e18);
        _onboard(alice, 20_000e6);
        address nvda = address(m.tokens[NVDA]);
        IStocklineRouter.Swap memory sell = IStocklineRouter.Swap({
            target: address(dex),
            data: abi.encodeCall(MockPayFirstSwap.swap, (nvda, address(m.usdg), 5e18, address(core.router))),
            amountIn: 5e18,
            minOut: 1
        });
        uint256 before = m.usdg.balanceOf(alice);
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        uint256 out = core.router.openShort(nvda, 3000e6, 5e18, sell, false, alice, att, block.timestamp);
        assertEq(
            m.usdg.balanceOf(alice), before - 3000e6 + out, "collateral in, proceeds to the user (compound = false)"
        );
        assertApproxEqRel(out, 5 * 225.66e6, 1e12, "sold at the pay-first DEX rate");

        uint256 usdgIn = 1300e6; // buys back ~5.76 NVDA ≥ the 5 NVDA debt
        IStocklineRouter.Swap memory buy = IStocklineRouter.Swap({
            target: address(dex),
            data: abi.encodeCall(MockPayFirstSwap.swap, (address(m.usdg), nvda, usdgIn, address(core.router))),
            amountIn: usdgIn,
            minOut: 5e18
        });
        vm.prank(alice);
        core.router.closeShort(nvda, usdgIn, buy, alice, block.timestamp);
        assertEq(IMorpho(m.morpho).position(ds[NVDA].market.id(), alice).borrowShares, 0, "closed");
    }

    function test_MN_R5_lifecycle_liquidationThroughTheOwnerSafesLiquidator() public {
        _lend(NVDA, 100e18);
        _onboard(alice, 20_000e6);
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        core.router.borrow(address(m.tokens[NVDA]), 5000e6, 10e18, alice, att, block.timestamp);
        int256 up = 406e8; // +80%: debt $4,060 > 77% × $5,000
        m.feeds[NVDA].setAnswer(up);
        _setDexPrice(NVDA, uint256(up));

        uint256 seize = 3000e6;
        address bot = makeAddr("liquidatorBot");
        StocklineLiquidator.Liquidation memory l = StocklineLiquidator.Liquidation({
            market: ds[NVDA].market,
            borrower: alice,
            seizedAssets: seize,
            repaidShares: 0,
            swap: StocklineLiquidator.Swap({
                target: address(dex),
                data: abi.encodeCall(
                    MockPayFirstSwap.swap, (address(m.usdg), address(m.tokens[NVDA]), seize, address(core.liquidator))
                ),
                amountIn: seize,
                minOut: 0
            }),
            minProfit: 0,
            recipient: bot,
            deadline: block.timestamp
        });
        vm.prank(bot);
        (uint256 seized, uint256 repaid,) = core.liquidator.liquidate(l);
        assertEq(seized, seize);
        assertGt(repaid, 0);
        assertGt(m.tokens[NVDA].balanceOf(bot), 0, "liquidation bonus paid in stock to the bot");
        assertEq(core.liquidator.owner(), roles.owner, "liquidator owned by the owner Safe");
    }

    function test_MN_R5_lifecycle_feesReachTheConvertersAndOnlyTheTimelockChangesTheSplit() public {
        _lend(NVDA, 100e18);
        _onboard(alice, 200_000e6);
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        core.router.borrow(address(m.tokens[NVDA]), 100_000e6, 80e18, alice, att, block.timestamp);
        vm.warp(block.timestamp + 30 days);
        IVaultV2Min v = IVaultV2Min(ds[NVDA].vault);
        v.accrueInterest();
        uint256 fee = IERC20(ds[NVDA].vault).balanceOf(address(core.feeSplitter));
        assertGt(fee, 0, "performance fee shares minted to the splitter (FE-R1)");
        core.feeSplitter.distribute(ds[NVDA].vault);
        uint256 t = IERC20(ds[NVDA].vault).balanceOf(address(core.treasuryConverter));
        uint256 b = IERC20(ds[NVDA].vault).balanceOf(address(core.backstopConverter));
        assertEq(t + b, fee);
        assertApproxEqAbs(t, b, 1, "50/50 (Q8)");

        vm.prank(roles.owner); // not even the owner Safe: only through the 48h timelock
        vm.expectRevert();
        core.feeSplitter.setRecipients(new IFeeSplitter.Recipient[](0));
    }

    // ------------------------------------------------------------------ helpers

    function assertConfigExternal(CoreConfig memory x, StockConfig[] memory s) external view {
        _assertMainnetConfig(x, s, d8Targets());
    }

    function _expectBad(CoreConfig memory x, string memory reason) internal {
        StockConfig[] memory s = _rehearsalStocks();
        vm.expectRevert(bytes(reason));
        this.assertConfigExternal(x, s);
    }

    function _rehearsalConfig(Roles memory r) internal view returns (CoreConfig memory x) {
        x.deployer = address(this);
        x.morpho = m.morpho;
        x.irm = m.irm;
        x.usdg = address(m.usdg);
        x.usdgFeed = address(m.usdgFeed);
        x.vaultFactory = m.vaultFactory;
        x.adapterFactory = m.adapterFactory;
        x.issuerRegistry = address(m.registry);
        x.swapTarget = address(dex);
        _applyMainnetRoles(x, r);
    }

    // ------------------------------------------------------------------ MN-R7, MN-R8: Phase 4 on the mainnet config

    function test_MN_R7_dnVaultShipsWithCapsZeroAndNoVenue() public view {
        assertEq(dn.vault.totalCap(), 0);
        assertEq(dn.adapter, address(0), "no venue adapter until one is verified");
        for (uint256 i; i < 3; i++) {
            assertEq(dn.strategy.sleeve(i).capUsdg, 0);
        }
        assertEq(dn.vault.owner(), address(core.timelock));
        assertEq(dn.strategy.operator(), dnRoles.operator);
        assertEq(dn.nav.perpValue(), 0);
        assertEq(dn.vault.maxDeposit(alice), 0);
    }

    function test_MN_R7_refusesAMockVenueOrANonZeroCapOn4663() public {
        vm.chainId(4663);
        address[] memory signers = new address[](2);
        signers[0] = dnRoles.navSigner1;
        signers[1] = dnRoles.navSigner2;
        DnConfig memory dc = _dnConfig(c, core, dnRoles.operator, signers, true, 0);
        DnSleeveConfig[] memory sl = _dnSleeves(stocks, ds, new uint128[](3));
        vm.expectRevert("MN-R7: no mock perp venue on 4663");
        this.deployDnExternal(dc, sl);
        dc.mockVenue = false;
        dc.totalCap = 1;
        vm.expectRevert("MN-R7: DN vault total cap must be 0 on 4663");
        this.deployDnExternal(dc, sl);
        dc.totalCap = 0;
        sl[1].capUsdg = 1;
        vm.expectRevert("MN-R7: DN sleeve caps must be 0 on 4663");
        this.deployDnExternal(dc, sl);
    }

    function deployDnExternal(DnConfig memory dc, DnSleeveConfig[] memory sl) external returns (DnDeployment memory) {
        return _deployDnVault(dc, sl);
    }

    function test_MN_R8_dnRolesDistinctFromEachOtherAndTheCoreRoles() public {
        DnRoles memory r = dnRoles;
        r.navSigner2 = r.navSigner1;
        vm.expectRevert("MN-R8: roles navSigner1 and navSigner2 are the same");
        this.assertDnExternal(r);
        r = dnRoles;
        r.operator = roles.allocator;
        vm.expectRevert("MN-R8: role dnOperator equals core role allocator");
        this.assertDnExternal(r);
        r = dnRoles;
        r.navSigner1 = address(0);
        vm.expectRevert("MN-R8: role navSigner1 is address(0)");
        this.assertDnExternal(r);
        r = dnRoles;
        r.navSigner2 = address(this);
        vm.expectRevert("MN-R8: role navSigner2 is the deployer");
        this.assertDnExternal(r);
    }

    function assertDnExternal(DnRoles memory r) external view {
        _assertDnRoles(c, r);
    }

    function test_MN_R8_verifyRolesFlagsADnCapOrOperatorDrift() public {
        vm.prank(address(core.timelock));
        dn.vault.setTotalCap(1);
        VerifyRoles.Expected memory e = _expected();
        e.dn.operator = makeAddr("someone");
        VerifyRoles.Check[] memory cs = verifier.verify(_deployment(), e);
        assertTrue(_failed(cs, "DN vault: total cap 0 (MN-R7, Q11)"));
        assertTrue(_failed(cs, "DN strategy: operator (MN-R8)"));
        assertFalse(_failed(cs, "DN vault: owner == timelock"));
    }

    function _rehearsalStocks() internal view returns (StockConfig[] memory s) {
        s = new StockConfig[](3);
        s[0] = StockConfig("SPY", address(m.tokens[0]), address(m.feeds[0]), 0.17e18, 1_000_000, 75_000);
        s[1] = StockConfig("NVDA", address(m.tokens[1]), address(m.feeds[1]), 0.52e18, 1_000_000, 250_000);
        s[2] = StockConfig("AAPL", address(m.tokens[2]), address(m.feeds[2]), 0.28e18, 250_000, 35_000);
        s = _launchCaps(s);
    }

    function _deployment() internal view returns (VerifyRoles.Deployment memory d) {
        d.timelock = address(core.timelock);
        d.marketHours = address(core.marketHours);
        d.clUSDG = address(core.clUSDG);
        d.router = address(core.router);
        d.routerImplementation = core.routerImplementation;
        d.liquidator = address(core.liquidator);
        d.feeSplitter = address(core.feeSplitter);
        d.treasuryConverter = address(core.treasuryConverter);
        d.backstopConverter = address(core.backstopConverter);
        d.vaultFactory = m.vaultFactory;
        d.adapterFactory = m.adapterFactory;
        d.dn = VerifyRoles.DnAddrs(address(dn.vault), address(dn.strategy), address(dn.nav), dn.adapter);
        d.stocks = new VerifyRoles.StockAddrs[](ds.length);
        for (uint256 i; i < ds.length; i++) {
            d.stocks[i] = VerifyRoles.StockAddrs(
                stocks[i].ticker,
                stocks[i].token,
                address(ds[i].wrapper),
                address(ds[i].oracle),
                ds[i].vault,
                ds[i].adapter
            );
        }
    }

    function _expected() internal view returns (VerifyRoles.Expected memory) {
        return VerifyRoles.Expected({
            dn: dnRoles,
            roles: roles,
            deployer: address(this),
            swapTarget: address(dex),
            timelockDelay: MAINNET_TIMELOCK
        });
    }

    function _failed(VerifyRoles.Check[] memory cs, string memory name) internal pure returns (bool) {
        for (uint256 i; i < cs.length; i++) {
            if (keccak256(bytes(cs[i].name)) == keccak256(bytes(name))) return !cs[i].ok;
        }
        revert(string.concat("no check named ", name));
    }

    function _attest(address user) internal view returns (IStocklineRouter.Attestation memory a) {
        a.expiry = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signer.privateKey, core.router.attestationDigest(user, a.expiry));
        a.signature = abi.encodePacked(r, s, v);
    }

    function _onboard(address who, uint256 usdg) internal {
        m.usdg.mint(who, usdg);
        vm.startPrank(who);
        IERC20(address(m.usdg)).approve(address(core.router), type(uint256).max);
        IMorpho(m.morpho).setAuthorization(address(core.router), true);
        vm.stopPrank();
    }

    function _lend(uint256 i, uint256 amount) internal {
        m.tokens[i].mint(lender, amount);
        vm.startPrank(lender);
        m.tokens[i].approve(address(core.router), type(uint256).max);
        IERC20(ds[i].vault).approve(address(core.router), type(uint256).max);
        core.router.lend(address(m.tokens[i]), amount, 0, lender, block.timestamp);
        vm.stopPrank();
        IVaultV2Min v = IVaultV2Min(ds[i].vault);
        uint256 room = v.totalAssets() * 9 / 10 - v.allocation(_adapterMarketId(i));
        vm.prank(roles.allocator);
        v.allocate(ds[i].adapter, abi.encode(ds[i].market), room);
    }

    function _adapterMarketId(uint256 i) internal view returns (bytes32) {
        return VaultV2Ids.marketId(ds[i].adapter, ds[i].market);
    }

    function _fundDex() internal {
        for (uint256 i; i < 3; i++) {
            m.tokens[i].mint(address(dex), 1_000_000e18);
            _setDexPrice(i, uint256(PRICES[i]));
        }
        m.usdg.mint(address(dex), 1_000_000_000e6);
    }

    function _setDexPrice(uint256 i, uint256 p8) internal {
        dex.setRate(address(m.tokens[i]), address(m.usdg), p8 * 1e6 / 1e8);
        dex.setRate(address(m.usdg), address(m.tokens[i]), 1e38 / p8);
    }
}
