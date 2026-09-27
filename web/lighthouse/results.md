# Lighthouse (06 acceptance: performance ≥ 85)

Run: `pnpm --filter @stockline/web lighthouse` on 2026-09-27T16:18:44.466Z: production build (`next build && next start`) against the local
stack (anvil seed week → indexer → API), Lighthouse 13 default mobile profile (simulated slow 4G, 4× CPU), Chromium from Playwright.

| Page | Performance | Accessibility | Best practices | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/` | **96** | 100 | 100 | 0.8 s | 2.4 s | 30 ms | 0.085 |
| `/short-interest` | **91** | 100 | 100 | 0.9 s | 3.1 s | 20 ms | 0.101 |
