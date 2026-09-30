// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LocalLendora} from "../utils/LocalLendora.sol";
import {DnVaultDeploy} from "../../script/DnVaultDeploy.sol";
import {DeltaNeutralVault} from "../../src/vault/DeltaNeutralVault.sol";
import {StrategyManager} from "../../src/vault/StrategyManager.sol";
import {NavOracle} from "../../src/vault/NavOracle.sol";
import {IDeltaNeutralVault} from "../../src/interfaces/IDeltaNeutralVault.sol";
import {INavOracle} from "../../src/interfaces/INavOracle.sol";
import {IStrategyManager} from "../../src/interfaces/IStrategyManager.sol";
import {MockPerpVenue} from "../mocks/MockPerpVenue.sol";
import {MockSwapAggregator} from "../mocks/MockSwapAggregator.sol";

/// @notice Phase 4 fixture: the full local Lendora (real wrappers, oracles, `rSTOCK` Vault V2s, router, mock DEX)
/// plus the delta-neutral vault stack from `DnVaultDeploy` on the mock venue. The test contract is the timelock.
abstract contract DnVaultBase is LocalLendora, DnVaultDeploy {
    uint256 internal constant SAT_0919_16Z = WED_0916_16Z + 3 days; // Sat 12:00 ET: feed closed
    uint256 internal constant CAP = 10_000_000e6;

    DeltaNeutralVault internal vault;
    StrategyManager internal strat;
    NavOracle internal nav;
    MockPerpVenue internal venue;
    address internal operator = makeAddr("operator");
    address internal dnGuardian = makeAddr("dnGuardian");
    Vm.Wallet internal signerA;
    Vm.Wallet internal signerB;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public virtual override {
        super.setUp();
        Vm.Wallet memory wa = vm.createWallet("navSignerA");
        Vm.Wallet memory wb = vm.createWallet("navSignerB");
        (signerA, signerB) = wa.addr < wb.addr ? (wa, wb) : (wb, wa);
        address[] memory signers = new address[](2);
        signers[0] = signerA.addr;
        signers[1] = signerB.addr;
        DnConfig memory dc = DnConfig({
            deployer: address(this),
            usdg: address(m.usdg),
            attestationSource: address(core.router),
            marketHours: address(core.marketHours),
            timelock: address(this),
            guardian: dnGuardian,
            operator: operator,
            feeRecipient: address(core.feeSplitter),
            navSigners: signers,
            swapTarget: address(m.dex),
            swapMode: IStrategyManager.SwapMode.Approve,
            mockVenue: true,
            totalCap: CAP
        });
        DnSleeveConfig[] memory sl = new DnSleeveConfig[](3);
        string[3] memory t = ["SPY", "NVDA", "AAPL"];
        uint256[3] memory mmf = [uint256(0.012e18), 0.03e18, 0.03e18];
        uint256[3] memory imf = [uint256(0.02e18), 0.05e18, 0.05e18];
        for (uint256 i; i < 3; i++) {
            sl[i] = DnSleeveConfig({
                ticker: t[i],
                stockToken: address(m.tokens[i]),
                wrapper: address(ds[i].wrapper),
                rVault: ds[i].vault,
                oracle: address(ds[i].oracle),
                capUsdg: uint128(CAP),
                mmfWad: mmf[i],
                imfWad: imf[i]
            });
        }
        DnDeployment memory d = _deployDnVault(dc, sl);
        vault = d.vault;
        strat = d.strategy;
        nav = d.nav;
        venue = MockPerpVenue(d.adapter);
        m.usdg.mint(address(venue), 10_000_000e6); // venue liquidity for positive PnL
        _report();
    }

    // ------------------------------------------------------------------ helpers

    function _sign(Vm.Wallet memory w, INavOracle.Report memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(w.privateKey, nav.reportDigest(r));
        return abi.encodePacked(rr, s, v);
    }

    function _currentReport() internal view returns (INavOracle.Report memory r) {
        (, uint256 eq) = venue.onchainEquity();
        uint256[] memory sizes = new uint256[](3);
        string[3] memory t = ["SPY", "NVDA", "AAPL"];
        for (uint256 i; i < 3; i++) {
            (, sizes[i]) = venue.shortSize(keccak256(bytes(t[i])));
        }
        r = INavOracle.Report({
            equity: eq,
            deposited: venue.totalDeposited(),
            requested: venue.totalRequested(),
            tradeNonce: strat.tradeNonce(),
            timestamp: uint64(vm.getBlockTimestamp()),
            shortSizes: sizes
        });
    }

    /// @dev Report the venue equity now, signed by both signers (always accepted).
    function _report() internal {
        uint64 last = nav.lastReport().timestamp;
        if (vm.getBlockTimestamp() <= last) vm.warp(last + 1); // one report per second at most
        INavOracle.Report memory r = _currentReport();
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(signerA, r);
        sigs[1] = _sign(signerB, r);
        nav.submit(r, sigs);
    }

    function _dnAttest(address user) internal view returns (IDeltaNeutralVault.Attestation memory a) {
        a.expiry = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signer.privateKey, core.router.attestationDigest(user, a.expiry));
        a.signature = abi.encodePacked(r, s, v);
    }

    function _deposit(address user, uint256 amount) internal returns (uint256 shares) {
        m.usdg.mint(user, amount);
        IDeltaNeutralVault.Attestation memory a = _dnAttest(user);
        vm.startPrank(user);
        IERC20(address(m.usdg)).approve(address(vault), amount);
        shares = vault.deposit(amount, user, a);
        vm.stopPrank();
    }

    function _buyData(uint256 i, uint256 usdgIn) internal view returns (IStrategyManager.Swap memory) {
        return IStrategyManager.Swap(
            address(m.dex),
            abi.encodeCall(MockSwapAggregator.swap, (address(m.usdg), address(m.tokens[i]), usdgIn, 0, address(strat)))
        );
    }

    function _sellData(uint256 i, uint256 stockIn) internal view returns (IStrategyManager.Swap memory) {
        return IStrategyManager.Swap(
            address(m.dex),
            abi.encodeCall(MockSwapAggregator.swap, (address(m.tokens[i]), address(m.usdg), stockIn, 0, address(strat)))
        );
    }

    /// @dev 08 structure for sleeve `i` with `d` USDG of NAV: S = d·0.95·3/4 spot (90% lent), M = d·0.95/4 margin,
    /// short = spot units. Pulls from the vault first.
    function _build(uint256 i, uint256 d) internal {
        uint256 s = d * 95 * 3 / 400;
        uint256 mg = d * 95 / 400;
        vm.startPrank(operator);
        strat.pullFromVault(s + mg);
        uint256 got = strat.buySpot(i, s, _minOut(strat.quote(i, 1e18), s), _buyData(i, s));
        strat.lend(i, got * 9 / 10);
        strat.depositMargin(mg);
        strat.adjustShort(i, -int256(got), 0);
        vm.stopPrank();
        _report();
    }

    /// @dev The contract's floor for buying with `usdgIn` at `unitValue` (USDG raw per 1e18 stock): fair × 99%, up.
    function _minOut(uint256 unitValue, uint256 usdgIn) internal pure returns (uint256) {
        uint256 fair = usdgIn * 1e18 / unitValue;
        return fair * 99 / 100 + 1;
    }

    function _setPrice(uint256 i, int256 p) internal {
        m.feeds[i].setAnswer(p);
        m.dex.setRate(address(m.tokens[i]), address(m.usdg), uint256(p) * 1e6 / 1e8);
        m.dex.setRate(address(m.usdg), address(m.tokens[i]), uint256(1e8) * 1e36 / (uint256(p) * 1e6));
    }
}
