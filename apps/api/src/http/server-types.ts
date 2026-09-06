import type { IncomingMessage, ServerResponse } from 'node:http';

import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { Logger } from 'pino';

/**
 * The concrete Fastify instance this application builds: the default HTTP server with a pino logger.
 * Naming it once keeps every route registrar in agreement; the bare `FastifyInstance` default uses
 * `FastifyBaseLogger`, which is not assignable to pino's `Logger`.
 */
export type ApplicationServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  Logger
>;
