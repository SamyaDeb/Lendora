import {describe, expect, it} from "vitest";
import {ContractFunctionExecutionError, HttpRequestError, InvalidRequestRpcError, RpcRequestError, TimeoutError, UnknownRpcError, parseAbi} from "viem";
import {HttpError, errorStatus} from "../src/errors.js";

describe("API error mapping (SI-R4 availability)", () => {
  it("SI_R4 while the indexer rebuilds its views (restart, missing relation or schema) the API answers 503 with Retry-After, not 500", () => {
    // Postgres: 42P01 undefined_table ("relation lendora_testnet.chain_head does not exist"), 3F000 invalid_schema.
    for (const code of ["42P01", "3F000"]) {
      const r = errorStatus(Object.assign(new Error(`relation "lendora_testnet.chain_head" does not exist`), {code}));
      expect(r.status, code).toBe(503);
      expect(r.retryAfter, code).toBeGreaterThan(0);
      expect(r.error, code).toMatch(/indexer/);
    }
  });
  it("HttpError keeps its status; anything else is a 500 without details", () => {
    expect(errorStatus(new HttpError(404, "unknown stock"))).toEqual({status: 404, error: "unknown stock"});
    expect(errorStatus(new RangeError("The number NaN cannot be converted to a BigInt"))).toEqual({status: 500, error: "internal error"});
  });
  it("T26 the chain RPC failing (throttled, down, refusing) is a 503 with Retry-After, not a 500 (46630: /v1/vault/* 500 for ~10 min)", () => {
    const url = "https://rpc.example";
    const abi = parseAbi(["function totalAssets() view returns (uint256)"]);
    const wrap = (cause: Error) => new ContractFunctionExecutionError(cause as never, {abi, functionName: "totalAssets", args: [], contractAddress: "0xcDFa4DD7535cFae585BbFe4627D8B0124be43118"});
    const causes = [
      new UnknownRpcError(new Error("An unknown RPC error occurred.")),
      new HttpRequestError({url, status: 429, body: {}}),
      new TimeoutError({body: {}, url}),
      new InvalidRequestRpcError(new RpcRequestError({url, body: {}, error: {code: -32600, message: "JSON is not a valid request object."}})),
    ];
    for (const c of causes) {
      for (const e of [c, wrap(c)]) {
        const r = errorStatus(e);
        expect(r.status, e.name).toBe(503);
        expect(r.retryAfter, e.name).toBeGreaterThan(0);
        expect(r.error, e.name).toMatch(/RPC/);
      }
    }
  });
});
