import {describe, expect, it} from "vitest";
import {HttpError, errorStatus} from "../src/errors.js";

describe("API error mapping (SI-R4 availability)", () => {
  it("SI_R4 while the indexer rebuilds its views (restart, missing relation or schema) the API answers 503 with Retry-After, not 500", () => {
    // Postgres: 42P01 undefined_table ("relation stockline_testnet.chain_head does not exist"), 3F000 invalid_schema.
    for (const code of ["42P01", "3F000"]) {
      const r = errorStatus(Object.assign(new Error(`relation "stockline_testnet.chain_head" does not exist`), {code}));
      expect(r.status, code).toBe(503);
      expect(r.retryAfter, code).toBeGreaterThan(0);
      expect(r.error, code).toMatch(/indexer/);
    }
  });
  it("HttpError keeps its status; anything else is a 500 without details", () => {
    expect(errorStatus(new HttpError(404, "unknown stock"))).toEqual({status: 404, error: "unknown stock"});
    expect(errorStatus(new RangeError("The number NaN cannot be converted to a BigInt"))).toEqual({status: 500, error: "internal error"});
  });
});
