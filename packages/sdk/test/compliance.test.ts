import {describe, expect, it} from "vitest";
import {isRestricted, restrictedList, restrictedListFromEnv, termsMessage} from "../src/compliance.js";

describe("compliance list and terms message (CP-R1, APP-R2, APP-R10)", () => {
  it("CP_R1 restricts the Stock Token exclusions and sanctioned jurisdictions, from config", () => {
    for (const c of ["US", "CA", "GB", "CH", "AE", "IR", "KP"]) expect(isRestricted({country: c}), c).toBe(true);
    for (const c of ["DE", "SG", "BR", "IN"]) expect(isRestricted({country: c}), c).toBe(false);
    expect(isRestricted({country: "UA", region: "UA-43"})).toBe(true); // Crimea
    expect(isRestricted({country: "UA", region: "43"})).toBe(true);
    expect(isRestricted({country: "UA", region: "UA-30"})).toBe(false); // Kyiv
    expect(restrictedList.countries).toContain("US");
  });

  it("CP_R1 the list is overridable by env without code changes", () => {
    const l = restrictedListFromEnv({RESTRICTED_COUNTRIES: "de, fr"});
    expect(isRestricted({country: "DE"}, l)).toBe(true);
    expect(isRestricted({country: "US"}, l)).toBe(false);
  });

  it("APP_R10 the terms message binds wallet, version and document hash", () => {
    const m = termsMessage("0xAbC0000000000000000000000000000000000001", "v1", "0xhash");
    expect(m).toContain("Wallet: 0xabc0000000000000000000000000000000000001");
    expect(m).toContain("Terms version: v1");
    expect(m).toContain("nothing here is an offer of securities");
  });

  it("T31 the terms message says signing is free and moves no funds (what a wallet user checks before signing)", () => {
    const m = termsMessage("0xAbC0000000000000000000000000000000000001", "v1", "0xhash");
    expect(m).toMatch(/Signing this message is free: it sends no transaction, moves no funds and approves nothing\./);
  });
});
