// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @notice Uniswap v3 pool stand-in for TWAP reads (OR-R31): `slot0`, `observe`, `token0/token1/fee`. The tick is
/// piecewise constant between `setTick` calls, and `observe` returns the exact time-integral of the tick, like the real
/// oracle accumulator. No swaps: the guard keeper only reads.
contract MockUniswapV3Pool {
    struct Observation {
        uint32 timestamp;
        int24 tick;
        int56 tickCumulative; // cumulative at `timestamp`
    }

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    Observation[] internal _obs;

    error OLD();

    constructor(address token0_, address token1_, uint24 fee_, int24 initialTick) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        _obs.push(Observation(uint32(block.timestamp), initialTick, 0));
    }

    /// @notice The pool trades at `tick` from now on.
    function setTick(int24 tick) external {
        Observation memory last = _obs[_obs.length - 1];
        uint32 nowTs = uint32(block.timestamp);
        int56 cum = last.tickCumulative + int56(last.tick) * int56(uint56(nowTs - last.timestamp));
        if (nowTs == last.timestamp) _obs[_obs.length - 1] = Observation(nowTs, tick, cum);
        else _obs.push(Observation(nowTs, tick, cum));
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        tick = _obs[_obs.length - 1].tick;
        return (0, tick, uint16(_obs.length - 1), uint16(_obs.length), uint16(_obs.length), 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; i++) {
            tickCumulatives[i] = _cumulativeAt(uint32(block.timestamp) - secondsAgos[i]);
        }
    }

    function _cumulativeAt(uint32 t) internal view returns (int56) {
        if (t < _obs[0].timestamp) revert OLD();
        uint256 i = _obs.length - 1;
        while (_obs[i].timestamp > t) i--;
        Observation memory o = _obs[i];
        return o.tickCumulative + int56(o.tick) * int56(uint56(t - o.timestamp));
    }
}
