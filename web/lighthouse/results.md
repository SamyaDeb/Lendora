# Lighthouse (06 acceptance: performance ≥ 85)

Run: `pnpm --filter @stockline/web lighthouse` on 2026-09-27T12:57:27.663Z: production build (`next build && next start`) against the local
stack (anvil seed week → indexer → API), Lighthouse 13 default mobile profile (simulated slow 4G, 4× CPU), Chromium from Playwright.

| Page | Performance | Accessibility | Best practices | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/` | **96** | 100 | 100 | 1.3 s | 2.7 s | 60 ms | 0 |
| `/short-interest` | **94** | 100 | 100 | 0.9 s | 3.1 s | 20 ms | 0 |
