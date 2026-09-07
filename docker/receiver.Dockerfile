# The bundled merchant endpoint. It verifies with the same module the API signs with, so the demo
# demonstrates interoperability rather than claiming it.

FROM node:24.11.1-bookworm-slim AS build
WORKDIR /repository

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/demo-receiver/package.json apps/demo-receiver/
RUN npm ci --workspace @cryptopay/shared --workspace @cryptopay/demo-receiver --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/demo-receiver apps/demo-receiver
RUN npm run build --workspace packages/shared && npm run build --workspace apps/demo-receiver
RUN npm ci --omit=dev --workspace @cryptopay/shared --workspace @cryptopay/demo-receiver --include-workspace-root

FROM node:24.11.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repository
RUN useradd --system --uid 10002 --home /repository receiver

COPY --from=build --chown=receiver:receiver /repository/node_modules ./node_modules
COPY --from=build --chown=receiver:receiver /repository/package.json ./package.json
COPY --from=build --chown=receiver:receiver /repository/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=receiver:receiver /repository/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=receiver:receiver /repository/apps/demo-receiver/dist ./apps/demo-receiver/dist
COPY --from=build --chown=receiver:receiver /repository/apps/demo-receiver/package.json ./apps/demo-receiver/package.json

USER receiver
EXPOSE 8080
CMD ["node", "apps/demo-receiver/dist/main.js"]
