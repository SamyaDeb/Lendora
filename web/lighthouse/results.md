# Lighthouse (06 acceptance: performance ≥ 85)

Run: `pnpm --filter @lendora/web lighthouse` on 2026-09-29T12:01:48.535Z: production build (`next build && next start`) against the local
stack (anvil seed week → indexer → API), Lighthouse 13 default mobile profile (simulated slow 4G, 4× CPU), Chromium from Playwright.

| Page | Performance | Accessibility | Best practices | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/markets` | **82** | 100 | 100 | 0.8 s | 4.1 s | 240 ms | 0.041 |
| `/data` | **89** | 100 | 100 | 0.9 s | 3.6 s | 130 ms | 0 |
