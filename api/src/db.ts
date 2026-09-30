import pg from "pg";
import {logPoolErrors} from "@stockline/sdk";

/**
 * Read-only access to the indexer's tables (through the `--views-schema` views in production) plus the API's own
 * `api_keys` table. Queries are parameterized; schema names are validated identifiers.
 */
const ident = (s: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s)) throw new Error(`bad schema name ${s}`);
  return `"${s}"`;
};

export type Row = Record<string, unknown> & {[k: string]: string | number | boolean | null | Record<string, unknown>};

export interface HeadRow {
  head_block: string;
  head_timestamp: string;
  safe_block: string;
  finalized_block: string;
}

export interface EventCursor {
  block: bigint;
  logIndex: number;
}

export class IndexerDb {
  readonly pool: pg.Pool;
  private readonly s: string;
  private readonly a: string;

  constructor(databaseUrl: string, indexerSchema: string, apiSchema: string, max = 20) {
    this.pool = logPoolErrors(new pg.Pool({connectionString: databaseUrl, max}), "api", process.env);
    this.s = ident(indexerSchema);
    this.a = ident(apiSchema);
  }

  /** Creates the API's own schema (API keys). Idempotent. Stores key hashes and wallet addresses only, never IPs. */
  async migrate(): Promise<void> {
    await this.pool.query(`create schema if not exists ${this.a}`);
    await this.pool.query(`create table if not exists ${this.a}.api_keys (
      id text primary key,
      key_hash text not null unique,
      address text not null,
      label text,
      created_at timestamptz not null default now(),
      revoked_at timestamptz
    )`);
    await this.pool.query(`create index if not exists api_keys_address on ${this.a}.api_keys (address)`);
  }

  async head(): Promise<HeadRow | undefined> {
    const {rows} = await this.pool.query(`select * from ${this.s}.chain_head limit 1`);
    return rows[0];
  }

  async latestSnapshots(): Promise<Row[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.latest_snapshot order by ticker`);
    return rows;
  }

  async latestSnapshot(ticker: string): Promise<Row | undefined> {
    const {rows} = await this.pool.query(`select * from ${this.s}.latest_snapshot where ticker = $1`, [ticker]);
    return rows[0];
  }

  async market(ticker: string): Promise<Row | undefined> {
    const {rows} = await this.pool.query(`select * from ${this.s}.market where ticker = $1`, [ticker]);
    return rows[0];
  }

  /** Rollup rows joined with flows for `[from, to)`, oldest first (SI-R2, SI-R12). */
  async history(ticker: string, interval: string, from: bigint, to: bigint, limit: number): Promise<Row[]> {
    const {rows} = await this.pool.query(
      `select r.*, coalesce(f.borrow_flow, 0) as borrow_flow, coalesce(f.repay_flow, 0) as repay_flow,
              coalesce(f.liquidation_flow, 0) as liquidation_flow
         from ${this.s}.rollup r
         left join ${this.s}.flow_bucket f on f.ticker = r.ticker and f.interval = r.interval and f.bucket = r.bucket
        where r.ticker = $1 and r.interval = $2 and r.bucket >= $3 and r.bucket < $4
        order by r.bucket asc limit $5`,
      [ticker, interval, from.toString(), to.toString(), limit],
    );
    return rows;
  }

  /** Event feed, newest first, strictly before `cursor` (07 `/events`). `ticker = "*"` for all stocks; empty
   * `types` = every type. */
  async events(ticker: string, types: string[], cursor: EventCursor | undefined, limit: number, account?: string): Promise<Row[]> {
    const params: unknown[] = [types, limit];
    let where = "(cardinality($1::text[]) = 0 or type = any($1))";
    if (account) {
      params.push(account);
      where += ` and lower(account) = lower($${params.length})`;
    }
    if (ticker !== "*") {
      params.push(ticker);
      where += ` and ticker = $${params.length}`;
    }
    if (cursor) {
      params.push(cursor.block.toString(), cursor.logIndex);
      where += ` and (block_number, log_index) < ($${params.length - 1}::numeric, $${params.length}::int)`;
    }
    const {rows} = await this.pool.query(
      `select * from ${this.s}.event_feed where ${where} order by block_number desc, log_index desc limit $2`,
      params,
    );
    return rows;
  }

  /** Events strictly after `cursor`, oldest first (WS fan-out). */
  async eventsAfter(cursor: EventCursor, limit = 500): Promise<Row[]> {
    const {rows} = await this.pool.query(
      `select * from ${this.s}.event_feed where (block_number, log_index) > ($1::numeric, $2::int)
        order by block_number asc, log_index asc limit $3`,
      [cursor.block.toString(), cursor.logIndex, limit],
    );
    return rows;
  }

  async lastEventCursor(): Promise<EventCursor> {
    const {rows} = await this.pool.query(`select block_number, log_index from ${this.s}.event_feed order by block_number desc, log_index desc limit 1`);
    return rows[0] ? {block: BigInt(rows[0].block_number), logIndex: Number(rows[0].log_index)} : {block: 0n, logIndex: -1};
  }

  async positions(address: string): Promise<Row[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.position where lower(account) = lower($1) order by ticker`, [address]);
    return rows;
  }

  // ------------------------------------------------------------------ Phase 4 vault (DN-R11) and G5 receipt markets

  /** NAV points (accepted reports) at or after `from` (unix s), oldest first. */
  async dnNavSince(from: bigint, limit = 20_000): Promise<Row[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.dn_nav where timestamp >= $1 order by timestamp asc, block_number asc limit $2`, [from.toString(), limit]);
    return rows;
  }

  /** The last NAV point at or before `ts` (the window's start value). */
  async dnNavAt(ts: bigint): Promise<Row | undefined> {
    const {rows} = await this.pool.query(`select * from ${this.s}.dn_nav where timestamp <= $1 order by timestamp desc, block_number desc limit 1`, [ts.toString()]);
    return rows[0];
  }

  /** Funding / costs / fee sums over days in [from, to). */
  async dnDaysSum(from: bigint, to: bigint): Promise<Row> {
    const {rows} = await this.pool.query(
      `select coalesce(sum(funding), 0)::text as funding, coalesce(sum(costs), 0)::text as costs, coalesce(sum(fee), 0)::text as fee
         from ${this.s}.dn_day where day >= $1 and day < $2`,
      [from.toString(), to.toString()],
    );
    return rows[0];
  }

  async dnAccount(address: string): Promise<Row | undefined> {
    const {rows} = await this.pool.query(`select * from ${this.s}.dn_account where lower(address) = lower($1)`, [address]);
    return rows[0];
  }

  /** Requests owned by or paying `address`, newest first, with the queue position of queued ones. */
  async dnRequests(address: string): Promise<Row[]> {
    const {rows} = await this.pool.query(
      `select r.*, case when r.status = 'queued'
                    then (select count(*) from ${this.s}.dn_request q where q.status = 'queued' and q.id <= r.id)
                    else 0 end as position
         from ${this.s}.dn_request r
        where lower(r.owner) = lower($1) or lower(r.receiver) = lower($1)
        order by r.id desc limit 200`,
      [address],
    );
    return rows;
  }

  async dnSleeves(): Promise<Row[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.dn_sleeve order by id`);
    return rows;
  }

  async receiptMarkets(): Promise<Row[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.receipt_market order by ticker`);
    return rows;
  }

  // ------------------------------------------------------------------ API keys (SI-R10)

  /** FE-R5: fees per stock per UTC day in [from, to] (unix seconds, day starts). */
  async feeDays(from: bigint, to: bigint): Promise<Row[]> {
    const {rows} = await this.pool.query(`select * from ${this.s}.fee_day where day >= $1 and day <= $2 order by day, ticker`, [from.toString(), to.toString()]);
    return rows;
  }

  /** FE-R5: count and sums of fee movements by kind in [from, to] (unix seconds). */
  async feeTotals(from: bigint, to: bigint): Promise<Row[]> {
    const {rows} = await this.pool.query(
      `select kind, count(*)::int as n, coalesce(sum(usd), 0)::text as usd, coalesce(sum(usdg), 0)::text as usdg
         from ${this.s}.fee_event where timestamp >= $1 and timestamp < $2 group by kind`,
      [from.toString(), to.toString()],
    );
    return rows;
  }

  async insertKey(id: string, keyHash: string, address: string, label: string | null): Promise<void> {
    await this.pool.query(`insert into ${this.a}.api_keys (id, key_hash, address, label) values ($1, $2, lower($3), $4)`, [id, keyHash, address, label]);
  }

  async keyByHash(keyHash: string): Promise<{id: string; address: string} | undefined> {
    const {rows} = await this.pool.query(`select id, address from ${this.a}.api_keys where key_hash = $1 and revoked_at is null`, [keyHash]);
    return rows[0];
  }

  async keysOf(address: string): Promise<{id: string; label: string | null; created_at: Date; revoked_at: Date | null}[]> {
    const {rows} = await this.pool.query(`select id, label, created_at, revoked_at from ${this.a}.api_keys where address = lower($1) order by created_at`, [address]);
    return rows;
  }

  async activeKeyCount(address: string): Promise<number> {
    const {rows} = await this.pool.query(`select count(*)::int as n from ${this.a}.api_keys where address = lower($1) and revoked_at is null`, [address]);
    return rows[0].n;
  }

  async revokeKey(id: string, address: string): Promise<boolean> {
    const r = await this.pool.query(`update ${this.a}.api_keys set revoked_at = now() where id = $1 and address = lower($2) and revoked_at is null`, [id, address]);
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
