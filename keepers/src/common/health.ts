import {createServer, type Server} from "node:http";

/** Per-market liveness for `/health` (LM-R33): last run time and block, last error. */
export class Health {
  private readonly runs = new Map<string, {at: number; block: bigint; error?: string}>();
  constructor(
    private readonly maxStaleMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  ok(market: string, block: bigint): void {
    this.runs.set(market, {at: this.now(), block});
  }

  fail(market: string, error: unknown): void {
    const prev = this.runs.get(market);
    this.runs.set(market, {at: prev?.at ?? 0, block: prev?.block ?? 0n, error: String(error)});
  }

  report(): {healthy: boolean; markets: Record<string, {lastRunMsAgo: number; lastBlock: string; error?: string}>} {
    const now = this.now();
    const markets: Record<string, {lastRunMsAgo: number; lastBlock: string; error?: string}> = {};
    let healthy = this.runs.size > 0;
    for (const [k, v] of this.runs) {
      const ago = now - v.at;
      markets[k] = {lastRunMsAgo: ago, lastBlock: v.block.toString(), ...(v.error ? {error: v.error} : {})};
      if (ago > this.maxStaleMs) healthy = false;
    }
    return {healthy, markets};
  }

  serve(port: number): Server {
    const server = createServer((req, res) => {
      if (req.url !== "/health") {
        res.writeHead(404).end();
        return;
      }
      const r = this.report();
      res.writeHead(r.healthy ? 200 : 503, {"content-type": "application/json"}).end(JSON.stringify(r));
    });
    return server.listen(port);
  }
}
