import type { Checkout, PaymentStatus } from '@cryptopay/shared';

/**
 * The checkout as this screen uses it.
 *
 * The wire contract types `status` as a plain string, because the enum is declared from a runtime
 * list. Narrowing it once, at the edge, is what lets every component downstream take a
 * `PaymentStatus` and lets an unrecognised status fail loudly instead of rendering an unstyled pill.
 */
export interface CheckoutView extends Omit<Checkout, 'status'> {
  readonly status: PaymentStatus;
}

export class CheckoutReadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CheckoutReadError';
    this.status = status;
  }
}
