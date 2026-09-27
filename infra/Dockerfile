# Stockline Node services (indexer, api, compliance, keepers): one image, the service chosen at runtime.
#   docker build -f infra/Dockerfile -t stockline-svc .
#   docker run -e SERVICE=api … stockline-svc
# SERVICE: indexer | api | compliance | allocator | guard | liquidator | alerts | feed-mirror | monitor | reconcile
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/devnet/package.json packages/devnet/
COPY indexer/package.json indexer/
COPY api/package.json api/
COPY compliance/package.json compliance/
COPY keepers/package.json keepers/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY packages/sdk packages/sdk
COPY indexer indexer
COPY api api
COPY compliance compliance
COPY keepers keepers
RUN pnpm --filter @stockline/sdk build

FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate && addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /app /app
USER app
ENV NODE_ENV=production DRY_RUN=true
COPY --chmod=755 infra/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
