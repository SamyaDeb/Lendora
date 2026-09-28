import {describe, expect, it} from "vitest";
import {redactSecrets, safeErrorLine} from "../src/redact.js";

describe("OFF-1 redactSecrets: no secret in logs, errors or /health", () => {
  const env = {
    RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/AbCdEf0123456789",
    KEEPER_REMOTE_SIGNER_AUTH: "Bearer s3cr3t-token-value",
    DATABASE_URL: "postgres://app:hunter2hunter2@db.internal:5432/stockline",
    PORT: "8080",
    SHORT_KEY: "abc",
  };

  it("OFF_1 replaces secret env values and URL paths/userinfo, keeps hosts for debugging", () => {
    const viemLike = `HTTP request failed.\n\nURL: ${env.RPC_URL}\nRequest body: {"method":"eth_call"}\nauth ${env.KEEPER_REMOTE_SIGNER_AUTH}`;
    const r = redactSecrets(viemLike, env);
    expect(r).not.toContain("AbCdEf0123456789");
    expect(r).not.toContain("s3cr3t-token-value");
    expect(r).toContain("[redacted:RPC_URL]");
    expect(r).toContain("[redacted:KEEPER_REMOTE_SIGNER_AUTH]");
    expect(redactSecrets(`connect ${env.DATABASE_URL} failed`, {})).toBe("connect postgres://[redacted]@db.internal:5432/[redacted] failed");
    expect(redactSecrets("GET https://api.telegram.org/bot123:ABC/sendMessage?x=1 failed", {})).toBe("GET https://api.telegram.org/[redacted] failed");
    expect(redactSecrets("port 8080 abc", env)).toBe("port 8080 abc"); // non-secret names and short values stay
  });

  it("OFF_1 safeErrorLine is one redacted line with a length bound", () => {
    const e = new Error(`request to ${env.RPC_URL} failed\nsecond line`);
    const line = safeErrorLine(e, env);
    expect(line).toBe("Error: request to [redacted:RPC_URL] failed | second line");
    expect(safeErrorLine("x".repeat(1000), {}, 50)).toHaveLength(51);
  });
});
