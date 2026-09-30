import {describe, expect, it} from "vitest";
import {decodeFunctionData, encodeAbiParameters, getAddress, keccak256} from "viem";
import {getDeployment} from "../src/addresses.js";
import {deltaNeutralVaultAbi, marketHoursAbi, navOracleAbi, lendoraOracleAbi, lendoraRouterAbi, strategyManagerAbi} from "../src/abis.js";
import {actionCall, operationId, saltOf, timelockAbi, timelockOperation, ZERO_BYTES32} from "../src/timelock.js";

const d = getDeployment(31337)!;

/** Remediation task 4: the calldata the runbooks give the owner multisig (rehearsed against the real
 * TimelockController on anvil in packages/devnet/test/runbooks.test.ts). */
describe("timelock calldata (runbooks)", () => {
  it("schedule / execute / cancel wrap the target call with the same operation", () => {
    const salt = saltOf("2026-10-02 NVDA re-anchor");
    const op = timelockOperation(d, {kind: "oracle.resetReferences", ticker: "NVDA"}, {delay: 172_800n, salt});
    expect(op.target).toBe(d.stocks.NVDA.oracle);
    expect(decodeFunctionData({abi: lendoraOracleAbi, data: op.data}).functionName).toBe("resetReferences");
    const s = decodeFunctionData({abi: timelockAbi, data: op.scheduleCalldata});
    expect(s.functionName).toBe("schedule");
    expect(s.args).toEqual([op.target, 0n, op.data, ZERO_BYTES32, salt, 172_800n]);
    const e = decodeFunctionData({abi: timelockAbi, data: op.executeCalldata});
    expect(e.args).toEqual([op.target, 0n, op.data, ZERO_BYTES32, salt]);
    expect(decodeFunctionData({abi: timelockAbi, data: op.cancelCalldata}).args).toEqual([op.id]);
    // OpenZeppelin TimelockController.hashOperation.
    const expected = keccak256(encodeAbiParameters([{type: "address"}, {type: "uint256"}, {type: "bytes"}, {type: "bytes32"}, {type: "bytes32"}], [op.target, 0n, op.data, ZERO_BYTES32, salt]));
    expect(op.id).toBe(expected);
    expect(operationId(op.target, 0n, op.data, ZERO_BYTES32, salt)).toBe(expected);
  });

  it("encodes every runbook action against the right contract", () => {
    const user = "0x00000000000000000000000000000000000000aa" as const;
    const cases = [
      [{kind: "oracle.clearMultiplierGuard", ticker: "SPY"}, d.stocks.SPY.oracle, lendoraOracleAbi, "clearMultiplierGuard"],
      [{kind: "oracle.setBufferFloor", ticker: "AAPL", floorWad: 0n}, d.stocks.AAPL.oracle, lendoraOracleAbi, "setBufferFloor"],
      [{kind: "oracle.setSequencerFeed", ticker: "NVDA", feed: user}, d.stocks.NVDA.oracle, lendoraOracleAbi, "setSequencerFeed"],
      [{kind: "marketHours.replaceSessionsFrom", fromIndex: 5n, sessions: [{openTs: 10n, closeTs: 20n}]}, d.marketHours, marketHoursAbi, "replaceSessionsFrom"],
      [{kind: "marketHours.replaceEventsFrom", ticker: "AAPL", fromIndex: 0n, events: [{startTs: 1n, endTs: 2n, bufferWad: 8n * 10n ** 16n}]}, d.marketHours, marketHoursAbi, "replaceEventsFrom"],
      [{kind: "router.delistMarket", ticker: "NVDA"}, d.router, lendoraRouterAbi, "delistMarket"],
      [{kind: "router.setGlobalCap", cap: 1n}, d.router, lendoraRouterAbi, "setGlobalCap"],
      [{kind: "router.setCapOverride", user, ticker: "NVDA", capUsdWad: 0n}, d.router, lendoraRouterAbi, "setCapOverride"],
      [{kind: "router.setAttestationSigner", signer: user}, d.router, lendoraRouterAbi, "setAttestationSigner"],
      [{kind: "router.setSwapTarget", target: user, mode: 0}, d.router, lendoraRouterAbi, "setSwapTarget"],
    ] as const;
    for (const [a, target, abi, fn] of cases) {
      const c = actionCall(d, a as never);
      expect(c.target, a.kind).toBe(target);
      expect(decodeFunctionData({abi: abi as never, data: c.data}).functionName, a.kind).toBe(fn);
    }
    const ev = decodeFunctionData({abi: marketHoursAbi, data: actionCall(d, cases[4][0] as never).data});
    expect(ev.args[0]).toBe(d.stocks.AAPL.stockToken);
    const co = decodeFunctionData({abi: lendoraRouterAbi, data: actionCall(d, cases[7][0] as never).data});
    expect(co.args).toEqual([getAddress(user), getAddress(d.stocks.NVDA.stockToken), 0n]);
  });

  it("Phase 4: DN vault owner actions (caps, NAV signers) through the same timelock", () => {
    const dn = d.dnVault!;
    const signer = "0x00000000000000000000000000000000000000bb" as const;
    const cases = [
      [{kind: "dnVault.setTotalCap", cap: 2_000_000n * 10n ** 6n}, dn.vault, deltaNeutralVaultAbi, "setTotalCap", [2_000_000n * 10n ** 6n]],
      [{kind: "dnStrategy.setSleeveCap", sleeve: 1n, capUsdg: 5n}, dn.strategy, strategyManagerAbi, "setSleeveCap", [1n, 5n]],
      [{kind: "navOracle.setSigner", signer, allowed: true}, dn.navOracle, navOracleAbi, "setSigner", [getAddress(signer), true]],
    ] as const;
    for (const [a, target, abi, fn, args] of cases) {
      const c = actionCall(d, a as never);
      expect(c.target, a.kind).toBe(target);
      const r = decodeFunctionData({abi: abi as never, data: c.data});
      expect(r.functionName, a.kind).toBe(fn);
      expect(r.args, a.kind).toEqual(args);
    }
    expect(() => actionCall({...d, dnVault: undefined}, {kind: "dnVault.setTotalCap", cap: 1n})).toThrow(/no DN vault/);
  });

  it("different salts give different operations; unknown tickers are refused", () => {
    const a = timelockOperation(d, {kind: "router.setGlobalCap", cap: 1n}, {delay: 1n, salt: saltOf("a")});
    const b = timelockOperation(d, {kind: "router.setGlobalCap", cap: 1n}, {delay: 1n, salt: saltOf("b")});
    expect(a.id).not.toBe(b.id);
    expect(() => actionCall(d, {kind: "router.delistMarket", ticker: "TSLA"})).toThrow(/unknown ticker TSLA/);
  });
});
