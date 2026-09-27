// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IMarketHours} from "../../src/interfaces/IMarketHours.sol";

/// @notice Reads `packages/sdk/data/calendar.json` (written by `genSessions.ts`, OR-R11) into `MarketHours` structs.
/// Shared by the deploy scripts and the tests, so both use exactly the generator's output.
library CalendarJson {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string internal constant PATH = "../packages/sdk/data/calendar.json";

    function read() internal view returns (string memory) {
        return vm.readFile(PATH);
    }

    function sessions(string memory json) internal pure returns (IMarketHours.Session[] memory out) {
        uint256[] memory opens = vm.parseJsonUintArray(json, ".sessionOpens");
        uint256[] memory closes = vm.parseJsonUintArray(json, ".sessionCloses");
        out = new IMarketHours.Session[](opens.length);
        for (uint256 i; i < opens.length; i++) {
            out[i] = IMarketHours.Session(uint64(opens[i]), uint64(closes[i]));
        }
    }

    /// @notice Event windows for `ticker` (empty if the calendar has none).
    function events(string memory json, string memory ticker)
        internal
        view
        returns (IMarketHours.EventWindow[] memory out)
    {
        string memory key = string.concat(".eventArrays.", ticker);
        if (!vm.keyExistsJson(json, key)) return out;
        uint256[] memory starts = vm.parseJsonUintArray(json, string.concat(key, ".starts"));
        uint256[] memory ends = vm.parseJsonUintArray(json, string.concat(key, ".ends"));
        string[] memory buffers = vm.parseJsonStringArray(json, string.concat(key, ".buffers"));
        out = new IMarketHours.EventWindow[](starts.length);
        for (uint256 i; i < starts.length; i++) {
            out[i] = IMarketHours.EventWindow(uint64(starts[i]), uint64(ends[i]), uint64(vm.parseUint(buffers[i])));
        }
    }
}
