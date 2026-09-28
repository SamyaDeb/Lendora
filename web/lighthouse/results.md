# Lighthouse (06 acceptance: performance ≥ 85)

Run: `pnpm --filter @stockline/web lighthouse` on 2026-09-28T19:59:01.645Z: production build (`next build && next start`) against the local
stack (anvil seed week → indexer → API), Lighthouse 13 default mobile profile (simulated slow 4G, 4× CPU), Chromium from Playwright.

| Page | Performance | Accessibility | Best practices | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/markets` | **90** | 100 | 100 | 0.8 s | 3.4 s | 160 ms | 0.033 |
| `/data` | **89** | 100 | 100 | 0.9 s | 3.6 s | 90 ms | 0 |
