/**
 * Timelock calldata for the runbooks (docs/runbooks/*). Prints the target call, the operation id, and the calldata the
 * owner multisig sends to the TimelockController to schedule, execute (after the delay) or cancel it. Never sends.
 *
 *   pnpm --filter @stockline/sdk timelock <action> [key=value …] [--network 31337|46630|4663|fork-4663]
 *        [--salt "<label>"] [--delay <seconds>]
 *
 * Actions and keys:
 *   oracle.clearMultiplierGuard      ticker=NVDA                                   (multiplier-change.md, OR-R3)
 *   oracle.resetReferences           ticker=NVDA                                   (oracle-stale-or-rejected.md, A13)
 *   oracle.setBufferFloor            ticker=NVDA floorWad=0                        (guard-tripped.md)
 *   oracle.setParams                 ticker=NVDA params='{"zWad":"2500000000000000000",…}'
 *   oracle.setSequencerFeed          ticker=NVDA feed=0x…                          (sequencer-l2-gap.md)
 *   marketHours.replaceSessionsFrom  fromIndex=412 sessions=sdk:<fromTs> | sessions='[{"openTs":…,"closeTs":…}]'
 *   marketHours.replaceEventsFrom    ticker=AAPL fromIndex=3 events=sdk:<fromTs> | events='[…]'   (calendar-push.md)
 *   router.delistMarket              ticker=NVDA                                   (wrapper-backing-shortfall.md)
 *   router.setGlobalCap              cap=4000000000000
 *   router.setCapOverride            user=0x… ticker=NVDA capUsdWad=0              (direct-borrow.md)
 *   router.setAttestationSigner      signer=0x…
 *   router.setSwapTarget             target=0x… mode=0|1|2
 *
 * Vault V2 curator actions (the vault's own timelock, not the TimelockController; FE-R1):
 *   vault.setPerformanceFeeRecipient ticker=NVDA recipient=0x…                   (turn fees on: → FeeSplitter)
 *   vault.setPerformanceFee          ticker=NVDA feeWad=100000000000000000        (10%)
 *   These print `submitCalldata` (curator → vault), the timelocked `data` (anyone → vault after the delay) and
 *   `revokeCalldata` (curator or guardian sentinel → vault, veto).
 *
 * G5 receipt market listing (A3; list-receipt-market.md), six curator actions on the receipt USDG vault:
 *   receipt.list                     ticker=NVDA capUsdg=250000 [launchTs=<unix>]  (CL-R10: 4663 needs launchTs,
 *                                    refused before launch + 30 days)
 *
 * `sdk:<fromTs>` takes the sessions (or the ticker's event windows) from packages/sdk/data/calendar.json whose
 * open/start is at or after `fromTs`, i.e. what `gen:sessions` produced.
 */
import {eventWindowsByTickerData, feedSessions} from "../src/calendar/schedule.js";
import {getDeployment, parseDeploymentKey, type Address} from "../src/addresses.js";
import {saltOf, timelockOperation, type OracleParamsInput, type TimelockAction} from "../src/timelock.js";
import {receiptListingOperations, vaultCuratorOperation} from "../src/vaultTimelock.js";

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const kind = argv[0];
const kv: Record<string, string> = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    i++;
    continue;
  }
  const eq = argv[i].indexOf("=");
  if (eq > 0) kv[argv[i].slice(0, eq)] = argv[i].slice(eq + 1);
}
const need = (k: string) => {
  if (kv[k] === undefined) throw new Error(`${kind} needs ${k}=…`);
  return kv[k];
};
const big = (v: string) => BigInt(v);
const bigObj = <T>(json: string): T => JSON.parse(json, (_k, v) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v)) as T;

function action(): TimelockAction {
  switch (kind) {
    case "oracle.clearMultiplierGuard":
    case "oracle.resetReferences":
    case "router.delistMarket":
      return {kind, ticker: need("ticker")};
    case "oracle.setBufferFloor":
      return {kind, ticker: need("ticker"), floorWad: big(need("floorWad"))};
    case "oracle.setParams": {
      const p = bigObj<Record<string, bigint | number>>(need("params"));
      const n = (k: string) => Number(p[k]);
      const b = (k: string) => BigInt(p[k]);
      const params: OracleParamsInput = {
        zWad: b("zWad"),
        sigmaWad: b("sigmaWad"),
        bMinWad: b("bMinWad"),
        bMaxWad: b("bMaxWad"),
        rampIn: n("rampIn"),
        stockHeartbeat: n("stockHeartbeat"),
        usdgHeartbeat: n("usdgHeartbeat"),
        staleGrace: n("staleGrace"),
        sequencerGrace: n("sequencerGrace"),
        bandLowWad: b("bandLowWad"),
        bandHighWad: b("bandHighWad"),
        maxQuietMultiplierStepWad: b("maxQuietMultiplierStepWad"),
      };
      return {kind, ticker: need("ticker"), params};
    }
    case "oracle.setSequencerFeed":
      return {kind, ticker: need("ticker"), feed: need("feed") as Address};
    case "marketHours.replaceSessionsFrom": {
      const s = need("sessions");
      const sessions = s.startsWith("sdk:")
        ? feedSessions.filter((x) => x.openTs >= Number(s.slice(4))).map((x) => ({openTs: BigInt(x.openTs), closeTs: BigInt(x.closeTs)}))
        : bigObj<{openTs: bigint; closeTs: bigint}[]>(s);
      return {kind, fromIndex: big(need("fromIndex")), sessions};
    }
    case "marketHours.replaceEventsFrom": {
      const ticker = need("ticker");
      const e = need("events");
      const events = e.startsWith("sdk:") ? (eventWindowsByTickerData[ticker] ?? []).filter((x) => x.startTs >= BigInt(e.slice(4))) : bigObj<{startTs: bigint; endTs: bigint; bufferWad: bigint}[]>(e);
      return {kind, ticker, fromIndex: big(need("fromIndex")), events};
    }
    case "router.setGlobalCap":
      return {kind, cap: big(need("cap"))};
    case "router.setCapOverride":
      return {kind, user: need("user") as Address, ticker: need("ticker"), capUsdWad: big(need("capUsdWad"))};
    case "router.setAttestationSigner":
      return {kind, signer: need("signer") as Address};
    case "router.setSwapTarget":
      return {kind, target: need("target") as Address, mode: Number(need("mode")) as 0 | 1 | 2};
    default:
      throw new Error(`unknown action ${kind ?? "(none)"}; see the header of scripts/timelockCalldata.ts`);
  }
}

const network = flag("network", "31337");
const d = getDeployment(parseDeploymentKey(network));
if (!d) throw new Error(`no deployment for ${network} in addresses.json`);
if (kind === "receipt.list") {
  const chainId = network === "fork-4663" ? 4663 : Number(network);
  const capUsdg = BigInt(need("capUsdg")) * 10n ** 6n;
  const ops = receiptListingOperations(d, need("ticker"), capUsdg, {chainId, launchTs: kv.launchTs ? Number(kv.launchTs) : undefined});
  const wait = network === "46630" ? "24h" : "48h";
  console.log(
    JSON.stringify(
      {network, ticker: kv.ticker, capUsdgRaw: capUsdg.toString(), operations: ops, steps: [`1. curator → vault ${ops[0].vault}: each submitCalldata (6)`, `2. after the vault timelock (${wait})`, "3. anyone → vault: each data (6)", "veto before 3: curator or guardian → vault: revokeCalldata"]},
      null,
      2,
    ),
  );
  process.exit(0);
}
if (kind?.startsWith("vault.")) {
  const va =
    kind === "vault.setPerformanceFeeRecipient"
      ? ({kind, ticker: need("ticker"), recipient: need("recipient") as Address} as const)
      : kind === "vault.setPerformanceFee"
        ? ({kind, ticker: need("ticker"), feeWad: big(need("feeWad"))} as const)
        : undefined;
  if (!va) throw new Error(`unknown action ${kind}; see the header of scripts/timelockCalldata.ts`);
  const op = vaultCuratorOperation(d, va);
  const wait = network === "46630" ? "24h" : "48h";
  console.log(
    JSON.stringify(
      {network, ...op, steps: [`1. curator → vault ${op.vault}: submitCalldata`, `2. after the vault timelock (${wait}): executableAt(data) <= now`, `3. anyone → vault: data`, `veto before 3: curator or guardian → vault: revokeCalldata`]},
      null,
      2,
    ),
  );
  process.exit(0);
}
const a = action();
const delay = BigInt(flag("delay", network === "46630" ? "86400" : "172800"));
const label = flag("salt", `${kind} ${new Date().toISOString().slice(0, 10)}`);
const op = timelockOperation(d, a, {delay, salt: saltOf(label)});
console.log(
  JSON.stringify(
    {network, timelock: d.timelock, saltLabel: label, ...op, steps: [`1. multisig → timelock ${d.timelock}: scheduleCalldata`, `2. after ${delay}s: isOperationReady(id) → true`, `3. multisig → timelock: executeCalldata`]},
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ),
);
