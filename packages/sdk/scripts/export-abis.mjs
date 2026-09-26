// Copies ABIs of Stockline contracts (contracts/src) from Foundry output into packages/sdk/abis.
// Run `forge build` in contracts/ first.
import {readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync} from "node:fs";
import {join, basename, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, "../../../contracts");
const outDir = join(here, "../abis");
mkdirSync(outDir, {recursive: true});

const walk = (dir) =>
  readdirSync(dir, {withFileTypes: true}).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".sol") ? [join(dir, e.name)] : [],
  );

let n = 0;
for (const src of walk(join(contracts, "src"))) {
  if (src.includes(`${"/"}mocks${"/"}`)) continue;
  const file = basename(src);
  const artifactDir = join(contracts, "out", file);
  if (!existsSync(artifactDir)) continue;
  for (const art of readdirSync(artifactDir)) {
    const {abi} = JSON.parse(readFileSync(join(artifactDir, art), "utf8"));
    writeFileSync(join(outDir, art), JSON.stringify(abi, null, 2) + "\n");
    n++;
  }
}
console.log(`exported ${n} ABIs to ${outDir}`);
