import type {ChainDriver, DriverEvent} from "./driver.js";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const H = 3600n;
const D = 86_400n;

/** Wed 2026-09-30 16:00Z (12:00 ET): an open feed session in the generated calendar (packages/sdk/data). */
export const SEED_WED = 1_790_784_000n;
/** Timeline of the seed week (UTC seconds). The 24/5 feed closes Fri 20:00 ET (Sat 00:00Z, EDT) and reopens Sun
 * 20:00 ET (Mon 00:00Z); the closure buffer ramps in over the 4h before the close (D2, OR-R20). */
export const SEED_TIMES = {
  start: SEED_WED - H,
  wed: SEED_WED,
  thu: SEED_WED + D,
  friMorning: SEED_WED + 2n * D - 3n * H,
  rampStart: SEED_WED + 2n * D + 4n * H,
  close: SEED_WED + 2n * D + 8n * H,
  reopen: SEED_WED + 4n * D + 8n * H,
  mon: SEED_WED + 4n * D + 22n * H,
  tue: SEED_WED + 5n * D + 22n * H,
  end: SEED_WED + 6n * D + 4n * H,
} as const;

/** Deterministic, keyless test users (impersonated on anvil). */
const user = (n: number) => `0x57000000000000000000000000000000000000${n.toString(16).padStart(2, "0")}` as `0x${string}`;
export const USERS = {
  alice: user(1), // lends SPY
  bob: user(2), // lends NVDA, withdraws part
  carol: user(3), // lends AAPL
  dave: user(4), // lends NVDA, withdraws half
  erin: user(5), // tight NVDA short, liquidated after the Monday gap
  frank: user(6), // SPY short, adds collateral, closes
  grace: user(7), // plain AAPL borrow, repays
  heidi: user(8), // NVDA short with compounding
  ivan: user(9), // small SPY borrow
  judy: user(10), // tries to borrow AAPL while the guard is tripped
  liquidator: user(11),
} as const;

export interface SeedResult {
  events: DriverEvent[];
  users: typeof USERS;
  times: typeof SEED_TIMES;
  /** Block of the last action. */
  lastBlock: bigint;
}

/**
 * The seed week every Phase 2 test and the dev stack reuse: lends, borrows, shorts (one compounding), repays, a
 * withdrawal, a close, Friday ramp-in, a frozen weekend with a DEX premium, a Monday gap that makes one short
 * liquidatable and a standard Morpho liquidation, a guardian trip of the AAPL guard (liquidity pulled, a borrow rejected, exits
 * working, then cleared), a brief issuer pause of SPY and a SPY dividend multiplier change inside an oracle-pause window.
 */
export async function seedWeek(drv: ChainDriver): Promise<SeedResult> {
  const T = SEED_TIMES;
  const u = USERS;
  await drv.useAttestationSigner();
  await drv.freshRounds(T.start);

  // Lenders (US-L1) and the allocator moving deposits into the markets (LM-R30).
  await drv.lend("SPY", u.alice, 600n * E18);
  await drv.lend("NVDA", u.bob, 2000n * E18);
  await drv.lend("AAPL", u.carol, 500n * E18);
  await drv.lend("NVDA", u.dave, 300n * E18);
  await drv.allocate();

  // Wednesday: shorts and borrows (US-B1, US-B2). Erin's HF at t + 24h is ~1.12, just above HF_MIN_OPEN.
  await drv.freshRounds(T.wed);
  await drv.openShort("NVDA", u.erin, 32_900n * E6, 100n * E18);
  await drv.openShort("SPY", u.frank, 100_000n * E6, 50n * E18);
  await drv.borrow("AAPL", u.grace, 48_000n * E6, 60n * E18);
  await drv.openShort("NVDA", u.heidi, 50_000n * E6, 150n * E18, true); // Morpho checks health before the proceeds are compounded
  await drv.allocate();
  await drv.freshRounds(T.wed + 2n * H);
  await drv.repay("AAPL", u.grace, 30n * E18);

  // Thursday: prices drift, more activity.
  await drv.freshRounds(T.thu, {NVDA: 224_90000000n, SPY: 775_10000000n, AAPL: 339_20000000n});
  await drv.addCollateral("SPY", u.frank, 5_000n * E6);
  await drv.borrow("SPY", u.ivan, 30_200n * E6, 20n * E18);
  const daveShares = await drv.a.client.readContract({
    address: drv.stock("NVDA").vault,
    abi: [{type: "function", name: "balanceOf", stateMutability: "view", inputs: [{type: "address"}], outputs: [{type: "uint256"}]}] as const,
    functionName: "balanceOf",
    args: [u.dave],
  });
  await drv.withdrawLend("NVDA", u.dave, daveShares / 2n);
  await drv.allocate();

  // Friday: last rounds of the week while the closure buffer ramps in (16:00–20:00 ET).
  await drv.freshRounds(T.friMorning);
  for (let t = T.rampStart; t < T.close; t += H) await drv.freshRounds(t);
  await drv.freshRounds(T.close - 600n);

  // Weekend: the feed is frozen (no rounds); blocks keep coming; a small NVDA DEX premium appears.
  await drv.walk(T.close + 12n * H, 3n * H);
  await drv.setDex("NVDA", (drv.prices.NVDA * 102n) / 100n);
  await drv.walk(T.reopen - 60n, 3n * H);

  // Sunday 20:00 ET reopen: the first fresh rounds release the buffer; NVDA gaps up 15%, Erin's short is under water.
  await drv.freshRounds(T.reopen + 60n, {NVDA: 258_60000000n, SPY: 779_70000000n, AAPL: 334_10000000n});
  await drv.liquidate("NVDA", u.erin, u.liquidator);
  await drv.allocate();

  // Monday: a lender exits (LM-R22), rounds continue.
  await drv.freshRounds(T.mon);
  await drv.withdrawLend("NVDA", u.bob, 400n * E18);
  await drv.allocate();

  // Tuesday: the guardian trips the AAPL guard (MANUAL) → the allocator pulls liquidity (LM-R31) → a new borrow fails;
  // exits keep working (CP-R4: Grace repays everything); the guardian clears and liquidity returns. Separately the
  // issuer pauses SPY for a moment (D4): `poke()` latches TOKEN_PAUSED and emits it, then clears. (While the Stock
  // Token itself is paused, exits that move the Stock Token wait for the issuer, LM-R5.)
  await drv.freshRounds(T.tue);
  await drv.guardian("AAPL", "trip");
  await drv.allocate(["AAPL"]);
  try {
    await drv.borrow("AAPL", u.judy, 10_000n * E6, 5n * E18);
    throw new Error("borrow succeeded while the AAPL guard was tripped");
  } catch (e) {
    if (String(e).includes("succeeded")) throw e;
    drv.events.push({kind: "borrowRejected", ticker: "AAPL", user: u.judy, block: await drv.a.client.getBlockNumber(), timestamp: await drv.now(), detail: {reason: String(e).split(": ").pop() ?? ""}});
  }
  await drv.repay("AAPL", u.grace);
  await drv.guardian("AAPL", "clear");
  await drv.allocate(["AAPL"]);
  await drv.issuerPause("SPY", true);
  await drv.issuerPause("SPY", false);
  await drv.freshRounds(T.tue + 2n * H);
  await drv.poke();
  await drv.allocate();

  // Frank closes his short (US-B4); SPY pays a dividend through the multiplier (OR-R3 accepted path).
  await drv.closeShort("SPY", u.frank);
  await drv.multiplierChange("SPY", 1_002_000_000_000_000_000n);
  await drv.freshRounds(T.end);
  await drv.allocate();

  return {events: drv.events, users: USERS, times: SEED_TIMES, lastBlock: await drv.a.client.getBlockNumber()};
}
