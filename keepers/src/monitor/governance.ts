import {keccak256, parseAbiItem, type Hex, type Log, type PublicClient} from "viem";
import {decodeStocklineCall, type ChainDeployment} from "@stockline/sdk";
import type {Observation} from "./rules.js";
import type {MonitorStore} from "./store.js";

/**
 * Governance watch (docs/prd/10 MON-R16…R18, threat model §7): every scheduled and executed timelock operation and
 * every role change on a Stockline contract pages, with the call decoded by the SDK. Two timelocks exist:
 * - the OpenZeppelin `TimelockController` (owner of router, oracles, `MarketHours`, vaults, splitter, converters):
 *   `CallScheduled` → `TIMELOCK_SCHEDULED`; `CallExecuted` → `TIMELOCK_EXECUTED`, or `TIMELOCK_EXECUTED_UNTRACKED`
 *   (P0) when this monitor never saw (and paged) the schedule, i.e. nobody had the delay to react;
 * - each Vault V2's own curator timelock: `Submit` → `TIMELOCK_SCHEDULED`; `Accept` → executed (same rules).
 * Its cursor starts at the head on first run (deploy-time role events do not page): start the monitor before the
 * first governance action (mainnet-launch §4).
 */
const EV = {
  callScheduled: parseAbiItem("event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)"),
  callExecuted: parseAbiItem("event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)"),
  cancelled: parseAbiItem("event Cancelled(bytes32 indexed id)"),
  roleGranted: parseAbiItem("event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)"),
  roleRevoked: parseAbiItem("event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)"),
  minDelayChange: parseAbiItem("event MinDelayChange(uint256 oldDuration, uint256 newDuration)"),
  submit: parseAbiItem("event Submit(bytes4 indexed selector, bytes data, uint256 executableAt)"),
  accept: parseAbiItem("event Accept(bytes4 indexed selector, bytes data)"),
  revoke: parseAbiItem("event Revoke(address indexed sender, bytes4 indexed selector, bytes data)"),
  setOwner: parseAbiItem("event SetOwner(address indexed newOwner)"),
  setCurator: parseAbiItem("event SetCurator(address indexed newCurator)"),
  setIsSentinel: parseAbiItem("event SetIsSentinel(address indexed account, bool newIsSentinel)"),
  setIsAllocator: parseAbiItem("event SetIsAllocator(address indexed account, bool newIsAllocator)"),
  ownershipTransferred: parseAbiItem("event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"),
  roleSet: parseAbiItem("event RoleSet(bytes32 indexed role, address account)"),
  attestationSignerSet: parseAbiItem("event AttestationSignerSet(address signer)"),
  upgraded: parseAbiItem("event Upgraded(address indexed implementation)"),
  keeperSet: parseAbiItem("event KeeperSet(address keeper)"),
  destinationSet: parseAbiItem("event DestinationSet(address destination)"),
  recipientsSet: parseAbiItem("event RecipientsSet((address account, uint16 bps)[] recipients)"),
} as const;

/** Events that are role changes (ROLE_CHANGED, MON-R18), by name. */
const ROLE_EVENTS = new Set(["RoleGranted", "RoleRevoked", "MinDelayChange", "SetOwner", "SetCurator", "SetIsSentinel", "SetIsAllocator", "OwnershipTransferred", "RoleSet", "AttestationSignerSet", "Upgraded", "KeeperSet", "DestinationSet", "RecipientsSet"]);

type AnyLog = Log & {eventName: string; args: Record<string, unknown>};
const lc = (a: string) => a.toLowerCase();
const str = (v: unknown): unknown => (typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(str) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)])) : v);

export class GovernanceWatch {
  private readonly labels = new Map<string, string>();

  constructor(
    private readonly client: PublicClient,
    private readonly d: ChainDeployment,
    private readonly store: MonitorStore,
    private readonly chunk: bigint,
  ) {
    const add = (a: string | undefined, l: string) => a && this.labels.set(lc(a), l);
    add(d.timelock, "timelock");
    add(d.router, "router");
    add(d.marketHours, "marketHours");
    add(d.liquidator, "liquidator");
    add(d.feeSplitter, "feeSplitter");
    add(d.treasuryConverter, "treasuryConverter");
    add(d.backstopConverter, "backstopConverter");
    for (const [t, s] of Object.entries(d.stocks)) {
      add(s.oracle, `oracle:${t}`);
      add(s.vault, `vault:${t}`);
    }
  }

  private label(a: string): string {
    return this.labels.get(lc(a)) ?? a;
  }

  /** Scan new logs up to `head`; push observations. */
  async scan(head: bigint, obs: Observation[]): Promise<void> {
    const cur = await this.store.cursor("governance");
    if (cur === undefined) {
      await this.store.setCursor("governance", head); // first run: from now on (see the class comment)
      return;
    }
    const addresses = [...this.labels.keys()] as `0x${string}`[];
    for (let lo = cur + 1n; lo <= head; lo += this.chunk) {
      const hi = lo + this.chunk - 1n < head ? lo + this.chunk - 1n : head;
      const logs = (await this.client.getLogs({address: addresses, events: Object.values(EV), fromBlock: lo, toBlock: hi})) as unknown as AnyLog[];
      logs.sort((a, b) => (a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : a.blockNumber! < b.blockNumber! ? -1 : 1));
      for (const l of logs) await this.handle(l, obs);
      await this.store.setCursor("governance", hi);
    }
  }

  private async handle(l: AnyLog, obs: Observation[]): Promise<void> {
    const where = {contract: this.label(l.address), address: l.address, tx: l.transactionHash, block: l.blockNumber!.toString(), logIndex: l.logIndex};
    const isTimelock = lc(l.address) === lc(this.d.timelock);
    const vaultTicker = this.label(l.address).startsWith("vault:") ? this.label(l.address).slice(6) : undefined;
    const a = l.args;

    if (isTimelock && l.eventName === "CallScheduled") {
      const call = decodeStocklineCall(this.d, a.target as `0x${string}`, a.data as Hex);
      const key = `timelock:${a.id as string}:${String(a.index)}`;
      await this.store.markScheduled(key);
      obs.push({rule: "TIMELOCK_SCHEDULED", subject: key, active: true, title: `Timelock scheduled: ${call.summary}`, details: {...where, id: a.id, delaySec: String(a.delay), call: str(call)}});
      return;
    }
    if (isTimelock && l.eventName === "CallExecuted") {
      const call = decodeStocklineCall(this.d, a.target as `0x${string}`, a.data as Hex);
      const key = `timelock:${a.id as string}:${String(a.index)}`;
      const tracked = await this.store.wasScheduled(key);
      obs.push({rule: tracked ? "TIMELOCK_EXECUTED" : "TIMELOCK_EXECUTED_UNTRACKED", subject: key, active: true, title: `Timelock executed${tracked ? "" : " (schedule never paged)"}: ${call.summary}`, details: {...where, id: a.id, call: str(call)}});
      return;
    }
    if (isTimelock && l.eventName === "Cancelled") {
      obs.push({rule: "TIMELOCK_SCHEDULED", subject: `timelock:${a.id as string}:cancelled`, active: true, title: `Timelock operation cancelled: ${a.id as string}`, details: {...where, id: a.id}});
      return;
    }
    if (vaultTicker && (l.eventName === "Submit" || l.eventName === "Accept" || l.eventName === "Revoke")) {
      const data = a.data as Hex;
      const call = decodeStocklineCall(this.d, l.address, data);
      const key = `vault:${vaultTicker}:${keccak256(data)}`;
      if (l.eventName === "Submit") {
        await this.store.markScheduled(key);
        obs.push({rule: "TIMELOCK_SCHEDULED", subject: `${key}:${where.block}`, active: true, title: `Vault ${vaultTicker} curator action submitted: ${call.summary}`, details: {...where, executableAt: String(a.executableAt), call: str(call)}});
      } else if (l.eventName === "Accept") {
        const tracked = await this.store.wasScheduled(key);
        obs.push({rule: tracked ? "TIMELOCK_EXECUTED" : "TIMELOCK_EXECUTED_UNTRACKED", subject: `${key}:${where.block}`, active: true, title: `Vault ${vaultTicker} curator action executed${tracked ? "" : " (submit never paged)"}: ${call.summary}`, details: {...where, call: str(call)}});
      } else {
        obs.push({rule: "TIMELOCK_SCHEDULED", subject: `${key}:revoked:${where.block}`, active: true, title: `Vault ${vaultTicker} curator action revoked: ${call.summary}`, details: {...where, by: a.sender, call: str(call)}});
      }
      return;
    }
    if (ROLE_EVENTS.has(l.eventName)) {
      obs.push({rule: "ROLE_CHANGED", subject: `${where.contract}:${l.eventName}:${l.transactionHash}:${l.logIndex}`, active: true, title: `${where.contract}: ${l.eventName}`, details: {...where, event: l.eventName, args: str(a)}});
    }
  }
}
