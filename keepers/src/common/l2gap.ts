import type {PublicClient} from "viem";

/**
 * OR-R6 keeper side: consecutive L2 block timestamps further apart than `gapSec` are a gap. Shared by the guard keeper
 * (trips `L2_GAP`) and the monitor (pages `L2_GAP`, MON-R8). Memory between calls is the last seen block and the last
 * gap time; after a restart detection starts again from the head, which can only miss a gap that happened while the
 * process was down (the guard keeper's own restart is itself paged by `KEEPER_DOWN`).
 */
export interface L2GapStatus {
  /** A gap was seen now or within the last `clearAfterSec`. */
  gap: boolean;
  /** Timestamp and number of the newest block. */
  now: bigint;
  number: bigint;
  /** Largest block-to-block interval seen in this call (0 if only one block). */
  maxIntervalSec: bigint;
}

export class L2GapDetector {
  private lastBlock?: {number: bigint; timestamp: bigint};
  private lastGapAt?: bigint;

  constructor(
    private readonly client: PublicClient,
    readonly gapSec: bigint,
    readonly clearAfterSec: bigint,
  ) {}

  /** Chain time of the most recent gap, if any. */
  get lastGap(): bigint | undefined {
    return this.lastGapAt;
  }

  /** Scans the blocks since the last call (at most `maxScan`; otherwise checks only the newest pair). */
  async detect(maxScan = 2000n): Promise<L2GapStatus> {
    const latest = await this.client.getBlock();
    let gap = false;
    let maxIntervalSec = 0n;
    const prev = this.lastBlock;
    if (prev && latest.number > prev.number && latest.timestamp - prev.timestamp >= this.gapSec) {
      const from = latest.number - prev.number > maxScan ? latest.number - 1n : prev.number;
      let last = from === prev.number ? prev.timestamp : (await this.client.getBlock({blockNumber: from})).timestamp;
      for (let n = from + 1n; n <= latest.number; n++) {
        const b = n === latest.number ? latest : await this.client.getBlock({blockNumber: n});
        const interval = b.timestamp - last;
        if (interval > maxIntervalSec) maxIntervalSec = interval;
        if (interval >= this.gapSec) gap = true;
        last = b.timestamp;
      }
    }
    if (gap) this.lastGapAt = latest.timestamp;
    this.lastBlock = {number: latest.number, timestamp: latest.timestamp};
    const inWindow = this.lastGapAt !== undefined && latest.timestamp - this.lastGapAt < this.clearAfterSec;
    return {gap: gap || inWindow, now: latest.timestamp, number: latest.number, maxIntervalSec};
  }
}
