# Testnet browser pass with a real wallet (46630)

What the automated pass ([`web/e2e/testnet.spec.ts`](../../web/e2e/testnet.spec.ts), an injected test wallet that signs in
node) can't judge: how a real wallet shows each prompt, WalletConnect on a phone, and one full short in a human's hands.
About 20 minutes. Use a fresh test wallet funded with a little testnet ETH (faucet.testnet.chain.robinhood.com), never
a wallet that holds anything real.

Setup: `scripts/dev-testnet.sh --network 46630` running; open http://127.0.0.1:3000. Network: Robinhood Chain Testnet,
chain id 46630, RPC `https://rpc.testnet.chain.robinhood.com`, currency ETH.

| # | Do | Expected | Result (pass / fail + note, tx hash) |
|---|---|---|---|
| **Row 24 in a real wallet** | | | |
| 1 | MetaMask (or Rabby) on **Ethereum mainnet**; click Connect wallet → Browser wallet | The wallet asks to connect, then asks to switch to Robinhood Chain Testnet (or to add it) | |
| 2 | Reject the switch | A toast: “Switch to Robinhood Chain Testnet to continue” and how (T24); the button stays “Connect wallet” | |
| 3 | Connect again, approve the switch | Connected; the header shows your address with a green dot | |
| 4 | In the wallet, switch to another network by hand | The header and the action button change to “Switch to Robinhood Chain Testnet”; one click brings it back; nothing is sent on the other chain | |
| **How the prompts read** | | | |
| 5 | `/portfolio` → Get test tokens | One transaction to the faucet (`0x3BA7…E9e2`); the wallet shows no token value leaving | |
| 6 | `/stock/NVDA?tab=lend`, lend 1 → Review → Confirm | First an **approve** prompt for NVDA, spender the router `0x8233…5C0B` (the app asks for unlimited: note whether your wallet offers to lower it and whether the lend still works with the exact amount), then the lend | |
| 7 | `/stock/NVDA?tab=short`, collateral 300 USDG, short 0.05 → Review | The review shows the liquidation price, health factor now / at the close / at +10% before any prompt | |
| 8 | Confirm | Prompts, in order: approve USDG (first time), **Morpho `setAuthorization(router, true)`** (first time; the label says it is revocable), a **signature** of the terms (plain text that says no funds move, with your address and the terms version; no gas), then the `openShort` transaction | |
| 9 | Read the terms signature text in the wallet | Readable text, not hex; names Lendora, the version and hash, and that signing moves no funds | |
| 10 | Reject one prompt (any), then press “Try again” | “You cancelled the request in your wallet.”; the retry picks up from the step that was rejected (approvals already done are not asked again) | |
| **WalletConnect on a phone** (needs `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`; skip and note it if unset) | | | |
| 11 | Connect wallet → WalletConnect; scan the QR with a phone wallet on 46630 | Connected; the address matches the phone | |
| 12 | Lend 0.1 NVDA from the desktop page | The prompt appears on the phone; after signing, the page shows the success state within ~10 s | |
| 13 | Open http://<this machine's LAN IP>:3000 on the phone itself (390 px class screen) | Pages fit without sideways scroll; Lend / Borrow / Short open as a bottom sheet | |
| **One full short, open and close** | | | |
| 14 | `/stock/NVDA?tab=short`: collateral 500 USDG, drag the safety target to 2.0 | The amount fills in; the preview updates; the health factor at 24 h reads ~2.0 | |
| 15 | Review → Confirm | “Shorted … NVDA”; View portfolio shows the position, health factor, liquidation price now and during the next closure | |
| 16 | `/portfolio`: add 100 USDG collateral | The health factor rises in the review (before → after) and on the card | |
| 17 | Repay part: type 0.01 in “Repay with stock” → Repay 0.01 | Debt falls by 0.01 NVDA; the position stays open (US-B5) | |
| 18 | Close (buy back with USDG) | Debt 0, collateral back in USDG minus the buy-back cost; the card disappears; History shows Shorted / Repaid / Closed short with explorer links | |

Record the results here (date, wallet, browser, phone) and file any failure in
[testnet-issues.md](testnet-issues.md) as the next T number.
