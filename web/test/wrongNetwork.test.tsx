import {renderHook} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";

// wagmi's `useChainId()` never follows a wallet to a chain that isn't in the config (createConfig: "If chain is not
// configured, then don't switch over to it"): it stays on the app's chain. Only the connection's own chain id moves.
const state = {accountChainId: undefined as number | undefined, appChainId: 0};
vi.mock("wagmi", () => ({
  useAccount: () => ({isConnected: true, connector: {id: "injected"}, chainId: state.accountChainId}),
  useChainId: () => state.appChainId, // wagmi keeps reporting the app's chain; the hook must not rely on it
  useConnect: () => ({connectors: [], connectAsync: vi.fn(), isPending: false}),
  useDisconnect: () => ({disconnect: vi.fn()}),
  useSwitchChain: () => ({switchChain: vi.fn(), isPending: false}),
}));

const {useWrongNetwork} = await import("../components/shell/ConnectButton");
const {chain} = await import("../lib/env");
state.appChainId = chain.id;

describe("T20 wrong-network prompt (APP-R1, 46630 browser pass row 24)", () => {
  it("fires when the wallet moves to a chain the app does not configure (e.g. Ethereum mainnet)", () => {
    state.accountChainId = 1;
    expect(renderHook(() => useWrongNetwork()).result.current).toBe(true);
  });
  it("stays quiet on the app's chain (46630 on testnet)", () => {
    state.accountChainId = chain.id;
    expect(renderHook(() => useWrongNetwork()).result.current).toBe(false);
  });
});

describe("T24 rejecting the network switch while connecting says why (APP-R1)", () => {
  it("wallet connected on another chain after a rejected switch → 'Switch to <chain> to continue'", async () => {
    const {connectFailure} = await import("../components/shell/ConnectButton");
    const rejected = Object.assign(new Error("User rejected the request."), {code: 4001});
    const r = connectFailure(rejected, {accounts: ["0x8571B0664e409f4bB06f71B5dfb1D5Ea45D78282"], chainId: 1});
    expect(r.title).toBe(`Switch to ${chain.name} to continue`);
    expect(r.body).toMatch(/another network/);
  });
  it("the connection itself cancelled → 'cancelled', not the switch text", async () => {
    const {connectFailure} = await import("../components/shell/ConnectButton");
    const r = connectFailure(Object.assign(new Error("User rejected the request."), {code: 4001}), {accounts: [], chainId: 1});
    expect(r.title).toMatch(/cancelled/i);
  });
  it("no wallet in the browser → try another option; anything else → its first line, never empty", async () => {
    const {connectFailure} = await import("../components/shell/ConnectButton");
    expect(connectFailure(new Error("ProviderNotFoundError: Provider not found.")).body).toMatch(/isn't available in this browser/);
    const r = connectFailure(new Error("Something odd\nstack…"));
    expect(r.body).toBe("Something odd");
  });
});
