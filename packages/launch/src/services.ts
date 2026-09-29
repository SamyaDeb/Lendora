import {readFileSync} from "node:fs";
import type {Run} from "./checks.js";

export interface ServiceVar {
  key: string;
  /** Literal value, or the launcher env var holding a secret (never printed). */
  literal?: string;
  secretFrom?: string;
  /** `<fill: …>` still in the template. */
  unfilled?: string;
}
export interface ServicePlan {
  service: string;
  vars: ServiceVar[];
}

/** `infra/mainnet.env.example` (or the owner's filled copy) → per-service variables, `shared` merged in, file order. */
export function parseServiceEnv(file: string): ServicePlan[] {
  const out: ServicePlan[] = [];
  let shared: ServiceVar[] = [];
  let cur: ServicePlan | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const h = /^##\s+([a-z0-9-]+)\s*$/.exec(line);
    if (h) {
      cur = {service: h[1], vars: []};
      if (h[1] === "shared") shared = cur.vars;
      else out.push(cur);
      continue;
    }
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m || !cur) continue;
    const [, key, value] = m;
    const v: ServiceVar = value.startsWith("$") ? {key, secretFrom: value.slice(1)} : /^<fill/.test(value) ? {key, unfilled: value} : {key, literal: value};
    cur.vars.push(v);
  }
  return out.map((s) => ({service: s.service, vars: [...shared.filter((x) => !s.vars.some((y) => y.key === x.key)), ...s.vars]}));
}

/** Problems before applying: unfilled template values, secrets missing from the env (names only). */
export function planProblems(plan: ServicePlan[], env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (plan[0]?.service !== "monitor") out.push("the monitor must be the first service (MON-R16)");
  for (const s of plan)
    for (const v of s.vars) {
      if (v.unfilled) out.push(`${s.service}.${v.key} unfilled (${v.unfilled})`);
      if (v.secretFrom && !env[v.secretFrom]) out.push(`${s.service}.${v.key}: secret ${v.secretFrom} is not in the environment`);
    }
  return out;
}

/** The plan as text: secrets by name only. */
export function describePlan(plan: ServicePlan[]): string {
  return plan.map((s) => [`[${s.service}]`, ...s.vars.map((v) => `  ${v.key}=${v.literal ?? (v.secretFrom ? `<secret from $${v.secretFrom}>` : v.unfilled)}`)].join("\n")).join("\n");
}

/**
 * `--apply`: set every service's variables through the Railway CLI, monitor first. Refused unless `railway whoami`
 * succeeds (the operator logged in). Secret values go to the CLI through its environment-backed args only here and are
 * never logged.
 */
export function applyPlan(plan: ServicePlan[], env: NodeJS.ProcessEnv, r: Run, log: (m: string) => void): string[] {
  const who = r("railway", ["whoami"]);
  if (who.status !== 0) return ["railway is not logged in (run `railway login`), nothing applied"];
  const problems = planProblems(plan, env);
  if (problems.length) return problems;
  for (const s of plan) {
    const args = ["variables", "--service", s.service, "--skip-deploys"];
    for (const v of s.vars) args.push("--set", `${v.key}=${v.literal ?? env[v.secretFrom!]}`);
    const res = r("railway", args);
    if (res.status !== 0) return [`railway variables for ${s.service} failed (exit ${res.status}); earlier services are set, re-run to continue`];
    log(`[services] ${s.service}: ${s.vars.length} variables set`);
  }
  return [];
}
