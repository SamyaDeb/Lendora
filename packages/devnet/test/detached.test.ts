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
});
