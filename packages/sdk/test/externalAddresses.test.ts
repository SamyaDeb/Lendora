import {readFileSync} from "node:fs";
import {keccak_256} from "@noble/hashes/sha3";
import {bytesToHex} from "@noble/hashes/utils";
import {describe, expect, it} from "vitest";
import {externalChainIds, getExternal} from "../src/externalAddresses.js";

/** EIP-55 checksum of a 20-byte hex address. */
function toChecksum(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

function collectAddresses(node: unknown, path: string, out: [string, string][]): void {
  if (typeof node === "string") {
    if (/^0x[0-9a-fA-F]{40}$/.test(node)) out.push([path, node]);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collectAddresses(v, `${path}.${k}`, out);
  }
}

describe("external-addresses.json", () => {
  const raw = JSON.parse(readFileSync(new URL("../external-addresses.json", import.meta.url), "utf8"));

  it("parses and is keyed by chain id", () => {
    expect(externalChainIds).toContain(4663);
    for (const key of Object.keys(raw).filter((k) => k !== "$comment")) {
      expect(key).toMatch(/^\d+$/);
    }
  });

  it("checksum helper matches the EIP-55 test vector", () => {
    expect(toChecksum("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  });

  it("every address is EIP-55 checksummed", () => {
    const found: [string, string][] = [];
    collectAddresses(raw, "", found);
    expect(found.length).toBeGreaterThan(50);
    for (const [path, address] of found) {
      expect(address, path).toBe(toChecksum(address));
    }
  });

  it("exposes the launch stocks with their feeds", () => {
    const rh = getExternal(4663)!;
    for (const t of ["SPY", "NVDA", "AAPL"]) {
      expect(rh.stockTokens[t]).toBeDefined();
      expect(rh.chainlink[t].decimals).toBe(8);
    }
    expect(rh.chainlink.USDG.proxy).toBeDefined();
    expect(getExternal(1)).toBeUndefined();
  });
});
