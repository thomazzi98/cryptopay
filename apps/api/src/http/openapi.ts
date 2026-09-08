import { buildOpenApiDocument, documentedOperations } from '@cryptopay/shared';

import type { ApplicationServer } from './server-types.js';

/**
 * Serves the contract, and refuses to start if it does not describe this server.
 *
 * The document is generated from the same zod schemas the handlers validate with, so the field
 * shapes cannot drift. What can drift is the set of endpoints: adding a route and forgetting to
 * document it, or documenting one nobody implemented. Both are checked here against the routes
 * Fastify actually registered, and both stop the process.
 *
 * Stopping is the point. A drift check that only runs in CI is a check that passes on the machine
 * where nobody was going to make the mistake; this one fails in the deployment where an integrator
 * would otherwise generate a client against an endpoint that answers 404.
 */

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
}

/** Fastify names path parameters `:name`; OpenAPI names them `{name}`. */
function toFastifyPath(documentedPath: string): string {
  return documentedPath.replaceAll(/\{(?<parameter>[^}]+)\}/gu, ':$<parameter>');
}

// HEAD is added automatically for every GET and OPTIONS is answered by the router itself, so neither
// is something a caller integrates against.
const UNDOCUMENTED_METHODS: ReadonlySet<string> = new Set(['HEAD', 'OPTIONS']);

/** Only so the two lists read in a stable order when the check reports what it found. */
function byName(left: string, right: string): number {
  return left.localeCompare(right);
}

export function assertRoutesMatchDocument(routes: readonly RegisteredRoute[]): void {
  const served = new Set(
    routes
      .filter((route) => !UNDOCUMENTED_METHODS.has(route.method.toUpperCase()))
      .map((route) => `${route.method.toUpperCase()} ${route.url}`),
  );
  const documented = new Set(
    documentedOperations().map(
      (operation) => `${operation.method.toUpperCase()} ${toFastifyPath(operation.path)}`,
    ),
  );

  const undocumented = [...served].filter((route) => !documented.has(route)).toSorted(byName);
  const unimplemented = [...documented].filter((route) => !served.has(route)).toSorted(byName);
  if (undocumented.length === 0 && unimplemented.length === 0) {
    return;
  }

  const complaints = [
    ...undocumented.map((route) => `  ${route} is served but not in the OpenAPI document`),
    ...unimplemented.map((route) => `  ${route} is documented but not served`),
  ];
  throw new Error(`The OpenAPI document does not describe this server:\n${complaints.join('\n')}`);
}

export function registerOpenApiRoute(server: ApplicationServer, serverUrl: string): void {
  // Built once. It is derived entirely from frozen schemas, so rebuilding it per request would burn
  // CPU to produce the identical bytes.
  const document = buildOpenApiDocument({ serverUrl });

  server.get('/openapi.json', (request, reply) => {
    void reply.code(200).type('application/json').send(document);
  });
}
