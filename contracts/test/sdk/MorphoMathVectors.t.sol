// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IMorpho, MarketParams, Market, Id} from "morpho-blue/src/interfaces/IMorpho.sol";
import {IIrm} from "morpho-blue/src/interfaces/IIrm.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";
import {MorphoStorageLib} from "morpho-blue/src/libraries/periphery/MorphoStorageLib.sol";
import {MorphoDeployer} from "../utils/MorphoDeployer.sol";

interface IAdaptiveCurveIrmView {
    function rateAtTarget(Id id) external view returns (int256);
}

/// @notice SI-R20 and the Phase 2 "one source of truth" rule: the SDK's AdaptiveCurveIrm mirror
/// (`packages/sdk/src/math/irm.ts`) and `expectedMarketBalances` (`math/morpho.ts`) equal the pinned AdaptiveCurveIrm
/// bytecode and `MorphoBalancesLib` on an unmodified Morpho Blue, exactly, on the vectors from
/// `packages/sdk/scripts/genMorphoVectors.ts`.
contract MorphoMathVectorsTest is Test {
    using MarketParamsLib for MarketParams;

    // Forge decodes JSON objects with keys in alphabetical order.
    struct IrmCase {
        uint256 avg;
        uint256 borrow;
        uint256 elapsed;
        uint256 end;
        uint256 rat;
        uint256 supply;
    }

    struct BalanceCase {
        uint256 borrowAssets;
        uint256 borrowShares;
        uint256 elapsed;
        uint256 fee;
        uint256 rat;
        uint256 supplyAssets;
        uint256 supplyShares;
        uint256 xBorrowAssets;
        uint256 xBorrowShares;
        uint256 xSupplyAssets;
        uint256 xSupplyShares;
    }

    function _irm(address morpho) internal returns (address) {
        return vm.deployCode("out/AdaptiveCurveIrm.sol/AdaptiveCurveIrm.json", abi.encode(morpho));
    }

    /// @dev `rateAtTarget` is the IRM's only storage (slot 0 mapping; MORPHO is immutable).
    function _setRateAtTarget(address irm, Id id, uint256 rat) internal {
        vm.store(irm, keccak256(abi.encode(Id.unwrap(id), uint256(0))), bytes32(rat));
    }

    function test_SI_R20_adaptiveCurveIrmVectorsMatchSdk() public {
        string memory json = vm.readFile("test/vectors/irm.json");
        uint256 t0 = vm.parseJsonUint(json, ".t0");
        IrmCase[] memory cases = abi.decode(vm.parseJson(json, ".cases"), (IrmCase[]));
        assertGe(cases.length, 3000);
        address irm = _irm(address(this)); // this test plays Morpho so it can call borrowRate()
        MarketParams memory p = MarketParams(address(1), address(2), address(3), irm, 0.77e18);
        Id id = p.id();
        for (uint256 i; i < cases.length; i++) {
            IrmCase memory c = cases[i];
            Market memory m = Market(uint128(c.supply), 0, uint128(c.borrow), 0, uint128(t0), 0);
            _setRateAtTarget(irm, id, c.rat);
            vm.warp(t0 + c.elapsed);
            assertEq(IIrm(irm).borrowRateView(p, m), c.avg, string.concat("avg ", vm.toString(i)));
            IIrm(irm).borrowRate(p, m);
            assertEq(uint256(IAdaptiveCurveIrmView(irm).rateAtTarget(id)), c.end, string.concat("end ", vm.toString(i)));
        }
    }

    function test_SI_R20_expectedMarketBalancesVectorsMatchSdk() public {
        string memory json = vm.readFile("test/vectors/morpho.json");
        uint256 t0 = vm.parseJsonUint(json, ".t0");
        BalanceCase[] memory cases = abi.decode(vm.parseJson(json, ".cases"), (BalanceCase[]));
        assertGe(cases.length, 2000);
        IMorpho morpho = MorphoDeployer.deploy(address(this));
        address irm = _irm(address(morpho));
        morpho.enableIrm(irm);
        morpho.enableLltv(0.77e18);
        MarketParams memory p = MarketParams(address(1), address(2), address(3), irm, 0.77e18);
        morpho.createMarket(p);
        Id id = p.id();
        for (uint256 i; i < cases.length; i++) {
            BalanceCase memory c = cases[i];
            vm.store(
                address(morpho),
                MorphoStorageLib.marketTotalSupplyAssetsAndSharesSlot(id),
                bytes32(c.supplyAssets | (c.supplyShares << 128))
            );
            vm.store(
                address(morpho),
                MorphoStorageLib.marketTotalBorrowAssetsAndSharesSlot(id),
                bytes32(c.borrowAssets | (c.borrowShares << 128))
            );
            vm.store(address(morpho), MorphoStorageLib.marketLastUpdateAndFeeSlot(id), bytes32(t0 | (c.fee << 128)));
            _setRateAtTarget(irm, id, c.rat);
            vm.warp(t0 + c.elapsed);
            (uint256 sa, uint256 ss, uint256 ba, uint256 bs) = MorphoBalancesLib.expectedMarketBalances(morpho, p);
            string memory tag = vm.toString(i);
            assertEq(sa, c.xSupplyAssets, string.concat("supplyAssets ", tag));
            assertEq(ss, c.xSupplyShares, string.concat("supplyShares ", tag));
            assertEq(ba, c.xBorrowAssets, string.concat("borrowAssets ", tag));
            assertEq(bs, c.xBorrowShares, string.concat("borrowShares ", tag));
        }
    }
}
