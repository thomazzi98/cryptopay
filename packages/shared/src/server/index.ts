/**
 * The node-only surface of the shared package.
 *
 * Everything here reaches for a node builtin, so it is kept out of the browser-safe entry point and
 * behind the `@cryptopay/shared/server` subpath. A lint rule enforces the split in the other
 * direction: nothing under `src/` outside this directory may import `node:*`.
 */

export * from './webhook-signature.js';
