# The API and both workers ship from one image; they differ only in the process they start.
#
# One image rather than three because they share every dependency and every line of the domain, so
# three would triple the build time and the surface to patch in exchange for nothing. What differs
# between them is the command and, more importantly, the database role and network policy the
# compose file gives each one.

FROM node:24.11.1-bookworm-slim AS build
WORKDIR /repository

# The manifests alone first, so a change to source code does not invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @cryptopay/shared --workspace @cryptopay/api --include-workspace-root

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace packages/shared && npm run build --workspace apps/api

# A second install with the dev dependencies removed. Copying node_modules from the build stage
# would carry TypeScript, ESLint and Vitest into production for no reason.
RUN npm ci --omit=dev --workspace @cryptopay/shared --workspace @cryptopay/api --include-workspace-root

FROM node:24.11.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repository

# Never root. A process that reaches a shell in this container should own nothing it can rewrite.
RUN useradd --system --uid 10001 --home /repository cryptopay

COPY --from=build --chown=cryptopay:cryptopay /repository/node_modules ./node_modules
COPY --from=build --chown=cryptopay:cryptopay /repository/package.json ./package.json
COPY --from=build --chown=cryptopay:cryptopay /repository/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=cryptopay:cryptopay /repository/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=cryptopay:cryptopay /repository/apps/api/dist ./apps/api/dist
COPY --from=build --chown=cryptopay:cryptopay /repository/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=cryptopay:cryptopay /repository/apps/api/migrations ./apps/api/migrations

USER cryptopay
EXPOSE 3001

# Overridden per service in the compose file. The API is the default because it is the one a person
# running this image by hand almost always wants.
CMD ["node", "apps/api/dist/main.api.js"]
