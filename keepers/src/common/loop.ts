/** Run `tick` every `intervalMs` until `signal` aborts; errors are reported and the loop continues (restart-safe:
 * every tick recomputes from chain state, nothing is kept between ticks). */
export async function runLoop(
  tick: () => Promise<void>,
  intervalMs: number,
  signal: AbortSignal,
  onError: (e: unknown) => void = (e) => console.error(e),
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
