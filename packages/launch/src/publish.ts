import {existsSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {isAddress} from "viem";

const REQUIRED = ["morpho", "adaptiveCurveIrm", "usdg", "usdgFeed", "timelock", "marketHours", "clUSDG", "router", "routerImplementation", "liquidator", "feeSplitter", "treasuryConverter", "backstopConverter", "vaultV2Factory", "adapterFactory"] as const;
const STOCK_REQUIRED = ["stockToken", "wrapper", "oracle", "feed", "vault", "adapter"] as const;
const ROLES = ["owner", "curator", "guardian", "allocator", "guardKeeper", "treasury", "feeKeeper", "backstopReserve"] as const;

type Entry = Record<string, unknown> & {stocks: Record<string, Record<string, unknown>>; roles: Record<string, string>};

/** The deployment file's problems (shape of an address-book chain entry). */
export function validateDeployment(e: Record<string, unknown>): string[] {
  const out: string[] = [];
  const addr = (v: unknown) => typeof v === "string" && isAddress(v, {strict: false}) && !/^0x0{40}$/i.test(v);
  for (const k of REQUIRED) if (!addr(e[k])) out.push(`${k} missing or not an address`);
  const roles = e.roles as Record<string, unknown> | undefined;
  for (const r of ROLES) if (!addr(roles?.[r])) out.push(`roles.${r} missing`);
  const stocks = e.stocks as Record<string, Record<string, unknown>> | undefined;
  if (!stocks || Object.keys(stocks).length === 0) out.push("no stocks");
  for (const [t, s] of Object.entries(stocks ?? {})) for (const k of STOCK_REQUIRED) if (!addr(s[k])) out.push(`stocks.${t}.${k} missing`);
  if (!/^\d+$/.test(String(e.deployBlock ?? e.startBlock ?? ""))) out.push("deployBlock missing (the indexer's start block)");
  const dn = e.dnVault as Record<string, unknown> | undefined;
  if (dn) for (const k of ["vault", "strategy", "navOracle"]) if (!addr(dn[k])) out.push(`dnVault.${k} missing`);
  return out;
}

/**
 * MN-R6 publish (launch step 6): `contracts/deployments/<name>.json` (+ any `<name>-receipt-<TICKER>.json`, G5 after
 * launch + 30 days) → `addresses.json.chains["4663"]`. The only writer of the 4663 key: Solidity scripts never write it.
 * Idempotent (same content: no change); a different existing entry is refused unless `replace`.
 */
export function publishDeployment(o: {deploymentsDir: string; name?: string; bookPath: string; key?: string; replace?: boolean}): {changed: boolean; entry: Entry; problems: string[]} {
  const name = o.name ?? "4663";
  const key = o.key ?? "4663";
  const file = join(o.deploymentsDir, `${name}.json`);
  if (!existsSync(file)) return {changed: false, entry: {} as Entry, problems: [`${file} not found (run the broadcast first)`]};
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const problems = validateDeployment(raw);
  if (problems.length) return {changed: false, entry: raw as Entry, problems};
  const {deployBlock, ...rest} = raw;
  const entry = {...rest, startBlock: Number(deployBlock ?? raw.startBlock)} as unknown as Entry;
  // Receipt markets (A3), listed later: merged under their stock.
  for (const f of readdirSync(o.deploymentsDir).filter((x) => x.startsWith(`${name}-receipt-`) && x.endsWith(".json"))) {
    const ticker = f.slice(`${name}-receipt-`.length, -".json".length);
    if (!entry.stocks[ticker]) {
      problems.push(`${f}: no stock ${ticker} in the deployment`);
      continue;
    }
    entry.stocks[ticker] = {...entry.stocks[ticker], receipt: JSON.parse(readFileSync(join(o.deploymentsDir, f), "utf8"))};
  }
  if (problems.length) return {changed: false, entry, problems};
  const sorted = sortKeys(entry) as Entry;
  const book = JSON.parse(readFileSync(o.bookPath, "utf8")) as {chains: Record<string, unknown>};
  const prev = book.chains[key];
  if (prev && JSON.stringify(sortKeys(prev)) === JSON.stringify(sorted)) return {changed: false, entry: sorted, problems: []};
  if (prev && !o.replace) return {changed: false, entry: sorted, problems: [`addresses.json already has a different "${key}" entry (pass replace only for a redeploy the owner approved)`]};
  book.chains[key] = sorted;
  writeFileSync(o.bookPath, `${JSON.stringify(book, null, 2)}\n`);
  return {changed: true, entry: sorted, problems: []};
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
