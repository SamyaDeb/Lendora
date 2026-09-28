// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {ReceiptCollateralOracle} from "../src/oracles/ReceiptCollateralOracle.sol";
import {StocklineOracleBase} from "../src/oracles/StocklineOracleBase.sol";
import {VaultV2Ids} from "../src/libraries/VaultV2Ids.sol";
import {
    IVaultV2Min,
    IVaultV2FactoryMin,
    IMorphoMarketV1AdapterV2Min,
    IMorphoMarketV1AdapterV2FactoryMin
} from "../src/interfaces/external/IMorphoVaultV2.sol";
import {StocklineDeploy} from "./StocklineDeploy.sol";

/// @notice The Vault V2 allocator call the receipt USDG vault needs (not in the frozen `IVaultV2Min`).
interface IVaultV2Liquidity {
    /// @notice Allocator: where deposits go and withdrawals come from (`MorphoMarketV1AdapterV2` + market params).
    function setLiquidityAdapterAndData(address newLiquidityAdapter, bytes memory newLiquidityData) external;
    /// @notice The adapter deposits are allocated to.
    function liquidityAdapter() external view returns (address);
    /// @notice The data passed to the liquidity adapter.
    function liquidityData() external view returns (bytes memory);
}

/// @title ReceiptMarketDeploy
/// @notice G5 receipt market (docs/prd/05-collateral-router.md §3; A3 of the Phase 4 session): lenders post `rSTOCK`
/// (a Stockline Vault V2 share) to borrow USDG. Two stages with different trust:
///
/// 1. **Deploy (anyone, keeps no power):** `ReceiptCollateralOracle` owned by the timelock from construction → the
///    Morpho market (USDG loan, `rSTOCK` collateral, AdaptiveCurveIrm, **LLTV 62.5%**; `createMarket` is
///    permissionless) seeded against share inflation → a USDG Vault V2 from the official factory whose only adapter
///    is the market (liquidity adapter, so deposits are lent and withdrawals pulled without a keeper), 10% performance
///    fee to the `FeeSplitter` (FE-R1), 48h timelocks, curator = curator multisig, owner = timelock, guardian =
///    sentinel. **Every cap stays 0**, so the vault refuses deposits and the market has no USDG to lend.
/// 2. **List (curator multisig, through the vault's own 48h timelock):** the three cap ids raised (absolute to the
///    listing cap, relative to 100%): six `submit`s encoded by the SDK tool (`receipt.list`), executable after 48h.
///    CL-R10: on 4663 the listing is only encoded once the stock market has run 30 days since launch.
abstract contract ReceiptMarketDeploy is StocklineDeploy {
    using MarketParamsLib for MarketParams;

    Vm private constant VM_R = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice 05 §3: LLTV of every receipt market at launch.
    uint256 internal constant RECEIPT_LLTV = 0.625e18;
    /// @notice CL-R10: the receipt market is listed no earlier than 30 days after the stock market's launch.
    uint256 internal constant RECEIPT_LISTING_DELAY = 30 days;
    /// @notice Raw USDG (6 dp, $1) seeded for a dead address in the market and the vault (share inflation).
    uint256 internal constant USDG_SEED = 1e6;
    /// @notice Relative cap of the single market: 100% of the vault (Vault V2 WAD).
    uint256 internal constant RECEIPT_RELATIVE_CAP = 1e18;

    /// @notice Inputs for one stock's receipt market. The stock (`wrapper`, `rVault`, `feed`) is already listed.
    struct ReceiptConfig {
        string ticker;
        address stockToken;
        address feed;
        address wrapper;
        address rVault; // the collateral: `rSTOCK`
        uint64 sigmaWad;
        address morpho;
        address irm;
        address usdg;
        address usdgFeed;
        address vaultFactory;
        address adapterFactory;
        address marketHours;
        address timelock; // owner of the oracle and the USDG vault
        address owner; // owner multisig: second allocator (as for rSTOCK vaults)
        address curator; // curator multisig: submits the listing
        address guardian; // oracle guardian, vault sentinel
        address allocator; // allocator key (the liquidity adapter needs no keeper; kept for parity)
        address guardKeeper; // oracle keeper
        address feeSplitter; // FE-R1 performance fee recipient; address(0) = no fee
        address sequencerFeed;
        address issuerRegistry;
        uint256 timelockDelay;
    }

    /// @notice What stage 1 produced.
    struct ReceiptDeployment {
        ReceiptCollateralOracle oracle;
        MarketParams market;
        address usdgVault;
        address usdgAdapter;
    }

    /// @notice Stage 1. Every call is made by `deployer` (broadcast in scripts, prank in tests); it needs
    /// `2 · USDG_SEED` USDG. No cap is raised.
    function _deployReceiptMarket(address deployer, ReceiptConfig memory r)
        internal
        returns (ReceiptDeployment memory d)
    {
        require(r.timelock != address(0) && r.curator != address(0), "receipt: timelock and curator required");
        require(IMorpho(r.morpho).isLltvEnabled(RECEIPT_LLTV), "receipt: LLTV 62.5% not enabled on Morpho");
        require(IERC20(r.usdg).balanceOf(deployer) >= 2 * USDG_SEED, "deployer needs 2 * USDG_SEED raw USDG");
        d.oracle = new ReceiptCollateralOracle(
            StocklineOracleBase.Deployment({
                stockFeed: r.feed,
                usdgFeed: r.usdgFeed,
                stockToken: r.stockToken,
                wrapper: r.wrapper,
                marketHours: r.marketHours,
                owner: r.timelock,
                guardian: r.guardian,
                keeper: r.guardKeeper,
                sequencerFeed: r.sequencerFeed,
                blocklist: r.issuerRegistry
            }),
            _oracleParams(r.sigmaWad),
            r.rVault,
            r.usdg
        );
        d.market = MarketParams({
            loanToken: r.usdg, collateralToken: r.rVault, oracle: address(d.oracle), irm: r.irm, lltv: RECEIPT_LLTV
        });
        IMorpho(r.morpho).createMarket(d.market);
        IERC20(r.usdg).approve(r.morpho, USDG_SEED);
        IMorpho(r.morpho).supply(d.market, USDG_SEED, 0, DEAD, "");

        d.usdgVault = IVaultV2FactoryMin(r.vaultFactory)
            .createVaultV2(deployer, r.usdg, keccak256(bytes(string.concat("receipt:", r.ticker))));
        d.usdgAdapter = IMorphoMarketV1AdapterV2FactoryMin(r.adapterFactory).createMorphoMarketV1AdapterV2(d.usdgVault);
        _configureReceiptVault(deployer, r, d);
    }

    function _configureReceiptVault(address deployer, ReceiptConfig memory r, ReceiptDeployment memory d) internal {
        IVaultV2Min v = IVaultV2Min(d.usdgVault);
        v.setName(string.concat("Stockline USDG (r", r.ticker, " loans)"));
        v.setSymbol(string.concat("sUSDG-r", r.ticker));
        v.setCurator(deployer); // temporary; all timelocks are still 0
        _curate(v, abi.encodeCall(IVaultV2Min.setIsAllocator, (r.allocator, true)));
        _curate(v, abi.encodeCall(IVaultV2Min.setIsAllocator, (r.owner, true)));
        _curate(v, abi.encodeCall(IVaultV2Min.setIsAllocator, (deployer, true)));
        _curate(v, abi.encodeCall(IVaultV2Min.addAdapter, (d.usdgAdapter)));
        if (r.feeSplitter != address(0)) {
            _curate(v, abi.encodeCall(IVaultV2Min.setPerformanceFeeRecipient, (r.feeSplitter)));
            _curate(v, abi.encodeCall(IVaultV2Min.setPerformanceFee, (PERFORMANCE_FEE)));
        }
        v.setMaxRate(MAX_RATE);
        // Seed while there is no liquidity adapter (with caps at 0 an allocation would revert), then route deposits.
        IERC20(r.usdg).approve(d.usdgVault, USDG_SEED);
        v.deposit(USDG_SEED, DEAD);
        IVaultV2Liquidity(d.usdgVault).setLiquidityAdapterAndData(d.usdgAdapter, abi.encode(d.market));
        if (deployer != r.allocator && deployer != r.owner) {
            _curate(v, abi.encodeCall(IVaultV2Min.setIsAllocator, (deployer, false)));
        }
        _lockAdapter(IMorphoMarketV1AdapterV2Min(d.usdgAdapter), r.timelockDelay);
        _lockVault(v, r.timelockDelay);
        v.setIsSentinel(r.guardian, true);
        v.setCurator(r.curator);
        v.setOwner(r.timelock);
    }

    /// @notice Stage 2 calls: the timelocked curator `submit`s and the calls executed after the delay. The SDK tool
    /// (`receipt.list`) encodes the same six; this is the Solidity copy for the fork tests.
    function _receiptListingCalls(ReceiptDeployment memory d, address rVault, uint256 capUsdgRaw)
        internal
        pure
        returns (bytes[6] memory calls)
    {
        bytes[3] memory ids = [
            VaultV2Ids.adapterIdData(d.usdgAdapter),
            VaultV2Ids.collateralIdData(rVault),
            VaultV2Ids.marketIdData(d.usdgAdapter, d.market)
        ];
        for (uint256 i; i < 3; i++) {
            calls[2 * i] = abi.encodeCall(IVaultV2Min.increaseAbsoluteCap, (ids[i], capUsdgRaw));
            calls[2 * i + 1] = abi.encodeCall(IVaultV2Min.increaseRelativeCap, (ids[i], RECEIPT_RELATIVE_CAP));
        }
    }

    /// @notice CL-R10 on 4663: listing only once the stock market has run 30 days since `launchTs`.
    function _assertListingWindow(uint256 chainId, uint256 launchTs, uint256 nowTs) internal pure {
        if (chainId != 4663) return;
        require(launchTs != 0, "CL-R10: set STOCK_LAUNCH_TS (the stock market's launch, from the launch log)");
        require(nowTs >= launchTs + RECEIPT_LISTING_DELAY, "CL-R10: the receipt market lists >= 30 days after launch");
    }

    /// @notice The `receipt` object stored under the stock in the address book.
    function _receiptJson(string memory key, string memory ticker, ReceiptDeployment memory d)
        internal
        returns (string memory)
    {
        string memory o = string.concat(key, "-", ticker, "-receipt");
        VM_R.serializeAddress(o, "oracle", address(d.oracle));
        VM_R.serializeAddress(o, "usdgVault", d.usdgVault);
        VM_R.serializeAddress(o, "usdgAdapter", d.usdgAdapter);
        VM_R.serializeBytes32(o, "marketId", Id.unwrap(d.market.id()));
        VM_R.serializeBytes32(o, "adapterMarketCapId", VaultV2Ids.marketId(d.usdgAdapter, d.market));
        return VM_R.serializeUint(o, "lltv", d.market.lltv);
    }
}
