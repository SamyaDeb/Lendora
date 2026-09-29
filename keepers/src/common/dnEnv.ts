import {z} from "zod";
import {httpUrl, int} from "./config.js";

const list = (name: string, re: RegExp, max: number, dflt: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const parts = (v === undefined || v === "" ? dflt : v).split(",").map((s) => s.trim());
      if (parts.length === 0 || parts.length > max || parts.some((p) => !re.test(p))) {
        ctx.addIssue({code: "custom", message: `${name} must be a comma-separated list of up to ${max} values matching ${re} (got "${v}")`});
        return z.NEVER;
      }
      return parts;
    });
const bigintIn = (name: string, min: bigint, max: bigint, dflt: bigint) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return dflt;
      if (!/^\d+$/.test(v) || BigInt(v) < min || BigInt(v) > max) {
        ctx.addIssue({code: "custom", message: `${name} must be an integer between ${min} and ${max} (got "${v}")`});
        return z.NEVER;
      }
      return BigInt(v);
    });
const fraction = (name: string, dflt: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return dflt;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        ctx.addIssue({code: "custom", message: `${name} must be a number between 0 and 1 (got "${v}")`});
        return z.NEVER;
      }
      return n;
    });

/** `FOO=` in an env file means unset. */
const unsetEmpty = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
const issues = (e: z.ZodError) => e.issues.map((i) => i.message).join("; ");

/**
 * OFF-20: the NAV reporter / co-signer env, validated like the other keepers (OFF-5). Before, `NAV_REPORT_EVERY_MS=abc`
 * became `NaN`, passed the 14-minute check, and the reporter only reported on moves: the oracle went stale (DN-R5).
 * OFF-21: the co-signer URL must be https off localhost / `*.railway.internal`, and a URL needs a token.
 */
const NavEnv = z
  .object({
    NAV_MODE: z.enum(["reporter", "cosigner"], {message: "NAV_MODE must be reporter or cosigner"}).default("reporter"),
    NAV_SOURCE: z.enum(["mock", "lighter"], {message: "NAV_SOURCE must be mock or lighter"}).default("mock"),
    NAV_REPORT_EVERY_MS: int("NAV_REPORT_EVERY_MS", 60_000, 14 * 60_000, 5 * 60_000),
    NAV_REPORT_MOVE_BPS: int("NAV_REPORT_MOVE_BPS", 1, 100, 50),
    INTERVAL_MS: int("INTERVAL_MS", 1_000, 5 * 60_000, 30_000),
    PORT: int("PORT", 1, 65_535, 8790),
    COSIGNER_URL: httpUrl("COSIGNER_URL", true).optional(),
    COSIGNER_TOKEN: z.string().optional(),
    LIGHTER_API_URL: httpUrl("LIGHTER_API_URL", true).default("https://api.rh.lighter.xyz"),
    LIGHTER_MARKET_IDS: list("LIGHTER_MARKET_IDS", /^\d{1,4}$/, 16, "26,15,10"),
  })
  .superRefine((e, ctx) => {
    if (e.NAV_MODE === "cosigner" && (e.COSIGNER_TOKEN ?? "").length < 32) ctx.addIssue({code: "custom", message: "NAV_MODE=cosigner needs COSIGNER_TOKEN (>= 32 chars)"});
    if (e.NAV_MODE === "reporter" && e.COSIGNER_URL && (e.COSIGNER_TOKEN ?? "").length < 32) ctx.addIssue({code: "custom", message: "COSIGNER_URL needs COSIGNER_TOKEN (>= 32 chars)"});
  });
export type NavEnv = z.infer<typeof NavEnv>;
export function loadNavEnv(env: NodeJS.ProcessEnv = process.env): NavEnv {
  const r = NavEnv.safeParse(unsetEmpty(env));
  if (!r.success) throw new Error(`nav-reporter config: ${issues(r.error)}`);
  return r.data;
}

/** OFF-20: the DN rebalancer env (kill-switch window, chunk, slippage ≤ 1% per DN-R10, venue ids, maintenance fractions). */
const DnEnv = z.object({
  DN_VENUE: z.enum(["mock", "lighter"], {message: "DN_VENUE must be mock or lighter"}).default("mock"),
  DN_KILL_WINDOW_H: int("DN_KILL_WINDOW_H", 1, 24 * 90, 168),
  DN_KILL_HOURS: int("DN_KILL_HOURS", 1, 24 * 90, 72),
  DN_KILL_LENDING_APY: fraction("DN_KILL_LENDING_APY", 0.02),
  DN_ENTRY_CHUNK_USDG: bigintIn("DN_ENTRY_CHUNK_USDG", 1_000_000n, 10n ** 15n, 50_000_000_000n),
  DN_SLIPPAGE_BPS: bigintIn("DN_SLIPPAGE_BPS", 1n, 100n, 50n),
  DN_MMF_WAD: list("DN_MMF_WAD", /^\d{1,19}$/, 16, "12000000000000000,30000000000000000,30000000000000000"),
  INTERVAL_MS: int("INTERVAL_MS", 1_000, 60 * 60_000, 60_000),
  LIGHTER_API_URL: httpUrl("LIGHTER_API_URL", true).default("https://api.rh.lighter.xyz"),
  LIGHTER_MARKET_IDS: list("LIGHTER_MARKET_IDS", /^\d{1,4}$/, 16, "26,15,10"),
});
export type DnEnv = z.infer<typeof DnEnv>;
export function loadDnEnv(env: NodeJS.ProcessEnv = process.env): DnEnv {
  const r = DnEnv.safeParse(unsetEmpty(env));
  if (!r.success) throw new Error(`dn-rebalancer config: ${issues(r.error)}`);
  return r.data;
}
