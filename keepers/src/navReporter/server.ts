import {createHash, timingSafeEqual} from "node:crypto";
import {Hono} from "hono";
import {bodyLimit} from "hono/body-limit";
import {safeErrorLine} from "@stockline/sdk";
import type {Health} from "../common/health.js";
import {parseReport, type Cosigner} from "./navReporter.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * The co-signer's HTTP face (`POST /cosign`). OFF-18: the bearer token is compared in constant time (on SHA-256
 * digests, so the length does not leak either). OFF-19: bodies over 16 KiB and malformed reports are refused (400)
 * before any RPC read, and a refusal carries one redacted line (never an RPC URL with its key).
 */
export function cosignerApp(co: Cosigner, token: string, health?: Health, env: Record<string, string | undefined> = process.env): Hono {
  const want = digest(`Bearer ${token}`);
  // T15: healthy from start; the staleness window (navHealthStaleMs) then counts from the last co-signed report.
  health?.ok("nav", 0n);
  const app = new Hono();
  app.post(
    "/cosign",
    bodyLimit({maxSize: 16 * 1024, onError: (c) => c.json({error: "body too large"}, 413)}),
    async (c) => {
      if (!timingSafeEqual(digest(c.req.header("authorization") ?? ""), want)) return c.json({error: "unauthorized"}, 401);
      let report;
      try {
        const j = (await c.req.json()) as Record<string, unknown>;
        if (!Array.isArray(j.shortSizes) || j.shortSizes.length > 16) throw new Error("shortSizes");
        report = parseReport(j);
      } catch {
        return c.json({error: "malformed report"}, 400);
      }
      try {
        const signature = await co.cosign(report);
        health?.ok("nav", 0n);
        return c.json({signature});
      } catch (e) {
        return c.json({error: safeErrorLine(e, env, 200)}, 422);
      }
    },
  );
  return app;
}
