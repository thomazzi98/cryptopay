import type { Checkout, NetworkFamily, PaymentStatus } from '@cryptopay/shared';

/**
 * The checkout as this screen uses it.
 *
 * The wire contract types `status` and `networkFamily` as plain strings, because both enums are
 * declared from a runtime list. Narrowing them once, at the edge, is what lets every component
 * downstream take the real union and lets an unrecognised value fail loudly instead of rendering an
 * unstyled pill or drawing a payment URI for a family this build has never heard of.
 */
export interface CheckoutView extends Omit<Checkout, 'status' | 'networkFamily'> {
  readonly status: PaymentStatus;
  readonly networkFamily: NetworkFamily;
}

export class CheckoutReadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CheckoutReadError';
    this.status = status;
  }
}
