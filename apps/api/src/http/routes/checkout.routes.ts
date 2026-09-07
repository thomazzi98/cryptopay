import { TransactionHintRequestSchema, type Checkout } from '@cryptopay/shared';

import type { EvaluationQueueRepository } from '../../infrastructure/persistence/evaluation-queue.repository.js';
import type { MerchantRepository } from '../../infrastructure/persistence/merchant.repository.js';
import type { PaymentRepository } from '../../infrastructure/persistence/payment.repository.js';
import type { PaymentTransferRepository } from '../../infrastructure/persistence/payment-transfer.repository.js';
import { presentCheckout } from '../presenters/checkout.presenter.js';
import { ApplicationError } from '../problem-details.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * The endpoints a customer's browser reaches, with no API key.
 *
 * The checkout token is the credential, and it is what limits the blast radius: it is a
 * high-entropy value bound to exactly one payment, so knowing it reveals that payment and nothing
 * else. What is returned is deliberately narrower than the merchant view — no merchant identifier,
 * no callback URL, no metadata, no payment identifier — because a customer needs the amount, the
 * address and the progress, and anything beyond that is a detail of somebody else's business.
 */

export interface CheckoutRouteDependencies {
  readonly paymentRepository: PaymentRepository;
  readonly paymentTransferRepository: PaymentTransferRepository;
  readonly merchantRepository: MerchantRepository;
  readonly evaluationQueueRepository: EvaluationQueueRepository;
}

export function registerCheckoutRoutes(
  server: ApplicationServer,
  dependencies: CheckoutRouteDependencies,
): void {
  server.get<{ Params: { checkoutToken: string } }>(
    '/v1/checkout/:checkoutToken',
    async (request, reply) => {
      const payment = await dependencies.paymentRepository.findByCheckoutToken(
        request.params.checkoutToken,
      );
      // An unknown token and a token for a payment that no longer exists answer identically, so the
      // endpoint cannot be used to learn which tokens are real.
      if (payment === null) {
        throw new ApplicationError('resource_not_found', 'No such checkout.');
      }

      const [merchant, transfers] = await Promise.all([
        dependencies.merchantRepository.findById(payment.merchantId),
        dependencies.paymentTransferRepository.findByPayment(payment.identifier),
      ]);

      const body: Checkout = presentCheckout(payment, transfers, merchant?.name ?? 'Merchant');
      // A checkout is never cached: the whole page is a status that changes underneath the reader.
      await reply.header('cache-control', 'no-store').code(200).send(body);
    },
  );

  /**
   * A latency optimisation, and nothing else.
   *
   * The browser may report the transaction it just sent, and the only effect is that the payment is
   * queued for evaluation sooner than the next scan would have done it. The hash is not stored, not
   * trusted, and never reaches the credit path: the amount, the asset, the recipient and the
   * confirmation count are always re-derived from the chain by the scanner.
   *
   * A fabricated hash therefore changes nothing, and a customer who closes the browser the instant
   * after signing is paid exactly the same way.
   */
  server.post<{ Params: { checkoutToken: string } }>(
    '/v1/checkout/:checkoutToken/transaction-hint',
    async (request, reply) => {
      const parsed = TransactionHintRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApplicationError(
          'validation_failed',
          'A transaction hint must carry a transaction reference.',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }

      const payment = await dependencies.paymentRepository.findByCheckoutToken(
        request.params.checkoutToken,
      );
      if (payment === null) {
        throw new ApplicationError('resource_not_found', 'No such checkout.');
      }

      await dependencies.evaluationQueueRepository.enqueue(payment.identifier);
      request.log.info(
        { event: 'checkout.hint_received', paymentId: payment.identifier },
        'A browser reported a transaction; the payment was queued for evaluation',
      );

      // 202 rather than 200: nothing has been decided, and the customer's browser must not read this
      // as confirmation that the payment succeeded.
      await reply.code(202).send({ accepted: true });
    },
  );
}
