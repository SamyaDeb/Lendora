import {z} from "@hono/zod-openapi";

/** Route schemas. OpenAPI 3.1 (`/v1/openapi.json`) and the SDK's typed client are generated from these. */

const Dec = z.string().openapi({description: "Decimal string", example: "1234.56"});
const Int = z.string().regex(/^-?\d+$/).openapi({description: "Integer as a decimal string (raw onchain units)", example: "1000000000000000000"});
const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).openapi({example: "0x0000000000000000000000000000000000000000"});
const Time = z.string().openapi({description: "ISO 8601 UTC", example: "2026-10-01T16:00:00.000Z"});

export const Symbol = z.string().regex(/^[A-Za-z0-9.]{1,12}$/).openapi({param: {name: "symbol", in: "path"}, example: "NVDA"});

/** SI-R13 on every data response. */
export const EnvelopeSchema = {
  asOfBlock: Int.openapi({description: "Block the data is as of (SI-R13)"}),
  asOfTime: Time,
  confirmed: z.boolean().openapi({description: "asOfBlock ≤ the chain's finalized block (SI-R3)"}),
  safe: z.boolean().openapi({description: "asOfBlock ≤ the chain's safe block"}),
  scope: z.string(),
};

export const MarketStatus = z.enum(["open", "closed", "ramping", "guard_tripped"]);

export const Market = z
  .object({
    symbol: z.string(),
    stockToken: Addr,
    marketId: z.string(),
    blockNumber: Int,
    time: Time,
    supplied: Dec.openapi({description: "Market supply + rSTOCK idle, shares of stock after the multiplier"}),
    borrowed: Dec.openapi({description: "Short interest: market borrow, shares of stock after the multiplier"}),
    borrowedUsd: Dec.openapi({description: "totalBorrowAssets × P_wrapped (feed, no buffer)"}),
    utilization: Dec.openapi({description: "Stock-loan market utilization (0–1)"}),
    utilizationVault: Dec.openapi({description: "borrowed / supplied incl. the idle reserve (0–1)"}),
    borrowApr: Dec,
    borrowApy: z.number(),
    supplyApy: z.number().openapi({description: "Variable lender APY through rSTOCK, net of the vault performance fee"}),
    rateKind: z.literal("variable"),
    siPctFloat: Dec.openapi({description: "borrowed / Stock Token totalSupply (0–1)"}),
    daysToCover: z.number().nullable(),
    borrowers: z.number().int(),
    newShorts24h: Dec,
    covered24h: Dec,
    marketStatus: MarketStatus,
    price: z.object({usdPerShare: Dec, usdPerToken: Dec, feedUpdatedAt: Time, multiplier: Dec}),
    buffer: Dec.openapi({description: "Oracle buffer in force (0–0.2)"}),
    guard: z.object({tripped: z.boolean(), reasons: z.array(z.string())}),
    raw: z.object({
      suppliedShares: Int,
      borrowedShares: Int,
      utilizationWad: Int,
      borrowRatePerSecWad: Int,
      bufferWad: Int,
      marketOpen: z.boolean(),
      guardReasons: Int,
      totalSupplyAssets: Int,
      totalBorrowAssets: Int,
      vaultIdle: Int,
      stockAnswer: Int,
      usdgAnswer: Int,
      multiplier: Int,
    }),
  })
  .openapi("Market");

export const MarketsResponse = z.object({...EnvelopeSchema, data: z.array(Market)}).openapi("MarketsResponse");

export const MarketDetail = Market.extend({
  params: z.object({
    lltv: Dec,
    uMax: Dec,
    hfMinOpen: Dec,
    supplyCapShares: Dec.openapi({description: "Vault V2 absolute cap, wSTOCK units"}),
    supplyCapUsd: Dec.openapi({description: "Cap at the current feed price"}),
    perAddressCapUsd: z.number(),
    oracle: z.object({z: Dec, sigma: Dec, bMin: Dec, bMax: Dec, rampInSec: z.number(), heartbeatSec: z.number(), staleGraceSec: z.number()}),
  }),
  schedule: z.object({
    sessionOpen: z.boolean(),
    bufferNow: Dec,
    nextClose: Time.nullable(),
    rampStart: Time.nullable(),
    reopen: Time.nullable(),
    bufferAtClose: Dec.nullable(),
    nextEvent: z.object({fullBy: Time, release: Time, buffer: Dec}).nullable(),
  }),
  contracts: z.object({stockToken: Addr, wrapper: Addr, oracle: Addr, vault: Addr, adapter: Addr, morpho: Addr, router: Addr.nullable(), lens: Addr.nullable(), marketHours: Addr}),
}).openapi("MarketDetail");

export const MarketDetailResponse = z.object({...EnvelopeSchema, data: MarketDetail}).openapi("MarketDetailResponse");

export const HistoryPoint = z
  .object({
    bucket: Time,
    blockNumber: Int,
    supplied: Dec,
    borrowed: Dec,
    borrowedUsd: Dec,
    utilization: Dec,
    utilizationVault: Dec,
    borrowApr: Dec,
    supplyApy: z.number(),
    siPctFloat: Dec,
    borrowers: z.number().int(),
    marketStatus: z.string(),
    buffer: Dec,
    priceUsdPerShare: Dec,
    borrowFlow: Dec,
    repayFlow: Dec,
    liquidationFlow: Dec,
  })
  .openapi("HistoryPoint");

export const HistoryQuery = z.object({
  interval: z.enum(["1m", "1h", "1d"]).default("1h").openapi({param: {name: "interval", in: "query"}}),
  from: Time.optional().openapi({param: {name: "from", in: "query"}, description: "Inclusive; default: 7 days before `to`"}),
  to: Time.optional().openapi({param: {name: "to", in: "query"}, description: "Exclusive; default: now"}),
  format: z.enum(["json", "csv"]).default("json").openapi({param: {name: "format", in: "query"}, description: "SI-R12"}),
  limit: z.coerce.number().int().min(1).max(5000).default(2000).openapi({param: {name: "limit", in: "query"}}),
});

export const HistoryResponse = z.object({...EnvelopeSchema, symbol: z.string(), interval: z.string(), data: z.array(HistoryPoint)}).openapi("HistoryResponse");

export const Event = z
  .object({
    id: z.string(),
    symbol: z.string(),
    type: z.string(),
    source: z.string(),
    account: z.string().nullable(),
    assets: Dec.nullable(),
    shares: Int.nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
    blockNumber: Int,
    logIndex: z.number().int(),
    time: Time,
    txHash: z.string(),
  })
  .openapi("Event");

export const EventsQuery = z.object({
  type: z.enum(["borrow", "repay", "liquidate", "lend", "withdrawLend", "all"]).default("all").openapi({param: {name: "type", in: "query"}}),
  cursor: z.string().optional().openapi({param: {name: "cursor", in: "query"}, description: "`nextCursor` of the previous page"}),
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().openapi({param: {name: "account", in: "query"}, description: "Only events of this wallet (public onchain data)"}),
  limit: z.coerce.number().int().min(1).max(500).default(100).openapi({param: {name: "limit", in: "query"}}),
});

export const EventsResponse = z.object({...EnvelopeSchema, data: z.array(Event), nextCursor: z.string().nullable()}).openapi("EventsResponse");

export const Position = z
  .object({
    symbol: z.string(),
    role: z.enum(["account", "vault-adapter"]),
    supplyShares: Int,
    borrowShares: Int,
    borrowed: Dec,
    collateralUsdg: Dec,
    healthFactor: Dec.nullable(),
    liquidationPriceUsdPerToken: Dec.nullable(),
    updatedBlock: Int,
  })
  .openapi("Position");

export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).openapi({param: {name: "address", in: "path"}});

export const PositionsResponse = z.object({...EnvelopeSchema, address: z.string(), data: z.array(Position)}).openapi("PositionsResponse");

export const StatusResponse = z
  .object({
    ...EnvelopeSchema,
    data: z.object({
      chainId: z.number(),
      network: z.string(),
      indexer: z.object({headBlock: Int, headTime: Time, chainBlock: Int.nullable(), lagBlocks: z.number().nullable(), safeBlock: Int, finalizedBlock: Int}),
      markets: z.array(
        z.object({
          symbol: z.string(),
          marketStatus: MarketStatus,
          snapshotBlock: Int,
          oracle: z.object({usdPerToken: Dec, updatedAt: Time, ageSec: z.number(), sessionOpen: z.boolean(), stale: z.boolean()}),
          guard: z.object({tripped: z.boolean(), reasons: z.array(z.string()), mask: Int}),
        }),
      ),
    }),
  })
  .openapi("StatusResponse");

export const TermsResponse = z.object({terms: z.string(), attribution: z.string(), warranty: z.string()}).openapi("TermsResponse");

export const NonceResponse = z.object({nonce: z.string(), domain: z.string(), chainId: z.number(), statement: z.string()}).openapi("NonceResponse");
export const CreateKeyBody = z.object({message: z.string().max(4000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/), label: z.string().max(64).optional()});
export const CreateKeyResponse = z.object({id: z.string(), key: z.string().openapi({description: "Shown once; store it"}), address: z.string(), tier: z.literal("keyed")}).openapi("CreateKeyResponse");
export const KeysResponse = z.object({address: z.string(), keys: z.array(z.object({id: z.string(), label: z.string().nullable(), createdAt: Time, revokedAt: Time.nullable()}))}).openapi("KeysResponse");
export const ErrorResponse = z.object({error: z.string()}).openapi("Error");
