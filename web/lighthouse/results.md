# Lighthouse (06 acceptance: performance ≥ 85)

Run: `pnpm --filter @stockline/web lighthouse` on 2026-09-28T19:18:14.603Z: production build (`next build && next start`) against the local
stack (anvil seed week → indexer → API), Lighthouse 13 default mobile profile (simulated slow 4G, 4× CPU), Chromium from Playwright.

| Page | Performance | Accessibility | Best practices | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/markets` | **82** | 100 | 100 | 0.8 s | 4.4 s | 190 ms | 0.031 |
| `/data` | **83** | 100 | 100 | 0.9 s | 4.7 s | 100 ms | 0 |
