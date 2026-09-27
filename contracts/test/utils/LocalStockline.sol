// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "morpho-blue/src/interfaces/IMorpho.sol";
import {StocklineDeploy} from "../../script/StocklineDeploy.sol";
import {LocalMocks} from "../../script/LocalMocks.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";

/// @notice The full local deployment (script/StocklineDeploy.sol + mocks) as a test fixture: unmodified Morpho Blue,
/// AdaptiveCurveIrm and Vault V2 from pinned sources, real wrappers, oracles, clUSDG and router behind its proxy.
abstract contract LocalStockline is Test, StocklineDeploy, LocalMocks {
    uint256 internal constant WED_0916_16Z = 1_789_574_400; // Wed 2026-09-16 12:00 ET

    Mocks internal m;
    CoreConfig internal c;
    Core internal core;
    StockDeployment[] internal ds;
    Vm.Wallet internal signer;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal allocator = makeAddr("allocator");

    function setUp() public virtual {
        vm.warp(WED_0916_16Z);
        signer = vm.createWallet("attestationSigner");
        m = _deployLocalMocks(address(this));
        c = CoreConfig({
            deployer: address(this),
            morpho: m.morpho,
            irm: m.irm,
            usdg: address(m.usdg),
            usdgFeed: address(m.usdgFeed),
            vaultFactory: m.vaultFactory,
            adapterFactory: m.adapterFactory,
            issuerRegistry: address(m.registry),
            sequencerFeed: address(0),
            owner: owner,
            curator: makeAddr("curator"),
            guardian: guardian,
            allocator: allocator,
            guardKeeper: makeAddr("guardKeeper"),
            feeSplitter: makeAddr("feeSplitter"),
            timelockDelay: 48 hours,
            attestationSigner: signer.addr,
            globalCollateralCap: 4_000_000e6,
            swapTarget: address(m.dex),
            swapMode: IStocklineRouter.SwapMode.Approve
        });
        StockConfig[] memory s = new StockConfig[](3);
        s[0] = StockConfig("SPY", address(m.tokens[0]), address(m.feeds[0]), 0.17e18, 1_000_000, 75_000);
        s[1] = StockConfig("NVDA", address(m.tokens[1]), address(m.feeds[1]), 0.52e18, 1_000_000, 250_000);
        s[2] = StockConfig("AAPL", address(m.tokens[2]), address(m.feeds[2]), 0.28e18, 250_000, 35_000);
        core = _deployCore(c, s);
        for (uint256 i; i < 3; i++) {
            ds.push(_deployStock(c, core, s[i]));
        }
        core = _finalize(c, core);
    }

    // ------------------------------------------------------------------ helpers

    function _attest(address user) internal view returns (IStocklineRouter.Attestation memory a) {
        a.expiry = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signer.privateKey, core.router.attestationDigest(user, a.expiry));
        a.signature = abi.encodePacked(r, s, v);
    }

    /// @dev Mint Stock Tokens and USDG to `who`, approve the router, authorize it on Morpho.
    function _onboard(address who, uint256 stockUnits, uint256 usdg) internal {
        for (uint256 i; i < 3; i++) {
            m.tokens[i].mint(who, stockUnits);
            vm.prank(who);
            m.tokens[i].approve(address(core.router), type(uint256).max);
            vm.prank(who);
            IERC20(ds[i].vault).approve(address(core.router), type(uint256).max);
        }
        m.usdg.mint(who, usdg);
        vm.startPrank(who);
        IERC20(address(m.usdg)).approve(address(core.router), type(uint256).max);
        IMorpho(m.morpho).setAuthorization(address(core.router), true);
        vm.stopPrank();
    }

    /// @dev Lend `amount` NVDA-like units via the router and allocate up to U_MAX into the market.
    function _lendAndAllocate(uint256 i, address lender, uint256 amount) internal {
        vm.prank(lender);
        core.router.lend(address(m.tokens[i]), amount, 0, lender, block.timestamp);
        IVaultV2Min v = IVaultV2Min(ds[i].vault);
        uint256 room = v.totalAssets() * 9 / 10 - v.allocation(keccak256(abi.encode("this", ds[i].adapter)));
        vm.prank(allocator);
        v.allocate(ds[i].adapter, abi.encode(ds[i].market), room);
    }

    function _tok(uint256 i) internal view returns (MockStockToken) {
        return m.tokens[i];
    }
}
