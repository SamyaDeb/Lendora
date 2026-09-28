# Stockline web app. NEXT_PUBLIC_* are inlined at build time (build args); server secrets come at runtime.
# OFF-15: base image pinned by digest (node v22.23.3, Alpine 3.24; 2026-09-28). Bump the digest deliberately.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/devnet/package.json packages/devnet/
COPY indexer/package.json indexer/
COPY api/package.json api/
COPY compliance/package.json compliance/
COPY keepers/package.json keepers/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/sdk packages/sdk
COPY web web
ARG NEXT_PUBLIC_CHAIN_ID=46630
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @stockline/sdk build && pnpm --filter @stockline/web build

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate && addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /app /app
USER app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
EXPOSE 3000
CMD ["pnpm", "--filter", "@stockline/web", "start"]
