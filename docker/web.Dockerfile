# The dashboard and the checkout page.
#
# Built with Next's standalone output, which traces exactly the files the server needs and leaves
# the rest behind. Copying node_modules instead would carry the whole toolchain into an image whose
# job is to serve two dozen routes.

FROM node:24.11.1-bookworm-slim AS build
WORKDIR /repository

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @cryptopay/shared --workspace @cryptopay/web --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace packages/shared && npm run build --workspace apps/web

FROM node:24.11.1-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /repository
RUN useradd --system --uid 10003 --home /repository web

COPY --from=build --chown=web:web /repository/apps/web/.next/standalone ./
COPY --from=build --chown=web:web /repository/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=web:web /repository/apps/web/public ./apps/web/public

USER web
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
