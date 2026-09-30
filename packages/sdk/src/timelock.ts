import {encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Hex} from "viem";
import type {Address, ChainDeployment} from "./addresses.js";
import {deltaNeutralVaultAbi, marketHoursAbi, navOracleAbi, lendoraOracleAbi, lendoraRouterAbi, strategyManagerAbi} from "./abis.js";

/**
 * Timelock calldata for the owner actions the runbooks reference (docs/runbooks/*, remediation task 4). The owner of
 * the router, the oracles and `MarketHours` is an OpenZeppelin `TimelockController` (48h on mainnet, 24h on testnet);
 * the owner multisig proposes (`schedule`) and, after the delay, executes (`execute`) the same operation. This module
 * only encodes: it never sends. The CLI is `packages/sdk/scripts/timelockCalldata.ts`.
 */
export const timelockAbi = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function cancel(bytes32 id)",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function getMinDelay() view returns (uint256)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
]);

export const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

export interface SessionInput {
  openTs: bigint;
  closeTs: bigint;
}

export interface EventWindowInput {
  startTs: bigint;
  endTs: bigint;
  bufferWad: bigint;
}

/** Oracle `Params` (ILendoraOracle.Params), field for field. */
export interface OracleParamsInput {
  zWad: bigint;
  sigmaWad: bigint;
  bMinWad: bigint;
  bMaxWad: bigint;
  rampIn: number;
  stockHeartbeat: number;
  usdgHeartbeat: number;
  staleGrace: number;
  sequencerGrace: number;
  bandLowWad: bigint;
  bandHighWad: bigint;
  maxQuietMultiplierStepWad: bigint;
}

/** The owner actions the runbooks use, by name. */
export type TimelockAction =
  | {kind: "oracle.clearMultiplierGuard"; ticker: string} // OR-R3 confirm (multiplier-change.md)
  | {kind: "oracle.resetReferences"; ticker: string} // OR-R7 re-anchor (oracle-stale-or-rejected.md, A13)
  | {kind: "oracle.setBufferFloor"; ticker: string; floorWad: bigint} // lower the guardian floor
  | {kind: "oracle.setParams"; ticker: string; params: OracleParamsInput}
  | {kind: "oracle.setSequencerFeed"; ticker: string; feed: Address} // OR-R6
  | {kind: "marketHours.replaceSessionsFrom"; fromIndex: bigint; sessions: SessionInput[]} // calendar-push.md
  | {kind: "marketHours.replaceEventsFrom"; ticker: string; fromIndex: bigint; events: EventWindowInput[]} // calendar-push.md
  | {kind: "router.delistMarket"; ticker: string} // kill plan (wrapper-backing-shortfall.md, usdg-freeze.md)
  | {kind: "router.setGlobalCap"; cap: bigint}
  | {kind: "router.setCapOverride"; user: Address; ticker: string; capUsdWad: bigint} // direct-borrow.md
  | {kind: "router.setAttestationSigner"; signer: Address} // compliance signer rotation
  | {kind: "router.setSwapTarget"; target: Address; mode: 0 | 1 | 2}
  | {kind: "dnVault.setTotalCap"; cap: bigint} // USDG raw; 0 at launch until the sim gate and the risk owner (Q11)
  | {kind: "dnStrategy.setSleeveCap"; sleeve: bigint; capUsdg: bigint}
  | {kind: "navOracle.setSigner"; signer: Address; allowed: boolean}; // DN-R4 signer rotation

export interface TimelockOperation {
  action: TimelockAction["kind"];
  target: Address;
  value: bigint;
  /** The call the timelock makes. */
  data: Hex;
  predecessor: Hex;
  salt: Hex;
  delay: bigint;
  /** `TimelockController.hashOperation` (to check readiness, or cancel). */
  id: Hex;
  /** Calldata for the multisig, to the timelock. */
  scheduleCalldata: Hex;
  executeCalldata: Hex;
  cancelCalldata: Hex;
}

function stock(d: ChainDeployment, ticker: string) {
  const s = d.stocks[ticker];
  if (!s) throw new Error(`unknown ticker ${ticker} (have ${Object.keys(d.stocks).join(", ")})`);
  return s;
}

/** Target and calldata of one owner action on a deployment. */
export function actionCall(d: ChainDeployment, a: TimelockAction): {target: Address; data: Hex} {
  switch (a.kind) {
    case "oracle.clearMultiplierGuard":
      return {target: stock(d, a.ticker).oracle, data: encodeFunctionData({abi: lendoraOracleAbi, functionName: "clearMultiplierGuard"})};
    case "oracle.resetReferences":
      return {target: stock(d, a.ticker).oracle, data: encodeFunctionData({abi: lendoraOracleAbi, functionName: "resetReferences"})};
    case "oracle.setBufferFloor":
      return {target: stock(d, a.ticker).oracle, data: encodeFunctionData({abi: lendoraOracleAbi, functionName: "setBufferFloor", args: [a.floorWad]})};
    case "oracle.setParams":
      return {target: stock(d, a.ticker).oracle, data: encodeFunctionData({abi: lendoraOracleAbi, functionName: "setParams", args: [a.params]})};
    case "oracle.setSequencerFeed":
      return {target: stock(d, a.ticker).oracle, data: encodeFunctionData({abi: lendoraOracleAbi, functionName: "setSequencerFeed", args: [a.feed]})};
    case "marketHours.replaceSessionsFrom":
      return {target: d.marketHours, data: encodeFunctionData({abi: marketHoursAbi, functionName: "replaceSessionsFrom", args: [a.fromIndex, a.sessions.map((s) => ({openTs: s.openTs, closeTs: s.closeTs}))]})};
    case "marketHours.replaceEventsFrom":
      return {
        target: d.marketHours,
        data: encodeFunctionData({abi: marketHoursAbi, functionName: "replaceEventsFrom", args: [stock(d, a.ticker).stockToken, a.fromIndex, a.events.map((e) => ({startTs: e.startTs, endTs: e.endTs, bufferWad: e.bufferWad}))]}),
      };
    case "router.delistMarket":
      return {target: router(d), data: encodeFunctionData({abi: lendoraRouterAbi, functionName: "delistMarket", args: [stock(d, a.ticker).stockToken]})};
    case "router.setGlobalCap":
      return {target: router(d), data: encodeFunctionData({abi: lendoraRouterAbi, functionName: "setGlobalCap", args: [a.cap]})};
    case "router.setCapOverride":
      return {target: router(d), data: encodeFunctionData({abi: lendoraRouterAbi, functionName: "setCapOverride", args: [a.user, stock(d, a.ticker).stockToken, a.capUsdWad]})};
    case "router.setAttestationSigner":
      return {target: router(d), data: encodeFunctionData({abi: lendoraRouterAbi, functionName: "setAttestationSigner", args: [a.signer]})};
    case "router.setSwapTarget":
      return {target: router(d), data: encodeFunctionData({abi: lendoraRouterAbi, functionName: "setSwapTarget", args: [a.target, a.mode]})};
    case "dnVault.setTotalCap":
      return {target: dnVault(d).vault, data: encodeFunctionData({abi: deltaNeutralVaultAbi, functionName: "setTotalCap", args: [a.cap]})};
    case "dnStrategy.setSleeveCap":
      return {target: dnVault(d).strategy, data: encodeFunctionData({abi: strategyManagerAbi, functionName: "setSleeveCap", args: [a.sleeve, a.capUsdg]})};
    case "navOracle.setSigner":
      return {target: dnVault(d).navOracle, data: encodeFunctionData({abi: navOracleAbi, functionName: "setSigner", args: [a.signer, a.allowed]})};
  }
}

function dnVault(d: ChainDeployment) {
  if (!d.dnVault) throw new Error("deployment has no DN vault");
  return d.dnVault;
}

function router(d: ChainDeployment): Address {
  if (!d.router) throw new Error("deployment has no router");
  return d.router;
}

/** `TimelockController.hashOperation`: keccak256(abi.encode(target, value, data, predecessor, salt)). */
export function operationId(target: Address, value: bigint, data: Hex, predecessor: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{type: "address"}, {type: "uint256"}, {type: "bytes"}, {type: "bytes32"}, {type: "bytes32"}], [target, value, data, predecessor, salt]));
}

/** A salt from a human label (e.g. "2026-10-02 NVDA re-anchor"), so operations are reproducible and distinct. */
export function saltOf(label: string): Hex {
  return keccak256(new TextEncoder().encode(label));
}

/** Schedule / execute / cancel calldata for one action. `delay` must be ≥ the timelock's min delay. */
export function timelockOperation(d: ChainDeployment, a: TimelockAction, o: {delay: bigint; salt: Hex; predecessor?: Hex}): TimelockOperation {
  const {target, data} = actionCall(d, a);
  const predecessor = o.predecessor ?? ZERO_BYTES32;
  const value = 0n;
  const id = operationId(target, value, data, predecessor, o.salt);
  return {
    action: a.kind,
    target,
    value,
    data,
    predecessor,
    salt: o.salt,
    delay: o.delay,
    id,
    scheduleCalldata: encodeFunctionData({abi: timelockAbi, functionName: "schedule", args: [target, value, data, predecessor, o.salt, o.delay]}),
    executeCalldata: encodeFunctionData({abi: timelockAbi, functionName: "execute", args: [target, value, data, predecessor, o.salt]}),
    cancelCalldata: encodeFunctionData({abi: timelockAbi, functionName: "cancel", args: [id]}),
  };
}
