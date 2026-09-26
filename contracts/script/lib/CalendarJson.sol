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

    /// @dev Mirrors one `sessions[]` entry; forge decodes JSON objects with keys in alphabetical order.
    struct SessionJson {
        uint256 closeTs;
        string closeUtc;
        uint256 openTs;
        string openUtc;
    }

    /// @dev Mirrors one `events.<TICKER>[]` entry (alphabetical keys).
    struct EventJson {
        string bufferWad;
        uint256 endTs;
        string endUtc;
        uint256 startTs;
    }

    function sessions(string memory json) internal pure returns (IMarketHours.Session[] memory out) {
        SessionJson[] memory raw = abi.decode(vm.parseJson(json, ".sessions"), (SessionJson[]));
        out = new IMarketHours.Session[](raw.length);
        for (uint256 i; i < raw.length; i++) {
            out[i] = IMarketHours.Session(uint64(raw[i].openTs), uint64(raw[i].closeTs));
        }
    }

    /// @notice Event windows for `ticker` (empty if the calendar has none).
    function events(string memory json, string memory ticker)
        internal
        view
        returns (IMarketHours.EventWindow[] memory out)
    {
        string memory key = string.concat(".events.", ticker);
        if (!vm.keyExistsJson(json, key)) return out;
        EventJson[] memory raw = abi.decode(vm.parseJson(json, key), (EventJson[]));
        out = new IMarketHours.EventWindow[](raw.length);
        for (uint256 i; i < raw.length; i++) {
            out[i] = IMarketHours.EventWindow(
                uint64(raw[i].startTs), uint64(raw[i].endTs), uint64(vm.parseUint(raw[i].bufferWad))
            );
        }
    }
}
