import { resolve } from 'node:path';

import type { NextConfig } from 'next';

/**
 * Turbopack is the default builder in Next 16, and an injected `webpack` key fails the build hard
 * rather than being ignored. There is deliberately none here.
 *
 * `serverRuntimeConfig` and `publicRuntimeConfig` were removed in this major, which is why the
 * dashboard reaches the API through a route handler rather than through a base URL inlined at build
 * time: an inlined URL cannot differ between the container and the browser, and the API key must
 * never reach the browser bundle at all.
 */
const configuration: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@cryptopay/shared'],
  typedRoutes: true,

  // Traces exactly the files the server needs, so the image carries those instead of a node_modules
  // holding the whole toolchain.
  output: 'standalone',

  // Without this the trace root is inferred from the nearest lockfile and stops at apps/web, which
  // silently leaves the workspace packages out of the image: the build succeeds and the container
  // then fails to start on a module it cannot find.
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
};

export default configuration;
