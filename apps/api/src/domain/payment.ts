import {
  calculateAcceptanceBand,
  isTerminalPaymentStatus,
  type AcceptanceBand,
  type AssetDescriptor,
  type Environment,
  type NetworkIdentifier,
  type PaymentStatus,
} from '@cryptopay/shared';

/**
 * The payment aggregate: a frozen record, never mutated in place.
 *
 * Every command in this layer is a pure function from a payment and an input to a decision. Nothing
 * here reads a clock, a database or a chain, so the whole lifecycle can be driven through its edge
 * cases in milliseconds and without a fixture.
 */

export interface Payment {
  readonly identifier: string;
  readonly merchantId: string;
  readonly environment: Environment;
  readonly networkIdentifier: NetworkIdentifier;
  readonly checkoutToken: string;

  readonly asset: AssetDescriptor;
  readonly requestedAmountInBaseUnits: bigint;
  readonly acceptanceBand: AcceptanceBand;
  readonly creditedAmountInBaseUnits: bigint;

  readonly receivingAccount: string;
  readonly status: PaymentStatus;
  readonly statusVersion: number;

  readonly requiredConfirmations: number;
  readonly requiresFinalityTag: boolean;
  readonly confirmationsObserved: number;
  readonly finalityConfirmed: boolean;
  readonly settlingBlockHeight: bigint | null;
  readonly createdAtBlockHeight: bigint;

  readonly merchantReference: string | null;
  readonly callbackUrl: string | null;
  readonly metadata: Readonly<Record<string, string>>;

  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly completedAt: Date | null;
}

export interface CreatePaymentInput {
  readonly identifier: string;
  readonly merchantId: string;
  readonly environment: Environment;
  readonly networkIdentifier: NetworkIdentifier;
  readonly checkoutToken: string;
  readonly asset: AssetDescriptor;
  readonly requestedAmountInBaseUnits: bigint;
  readonly underpaymentToleranceBasisPoints: number;
  readonly overpaymentToleranceBasisPoints: number;
  readonly receivingAccount: string;
  readonly requiredConfirmations: number;
  readonly requiresFinalityTag: boolean;
  readonly createdAtBlockHeight: bigint;
  readonly merchantReference: string | null;
  readonly callbackUrl: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  readonly lifetimeSeconds: number;
}

const MILLISECONDS_PER_SECOND = 1000;

export function createPayment(input: CreatePaymentInput): Payment {
  const acceptanceBand = calculateAcceptanceBand(
    input.requestedAmountInBaseUnits,
    input.underpaymentToleranceBasisPoints,
    input.overpaymentToleranceBasisPoints,
  );

  return Object.freeze({
    identifier: input.identifier,
    merchantId: input.merchantId,
    environment: input.environment,
    networkIdentifier: input.networkIdentifier,
    checkoutToken: input.checkoutToken,

    asset: input.asset,
    requestedAmountInBaseUnits: input.requestedAmountInBaseUnits,
    acceptanceBand,
    creditedAmountInBaseUnits: 0n,

    receivingAccount: input.receivingAccount,
    status: 'pending',
    statusVersion: 0,

    requiredConfirmations: input.requiredConfirmations,
    requiresFinalityTag: input.requiresFinalityTag,
    confirmationsObserved: 0,
    finalityConfirmed: false,
    settlingBlockHeight: null,
    createdAtBlockHeight: input.createdAtBlockHeight,

    merchantReference: input.merchantReference,
    callbackUrl: input.callbackUrl,
    metadata: Object.freeze({ ...input.metadata }),

    createdAt: input.createdAt,
    expiresAt: new Date(
      input.createdAt.getTime() + input.lifetimeSeconds * MILLISECONDS_PER_SECOND,
    ),
    completedAt: null,
  });
}

export function hasExpired(payment: Payment, now: Date): boolean {
  return now.getTime() >= payment.expiresAt.getTime();
}

export function isFinished(payment: Payment): boolean {
  return isTerminalPaymentStatus(payment.status);
}

/** Whether the credited amount has reached the point where the payment is awaiting finality. */
export function reachesAcceptanceBand(payment: Payment): boolean {
  return payment.creditedAmountInBaseUnits >= payment.acceptanceBand.minimumInBaseUnits;
}

export function exceedsAcceptanceBand(payment: Payment): boolean {
  return payment.creditedAmountInBaseUnits > payment.acceptanceBand.maximumInBaseUnits;
}

export function confirmationsFor(payment: Payment, tipHeight: bigint): number {
  if (payment.settlingBlockHeight === null) {
    return 0;
  }
  const confirmations = tipHeight - payment.settlingBlockHeight + 1n;
  if (confirmations < 0n) {
    return 0;
  }
  return Number(confirmations);
}
