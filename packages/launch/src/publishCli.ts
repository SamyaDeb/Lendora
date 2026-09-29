/** `pnpm --filter @stockline/launch publish-deployment [--name 4663] [--replace]`: deployments/<name>.json → addresses.json["4663"] (MN-R6). */
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {publishDeployment} from "./publish.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const i = process.argv.indexOf("--name");
const r = publishDeployment({deploymentsDir: join(root, "contracts/deployments"), name: i >= 0 ? process.argv[i + 1] : "4663", bookPath: join(root, "packages/sdk/addresses.json"), replace: process.argv.includes("--replace")});
if (r.problems.length) {
  console.error(r.problems.join("\n"));
  process.exit(1);
}
console.log(r.changed ? 'addresses.json chains["4663"] written' : "unchanged");
