FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
ENV CI=true
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --dir artifacts/api-server run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
RUN corepack enable

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /app/artifacts/api-server/package.json ./artifacts/api-server/package.json

EXPOSE 4000
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
