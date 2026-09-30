/**
 * Morpho interest and AdaptiveCurveIrm vectors (Phase 2: the indexer, API and lens all derive rates and accrued totals
 * from these SDK functions, SI-R20). Checked in forge against the pinned AdaptiveCurveIrm bytecode and
 * `MorphoBalancesLib.expectedMarketBalances` on an unmodified Morpho Blue (`test/sdk/MorphoMathVectors.t.sol`).
 *
 *   pnpm --filter @lendora/sdk gen:vectors:morpho
 *
 * Deterministic (fixed seed). Writes contracts/test/vectors/{irm,morpho}.json.
 */
import {mkdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {adaptiveCurveBorrowRate, MAX_RATE_AT_TARGET, MIN_RATE_AT_TARGET} from "../src/math/irm.js";
import {expectedMarketBalances} from "../src/math/morpho.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../../contracts/test/vectors");
mkdirSync(outDir, {recursive: true});

let state = 0x5eed_2026_0928n;
function next(): bigint {
  state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
  let z = state;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
  return z ^ (z >> 31n);
}
const rand = (lo: bigint, hi: bigint) => lo + (next() % (hi - lo + 1n));
const pick = <T>(xs: T[]): T => xs[Number(next() % BigInt(xs.length))];
function write(name: string, data: unknown): void {
  const s = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? `__BIG__${v.toString()}` : v), 1).replace(/"__BIG__(\d+)"/g, "$1");
  writeFileSync(join(outDir, name), s + "\n");
}

const WAD = 10n ** 18n;
const T0 = 1_790_000_000n;

/** A market state with utilization drawn to cover 0, below/at/above target and 100%. */
function market() {
  const supply = pick([0n, rand(1n, 10n ** 6n), rand(10n ** 12n, 10n ** 24n), rand(10n ** 24n, 10n ** 27n)]);
  const uWad = pick([0n, 9n * 10n ** 17n, WAD, rand(0n, WAD), rand(85n * 10n ** 16n, 95n * 10n ** 16n)]);
  const borrow = (supply * uWad) / WAD;
  const supplyShares = supply * rand(10n ** 6n, 15n * 10n ** 5n);
  const borrowShares = borrow * rand(10n ** 6n, 12n * 10n ** 5n);
  const rat = pick([0n, MIN_RATE_AT_TARGET, MAX_RATE_AT_TARGET, rand(MIN_RATE_AT_TARGET, MAX_RATE_AT_TARGET)]);
  const elapsed = pick([0n, 1n, 12n, 3600n, 86_400n, 30n * 86_400n, rand(1n, 400n * 86_400n)]);
  return {supply, borrow, supplyShares, borrowShares, rat, elapsed};
}

const irm = [];
for (let i = 0; i < 3_000; i++) {
  const m = market();
  const r = adaptiveCurveBorrowRate({totalSupplyAssets: m.supply, totalBorrowAssets: m.borrow, lastUpdate: T0}, m.rat, T0 + m.elapsed);
  irm.push({avg: r.avgRate, borrow: m.borrow, elapsed: m.elapsed, end: r.endRateAtTarget, rat: m.rat, supply: m.supply});
}
write("irm.json", {$comment: "adaptiveCurveBorrowRate at lastUpdate = t0; `rat` = stored rateAtTarget. Generated; do not edit.", t0: T0, cases: irm});

const morpho = [];
for (let i = 0; i < 3_000; i++) {
  const m = market();
  if (m.supply === 0n) continue;
  const fee = pick([0n, rand(0n, 25n * 10n ** 16n)]);
  const x = expectedMarketBalances(
    {totalSupplyAssets: m.supply, totalSupplyShares: m.supplyShares, totalBorrowAssets: m.borrow, totalBorrowShares: m.borrowShares, lastUpdate: T0, fee},
    m.rat,
    T0 + m.elapsed,
  );
  morpho.push({
    borrowAssets: m.borrow,
    borrowShares: m.borrowShares,
    elapsed: m.elapsed,
    fee,
    rat: m.rat,
    supplyAssets: m.supply,
    supplyShares: m.supplyShares,
    xBorrowAssets: x.totalBorrowAssets,
    xBorrowShares: x.totalBorrowShares,
    xSupplyAssets: x.totalSupplyAssets,
    xSupplyShares: x.totalSupplyShares,
  });
}
write("morpho.json", {$comment: "expectedMarketBalances with the AdaptiveCurveIrm at lastUpdate = t0. Generated; do not edit.", t0: T0, cases: morpho});
console.log(`wrote ${irm.length} irm and ${morpho.length} morpho vectors to ${outDir}`);
