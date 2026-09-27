import {createPublicClient, http, type PublicClient} from "viem";
import {stocklineOracleAbi, type ChainDeployment} from "@stockline/sdk";

/** Live chain reads the API needs beyond the indexer: oracle params (timelocked, cached 10 min) and the chain head
 * (indexer lag in `/status`, cached 1 s). */
export interface OracleParams {
  z: bigint;
  sigma: bigint;
  bMin: bigint;
  bMax: bigint;
  rampIn: bigint;
  stockHeartbeat: bigint;
  staleGrace: bigint;
}

export interface ChainReader {
  readonly client: PublicClient;
  blockNumber(): Promise<bigint | null>;
  oracleParams(ticker: string): Promise<OracleParams>;
}

export class RpcChainReader implements ChainReader {
  readonly client: PublicClient;
  private head?: {at: number; n: bigint};
  private readonly params = new Map<string, {at: number; p: OracleParams}>();

  constructor(
    rpcUrl: string,
    private readonly d: ChainDeployment,
  ) {
    this.client = createPublicClient({transport: http(rpcUrl, {batch: true})}) as PublicClient;
  }

  async blockNumber(): Promise<bigint | null> {
    if (this.head && Date.now() - this.head.at < 1000) return this.head.n;
    try {
      const n = await this.client.getBlockNumber({cacheTime: 0});
      this.head = {at: Date.now(), n};
      return n;
    } catch {
      return null;
    }
  }

  async oracleParams(ticker: string): Promise<OracleParams> {
    const hit = this.params.get(ticker);
    if (hit && Date.now() - hit.at < 600_000) return hit.p;
    const r = await this.client.readContract({address: this.d.stocks[ticker].oracle, abi: stocklineOracleAbi, functionName: "params"});
    const p = {
      z: BigInt(r.zWad),
      sigma: BigInt(r.sigmaWad),
      bMin: BigInt(r.bMinWad),
      bMax: BigInt(r.bMaxWad),
      rampIn: BigInt(r.rampIn),
      stockHeartbeat: BigInt(r.stockHeartbeat),
      staleGrace: BigInt(r.staleGrace),
    };
    this.params.set(ticker, {at: Date.now(), p});
    return p;
  }
}
