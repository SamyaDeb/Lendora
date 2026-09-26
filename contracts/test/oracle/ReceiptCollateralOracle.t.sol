// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ReceiptCollateralOracle} from "../../src/oracles/ReceiptCollateralOracle.sol";
import {StocklineOracleBase} from "../../src/oracles/StocklineOracleBase.sol";
import {IStocklineOracle} from "../../src/interfaces/IStocklineOracle.sol";
import {OracleMath} from "../../src/libraries/OracleMath.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockERC4626Vault} from "../mocks/MockERC4626Vault.sol";
import {OracleFixture} from "./OracleFixture.sol";

/// @notice G5 receipt-collateral oracle (collateral `rNVDA`, loan USDG): same feeds, buffer and guard as the stock-loan
/// oracle, but the buffer marks the collateral **down** (OR-R1 receipt formula, D1: no multiplier).
contract ReceiptCollateralOracleTest is OracleFixture {
    ReceiptCollateralOracle internal receipt;
    MockERC4626Vault internal vault;
    MockUSDG internal usdg;

    function setUp() public override {
        super.setUp();
        vault = new MockERC4626Vault();
        usdg = new MockUSDG(6);
        receipt = new ReceiptCollateralOracle(_deployment(), _params(), address(vault), address(usdg));
    }

    function test_OR_R1_receiptPriceFormula() public {
        assertEq(receipt.SCALE_EXP(), 6);
        assertEq(receipt.ONE_SHARE(), 1e18);
        // 1 rNVDA share = 1 wNVDA = $100 → 100 USDG → Morpho price 100e6 * 1e36 / 1e18.
        assertEq(receipt.price(), 100e24);
        vault.setAssetsPerShare(1.02e18);
        usdgFeed.setAnswer(0.9996e8);
        assertEq(receipt.price(), OracleMath.receiptPrice(1.02e18, 100e8, 0.9996e8, 0, 6));
    }

    function test_OR_R20_bufferMarksCollateralDown() public {
        _roundAt(CLOSE_0918 - 1 hours, P0);
        _warpKeepUsdgFresh(CLOSE_0918 + 1 hours);
        uint256 b = receipt.buffer();
        assertEq(b, _full(48 hours));
        assertEq(receipt.price(), 100e24 * (1e18 - b) / 1e18);
        assertLt(receipt.price(), receipt.priceAt(WED_0916_16Z));
    }

    function test_D1_multiplierDoesNotMoveReceiptPrice() public {
        uint256 before = receipt.price();
        nvda.setUIMultiplier(4e18);
        assertEq(receipt.price(), before);
    }

    function test_constructorChecks() public {
        StocklineOracleBase.Deployment memory d = _deployment();
        IStocklineOracle.Params memory p = _params();
        vm.expectRevert(IStocklineOracle.ZeroAddress.selector);
        new ReceiptCollateralOracle(d, p, address(0), address(usdg));
        MockUSDG weird = new MockUSDG(0);
        vm.mockCall(address(vault), abi.encodeWithSignature("decimals()"), abi.encode(uint8(60)));
        vm.expectRevert(ReceiptCollateralOracle.BadDecimals.selector);
        new ReceiptCollateralOracle(d, p, address(vault), address(weird));
        assertEq(receipt.VAULT(), address(vault));
        assertEq(receipt.LOAN_TOKEN(), address(usdg));
    }
}
