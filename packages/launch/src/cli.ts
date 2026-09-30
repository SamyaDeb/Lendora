/**
 * The mainnet launcher (Part D). Use scripts/mainnet-launch.sh; see docs/runbooks/mainnet-launch.md §3.
 *
 *   scripts/mainnet-launch.sh [--dry-run] [--apply] [--services-env FILE] [--skip-suite] [--skip-fork-suites]
 *
 * Real launch: I_HAVE_THE_OWNERS_GO=1 (set by the operator after the owner's written go), every LENDORA_* role,
 * LAUNCH_DEPLOYER, LAUNCH_SIGNER=ledger|trezor|aws|gcp, ROBINHOOD_RPC_URL (the real endpoint). Dry run: the same env
 * against a local anvil fork of 4663, no go, publishes into a temp copy of the address book.
 */
import {copyFileSync, mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline/promises";
import {fileURLToPath} from "node:url";
import {launch, Refusal, run} from "./index.js";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const flag = (f: string) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dryRun = has("dry-run");
const book = dryRun ? join(mkdtempSync(join(tmpdir(), "launch-book-")), "addresses.json") : undefined;
if (book) copyFileSync(join(root, "packages/sdk/addresses.json"), book);

try {
  await launch({
    root,
    env: process.env,
    dryRun,
    apply: has("apply"),
    skipSuite: has("skip-suite"),
    skipForkSuites: has("skip-fork-suites"),
    servicesEnv: flag("services-env"),
    bookPath: book,
    run,
    log: (m) => console.log(m),
    confirm: async (summary) => {
      console.log(`\n${summary}`);
      const rl = createInterface({input: process.stdin, output: process.stdout});
      const a = await rl.question("> ");
      rl.close();
      return a;
    },
  });
  if (book) console.log(`[dry run] published into ${book} (the real address book is untouched)`);
} catch (e) {
  if (e instanceof Refusal) {
    console.error(`\nREFUSED at ${e.step}:`);
    for (const p of e.problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  throw e;
}
