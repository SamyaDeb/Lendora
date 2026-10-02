import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {describe, expect, it} from "vitest";

const LIB = resolve(__dirname, "../../../scripts/lib/detached.sh");
const bash = (script: string, env: Record<string, string>) => execFileSync("bash", ["-c", `set -euo pipefail; . "${LIB}"; ${script}`], {env: {...process.env, ...env}, encoding: "utf8"});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * scripts/dev-testnet.sh --stop reported "stopped" while the service kept running and held its port (found on 46630:
 * a restarted API/alerts/allocator died with EADDRINUSE). The pid file named a wrapper subshell, not the service's
 * process group, so the group kill missed. The recorded pid must lead the group that `stop` kills.
 */
describe("detached services (scripts/lib/detached.sh)", () => {
  it("stop kills the service itself, not only a wrapper, and clears the pid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "detached-"));
    const env = {RUN: dir, LOGS: dir, ROOT: "/"};
    bash(`detached_start svc tmp FOO=bar -- sh -c 'echo "$$" > "${dir}/child"; exec sleep 300'`, env);
    let child = 0;
    for (let i = 0; i < 50 && !child; i++) {
      try {
        child = Number(readFileSync(join(dir, "child"), "utf8"));
      } catch {
        execFileSync("sleep", ["0.1"]);
      }
    }
    expect(child).toBeGreaterThan(0);
    const pid = Number(readFileSync(join(dir, "svc.pid"), "utf8"));
    // The service leads its own process group: the recorded pid is that group.
    expect(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child)], {encoding: "utf8"}).trim())).toBe(pid);
    expect(bash("detached_alive svc && echo yes || echo no", env).trim()).toBe("yes");
    bash("detached_stop svc", env);
    expect(alive(child)).toBe(false);
    expect(bash("detached_alive svc && echo yes || echo no", env).trim()).toBe("no");
  });

  it("supervise restarts a service that exits and redacts URL paths (RPC keys) from its output (T16, T17)", () => {
    const SUP = resolve(__dirname, "../../../scripts/lib/supervise.sh");
    const dir = mkdtempSync(join(tmpdir(), "supervise-"));
    const env = {RUN: dir, LOGS: dir, ROOT: "/", SUPERVISE_DELAY_SEC: "0.2"};
    // Ponder prints the failing RPC URL with its key, then exits on an unhandled rejection (46630, DNS outage).
    const svc = `echo run >> "${dir}/runs"; echo "URL: https://rpc.example.com/v2/SECRETKEY123 failed"; [ "$(wc -l < "${dir}/runs")" -ge 3 ] && exec sleep 300; exit 1`;
    bash(`detached_start svc tmp X=1 -- "${SUP}" sh -c '${svc.replace(/'/g, "'\\''")}'`, env);
    let runs = 0;
    for (let i = 0; i < 100 && runs < 3; i++) {
      try {
        runs = readFileSync(join(dir, "runs"), "utf8").trim().split("\n").length;
      } catch {
        /* not started yet */
      }
      execFileSync("sleep", ["0.1"]);
    }
    expect(runs, "restarted after each exit").toBe(3);
    const log = readFileSync(join(dir, "svc.log"), "utf8");
    expect(log).not.toContain("SECRETKEY123");
    expect(log).toContain("https://rpc.example.com/[redacted]");
    expect(log).toMatch(/\[supervise\] exited \(1\), restarting/);
    bash("detached_stop svc", env);
    expect(bash("detached_alive svc && echo yes || echo no", env).trim()).toBe("no");
  });

  it("T41 supervise restarts a service whose health check keeps failing (46630: the indexer drifted 151k blocks behind while running)", () => {
    const SUP = resolve(__dirname, "../../../scripts/lib/supervise.sh");
    const dir = mkdtempSync(join(tmpdir(), "supervise-check-"));
    // The service never exits; the check fails until the second start, then passes.
    const env = {RUN: dir, LOGS: dir, ROOT: "/", SUPERVISE_DELAY_SEC: "0.2", SUPERVISE_CHECK: `[ "$(wc -l < "${dir}/runs")" -ge 2 ]`, SUPERVISE_CHECK_EVERY_SEC: "0.2", SUPERVISE_CHECK_FAILS: "3"};
    const svc = `echo run >> "${dir}/runs"; exec sleep 300`;
    bash(`detached_start svc tmp X=1 -- "${SUP}" sh -c '${svc}'`, env);
    let runs = 0;
    for (let i = 0; i < 100 && runs < 2; i++) {
      try {
        runs = readFileSync(join(dir, "runs"), "utf8").trim().split("\n").length;
      } catch {
        /* not started yet */
      }
      execFileSync("sleep", ["0.1"]);
    }
    expect(runs, "restarted once the check failed 3 times in a row").toBe(2);
    execFileSync("sleep", ["1.5"]);
    expect(readFileSync(join(dir, "runs"), "utf8").trim().split("\n").length, "a passing check leaves it running").toBe(2);
    expect(readFileSync(join(dir, "svc.log"), "utf8")).toMatch(/\[supervise\] health check failed 3 times, restarting/);
    bash("detached_stop svc", env);
    expect(bash("detached_alive svc && echo yes || echo no", env).trim()).toBe("no");
  });
});
