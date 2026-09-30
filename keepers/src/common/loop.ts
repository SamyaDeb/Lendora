import {safeErrorLine} from "@lendora/sdk";

/** Run `tick` every `intervalMs` until `signal` aborts; errors are reported and the loop continues (restart-safe:
 * every tick recomputes from chain state, nothing is kept between ticks). */
export async function runLoop(
  tick: () => Promise<void>,
  intervalMs: number,
  signal: AbortSignal,
  onError: (e: unknown) => void = (e) => console.error(safeErrorLine(e, process.env)), // OFF-1: never a raw error
): Promise<void> {
  while (!signal.aborted) {
    try {
      await tick();
    } catch (e) {
      onError(e);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/**
 * A keeper's main loop until SIGINT/SIGTERM: the current tick finishes, `cleanup` runs, then the process exits. Without
 * the explicit exit the `/health` server (and pg pools) kept the process alive after the loop ended, so
 * `dev-testnet.sh --stop` and platform restarts had to SIGKILL every keeper after their grace period.
 */
export async function runService(
  tick: () => Promise<void>,
  intervalMs: number,
  o: {
    cleanup?: () => Promise<void>;
    proc?: {on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown};
    exit?: (code: number) => void;
  } = {},
): Promise<void> {
  const abort = new AbortController();
  const proc = o.proc ?? process;
  proc.on("SIGINT", () => abort.abort());
  proc.on("SIGTERM", () => abort.abort());
  await runLoop(tick, intervalMs, abort.signal);
  let code = 0;
  try {
    await o.cleanup?.();
  } catch (e) {
    console.error(safeErrorLine(e, process.env));
    code = 1;
  }
  (o.exit ?? process.exit)(code);
}
