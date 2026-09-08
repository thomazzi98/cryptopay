import { CreateGatewayPaymentRequestSchema, type NetworkFamily } from '@cryptopay/shared';
import type { FastifyRequest } from 'fastify';

import type { CancelPaymentUseCase } from '../../application/cancel-payment.use-case.js';
import type {
  CreatePaymentFailure,
  CreatePaymentUseCase,
} from '../../application/create-payment.use-case.js';
import type { Payment } from '../../domain/payment.js';
import { resolveNetwork } from '../../infrastructure/chain/network-configuration.js';
import { resolveToken } from '../../infrastructure/chain/token-registry.js';
import type { BlockCursorRepository } from '../../infrastructure/persistence/block-cursor.repository.js';
import type { IdempotencyRepository } from '../../infrastructure/persistence/idempotency.repository.js';
import type { MerchantRepository } from '../../infrastructure/persistence/merchant.repository.js';
import type { PaymentRepository } from '../../infrastructure/persistence/payment.repository.js';
import type { PaymentTransferRepository } from '../../infrastructure/persistence/payment-transfer.repository.js';
import { MissingWalletSeedError } from '../../infrastructure/wallet/allocator-provider.js';
import { requireScope, type AuthenticationHook } from '../authentication.js';
import { GATEWAY_CODES, gatewayError } from '../gateway-error.js';
import {
  presentGatewayPayment,
  presentGatewayPaymentStatus,
} from '../presenters/gateway-payment.presenter.js';
import { ApplicationError, type ProblemCode } from '../problem-details.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * The contract an external payment gateway integrates against.
 *
 * This is a second presentation over the same use cases, not a second implementation. Creation runs
 * through the same two-phase idempotency reservation, the same domain and the same repository as
 * `/v1`, so there is one place where a payment comes into existence and one set of guarantees about
 * it. What differs is the vocabulary: a family instead of a deployment, a decimal string instead of
 * a base-unit pair, an uppercase lifecycle instead of the internal one, and a payment URI plus a QR
 * code the caller never has to know how to build.
 */

const GATEWAY_PAYMENTS_PATH = '/api/v1/payments';

/** Each creation failure is named for what the caller has to change, not for where it was raised. */
const FAILURE_CODES: Readonly<
  Record<CreatePaymentFailure['reason'], { readonly status: ProblemCode; readonly code: string }>
> = Object.freeze({
  unknown_network: { status: 'validation_failed', code: GATEWAY_CODES.unsupportedNetwork },
  environment_mismatch: { status: 'validation_failed', code: GATEWAY_CODES.networkNotPermitted },
  unknown_asset: { status: 'validation_failed', code: GATEWAY_CODES.unsupportedCurrency },
  invalid_amount: { status: 'validation_failed', code: GATEWAY_CODES.invalidPaymentAmount },
  network_not_watched: { status: 'service_unavailable', code: GATEWAY_CODES.networkUnavailable },
  unreachable_callback: { status: 'validation_failed', code: GATEWAY_CODES.invalidCallbackUrl },
  duplicate_external_reference: {
    status: 'validation_failed',
    code: GATEWAY_CODES.duplicateExternalReference,
  },
});

/**
 * Raised when another request took over this one's reservation mid-flight, so that the transaction
 * rolls back and one idempotency key yields one payment rather than two.
 */
class LostReservationError extends Error {
  constructor() {
    super('The idempotency reservation was claimed by another request');
    this.name = 'LostReservationError';
  }
}

export interface GatewayPaymentRouteDependencies {
  readonly authenticate: AuthenticationHook;
  readonly paymentCreator: CreatePaymentUseCase;
  readonly paymentCanceler: CancelPaymentUseCase;
  readonly paymentRepository: PaymentRepository;
  readonly merchantRepository: MerchantRepository;
  readonly idempotencyRepository: IdempotencyRepository;
  readonly paymentTransferRepository: PaymentTransferRepository;
  readonly blockCursorRepository: BlockCursorRepository;
}

function readIdempotencyKey(headerValue: unknown): string {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    throw gatewayError(
      'validation_failed',
      GATEWAY_CODES.idempotencyKeyRequired,
      'An Idempotency-Key header is required when creating a payment, so a retry cannot create a second one.',
    );
  }
  if (headerValue.length > 255) {
    throw gatewayError(
      'validation_failed',
      GATEWAY_CODES.idempotencyKeyRequired,
      'The Idempotency-Key header is too long.',
    );
  }
  return headerValue;
}

export function registerGatewayPaymentRoutes(
  server: ApplicationServer,
  dependencies: GatewayPaymentRouteDependencies,
): void {
  /**
   * Whether the scanner has reached this payment yet, which is what separates CREATED from
   * WAITING_FOR_PAYMENT. A cursor that has not been initialised, or one that has halted, both mean
   * the same thing to a caller: nobody is watching this destination yet.
   */
  async function monitoringHasReached(payment: Payment): Promise<boolean> {
    const cursor = await dependencies.blockCursorRepository.find(payment.networkIdentifier);
    if (cursor === null) {
      return false;
    }
    if (cursor.haltedAt !== null) {
      return false;
    }
    // Strictly greater, not equal. A payment is created at the head the scanner has already
    // covered, so equality holds the instant it exists and would make CREATED unobservable. The
    // honest question is whether the scanner has since covered a block in which this payment could
    // have been paid.
    return cursor.lastScannedHeight > payment.createdAtBlockHeight;
  }

  /**
   * Scoped by merchant and environment in the query rather than checked afterwards, so a payment
   * that does not exist and another merchant's payment are indistinguishable. A 403 would confirm
   * the identifier is real, which is all an enumeration attack needs.
   */
  async function requireOwnedPayment(request: FastifyRequest, paymentId: string): Promise<Payment> {
    const authenticated = requireScope(request, 'payments:read');
    const payment = await dependencies.paymentRepository.findById(
      authenticated.merchantId,
      authenticated.environment,
      paymentId,
    );
    if (payment === null) {
      throw gatewayError('resource_not_found', GATEWAY_CODES.paymentNotFound, 'No such payment.');
    }
    return payment;
  }

  async function present(payment: Payment) {
    const [transfers, monitoringHasReachedCreation] = await Promise.all([
      dependencies.paymentTransferRepository.findByPayment(payment.identifier),
      monitoringHasReached(payment),
    ]);
    return presentGatewayPayment(payment, transfers, { monitoringHasReachedCreation });
  }

  server.post(
    GATEWAY_PAYMENTS_PATH,
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireScope(request, 'payments:write');
      const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);

      const parsed = CreateGatewayPaymentRequestSchema.safeParse(request.body);
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

      // The family the caller named plus the environment their key carries decides the network. The
      // caller cannot name a deployment, so a test key has no way to spell mainnet.
      const network = resolveNetwork(
        parsed.data.network as NetworkFamily,
        authenticated.environment,
      );
      if (network === null) {
        throw gatewayError(
          'validation_failed',
          GATEWAY_CODES.unsupportedNetwork,
          `No ${parsed.data.network} network is available for ${authenticated.environment} keys.`,
        );
      }

      const token = resolveToken(network.networkIdentifier, parsed.data.currency);
      if (token === null) {
        throw gatewayError(
          'validation_failed',
          GATEWAY_CODES.unsupportedCurrency,
          `${parsed.data.currency} is not supported on ${network.displayName}.`,
        );
      }

      const rawBody = JSON.stringify(request.body ?? {});
      const reservation = await dependencies.idempotencyRepository.reserve({
        merchantId: authenticated.merchantId,
        environment: authenticated.environment,
        idempotencyKey,
        method: 'POST',
        path: GATEWAY_PAYMENTS_PATH,
        body: rawBody,
      });

      if (reservation.kind === 'fingerprint_mismatch') {
        throw gatewayError(
          'validation_failed',
          GATEWAY_CODES.idempotencyKeyConflict,
          'This Idempotency-Key was already used with a different request body.',
        );
      }
      if (reservation.kind === 'in_progress') {
        void reply.header('retry-after', String(reservation.retryAfterSeconds));
        throw gatewayError(
          'rate_limited',
          GATEWAY_CODES.idempotencyKeyInUse,
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
        throw gatewayError(
          'resource_not_found',
          GATEWAY_CODES.paymentNotFound,
          'The merchant no longer exists.',
        );
      }

      try {
        const result = await dependencies.paymentCreator.execute({
          merchant,
          environment: authenticated.environment,
          request: {
            network: network.networkIdentifier,
            assetSymbol: token.currency,
            amount: parsed.data.amount,
            callbackUrl: parsed.data.callbackUrl,
            merchantReference: parsed.data.externalReference,
            metadata: parsed.data.metadata,
            expiresInSeconds: parsed.data.expiresIn,
          },
          // Written inside the payment's own transaction, so a stored response cannot outlive a rolled
          // back payment, and a payment cannot exist without the response a retry will be handed.
          onPersist: async (client, payment) => {
            const body = presentGatewayPayment(payment, [], {
              // A payment being created has not been scanned yet by definition.
              monitoringHasReachedCreation: false,
            });
            const stillOurs = await dependencies.idempotencyRepository.complete(
              client,
              authenticated.merchantId,
              authenticated.environment,
              idempotencyKey,
              reservation.ownerToken,
              201,
              JSON.stringify(body),
            );
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
          const mapped = FAILURE_CODES[result.failure.reason];
          throw gatewayError(mapped.status, mapped.code, result.failure.detail);
        }

        await reply
          .code(201)
          .send(presentGatewayPayment(result.payment, [], { monitoringHasReachedCreation: false }));
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
          throw gatewayError(
            'service_unavailable',
            GATEWAY_CODES.networkUnavailable,
            'This environment cannot issue payment destinations yet. The operator has been notified.',
          );
        }
        throw error;
      }
    },
  );

  server.get(
    `${GATEWAY_PAYMENTS_PATH}/:paymentId`,
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const { paymentId } = request.params as { paymentId: string };
      const payment = await requireOwnedPayment(request, paymentId);
      await reply.send(await present(payment));
    },
  );

  server.get(
    `${GATEWAY_PAYMENTS_PATH}/:paymentId/status`,
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const { paymentId } = request.params as { paymentId: string };
      const payment = await requireOwnedPayment(request, paymentId);
      await reply.send(
        presentGatewayPaymentStatus(payment, {
          monitoringHasReachedCreation: await monitoringHasReached(payment),
        }),
      );
    },
  );

  server.post(
    `${GATEWAY_PAYMENTS_PATH}/:paymentId/cancel`,
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireScope(request, 'payments:write');
      const { paymentId } = request.params as { paymentId: string };
      const outcome = await dependencies.paymentCanceler.execute(
        authenticated.merchantId,
        authenticated.environment,
        paymentId,
      );

      if (outcome.kind === 'not_found') {
        throw gatewayError('resource_not_found', GATEWAY_CODES.paymentNotFound, 'No such payment.');
      }
      if (outcome.kind === 'rejected') {
        // Cancelling a payment the customer has already funded would strand real money, so the
        // current state is named: the caller needs to know it was refused because money arrived.
        throw gatewayError(
          'validation_failed',
          GATEWAY_CODES.paymentNotCancellable,
          outcome.detail,
        );
      }

      await reply.send(await present(outcome.payment));
    },
  );
}
