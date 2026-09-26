// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title OracleMath
/// @notice Pure price, buffer and health-factor math (docs/prd/04-oracle.md §1, §3). Mirrored operation-for-operation
/// by `packages/sdk/src/math/oracle.ts`; both are checked against the same vectors in `test/vectors/` (OR-R1, OR-R22).
/// Every function floors at each step, in the order written, so the SDK can reproduce results exactly.
library OracleMath {
    uint256 internal constant WAD = 1e18;
    /// @notice 8760 hours, the year in `b_full = z·σ·sqrt(closureHours / 8760)`.
    uint256 internal constant YEAR = 8760 hours;
    /// @notice Morpho's oracle price scale.
    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;

    /// @notice `clamp(z·σ·sqrt(closureSeconds / YEAR), bMin, bMax)`, all WAD (OR-R20).
    /// sqrt is `Math.sqrt(closureSeconds·1e36 / YEAR)` (floor), i.e. sqrt of the year fraction in WAD.
    function fullBuffer(uint256 zWad, uint256 sigmaWad, uint256 bMinWad, uint256 bMaxWad, uint256 closureSeconds)
        internal
        pure
        returns (uint256 b)
    {
        uint256 sqrtYearFraction = Math.sqrt(closureSeconds * 1e36 / YEAR);
        b = Math.mulDiv(Math.mulDiv(zWad, sigmaWad, WAD), sqrtYearFraction, WAD);
        if (b < bMinWad) b = bMinWad;
        if (b > bMaxWad) b = bMaxWad;
    }

    /// @notice Buffer contributed by one window (a feed closure or an event, OR-R20, OR-R14): 0 before
    /// `start − ramp`, linear ramp to `bFull` at `start`, then held until the first good round with
    /// `updatedAt >= releaseAt` (`releaseAt == 0`: never released). `t` and `updatedAt` are UTC seconds.
    function windowBuffer(uint256 bFull, uint256 start, uint256 releaseAt, uint256 ramp, uint256 t, uint256 updatedAt)
        internal
        pure
        returns (uint256)
    {
        if (releaseAt != 0 && updatedAt >= releaseAt) return 0;
        if (t >= start) return bFull;
        if (t + ramp <= start) return 0;
        return Math.mulDiv(bFull, t + ramp - start, ramp);
    }

    /// @notice Morpho price of a stock-loan market (collateral `clUSDG`, loan `wSTOCK`), D1 formula (OR-R1):
    /// `valuePerToken · usdgAnswer · 10^scaleExp / (stockAnswer · (1e18 + b))`, one mulDiv, rounded down.
    /// @param scaleExp `36 + loanDecimals − collateralDecimals + stockFeedDecimals − usdgFeedDecimals`.
    function stockLoanPrice(
        uint256 valuePerTokenWad,
        uint256 usdgAnswer,
        uint256 stockAnswer,
        uint256 bufferWad,
        uint256 scaleExp
    ) internal pure returns (uint256) {
        return Math.mulDiv(valuePerTokenWad * usdgAnswer, 10 ** scaleExp, stockAnswer * (WAD + bufferWad));
    }

    /// @notice Morpho price of a receipt-collateral market (collateral `rSTOCK`, loan USDG), D1 formula:
    /// `assetsPerShare · stockAnswer · (1e18 − b) · 10^scaleExp / (1e18 · usdgAnswer)`, rounded down.
    /// @param assetsPerShare `vault.convertToAssets(10^shareDecimals)` in raw `wSTOCK` units.
    /// @param scaleExp `36 + loanDecimals − collateralDecimals + usdgFeedDecimals − assetDecimals −
    /// stockFeedDecimals`.
    function receiptPrice(
        uint256 assetsPerShare,
        uint256 stockAnswer,
        uint256 usdgAnswer,
        uint256 bufferWad,
        uint256 scaleExp
    ) internal pure returns (uint256) {
        return Math.mulDiv(assetsPerShare * stockAnswer, (WAD - bufferWad) * 10 ** scaleExp, WAD * usdgAnswer);
    }

    /// @notice Morpho health factor in WAD: `collateral·price/1e36·lltv/1e18` (Morpho's own rounding) over
    /// `borrowed`.
    /// `type(uint256).max` when nothing is borrowed.
    function healthFactor(uint256 collateral, uint256 price, uint256 lltvWad, uint256 borrowed)
        internal
        pure
        returns (uint256)
    {
        if (borrowed == 0) return type(uint256).max;
        uint256 maxBorrow = Math.mulDiv(Math.mulDiv(collateral, price, ORACLE_PRICE_SCALE), lltvWad, WAD);
        return Math.mulDiv(maxBorrow, WAD, borrowed);
    }
}
