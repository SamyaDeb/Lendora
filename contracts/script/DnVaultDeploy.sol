// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeltaNeutralVault} from "../src/vault/DeltaNeutralVault.sol";
import {StrategyManager} from "../src/vault/StrategyManager.sol";
import {NavOracle} from "../src/vault/NavOracle.sol";
import {IStrategyManager} from "../src/interfaces/IStrategyManager.sol";
import {MockPerpVenue} from "../test/mocks/MockPerpVenue.sol";
import {LendoraDeploy} from "./LendoraDeploy.sol";

/// @dev Feed getter of `LendoraOracleBase`.
interface IStockFeedOf {
    function STOCK_FEED() external view returns (address);
}

/// @title DnVaultDeploy
/// @notice Phase 4 deployment logic shared by the scripts (anvil, testnet, mainnet config) and the tests: the
/// `DeltaNeutralVault`, its `StrategyManager` and `NavOracle`, and on anvil/testnet a `MockPerpVenue` (Q11: testnet
/// uses the mock venue only). **Every cap is taken from the config and every deploy config passes 0** (DN-R6, Q11)
/// until
/// the simulation gate passes and the risk owner signs. Ownership of the three contracts ends at the timelock.
abstract contract DnVaultDeploy is LendoraDeploy {
    Vm private constant VM_DN = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice 08 launch structure: `c` = 5% (buffer), swap floor 1%, NAV max age 15 min open and closed (DN-R5).
    uint256 internal constant DN_BUFFER_BPS = 500;
    uint256 internal constant DN_MAX_SLIPPAGE_BPS = 100;
    uint256 internal constant DN_MAX_AGE = 15 minutes;
    /// @notice DN-R8 default until the sim sets it per sleeve (the sim recommends a dynamic ratio, report §5).
    uint16 internal constant DN_MAX_LEND_BPS = 9000;

    struct DnConfig {
        address deployer;
        address usdg;
        address attestationSource; // the router (RT-R2 signer and domain)
        address marketHours;
        address timelock; // final owner of the vault, strategy and NAV oracle
        address guardian;
        address operator; // rebalancer key
        address feeRecipient; // FeeSplitter (DN-R9)
        address[] navSigners; // NAV reporter + second signer (DN-R4)
        address swapTarget; // UniversalRouter on 4663, the mock DEX elsewhere
        IStrategyManager.SwapMode swapMode;
        bool mockVenue; // anvil / testnet only (MN-R7: refused on 4663)
        uint256 totalCap; // 0 in every deploy config (Q11)
    }

    struct DnSleeveConfig {
        string ticker;
        address stockToken;
        address wrapper;
        address rVault;
        address oracle;
        uint128 capUsdg; // 0 in every deploy config
        uint256 mmfWad; // mock venue maintenance fraction (Lighter: SPY 1.2%, NVDA/AAPL 3%)
        uint256 imfWad; // mock venue initial fraction (Lighter: SPY 2%, NVDA/AAPL 5%)
    }

    struct DnDeployment {
        DeltaNeutralVault vault;
        StrategyManager strategy;
        NavOracle nav;
        address adapter; // zero unless a venue is wired
    }

    /// @notice The venue market id of a ticker (mock venue; a live adapter maps its own ids).
    function _perpMarket(string memory ticker) internal pure returns (bytes32) {
        return keccak256(bytes(ticker));
    }

    function _deployDnVault(DnConfig memory c, DnSleeveConfig[] memory sleeves)
        internal
        returns (DnDeployment memory d)
    {
        require(c.timelock != address(0) && c.guardian != address(0) && c.operator != address(0), "dn: roles");
        if (block.chainid == 4663) {
            // MN-R7: mainnet never gets the mock venue, and ships with every cap at 0 until the gate passes (Q11).
            require(!c.mockVenue, "MN-R7: no mock perp venue on 4663");
            require(c.totalCap == 0, "MN-R7: DN vault total cap must be 0 on 4663");
            for (uint256 i; i < sleeves.length; i++) {
                require(sleeves[i].capUsdg == 0, "MN-R7: DN sleeve caps must be 0 on 4663");
            }
        }
        d.vault = new DeltaNeutralVault(
            IERC20(c.usdg), c.deployer, c.attestationSource, c.marketHours, c.guardian, c.feeRecipient, DN_BUFFER_BPS
        );
        d.strategy = new StrategyManager(c.deployer, address(d.vault), c.operator, c.guardian, DN_MAX_SLIPPAGE_BPS);
        d.nav = new NavOracle(c.deployer, address(d.vault), address(d.strategy), DN_MAX_AGE, DN_MAX_AGE);
        for (uint256 i; i < c.navSigners.length; i++) {
            d.nav.setSigner(c.navSigners[i], true);
        }
        d.vault.setStrategy(address(d.strategy));
        d.vault.setNavOracle(address(d.nav));
        d.vault.setTotalCap(c.totalCap);

        if (c.mockVenue) {
            MockPerpVenue venue = new MockPerpVenue(c.usdg, address(d.strategy));
            for (uint256 i; i < sleeves.length; i++) {
                venue.listMarket(
                    _perpMarket(sleeves[i].ticker),
                    IStockFeedOf(sleeves[i].oracle).STOCK_FEED(),
                    sleeves[i].mmfWad,
                    sleeves[i].imfWad
                );
            }
            d.adapter = address(venue);
            d.strategy.setAdapter(d.adapter);
        }
        for (uint256 i; i < sleeves.length; i++) {
            d.strategy
                .addSleeve(
                    IStrategyManager.Sleeve({
                        stockToken: sleeves[i].stockToken,
                        wrapper: sleeves[i].wrapper,
                        rVault: sleeves[i].rVault,
                        oracle: sleeves[i].oracle,
                        perpMarket: _perpMarket(sleeves[i].ticker),
                        capUsdg: sleeves[i].capUsdg,
                        maxLendBps: DN_MAX_LEND_BPS,
                        active: true
                    })
                );
        }
        if (c.swapTarget != address(0)) d.strategy.setSwapTarget(c.swapTarget, c.swapMode);

        d.vault.transferOwnership(c.timelock);
        d.strategy.transferOwnership(c.timelock);
        d.nav.transferOwnership(c.timelock);
    }

    // ------------------------------------------------------------------ Config helpers and address book

    /// @notice Sleeves for the listed stocks, with the venue margin fractions of Lighter (SPY 1.2% / 2%, others
    /// 3% / 5%) for the mock venue, and the given spot caps (0 on testnet and mainnet).
    function _dnSleeves(StockConfig[] memory stocks, StockDeployment[] memory ds, uint128[] memory caps)
        internal
        pure
        returns (DnSleeveConfig[] memory sl)
    {
        sl = new DnSleeveConfig[](stocks.length);
        for (uint256 i; i < stocks.length; i++) {
            bool spy = keccak256(bytes(stocks[i].ticker)) == keccak256("SPY");
            sl[i] = DnSleeveConfig({
                ticker: stocks[i].ticker,
                stockToken: stocks[i].token,
                wrapper: address(ds[i].wrapper),
                rVault: ds[i].vault,
                oracle: address(ds[i].oracle),
                capUsdg: caps[i],
                mmfWad: spy ? 0.012e18 : 0.03e18,
                imfWad: spy ? 0.02e18 : 0.05e18
            });
        }
    }

    /// @notice The DN config for a Lendora deployment: router attestations, the timelock, the guardian, the
    /// `FeeSplitter`, the core swap target.
    function _dnConfig(
        CoreConfig memory c,
        Core memory core,
        address operator,
        address[] memory navSigners,
        bool mockVenue,
        uint256 totalCap
    ) internal pure returns (DnConfig memory) {
        return DnConfig({
            deployer: c.deployer,
            usdg: c.usdg,
            attestationSource: address(core.router),
            marketHours: address(core.marketHours),
            timelock: address(core.timelock),
            guardian: c.guardian,
            operator: operator,
            feeRecipient: address(core.feeSplitter),
            navSigners: navSigners,
            swapTarget: c.swapTarget,
            swapMode: IStrategyManager.SwapMode(uint8(c.swapMode)),
            mockVenue: mockVenue,
            totalCap: totalCap
        });
    }

    /// @notice The `dnVault` object of an address-book chain entry.
    function _dnJson(string memory key, DnDeployment memory d) internal returns (string memory) {
        string memory o = string.concat(key, "-dnVault");
        VM_DN.serializeAddress(o, "vault", address(d.vault));
        VM_DN.serializeAddress(o, "strategy", address(d.strategy));
        VM_DN.serializeAddress(o, "navOracle", address(d.nav));
        return VM_DN.serializeAddress(o, "perpAdapter", d.adapter);
    }

    /// @notice Write `dnVault` under `chains.<key>` of packages/sdk/addresses.json (never the real 4663 key).
    function _writeDn(string memory key, DnDeployment memory d) internal {
        require(keccak256(bytes(key)) != keccak256("4663"), "never write the real 4663 key from a script");
        VM_DN.writeJson(_dnJson(key, d), "../packages/sdk/addresses.json", string.concat(".chains.", key, ".dnVault"));
    }
}
