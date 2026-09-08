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
# The root `prepare` script runs before any source is copied, so the one file it needs comes first.
# It installs git hooks where there is a git repository and does nothing here, which is the point.
COPY scripts/install-git-hooks.mjs scripts/
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
# Created unconditionally so the COPY below never depends on which dependency happened to conflict
# this week. An empty directory copies fine; a missing one fails the build.
RUN mkdir -p apps/api/node_modules packages/shared/node_modules

FROM node:24.11.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repository

# Never root. A process that reaches a shell in this container should own nothing it can rewrite.
#
# The mount point below is where the bootstrap leaves the demo receiver's copy of the merchant's
# signing secret. Three details are load-bearing and each was a failure first:
#
#   - It exists in the image, so Docker initialises the named volume from it, ownership included. A
#     volume mounted over a path the image does not have is created owned by root, and a container
#     that correctly refuses to run as root then cannot write to its own volume.
#   - The two images share one group rather than one account, because the receiver is a different
#     service with a different uid and that separation is the point.
#   - The directory is setgid, so the file the bootstrap creates inherits that group. Without it the
#     file is owned by this image's group alone and the receiver reads EACCES, which surfaces as a
#     receiver that answers 503 to every callback for no visible reason.
RUN groupadd --system --gid 10500 demosecret \
  && useradd --system --uid 10001 --home /repository --groups demosecret cryptopay \
  && mkdir -p /demo-secret \
  && chown cryptopay:demosecret /demo-secret \
  && chmod 2770 /demo-secret

# The root tree, and then each workspace's own.
#
# npm workspaces hoist what it can and leave a version conflict nested: viem pulls @noble/curves 1.x
# to the root, so the 2.x this codebase requires lives in apps/api/node_modules. Copying only the
# root drops it, the image builds and starts cleanly, and the first payment fails at run time with
# "Cannot read properties of undefined" from a v1 module answering a v2 call.
COPY --from=build --chown=cryptopay:cryptopay /repository/node_modules ./node_modules
COPY --from=build --chown=cryptopay:cryptopay /repository/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=cryptopay:cryptopay /repository/packages/shared/node_modules ./packages/shared/node_modules
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
