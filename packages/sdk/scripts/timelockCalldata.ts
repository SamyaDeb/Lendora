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
 * `sdk:<fromTs>` takes the sessions (or the ticker's event windows) from packages/sdk/data/calendar.json whose
 * open/start is at or after `fromTs`, i.e. what `gen:sessions` produced.
 */
import {eventWindowsByTickerData, feedSessions} from "../src/calendar/schedule.js";
import {getDeployment, parseDeploymentKey, type Address} from "../src/addresses.js";
import {saltOf, timelockOperation, type OracleParamsInput, type TimelockAction} from "../src/timelock.js";

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
