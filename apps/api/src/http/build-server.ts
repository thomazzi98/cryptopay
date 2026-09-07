import { randomUUID } from 'node:crypto';

import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import { callbackSsrfPolicy, type Configuration } from '../configuration.js';
import type { CancelPaymentUseCase } from '../application/cancel-payment.use-case.js';
import type { CreatePaymentUseCase } from '../application/create-payment.use-case.js';
import type { IdempotencyRepository } from '../infrastructure/persistence/idempotency.repository.js';
import type { MerchantRepository } from '../infrastructure/persistence/merchant.repository.js';
import type { PaymentRepository } from '../infrastructure/persistence/payment.repository.js';
import { runWithRequestContext } from '../observability/logger.js';
import { createAuthenticationHook } from './authentication.js';
import {
  ApplicationError,
  PROBLEM_CONTENT_TYPE,
  toProblemDetails,
  toUnexpectedProblemDetails,
} from './problem-details.js';
import type { BlockCursorRepository } from '../infrastructure/persistence/block-cursor.repository.js';
import type { PaymentTransferRepository } from '../infrastructure/persistence/payment-transfer.repository.js';
import type { WebhookDeliveryRepository } from '../infrastructure/persistence/webhook-delivery.repository.js';
import type { WebhookSecretRepository } from '../infrastructure/persistence/webhook-secret.repository.js';
import type { UlidFactory } from '../infrastructure/system/ulid.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { registerMerchantRoutes } from './routes/merchants.routes.js';
import { registerPaymentRoutes } from './routes/payments.routes.js';
import { registerWebhookRoutes } from './routes/webhooks.routes.js';
import type { ApplicationServer } from './server-types.js';

export interface ServerDependencies {
  readonly configuration: Configuration;
  readonly logger: Logger;
  readonly merchantRepository: MerchantRepository;
  readonly paymentRepository: PaymentRepository;
  readonly idempotencyRepository: IdempotencyRepository;
  readonly paymentCreator: CreatePaymentUseCase;
  readonly paymentCanceler: CancelPaymentUseCase;
  readonly paymentTransferRepository: PaymentTransferRepository;
  readonly webhookDeliveryRepository: WebhookDeliveryRepository;
  readonly webhookSecretRepository: WebhookSecretRepository;
  readonly blockCursorRepository: BlockCursorRepository;
  readonly ulidFactory: UlidFactory;
}

const MAXIMUM_SUPPLIED_REQUEST_ID_LENGTH = 128;
const MAXIMUM_REQUEST_BODY_BYTES = 1_048_576;

/**
 * One structured line per request, emitted on completion. Extending Fastify's log controller rather
 * than adding an onResponse hook means the line is also emitted when the request ends in an error,
 * and it replaces the framework's own pair of lines instead of duplicating them.
 */
class RequestLogController extends LogController {
  override incomingRequest(): void {
    // Nothing is logged on arrival: the completion line carries the outcome and the duration, and a
    // second line per request doubles log volume without adding information.
  }

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    request.log.info(
      {
        event: 'http.request_completed',
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        status: reply.statusCode,
        durationMilliseconds: Math.round(reply.elapsedTime),
        failed: error !== null && error !== undefined,
      },
      'request completed',
    );
  }
}

const DEFAULT_ERROR_STATUS = 500;

/**
 * Anything can be thrown in JavaScript, including values that are not Errors. Reading the status and
 * message defensively means an unusual throw still produces a well-formed problem response rather
 * than a second failure inside the error handler.
 */
function readStatusCode(error: unknown): number {
  if (error instanceof Error && 'statusCode' in error) {
    const candidate: unknown = (error as { statusCode?: unknown }).statusCode;
    if (typeof candidate === 'number') {
      return candidate;
    }
  }
  return DEFAULT_ERROR_STATUS;
}

function readMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unhandled non-error throw';
}

/**
 * Builds the HTTP server without listening, so tests drive it through `fastify.inject()` rather than
 * binding a socket. That removes port allocation, teardown races and a dependency.
 *
 * There is no CORS configuration anywhere in this API, deliberately. The browser only ever talks to
 * the dashboard's own origin, which proxies; an API that never receives a cross-origin browser
 * request has no cross-origin policy to get wrong.
 */
export function buildServer(dependencies: ServerDependencies): ApplicationServer {
  const { configuration, logger, merchantRepository } = dependencies;

  const server = Fastify({
    loggerInstance: logger,
    logController: new RequestLogController(),
    // The async-local context is the single source of correlation, for HTTP handlers and for the
    // workers alike. Without this, Fastify binds its own request id onto every child logger and each
    // line carries the same value twice under two different keys.
    childLoggerFactory: (logger) => logger,
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      if (
        typeof supplied === 'string' &&
        supplied.length > 0 &&
        supplied.length <= MAXIMUM_SUPPLIED_REQUEST_ID_LENGTH
      ) {
        return supplied;
      }
      return randomUUID();
    },
    // Trusting a forwarded address from an untrusted hop lets a client choose the address that rate
    // limiting keys on. This is enabled only behind a proxy that overwrites the header.
    trustProxy: false,
    bodyLimit: MAXIMUM_REQUEST_BODY_BYTES,
  });

  server.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    runWithRequestContext({ requestId: request.id }, done);
  });

  server.setNotFoundHandler((request, reply) => {
    const problem = toProblemDetails(
      new ApplicationError(
        'resource_not_found',
        `No route matches ${request.method} ${request.url}`,
      ),
      request.id,
      request.url,
    );
    void reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ApplicationError) {
      request.log.warn({ event: 'http.request_rejected', code: error.code }, error.detail);
      const problem = toProblemDetails(error, request.id, request.url);
      void reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
      return;
    }

    const statusCode = readStatusCode(error);
    if (statusCode < DEFAULT_ERROR_STATUS) {
      const message = readMessage(error);
      request.log.warn({ event: 'http.request_rejected', statusCode }, message);
      const problem = toProblemDetails(
        new ApplicationError('malformed_request', message),
        request.id,
        request.url,
      );
      void reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
      return;
    }

    // The client gets a request identifier and nothing else. A driver message or a stack trace
    // leaks table names, file paths and occasionally credentials.
    request.log.error({ event: 'http.request_failed', error }, 'unhandled error');
    const problem = toUnexpectedProblemDetails(request.id);
    void reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  const authenticate = createAuthenticationHook({
    merchantRepository,
    apiKeyPepper: configuration.apiKeyPepper,
  });

  registerHealthRoutes(server, {
    startedAtMilliseconds: Date.now(),
    callbackSsrfPolicy: callbackSsrfPolicy(configuration),
    blockCursorRepository: dependencies.blockCursorRepository,
    now: () => new Date(),
  });
  registerMerchantRoutes(server, { merchantRepository, authenticate });
  registerPaymentRoutes(server, {
    authenticate,
    paymentCreator: dependencies.paymentCreator,
    paymentCanceler: dependencies.paymentCanceler,
    paymentRepository: dependencies.paymentRepository,
    merchantRepository,
    idempotencyRepository: dependencies.idempotencyRepository,
    checkoutBaseUrl: configuration.publicCheckoutBaseUrl,
    paymentTransferRepository: dependencies.paymentTransferRepository,
    webhookDeliveryRepository: dependencies.webhookDeliveryRepository,
  });
  registerWebhookRoutes(server, {
    authenticate,
    webhookDeliveryRepository: dependencies.webhookDeliveryRepository,
    webhookSecretRepository: dependencies.webhookSecretRepository,
    ulidFactory: dependencies.ulidFactory,
    now: () => new Date(),
  });

  return server;
}
