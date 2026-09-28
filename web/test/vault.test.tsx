import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {cleanup, fireEvent, render} from "@testing-library/react";
import {FX_VAULT_OVERVIEW, FX_VAULT_USER, fxVault, VAULT_STATES, type VaultState} from "@/lib/fixtures";
import {depositBlocker, withdrawBlocker, type VaultOverview, type WithdrawRequest} from "@/lib/vault";
import {VaultView} from "@/components/vault/VaultView";
import {WithdrawRequestCard} from "@/components/vault/WithdrawRequestCard";
import {WithdrawSplit} from "@/components/vault/WithdrawForm";
import {DepositForm} from "@/components/vault/DepositForm";
import type {DepositFlow} from "@/lib/vault/useDepositFlow";

vi.mock("next/navigation", () => ({useRouter: () => ({push: vi.fn()}), usePathname: () => "/vault"}));
beforeAll(() => {
  // jsdom has no matchMedia (useMediaQuery): report a desktop viewport.
  window.matchMedia = ((q: string) => ({matches: q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}})) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

/** CP-R7: no promises anywhere on the page. */
const PROMISE = /guarantee|up to \d|will earn|earn \d+(\.\d+)?%|risk[- ]free/i;
const A = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955" as const;

function view(state: VaultState, extra: Partial<Parameters<typeof VaultView>[0]> = {}) {
  const fx = fxVault(state);
  return render(<VaultView o={fx.overview} u={fx.user} error={fx.error} connected={state !== "disconnected"} fixture onMode={() => {}} panel={<div data-testid="panel-slot" />} onRetry={() => {}} {...extra} />);
}

describe("USDG Earn page (fixtures)", () => {
  it("labels the APY as net, windowed, variable and historical, and never promises a return", () => {
    const {container, getByTestId} = view("open");
    expect(getByTestId("apy-label").textContent).toBe("Net APY (30d, variable)");
    expect(getByTestId("apy-headline").textContent).toContain("9.34%");
    expect(container.textContent).toContain("historical");
    expect(container.textContent).toContain("Past returns don't predict future ones.");
    expect(container.textContent).not.toMatch(PROMISE);
    expect(getByTestId("preview-badge")).toBeTruthy();
  });

  it("the split adds up to the headline, and the window switch moves both", () => {
    const {getByTestId} = view("open");
    expect(getByTestId("split-net").textContent).toBe("9.34%");
    fireEvent.click(getByTestId("apy-7d"));
    expect(getByTestId("apy-label").textContent).toBe("Net APY (7d, variable)");
    expect(getByTestId("split-net").textContent).toBe("10.12%");
    const costs = getByTestId("yield-split").querySelector('[data-part="costs"]')!;
    expect(costs.textContent).toContain("−0.68%"); // negative, and said so in text
  });

  it("puts the yield sources, fee and risks on the same screen as the deposit button", () => {
    const {container, getByTestId} = view("open");
    expect(getByTestId("panel-slot")).toBeTruthy();
    expect(container.textContent).toContain("Where the yield comes from");
    expect(container.textContent).toContain("10% of gains above your previous high. No management fee.");
    const risks = getByTestId("vault-risks").textContent!;
    expect(risks).toContain("single point of failure");
    expect(risks).toContain("audited separately");
    expect(risks).toContain("72 hours or at the next US market open");
    expect(getByTestId("how-its-run").hasAttribute("open")).toBe(false); // collapsed by default
  });

  const MESSAGES: Partial<Record<VaultState, string>> = {
    preview: "Deposits open after the simulation gate and audits.",
    cap_full: "The vault is full. Withdrawals work; deposits reopen when the cap rises.",
    weekend: "Perps keep trading while Stock Token prices are frozen.",
    nav_stale: "Withdrawal requests and claims of settled requests still work.",
    kill_switch: "The NVDA sleeve moved to USDG because funding stayed negative. Your balance isn't affected; the APY is lower.",
    venue_halted: "Queued withdrawals may take longer than 72 hours",
    error: "Vault data didn't load",
  };
  it.each(VAULT_STATES.filter((s) => MESSAGES[s]))("state %s says what is going on", (s) => {
    const {container} = view(s);
    expect(container.textContent).toContain(MESSAGES[s]);
    expect(container.textContent).not.toMatch(PROMISE);
  });

  it("weekend keeps 3× margin; kill switch marks the sleeve unwound; halted venue is a danger alert", () => {
    expect(view("weekend").container.textContent).toContain("3× maintenance instead of 2×");
    cleanup();
    expect(view("kill_switch").getByTestId("sleeves").textContent).toContain("Unwound to USDG");
    cleanup();
    expect(view("venue_halted").getByRole("alert").textContent).toContain("halted withdrawals");
  });

  it("loading is a layout-matched skeleton; error offers a retry", () => {
    expect(view("loading").getByTestId("vault-loading").getAttribute("aria-busy")).toBe("true");
    cleanup();
    const onRetry = vi.fn();
    const e = view("error", {onRetry});
    fireEvent.click(e.getByText("Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("position strip: only for a connected wallet with shares or requests; earnings unknown until indexed", () => {
    expect(view("disconnected").queryByTestId("position-strip")).toBeNull();
    cleanup();
    expect(view("empty").queryByTestId("position-strip")).toBeNull();
    cleanup();
    const r = view("has_requests");
    expect(r.getByTestId("position-earned").textContent).toContain("+");
    expect(r.getByTestId("position-strip").querySelectorAll("[data-status]").length).toBe(2);
    cleanup();
    const unindexed = render(<VaultView o={FX_VAULT_OVERVIEW} u={{...FX_VAULT_USER, netDeposits: 0}} connected onMode={() => {}} panel={null} />);
    expect(unindexed.getByTestId("position-earned").textContent).toBe("–");
  });
});

describe("withdraw", () => {
  it("previews the instant and queued parts with the settlement time", () => {
    const {getByTestId} = render(<WithdrawSplit pv={{instant: 3_000, queued: 2_000, settlesAt: "2026-10-12T13:30:00.000Z"}} asOf="2026-10-10T09:10:00.000Z" fetchedAt={Date.now()} />);
    expect(getByTestId("withdraw-split").textContent).toBe("3,000 USDG now · 2,000 USDG queued, paid by Mon 09:30 ET (2d 4h)");
  });

  const req = (status: WithdrawRequest["status"]): WithdrawRequest => ({id: `r-${status}`, assets: 2_000, shares: 1_918.8, requestedAt: "2026-10-06T19:19:12.000Z", settlesAt: "2026-10-09T20:19:12.000Z", status, position: status === "queued" ? 3 : 0});
  it("request cards: queued has a countdown and position, ready has Claim, claimed says so", () => {
    const onClaim = vi.fn();
    const q = render(<WithdrawRequestCard r={req("queued")} asOf="2026-10-06T20:19:12.000Z" fetchedAt={Date.now()} onClaim={onClaim} />);
    expect(q.getByText("Queued")).toBeTruthy();
    expect(q.getByTestId("request-countdown").textContent).toContain("3d 0h");
    expect(q.container.textContent).toContain("#3 in the queue");
    expect(q.queryByRole("button")).toBeNull();
    cleanup();
    const r = render(<WithdrawRequestCard r={req("ready")} onClaim={onClaim} />);
    expect(r.getByText("Ready to claim")).toBeTruthy();
    fireEvent.click(r.getByTestId("claim-r-ready"));
    expect(onClaim).toHaveBeenCalledWith(expect.objectContaining({id: "r-ready"}));
    cleanup();
    expect(render(<WithdrawRequestCard r={req("claimed")} />).container.textContent).toContain("Claimed");
  });

  it("is an exit: never blocked by region, pause or a stale NAV, only by the amount", () => {
    const stale = fxVault("nav_stale").overview!;
    expect(withdrawBlocker({connected: true, o: stale, u: FX_VAULT_USER, assets: 100})).toBeUndefined();
    expect(withdrawBlocker({connected: true, o: fxVault("cap_full").overview!, u: FX_VAULT_USER, assets: 100})).toBeUndefined();
    expect(withdrawBlocker({connected: true, o: stale, u: FX_VAULT_USER, assets: 1e9})).toBe("That's more than your balance in the vault.");
  });
});

describe("deposit (entry)", () => {
  const o = FX_VAULT_OVERVIEW;
  const base = {connected: true, o, u: FX_VAULT_USER, assets: 1_000};
  it.each<[string, Parameters<typeof depositBlocker>[0], string]>([
    ["not connected", {...base, connected: false}, "Connect a wallet to deposit."],
    ["wrong network", {...base, wrongNetwork: true}, "Switch your wallet to the right network to deposit."],
    ["restricted region", {...base, restricted: true}, "USDG Earn isn't available in your region. Withdrawals and claims still work from your portfolio."],
    ["pre-launch", {...base, o: fxVault("preview").overview}, "Deposits open after the simulation gate and audits."],
    ["cap full", {...base, o: fxVault("cap_full").overview}, "The vault is full. Withdrawals work; deposits reopen when the cap rises."],
    ["paused", {...base, o: {...o, depositsOpen: false, pauseReason: "paused"} as VaultOverview}, "Deposits are paused by the vault's guardian. Withdrawals and claims still work."],
    ["stale NAV", {...base, o: fxVault("nav_stale").overview}, "Deposits are paused while the vault's price data is more than 15 minutes old and markets are closed. They reopen with the next fresh report."],
    ["over balance", {...base, assets: 60_000}, "That's more USDG than you hold."],
    ["over the cap", {...base, u: {...FX_VAULT_USER, usdgBalance: 1e7}, assets: 800_000}, "Only 716,000.00 USDG of room is left under the vault's cap."],
  ])("blocked: %s", (_, p, msg) => {
    expect(depositBlocker(p)).toBe(msg);
  });

  it("shows the reason under the button, and the only estimate carries 'variable, not a forecast'", () => {
    const f = {amount: "60000", setAmount: () => {}, assets: 60_000, invalid: false, o, u: FX_VAULT_USER, preview: {shares: 57_564.9, sharePrice: o.sharePrice}, address: A, pinned: true, blocker: depositBlocker({...base, assets: 60_000}), plan: [], steps: {states: [], busy: false, error: undefined, run: async () => true, reset: () => {}}, confirm: async () => false} as unknown as DepositFlow;
    const {getByTestId, container} = render(<DepositForm f={f} />);
    expect(getByTestId("deposit-blocker").textContent).toBe("That's more USDG than you hold.");
    expect((getByTestId("deposit-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId("earn-estimate").textContent).toBe("At today's rate ≈ 5,604.00 USDG a year (variable, not a forecast)");
    expect(container.textContent).not.toMatch(PROMISE);
  });
});
