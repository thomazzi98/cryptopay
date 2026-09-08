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
};

export default configuration;
