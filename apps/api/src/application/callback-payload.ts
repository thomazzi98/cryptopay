import type { Payment } from '../domain/payment.js';
import { presentPayment } from '../http/presenters/payment.presenter.js';
import type { OutboxEntry } from '../infrastructure/persistence/payment.repository.js';
import type { UlidFactory } from '../infrastructure/system/ulid.js';

/**
 * The body a merchant receives.
 *
 * It carries the same payment resource the API returns from `GET /v1/payments/{id}`, so a merchant
 * has one shape to model rather than two, and so a callback and a poll can never disagree about what
 * a payment looks like.
 *
 * The body is serialized here, once, and stored. Every attempt transmits those exact bytes, because
 * the signature is computed over them: re-serializing the object per attempt reorders keys and the
 * merchant's verification then fails for a reason neither side can see.
 */

export interface CallbackEnvelopeInput {
  readonly payment: Payment;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly checkoutBaseUrl: string;
  readonly ulidFactory: UlidFactory;
}

export function buildOutboxEntry(input: CallbackEnvelopeInput): OutboxEntry | null {
  const destinationUrl = input.payment.callbackUrl;
  // A merchant who supplied no callback URL is polling instead. Writing a delivery row for them
  // would leave the outbox permanently full of work nobody asked for.
  if (destinationUrl === null) {
    return null;
  }

  const identifier = `whd_${input.ulidFactory.create(input.occurredAt.getTime())}`;
  const envelope = {
    identifier,
    type: input.eventType,
    occurredAt: input.occurredAt.toISOString(),
    environment: input.payment.environment,
    data: presentPayment(input.payment, { checkoutBaseUrl: input.checkoutBaseUrl }),
  };

  return {
    identifier,
    merchantId: input.payment.merchantId,
    environment: input.payment.environment,
    eventType: input.eventType,
    destinationUrl,
    payload: JSON.stringify(envelope),
  };
}
