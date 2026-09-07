import {
  ListWebhookDeliveriesQuerySchema,
  type WebhookDelivery as WebhookDeliveryContract,
  type WebhookDeliveryList,
  type WebhookSecret as WebhookSecretContract,
} from '@cryptopay/shared';

import type {
  DeliveryAttempt,
  WebhookDelivery,
  WebhookDeliveryRepository,
} from '../../infrastructure/persistence/webhook-delivery.repository.js';
import type { WebhookSecretRepository } from '../../infrastructure/persistence/webhook-secret.repository.js';
import type { UlidFactory } from '../../infrastructure/system/ulid.js';
import { requireMerchant, type AuthenticationHook } from '../authentication.js';
import { ApplicationError } from '../problem-details.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * Everything a merchant needs to see and repair their own callbacks.
 *
 * Redelivery is the endpoint this exists for. A merchant whose receiver was down while an event was
 * sent has no way to recover it otherwise, and telling them to reconcile by polling is telling them
 * to build the notification system themselves. The identifier does not change on a redelivery, so a
 * merchant who did process the original can deduplicate it on the webhook-id they already stored.
 */

export interface WebhookRouteDependencies {
  readonly authenticate: AuthenticationHook;
  readonly webhookDeliveryRepository: WebhookDeliveryRepository;
  readonly webhookSecretRepository: WebhookSecretRepository;
  readonly ulidFactory: UlidFactory;
  readonly now: () => Date;
}

function presentAttempt(attempt: DeliveryAttempt) {
  return {
    attemptNumber: attempt.attemptNumber,
    outcome: attempt.outcome,
    responseStatus: attempt.responseStatus,
    resolvedAddress: attempt.resolvedAddress,
    responseSnippet: attempt.responseSnippet,
    durationMilliseconds: attempt.durationMilliseconds,
    failureReason: attempt.failureReason,
    usedPrivateAllowlist: attempt.usedPrivateAllowlist,
    requestedAt: attempt.requestedAt.toISOString(),
  };
}

function presentDelivery(
  delivery: WebhookDelivery,
  attempts: readonly DeliveryAttempt[],
): WebhookDeliveryContract {
  const awaitingRetry = delivery.status === 'pending' || delivery.status === 'failed';
  return {
    identifier: delivery.identifier,
    paymentIdentifier: delivery.paymentId,
    eventType: delivery.eventType,
    destinationUrl: delivery.destinationUrl,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    nextAttemptAt: awaitingRetry ? delivery.nextAttemptAt.toISOString() : null,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    lastFailure: delivery.lastFailure,
    createdAt: delivery.createdAt.toISOString(),
    attempts: attempts.map((attempt) => presentAttempt(attempt)),
  };
}

/**
 * A secret is returned in full exactly once, when it is created. Afterwards only a hint is shown,
 * because a value that can be read back from an API is a value that leaks through every log, proxy
 * and screen share that ever touches it.
 */
function presentSecret(
  secret: { identifier: string; secret: string; createdAt: Date; retiredAt: Date | null },
  reveal: boolean,
): WebhookSecretContract {
  return {
    identifier: secret.identifier,
    secret: reveal ? secret.secret : null,
    hint: `${secret.secret.slice(0, 11)}...`,
    createdAt: secret.createdAt.toISOString(),
    retiredAt: secret.retiredAt?.toISOString() ?? null,
  };
}

export function registerWebhookRoutes(
  server: ApplicationServer,
  dependencies: WebhookRouteDependencies,
): void {
  server.get(
    '/v1/webhooks/deliveries',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const parsed = ListWebhookDeliveriesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ApplicationError(
          'validation_failed',
          'The delivery list could not be read from these query parameters.',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }

      const page = await dependencies.webhookDeliveryRepository.list({
        merchantId: authenticated.merchantId,
        environment: authenticated.environment,
        limit: parsed.data.limit,
        ...(parsed.data.status !== undefined && { status: parsed.data.status }),
        ...(parsed.data.paymentIdentifier !== undefined && {
          paymentId: parsed.data.paymentIdentifier,
        }),
        ...(parsed.data.startingAfter !== undefined && {
          startingAfter: parsed.data.startingAfter,
        }),
      });

      const body: WebhookDeliveryList = {
        data: page.deliveries.map((delivery) => presentDelivery(delivery, [])),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      };
      await reply.code(200).send(body);
    },
  );

  server.get<{ Params: { deliveryId: string } }>(
    '/v1/webhooks/deliveries/:deliveryId',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const delivery = await dependencies.webhookDeliveryRepository.findById(
        request.params.deliveryId,
        authenticated.merchantId,
      );
      if (delivery?.environment !== authenticated.environment) {
        throw new ApplicationError('resource_not_found', 'No such webhook delivery.');
      }

      const attempts = await dependencies.webhookDeliveryRepository.attemptsFor(
        delivery.identifier,
      );
      await reply.code(200).send(presentDelivery(delivery, attempts));
    },
  );

  /**
   * Puts a delivery back in the queue.
   *
   * Deliberately permitted for a delivery that already succeeded, not only a failed one: a merchant
   * who lost the event on their side, or who was writing to a database that rolled back, needs it
   * again and knows better than we do whether they do.
   */
  server.post<{ Params: { deliveryId: string } }>(
    '/v1/webhooks/deliveries/:deliveryId/redeliver',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const existing = await dependencies.webhookDeliveryRepository.findById(
        request.params.deliveryId,
        authenticated.merchantId,
      );
      if (existing?.environment !== authenticated.environment) {
        throw new ApplicationError('resource_not_found', 'No such webhook delivery.');
      }
      if (existing.status === 'in_flight') {
        throw new ApplicationError(
          'validation_failed',
          'This delivery is being attempted right now. Wait for the attempt to finish before asking for another.',
        );
      }

      const requeued = await dependencies.webhookDeliveryRepository.requeue(
        existing.identifier,
        authenticated.merchantId,
        dependencies.now(),
      );
      if (requeued === null) {
        throw new ApplicationError(
          'validation_failed',
          'This delivery could not be queued again. It may have started an attempt in the meantime.',
        );
      }

      request.log.info(
        { event: 'webhook.redelivery_requested', deliveryId: requeued.identifier },
        'A merchant asked for a callback to be sent again',
      );
      const attempts = await dependencies.webhookDeliveryRepository.attemptsFor(
        requeued.identifier,
      );
      await reply.code(202).send(presentDelivery(requeued, attempts));
    },
  );

  server.get(
    '/v1/webhooks/secrets',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const secrets = await dependencies.webhookSecretRepository.activeSecrets(
        authenticated.merchantId,
        authenticated.environment,
      );
      await reply.code(200).send({ data: secrets.map((secret) => presentSecret(secret, false)) });
    },
  );

  /**
   * Starts a rotation rather than performing one. Both secrets sign until the old one is retired, so
   * an endpoint that has not been updated yet keeps verifying; replacing outright breaks every
   * integration at the moment the merchant is least able to tell why.
   */
  server.post(
    '/v1/webhooks/secrets',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const now = dependencies.now();
      const identifier = `whs_${dependencies.ulidFactory.create(now.getTime())}`;
      const secret = await dependencies.webhookSecretRepository.issue(
        identifier,
        authenticated.merchantId,
        authenticated.environment,
      );

      await reply
        .code(201)
        .send(presentSecret({ identifier, secret, createdAt: now, retiredAt: null }, true));
    },
  );

  server.delete<{ Params: { secretId: string } }>(
    '/v1/webhooks/secrets/:secretId',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const retired = await dependencies.webhookSecretRepository.retire(
        request.params.secretId,
        authenticated.merchantId,
      );
      // Refusing to retire the last one is deliberate: a merchant with no active secret would receive
      // callbacks nobody can verify, which is worse than a stale secret that still works.
      if (!retired) {
        throw new ApplicationError(
          'validation_failed',
          'That secret is either unknown, already retired, or the only one left. Create a replacement before retiring it.',
        );
      }
      await reply.code(204).send();
    },
  );
}
