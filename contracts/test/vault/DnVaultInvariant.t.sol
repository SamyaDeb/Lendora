// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDeltaNeutralVault} from "../../src/interfaces/IDeltaNeutralVault.sol";
import {INavOracle} from "../../src/interfaces/INavOracle.sol";
import {IStrategyManager} from "../../src/interfaces/IStrategyManager.sol";
import {IMarketHours} from "../../src/interfaces/IMarketHours.sol";
import {DeltaNeutralVault} from "../../src/vault/DeltaNeutralVault.sol";
import {StrategyManager} from "../../src/vault/StrategyManager.sol";
import {NavOracle} from "../../src/vault/NavOracle.sol";
import {MockPerpVenue} from "../mocks/MockPerpVenue.sol";
import {MockSwapAggregator} from "../mocks/MockSwapAggregator.sol";
import {MockChainlinkAggregator} from "../mocks/MockChainlinkAggregator.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {StocklineRouter} from "../../src/StocklineRouter.sol";
import {DnVaultBase} from "./DnVaultBase.sol";

/// @notice Everything the invariant handler needs from the fixture, in one struct.
struct DnWorld {
    DeltaNeutralVault vault;
    StrategyManager strat;
    NavOracle nav;
    MockPerpVenue venue;
    MockSwapAggregator dex;
    MockUSDG usdg;
    StocklineRouter router;
    IMarketHours hours_;
    address operator;
    address guardian;
    uint256 attesterKey;
    uint256 signerAKey;
    uint256 signerBKey;
    MockChainlinkAggregator usdgFeed;
    MockChainlinkAggregator[3] feeds;
    address[3] tokens;
    address[3] wrappers;
    address[3] rVaults;
}

/// @notice Drives users, the operator, the NAV reporter, time, prices and funding. Every action is best-effort
/// (the suite runs with `fail_on_revert`), and the per-action properties are asserted where they happen.
contract DnHandler is CommonBase, StdCheats, StdUtils {
    DnWorld internal w;
    address[3] internal users = [address(0xA11CE), address(0xB0B), address(0xCA7)];
    int256[3] internal price = [int256(772.33e8), int256(225.66e8), int256(341.45e8)];

    // ghosts
    uint256 public deposits;
    uint256 public exits;
    uint256 public settles;
    uint256 public operatorSwaps;
    uint256 public staleRefusals;
    uint256 public maliciousRefusals;
    uint256 public maxPriceDriftWad;

    constructor(DnWorld memory w_) {
        w = w_;
    }

    // ------------------------------------------------------------------ helpers

    function _live() internal view returns (bool) {
        return w.nav.fresh() && w.vault.marketOpen();
    }

    function _attest(address user) internal view returns (IDeltaNeutralVault.Attestation memory a) {
        a.expiry = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w.attesterKey, w.router.attestationDigest(user, a.expiry));
        a.signature = abi.encodePacked(r, s, v);
    }

    function _sig(uint256 key, INavOracle.Report memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key, w.nav.reportDigest(r));
        return abi.encodePacked(rr, s, v);
    }

    function report() public {
        (, uint256 eq) = w.venue.onchainEquity();
        uint256[] memory sizes = new uint256[](3);
        for (uint256 i; i < 3; i++) {
            (, sizes[i]) = w.venue.shortSize(keccak256(bytes(["SPY", "NVDA", "AAPL"][i])));
        }
        INavOracle.Report memory r = INavOracle.Report(
            eq,
            w.venue.totalDeposited(),
            w.venue.totalRequested(),
            w.strat.tradeNonce(),
            uint64(vm.getBlockTimestamp()),
            sizes
        );
        if (r.timestamp <= w.nav.lastReport().timestamp) return;
        address a = vm.addr(w.signerAKey);
        address b = vm.addr(w.signerBKey);
        bytes[] memory sigs = new bytes[](2);
        (sigs[0], sigs[1]) =
            a < b ? (_sig(w.signerAKey, r), _sig(w.signerBKey, r)) : (_sig(w.signerBKey, r), _sig(w.signerAKey, r));
        w.nav.submit(r, sigs);
    }

    function _refreshFeeds() internal {
        for (uint256 i; i < 3; i++) {
            w.feeds[i].setAnswer(price[i]);
        }
        w.usdgFeed.setAnswer(1e8);
    }

    uint256 internal _supplyBefore;

    /// @dev Assert that an operation at a fresh NAV left the share price unchanged, up to rounding and ERC-4626's
    /// virtual share (1e12 units) and asset (1 wei), whose weight is 1e12 / supply of the price. An empty vault
    /// before or after quotes the virtual price only: nothing to compare.
    function _checkPrice(uint256 before) internal {
        uint256 s0 = _supplyBefore;
        uint256 s1 = w.vault.totalSupply();
        if (s0 == 0 || s1 == 0) return;
        uint256 afterP = w.vault.sharePrice();
        uint256 d = afterP > before ? afterP - before : before - afterP;
        uint256 minS = s0 < s1 ? s0 : s1;
        uint256 tol = 1e9 + before * 2e12 / minS;
        if (d > maxPriceDriftWad) maxPriceDriftWad = d;
        require(d <= tol, "share price moved on deposit/withdraw/settle");
    }

    // ------------------------------------------------------------------ users

    function deposit(uint256 u, uint256 amount) external {
        address user = users[u % 3];
        amount = bound(amount, 1e6, 200_000e6);
        w.usdg.mint(user, amount);
        IDeltaNeutralVault.Attestation memory a = _attest(user);
        vm.prank(user);
        IERC20(address(w.usdg)).approve(address(w.vault), amount);
        bool live = _live();
        uint256 supply = w.vault.totalSupply();
        if (live) w.vault.accrueFee();
        uint256 p0 = live ? w.vault.sharePrice() : 0;
        _supplyBefore = w.vault.totalSupply();
        bool roomy = live && w.vault.totalAssets() + amount <= w.vault.totalCap();
        vm.prank(user);
        try w.vault.deposit(amount, user, a) {
            require(live, "DN-R5/R12: minted on a stale NAV or a closed session");
            require(w.vault.totalAssets() <= w.vault.totalCap(), "DN-R6: cap exceeded");
            _checkPrice(p0);
            deposits++;
        } catch {
            require(!roomy, "a live, roomy deposit failed");
            require(w.vault.totalSupply() == supply, "supply moved on a failed deposit");
            if (!live) staleRefusals++;
        }
    }

    function withdraw(uint256 u, uint256 frac) external {
        address user = users[u % 3];
        bool live = _live();
        if (live) w.vault.accrueFee();
        uint256 max = w.vault.maxWithdraw(user);
        uint256 amount = live ? bound(frac, 0, max) : bound(frac, 1, 1e6);
        if (amount == 0) return;
        uint256 p0 = live ? w.vault.sharePrice() : 0;
        _supplyBefore = w.vault.totalSupply();
        vm.prank(user);
        try w.vault.withdraw(amount, user, user) {
            require(live, "DN-R5/R12: burned on a stale NAV or a closed session");
            _checkPrice(p0);
            exits++;
        } catch {
            if (!live) staleRefusals++;
        }
    }

    function requestRedeem(uint256 u, uint256 frac) external {
        address user = users[u % 3];
        uint256 bal = w.vault.balanceOf(user);
        if (bal == 0) return;
        uint256 shares = bound(frac, 1, bal);
        vm.prank(user);
        w.vault.requestRedeem(shares, user, user); // CP-R4: never refused
    }

    function settle(uint256 n) external {
        bool live = _live();
        if (live) w.vault.accrueFee();
        uint256 p0 = live ? w.vault.sharePrice() : 0;
        _supplyBefore = w.vault.totalSupply();
        try w.vault.settle(bound(n, 1, 5)) returns (uint256 k) {
            require(live, "DN-R5/R12: settled on a stale NAV");
            _checkPrice(p0);
            settles += k;
        } catch {
            require(!live, "a live settle reverted");
        }
    }

    function claim(uint256 idSeed) external {
        (uint256 head,) = w.vault.queueBounds();
        if (head == 0) return;
        uint256 id = bound(idSeed, 0, head - 1);
        IDeltaNeutralVault.Request memory r = w.vault.request(id);
        if (r.status != IDeltaNeutralVault.RequestStatus.Claimable) return;
        uint256 before = IERC20(address(w.usdg)).balanceOf(r.receiver);
        w.vault.claim(id); // never gated
        require(IERC20(address(w.usdg)).balanceOf(r.receiver) == before + r.assets, "claim paid");
    }

    // ------------------------------------------------------------------ world

    function warp(uint256 secs, bool refresh) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 3 hours));
        if (refresh) {
            _refreshFeeds();
            report();
        }
    }

    function move(uint256 i, int256 bps) external {
        i %= 3;
        bps = bound(bps, -300, 300);
        price[i] = price[i] * (10_000 + bps) / 10_000;
        w.feeds[i].setAnswer(price[i]);
        uint256 p = uint256(price[i]);
        w.dex.setRate(w.tokens[i], address(w.usdg), p * 1e6 / 1e8);
        w.dex.setRate(address(w.usdg), w.tokens[i], uint256(1e8) * 1e36 / (p * 1e6));
    }

    function funding(uint256 i, int256 rate) external {
        try w.venue.applyFunding(keccak256(bytes(["SPY", "NVDA", "AAPL"][i % 3])), bound(rate, -1e15, 1e15)) {} catch {}
    }

    // ------------------------------------------------------------------ operator

    function build(uint256 i, uint256 usdg) external {
        i %= 3;
        usdg = bound(usdg, 1000e6, 100_000e6);
        uint256 s = usdg * 3 / 4;
        vm.startPrank(w.operator);
        try w.strat.pullFromVault(usdg) {} catch {}
        uint256 have = IERC20(address(w.usdg)).balanceOf(address(w.strat));
        if (have >= usdg) {
            uint256 unit = w.strat.quote(i, 1e18);
            uint256 minOut = (s * 1e18 / unit) * 99 / 100 + 1;
            IStrategyManager.Swap memory sw = IStrategyManager.Swap(
                address(w.dex),
                abi.encodeCall(MockSwapAggregator.swap, (address(w.usdg), w.tokens[i], s, 0, address(w.strat)))
            );
            try w.strat.buySpot(i, s, minOut, sw) returns (uint256 got) {
                operatorSwaps++;
                IStrategyManager.Sleeve memory sl = w.strat.sleeve(i);
                require(w.strat.quote(i, w.strat.spotUnits(i)) <= sl.capUsdg, "DN-R6: sleeve cap");
                try w.strat.lend(i, got * 9 / 10) {} catch {}
                try w.strat.depositMargin(usdg - s) {} catch {}
                try w.strat.adjustShort(i, -int256(got), 0) {} catch {}
            } catch {}
        }
        vm.stopPrank();
    }

    function unwind(uint256 i, uint256 frac) external {
        i %= 3;
        frac = bound(frac, 1, 100);
        vm.startPrank(w.operator);
        uint256 shares = IERC20(w.rVaults[i]).balanceOf(address(w.strat)) * frac / 100;
        if (shares > 0) try w.strat.unlend(i, shares) {} catch {}
        uint256 wrapped = IERC20(w.wrappers[i]).balanceOf(address(w.strat)) * frac / 100;
        if (wrapped > 0) {
            uint256 v = w.strat.quote(i, wrapped);
            IStrategyManager.Swap memory sw = IStrategyManager.Swap(
                address(w.dex),
                abi.encodeCall(MockSwapAggregator.swap, (w.tokens[i], address(w.usdg), wrapped, 0, address(w.strat)))
            );
            try w.strat.sellSpot(i, wrapped, (v * 99 + 99) / 100, sw) {
                operatorSwaps++;
            } catch {}
        }
        (, uint256 size) = w.venue.shortSize(keccak256(bytes(["SPY", "NVDA", "AAPL"][i])));
        if (size > 0) try w.strat.adjustShort(i, int256(size * frac / 100), 0) {} catch {}
        (, uint256 eq) = w.venue.onchainEquity();
        if (eq > 0) try w.strat.requestMarginWithdraw(eq * frac / 200) {} catch {}
        try w.strat.claimMargin() {} catch {}
        uint256 u = IERC20(address(w.usdg)).balanceOf(address(w.strat));
        if (u > 0) w.strat.returnToVault(u);
        vm.stopPrank();
    }

    /// @dev DN-R10: an operator trying to route value away must fail.
    function malicious(uint256 i, uint256 usdg, bool loose) external {
        i %= 3;
        usdg = bound(usdg, 1e6, 10_000e6);
        uint256 unit = w.strat.quote(i, 1e18);
        uint256 fair = usdg * 1e18 / unit;
        IStrategyManager.Swap memory sw = IStrategyManager.Swap(
            address(w.dex),
            abi.encodeCall(
                MockSwapAggregator.swap, (address(w.usdg), w.tokens[i], usdg, 0, loose ? address(w.strat) : w.operator)
            )
        );
        uint256 minOut = loose ? fair * 97 / 100 : fair * 99 / 100 + 1; // 3% below fair, or proceeds to the operator
        vm.prank(w.operator);
        try w.strat.buySpot(i, usdg, minOut, sw) {
            revert("DN-R10: a loose or misdirected swap succeeded");
        } catch {
            maliciousRefusals++;
        }
    }
}

/// @notice Invariants of the delta-neutral vault (Phase 4 task 14): share price stable across deposits and exits, no
/// mint/burn on a stale NAV (asserted in the handler), the operator can't extract value, the queue is FIFO and always
/// settleable from the vault's assets after an unwind, caps respected.
/// forge-config: default.invariant.fail_on_revert = true
/// forge-config: default.isolate = true
contract DnVaultInvariantTest is DnVaultBase {
    DnHandler internal h;

    function setUp() public override {
        super.setUp();
        venue.setWithdrawDelay(0);
        m.usdg.mint(address(m.dex), 1_000_000_000e6);
        for (uint256 i; i < 3; i++) {
            m.tokens[i].mint(address(m.dex), 10_000_000e18);
        }
        DnWorld memory world;
        world.vault = vault;
        world.strat = strat;
        world.nav = nav;
        world.venue = venue;
        world.dex = m.dex;
        world.usdg = m.usdg;
        world.router = core.router;
        world.hours_ = core.marketHours;
        world.operator = operator;
        world.guardian = dnGuardian;
        world.attesterKey = signer.privateKey;
        world.signerAKey = signerA.privateKey;
        world.signerBKey = signerB.privateKey;
        world.usdgFeed = m.usdgFeed;
        for (uint256 i; i < 3; i++) {
            world.feeds[i] = m.feeds[i];
            world.tokens[i] = address(m.tokens[i]);
            world.wrappers[i] = address(ds[i].wrapper);
            world.rVaults[i] = ds[i].vault;
        }
        h = new DnHandler(world);
        // The handler moves feeds and DEX rates and applies funding (the mocks are ungated on anvil).
        targetContract(address(h));
        excludeSender(address(vault));
    }

    /// @dev FIFO bookkeeping: everything before the head is settled, everything from it queued; escrow and reserves add
    /// up and are backed.
    function invariant_DN_R1_queueIsFifoAndBooked() public view {
        (uint256 head, uint256 tail) = vault.queueBounds();
        uint256 escrow;
        uint256 owed;
        for (uint256 id; id < tail; id++) {
            IDeltaNeutralVault.Request memory r = vault.request(id);
            if (id < head) {
                assertTrue(
                    r.status == IDeltaNeutralVault.RequestStatus.Claimable
                        || r.status == IDeltaNeutralVault.RequestStatus.Claimed
                );
                if (r.status == IDeltaNeutralVault.RequestStatus.Claimable) owed += r.assets;
            } else {
                assertEq(uint8(r.status), uint8(IDeltaNeutralVault.RequestStatus.Queued));
                escrow += r.shares;
            }
        }
        assertEq(vault.escrowedShares(), escrow, "escrow");
        assertEq(vault.balanceOf(address(vault)), escrow, "escrowed shares held by the vault");
        assertEq(vault.reserved(), owed, "reserved = claimable");
        assertGe(IERC20(address(m.usdg)).balanceOf(address(vault)), owed, "claims are backed");
    }

    /// @dev DN-R10: nothing ever reaches the operator.
    function invariant_DN_R10_operatorHoldsNothing() public view {
        assertEq(IERC20(address(m.usdg)).balanceOf(operator), 0);
        assertEq(vault.balanceOf(operator), 0);
        for (uint256 i; i < 3; i++) {
            assertEq(IERC20(address(m.tokens[i])).balanceOf(operator), 0);
            assertEq(IERC20(address(ds[i].wrapper)).balanceOf(operator), 0);
            assertEq(IERC20(ds[i].vault).balanceOf(operator), 0);
        }
    }

    /// @dev DN-R1: the queue is always settleable from the vault's assets: unwind everything (guardian), report,
    /// settle every request, all within a snapshot that is then discarded.
    function invariant_DN_R1_queueAlwaysSettleableAfterAnUnwind() public {
        uint256 snap = vm.snapshotState();
        uint256 t = vm.getBlockTimestamp();
        if (!core.marketHours.isOpen(t)) {
            (, uint256 reopen,,) = core.marketHours.closureWindows(t);
            vm.warp(reopen + 1 hours);
        }
        for (uint256 i; i < 3; i++) {
            (, int256 a,,,) = m.feeds[i].latestRoundData();
            m.feeds[i].setAnswer(a);
        }
        m.usdgFeed.setAnswer(1e8);
        vm.startPrank(dnGuardian);
        for (uint256 i; i < 3; i++) {
            uint256 sh = IERC20(ds[i].vault).balanceOf(address(strat));
            if (sh > 0) strat.unlend(i, sh);
            uint256 wr = IERC20(address(ds[i].wrapper)).balanceOf(address(strat));
            if (wr > 0) {
                uint256 v = strat.quote(i, wr);
                // The contract's own floor (1% slippage, rounded up): 0 for dust worth 0 USDG, which the guardian
                // may sell for nothing. `v * 99 / 100 + 1` demanded 1 unit out of dust and reverted.
                strat.sellSpot(i, wr, (v * 99 + 99) / 100, _sellData(i, wr));
            }
            (, uint256 size) = venue.shortSize(keccak256(bytes(["SPY", "NVDA", "AAPL"][i])));
            if (size > 0) strat.adjustShort(i, int256(size), 0);
        }
        (, uint256 eq) = venue.onchainEquity();
        if (eq > 0) strat.requestMarginWithdraw(eq);
        strat.claimMargin();
        uint256 u = IERC20(address(m.usdg)).balanceOf(address(strat));
        if (u > 0) strat.returnToVault(u);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1);
        h.report();
        vault.settle(type(uint256).max);
        (uint256 head, uint256 tail) = vault.queueBounds();
        assertEq(head, tail, "every queued request settles after an unwind");
        vm.revertToState(snap);
    }

    function invariant_DN_R6_totalCapAndSleeveCaps() public view {
        assertLe(vault.totalCap(), CAP);
        for (uint256 i; i < 3; i++) {
            assertLe(strat.sleeve(i).capUsdg, CAP);
        }
    }

    function afterInvariant() public {
        emit log_named_uint("deposits", h.deposits());
        emit log_named_uint("instant exits", h.exits());
        emit log_named_uint("settled", h.settles());
        emit log_named_uint("operator swaps", h.operatorSwaps());
        emit log_named_uint("stale/closed refusals", h.staleRefusals());
        emit log_named_uint("malicious swaps refused", h.maliciousRefusals());
        emit log_named_uint("max share-price drift (wad)", h.maxPriceDriftWad());
    }
}
