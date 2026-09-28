import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {ConsolePager, FilePager, pagersFromEnv, type Page} from "../src/monitor/index.js";

const page = (action: Page["action"]): Page => ({action, rule: "LOW_GAS", subject: "operator", severity: "P1", key: "LOW_GAS:operator", title: "t", details: {balanceWei: 5n}, block: 7n, at: 1});

describe("MON pagers from env", () => {
  it("MON_R15 MONITOR_PAGE_FILE appends one JSON line per page (bigints as strings), next to the console pager", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "pages-")), "pages.jsonl");
    const pagers = pagersFromEnv({MONITOR_PAGE_FILE: file});
    expect(pagers.map((p) => p.name).sort()).toEqual(["console", "file"]);
    const fp = pagers.find((p) => p instanceof FilePager)!;
    await fp.send(page("trigger"));
    await fp.send(page("resolve"));
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.action)).toEqual(["trigger", "resolve"]);
    expect(lines[0].details.balanceWei).toBe("5");
    expect(lines[0].block).toBe("7");
  });

  it("MON no pager configured: console only", () => {
    const pagers = pagersFromEnv({});
    expect(pagers).toHaveLength(1);
    expect(pagers[0]).toBeInstanceOf(ConsolePager);
  });
});
