// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {MainnetConfig} from "../../../script/MainnetConfig.sol";
import {VerifyRoles} from "../../../script/VerifyRoles.s.sol";
import {IStocklineRouter} from "../../../src/interfaces/IStocklineRouter.sol";
import {IVaultV2Min} from "../../../src/interfaces/external/IMorphoVaultV2.sol";
import {VaultV2Ids} from "../../../src/libraries/VaultV2Ids.sol";
import {MockSafe} from "../../mocks/MockSafe.sol";
import {Phase0ForkBase} from "../phase0/Phase0ForkBase.sol";

/// @notice Task 7 (mainnet-launch §3.1, MN-R1…MN-R5) on a fork of Robinhood Chain (4663) at `latest`: the exact
/// mainnet configuration (live Morpho Blue, Vault V2 factories, Stock Tokens, USDG, Chainlink feeds, UniversalRouter;
/// 48h timelocks; caps at 25% of D8; `Transfer` swap mode; no sequencer feed) with Safe-like placeholder multisigs and
/// distinct keeper keys, then `VerifyRoles` (every check must pass, including the Vault V2 code against the official
/// factory) and the Phase 1 lend → borrow → repay → withdraw flow against it. Skips with "pending RPC" when
/// `ROBINHOOD_RPC_URL` is unset (Q7); `test/deploy/DeployMainnet.t.sol` runs the same flow on anvil.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract DeployMainnetForkTest is Phase0ForkBase, MainnetConfig {
    using MarketParamsLib for MarketParams;

    address internal deployer = makeAddr("fresh.deployer");
    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");
    Roles internal roles;
    CoreConfig internal c;
    StockConfig[] internal stocks;
    Core internal core;
    StockDeployment[] internal ds;
    Vm.Wallet internal signer;
    VerifyRoles internal verifier;

    function setUp() public override {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "pending RPC (ROBINHOOD_RPC_URL unset, Q7)");
            return;
        }
        vm.createSelectFork(rpc);
        forkBlock = block.number;
        assertEq(block.chainid, CHAIN_ID, "not Robinhood Chain");

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
        c = mainnetCoreConfig(deployer, roles);
        StockConfig[] memory s = mainnetStocks();
        _assertMainnetConfig(c, s, d8Targets());
        for (uint256 i; i < s.length; i++) {
            stocks.push(s[i]);
            deal(s[i].token, deployer, 2 * SEED, true); // the fresh deployer buys 2e-6 shares of each before launch
        }
        vm.startPrank(deployer);
        (Core memory core_, StockDeployment[] memory ds_) = _deployMainnet(c, s);
        vm.stopPrank();
        core = core_;
        for (uint256 i; i < ds_.length; i++) {
            ds.push(ds_[i]);
        }
        verifier = new VerifyRoles();
    }

    function test_MN_R5_fork_verifyRolesPassesOnTheExactMainnetConfig() public view {
        VerifyRoles.Check[] memory cs = verifier.verify(_deployment(), _expected());
        assertEq(verifier.printTable(cs), 0, "every VerifyRoles check passes on the live externals");
    }

    function test_MN_R5_fork_lendBorrowRepayWithdraw() public {
        uint256 i = 1; // NVDA
        address token = stocks[i].token;
        deal(token, lender, 100e18, true);
        vm.startPrank(lender);
        IERC20(token).approve(address(core.router), 100e18);
        core.router.lend(token, 100e18, 0, lender, block.timestamp);
        vm.stopPrank();
        IVaultV2Min v = IVaultV2Min(ds[i].vault);
        vm.prank(roles.allocator);
        v.allocate(ds[i].adapter, abi.encode(ds[i].market), 90e18);

        _freshRound(c.usdgFeed);
        _freshRound(stocks[i].feed);
        (uint256 p,) = ds[i].oracle.stockAnswer();
        uint256 collateral = p * 10 * 3 / 100; // 3x the value of 10 NVDA, USDG 6 dp
        deal(c.usdg, borrower, collateral, true);
        IStocklineRouter.Attestation memory att;
        att.expiry = block.timestamp + 1 days;
        (uint8 sv, bytes32 r, bytes32 ss) =
            vm.sign(signer.privateKey, core.router.attestationDigest(borrower, att.expiry));
        att.signature = abi.encodePacked(r, ss, sv);
        vm.startPrank(borrower);
        IERC20(c.usdg).approve(address(core.router), type(uint256).max);
        IERC20(token).approve(address(core.router), type(uint256).max);
        IMorpho(c.morpho).setAuthorization(address(core.router), true);
        core.router.borrow(token, collateral, 10e18, borrower, att, block.timestamp);
        assertEq(IERC20(token).balanceOf(borrower), 10e18);
        deal(token, borrower, 11e18, true); // interest headroom
        core.router.repay(token, 0, type(uint256).max, borrower, block.timestamp);
        core.router.withdrawCollateral(token, type(uint256).max, borrower, block.timestamp);
        vm.stopPrank();
        Position memory pos = IMorpho(c.morpho).position(ds[i].market.id(), borrower);
        assertEq(pos.borrowShares, 0);
        assertEq(pos.collateral, 0);
        vm.clearMockedCalls();

        uint256 allocated = v.allocation(VaultV2Ids.marketId(ds[i].adapter, ds[i].market));
        vm.prank(roles.allocator);
        v.deallocate(ds[i].adapter, abi.encode(ds[i].market), allocated);
        uint256 shares = IERC20(ds[i].vault).balanceOf(lender);
        vm.startPrank(lender);
        IERC20(ds[i].vault).approve(address(core.router), shares);
        core.router.withdrawLend(token, shares, 0, lender, block.timestamp);
        vm.stopPrank();
        assertGe(IERC20(token).balanceOf(lender), 100e18 - 1, "lender exits whole");
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
        d.vaultFactory = c.vaultFactory;
        d.adapterFactory = c.adapterFactory;
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
            roles: roles, deployer: deployer, swapTarget: c.swapTarget, timelockDelay: MAINNET_TIMELOCK
        });
    }

    function _freshRound(address feed) internal {
        (uint80 id, int256 answer,,, uint80 answeredIn) = AggregatorLikeM(feed).latestRoundData();
        vm.mockCall(
            feed,
            abi.encodeCall(AggregatorLikeM.latestRoundData, ()),
            abi.encode(id, answer, block.timestamp, block.timestamp, answeredIn)
        );
    }
}

interface AggregatorLikeM {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
