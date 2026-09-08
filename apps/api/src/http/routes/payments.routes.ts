import {
  CreatePaymentRequestSchema,
  ListPaymentsQuerySchema,
  isNetworkIdentifier,
  isPaymentStatus,
  type PaymentList,
} from '@cryptopay/shared';

import type { FastifyRequest } from 'fastify';

import type { CancelPaymentUseCase } from '../../application/cancel-payment.use-case.js';
import type {
  CreatePaymentFailure,
  CreatePaymentUseCase,
} from '../../application/create-payment.use-case.js';
import { MissingWalletSeedError } from '../../infrastructure/wallet/allocator-provider.js';
import type { IdempotencyRepository } from '../../infrastructure/persistence/idempotency.repository.js';
import type { MerchantRepository } from '../../infrastructure/persistence/merchant.repository.js';
import type { PaymentRepository } from '../../infrastructure/persistence/payment.repository.js';
import type { PaymentTransferRepository } from '../../infrastructure/persistence/payment-transfer.repository.js';
import type { WebhookDeliveryRepository } from '../../infrastructure/persistence/webhook-delivery.repository.js';
import { requireMerchant, type AuthenticationHook } from '../authentication.js';
import { presentPayment, presentTransfer } from '../presenters/payment.presenter.js';
import { ApplicationError, type ProblemCode } from '../problem-details.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * The merchant-facing payment endpoints.
 *
 * Creation is idempotent by requirement rather than by courtesy: the header is mandatory, the
 * reservation is taken before any work runs, and the stored response is written in the same
 * transaction as the payment it describes.
 */

export interface PaymentRouteDependencies {
  readonly authenticate: AuthenticationHook;
  readonly paymentCreator: CreatePaymentUseCase;
  readonly paymentCanceler: CancelPaymentUseCase;
  readonly paymentRepository: PaymentRepository;
  readonly merchantRepository: MerchantRepository;
  readonly idempotencyRepository: IdempotencyRepository;
  readonly checkoutBaseUrl: string;
  readonly paymentTransferRepository: PaymentTransferRepository;
  readonly webhookDeliveryRepository: WebhookDeliveryRepository;
}

/**
 * Raised when another request took over this one's reservation mid-flight. It exists to roll the
 * transaction back: the payment and the address this request wrote are discarded so that one
 * Idempotency-Key yields one payment, and the caller's retry is served the winner's response.
 */
class LostReservationError extends Error {
  constructor() {
    super('The idempotency reservation was claimed by another request');
    this.name = 'LostReservationError';
  }
}

const FAILURE_CODES: Readonly<Record<CreatePaymentFailure['reason'], ProblemCode>> = Object.freeze({
  unknown_network: 'validation_failed',
  environment_mismatch: 'validation_failed',
  unknown_asset: 'validation_failed',
  invalid_amount: 'validation_failed',
  network_not_watched: 'service_unavailable',
  unreachable_callback: 'validation_failed',
  duplicate_external_reference: 'validation_failed',
});

function readIdempotencyKey(headerValue: unknown): string {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    throw new ApplicationError(
      'validation_failed',
      'An Idempotency-Key header is required when creating a payment, so a retry cannot create a second one.',
    );
  }
  if (headerValue.length > 255) {
    throw new ApplicationError('validation_failed', 'The Idempotency-Key header is too long.');
  }
  return headerValue;
}

export function registerPaymentRoutes(
  server: ApplicationServer,
  dependencies: PaymentRouteDependencies,
): void {
  const context = { checkoutBaseUrl: dependencies.checkoutBaseUrl };

  /**
   * Scoped by merchant in the query rather than checked afterwards, so a missing payment and another
   * merchant's payment are indistinguishable and both answer 404. A 403 would confirm the identifier
   * exists, which is all an enumeration attack needs.
   */
  async function requireOwnedPayment(request: FastifyRequest, paymentId: string) {
    const authenticated = requireMerchant(request);
    const payment = await dependencies.paymentRepository.findById(
      authenticated.merchantId,
      authenticated.environment,
      paymentId,
    );
    if (payment === null) {
      throw new ApplicationError('resource_not_found', 'No such payment.');
    }
    return payment;
  }

  server.post('/v1/payments', { preHandler: dependencies.authenticate }, async (request, reply) => {
    const authenticated = requireMerchant(request);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);

    const parsed = CreatePaymentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApplicationError(
        'validation_failed',
        'The payment could not be created from this request.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const rawBody = JSON.stringify(request.body ?? {});
    const reservation = await dependencies.idempotencyRepository.reserve({
      merchantId: authenticated.merchantId,
      environment: authenticated.environment,
      idempotencyKey,
      method: 'POST',
      path: '/v1/payments',
      body: rawBody,
    });

    if (reservation.kind === 'fingerprint_mismatch') {
      throw new ApplicationError(
        'validation_failed',
        'This Idempotency-Key was already used with a different request body.',
      );
    }
    if (reservation.kind === 'in_progress') {
      void reply.header('retry-after', String(reservation.retryAfterSeconds));
      throw new ApplicationError(
        'rate_limited',
        'An identical request is already being processed. Retry shortly.',
      );
    }
    if (reservation.kind === 'replay') {
      await reply
        .code(reservation.status)
        .header('idempotency-replayed', 'true')
        .type('application/json')
        .send(reservation.body);
      return;
    }

    const merchant = await dependencies.merchantRepository.findById(authenticated.merchantId);
    if (merchant === null) {
      await dependencies.idempotencyRepository.abandon(
        authenticated.merchantId,
        authenticated.environment,
        idempotencyKey,
        reservation.ownerToken,
      );
      throw new ApplicationError('resource_not_found', 'The merchant no longer exists.');
    }

    try {
      const result = await dependencies.paymentCreator.execute({
        merchant,
        environment: authenticated.environment,
        request: parsed.data,
        // Placed inside the payment's transaction so a stored response cannot outlive a rolled back
        // payment, nor a payment exist without the response a retry will be given.
        onPersist: async (client, payment) => {
          const stillOurs = await dependencies.idempotencyRepository.complete(
            client,
            authenticated.merchantId,
            authenticated.environment,
            idempotencyKey,
            reservation.ownerToken,
            201,
            JSON.stringify(presentPayment(payment, context)),
          );
          // The reservation was taken over while this request was still working, which means another
          // request is creating a payment for the same key. Throwing here rolls back the payment and
          // the address this request had already written, so the key yields one payment rather than
          // two. The caller retries and is served the winner's response.
          if (!stillOurs) {
            throw new LostReservationError();
          }
        },
      });

      if (result.kind === 'failed') {
        await dependencies.idempotencyRepository.abandon(
          authenticated.merchantId,
          authenticated.environment,
          idempotencyKey,
          reservation.ownerToken,
        );
        throw new ApplicationError(FAILURE_CODES[result.failure.reason], result.failure.detail);
      }

      await reply.code(201).send(presentPayment(result.payment, context));
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      await dependencies.idempotencyRepository.abandon(
        authenticated.merchantId,
        authenticated.environment,
        idempotencyKey,
        reservation.ownerToken,
      );

      if (error instanceof MissingWalletSeedError) {
        request.log.error(
          { event: 'payment.wallet_seed_missing', environment: authenticated.environment },
          error.message,
        );
        throw new ApplicationError(
          'service_unavailable',
          'This environment cannot issue payment addresses yet. The operator has been notified.',
        );
      }
      throw error;
    }
  });

  server.get('/v1/payments', { preHandler: dependencies.authenticate }, async (request, reply) => {
    const authenticated = requireMerchant(request);
    const parsed = ListPaymentsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApplicationError(
        'validation_failed',
        'The payment list could not be read from these query parameters.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const query = parsed.data;
    const page = await dependencies.paymentRepository.list({
      merchantId: authenticated.merchantId,
      environment: authenticated.environment,
      limit: query.limit,
      ...(query.status !== undefined && isPaymentStatus(query.status) && { status: query.status }),
      ...(query.network !== undefined &&
        isNetworkIdentifier(query.network) && { networkIdentifier: query.network }),
      ...(query.merchantReference !== undefined && { merchantReference: query.merchantReference }),
      ...(query.createdAfter !== undefined && { createdAfter: new Date(query.createdAfter) }),
      ...(query.createdBefore !== undefined && { createdBefore: new Date(query.createdBefore) }),
      ...(query.startingAfter !== undefined && { startingAfter: query.startingAfter }),
    });

    const body: PaymentList = {
      data: page.payments.map((payment) => presentPayment(payment, context)),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
    await reply.code(200).send(body);
  });

  server.get<{ Params: { paymentId: string } }>(
    '/v1/payments/:paymentId',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const payment = await dependencies.paymentRepository.findById(
        authenticated.merchantId,
        authenticated.environment,
        request.params.paymentId,
      );

      // Another merchant's payment answers 404 rather than 403, because 403 would confirm that the
      // identifier exists.
      if (payment === null) {
        throw new ApplicationError('resource_not_found', 'No such payment.');
      }
      await reply.code(200).send(presentPayment(payment, context));
    },
  );

  /**
   * Every transfer ever seen for this payment, orphaned ones included.
   *
   * Nothing is filtered out. A customer whose money was withdrawn by a reorg, or who sent the wrong
   * token to the right address, needs that to be visible; a list that quietly omits it leaves support
   * with nothing to say.
   */
  server.get<{ Params: { paymentId: string } }>(
    '/v1/payments/:paymentId/transfers',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const payment = await requireOwnedPayment(request, request.params.paymentId);
      const transfers = await dependencies.paymentTransferRepository.findByPayment(
        payment.identifier,
      );
      await reply.code(200).send({
        data: transfers.map((transfer) =>
          presentTransfer(transfer, payment.networkIdentifier, payment.asset.decimals),
        ),
      });
    },
  );

  /** The audit trail exactly as it was written, which is what makes the timeline trustworthy. */
  server.get<{ Params: { paymentId: string } }>(
    '/v1/payments/:paymentId/timeline',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const payment = await requireOwnedPayment(request, request.params.paymentId);
      const changes = await dependencies.paymentRepository.timelineFor(payment.identifier);
      await reply.code(200).send({ data: changes });
    },
  );

  server.get<{ Params: { paymentId: string } }>(
    '/v1/payments/:paymentId/deliveries',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const payment = await requireOwnedPayment(request, request.params.paymentId);
      const deliveries = await dependencies.webhookDeliveryRepository.findByPayment(
        payment.identifier,
      );
      await reply.code(200).send({
        data: deliveries.map((delivery) => ({
          identifier: delivery.identifier,
          eventType: delivery.eventType,
          destinationUrl: delivery.destinationUrl,
          status: delivery.status,
          attemptCount: delivery.attemptCount,
          deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
          lastFailure: delivery.lastFailure,
          createdAt: delivery.createdAt.toISOString(),
        })),
      });
    },
  );

  server.post<{ Params: { paymentId: string } }>(
    '/v1/payments/:paymentId/cancel',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const result = await dependencies.paymentCanceler.execute(
        authenticated.merchantId,
        authenticated.environment,
        request.params.paymentId,
      );

      if (result.kind === 'not_found') {
        throw new ApplicationError('resource_not_found', 'No such payment.');
      }
      if (result.kind === 'rejected') {
        throw new ApplicationError(
          'validation_failed',
          `${result.detail} The payment is currently ${result.currentStatus}.`,
        );
      }
      await reply.code(200).send(presentPayment(result.payment, context));
    },
  );
}
