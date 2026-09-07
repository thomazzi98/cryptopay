import { transition, type PaymentStatus, type PaymentTrigger } from '@cryptopay/shared';

import type { PaymentEvent } from './payment-decision.js';
import {
  exceedsAcceptanceBand,
  isFinished,
  reachesAcceptanceBand,
  type Payment,
} from './payment.js';

/**
 * Turning what the chain showed into what the payment is worth.
 *
 * Everything here is derived from figures the caller recomputed from stored transfer rows. Nothing
 * is incremented, so applying the same observation twice produces the same payment, which is what
 * makes an at-least-once pipeline safe to replay.
 *
 * The result distinguishes a status change from a figure change on purpose. A confirmation count
 * advances on nearly every tick while a payment is confirming; writing an audit row for each would
 * bury the four transitions that actually matter under hundreds that do not.
 */

export interface LedgerObservation {
  readonly creditedAmountInBaseUnits: bigint;
  readonly settlingBlockHeight: bigint | null;
  readonly confirmations: number;
  /** The finality gate's verdict. Computed by the finality policy, never guessed here. */
  readonly finalityIsOpen: boolean;
}

export type LedgerApplication =
  | {
      readonly kind: 'transitioned';
      readonly payment: Payment;
      readonly trigger: PaymentTrigger;
      readonly events: readonly PaymentEvent[];
    }
  /** The same status, with figures the customer watches brought up to date. */
  | { readonly kind: 'progressed'; readonly payment: Payment }
  | { readonly kind: 'unchanged'; readonly reason: string };

interface TargetStatus {
  readonly status: PaymentStatus;
  readonly trigger: PaymentTrigger;
}

/**
 * Where the payment belongs given the money currently credited to it.
 *
 * Read top to bottom: no money, some money, enough money, enough money and finality. The trigger
 * differs by direction, because a payment falling back from `confirming` did so because a reorg
 * withdrew transfers, and the audit trail should say so rather than calling it a credit.
 */
function chooseTarget(observed: Payment, finalityIsOpen: boolean): TargetStatus {
  if (observed.creditedAmountInBaseUnits === 0n) {
    return { status: 'pending', trigger: 'TRANSFERS_ORPHANED' };
  }
  if (!reachesAcceptanceBand(observed)) {
    const fallingBack = observed.status === 'confirming';
    return {
      status: 'partially_funded',
      trigger: fallingBack ? 'TRANSFERS_ORPHANED' : 'TRANSFER_CREDITED',
    };
  }
  if (observed.status !== 'confirming') {
    return { status: 'confirming', trigger: 'TRANSFER_CREDITED' };
  }
  if (!finalityIsOpen) {
    return { status: 'confirming', trigger: 'CHAIN_PROGRESS_OBSERVED' };
  }
  if (exceedsAcceptanceBand(observed)) {
    return { status: 'overpaid', trigger: 'CHAIN_PROGRESS_OBSERVED' };
  }
  return { status: 'completed', trigger: 'CHAIN_PROGRESS_OBSERVED' };
}

export function applyLedgerObservation(
  payment: Payment,
  observation: LedgerObservation,
  now: Date,
): LedgerApplication {
  // A terminal payment is never moved by a later observation. There is deliberately no edge out of
  // `completed`, because a resurrection edge is exactly what double-credits a merchant; a transfer
  // that arrives afterwards is recorded and surfaced, and settling it is a separate decision.
  if (isFinished(payment)) {
    return { kind: 'unchanged', reason: `the payment is already ${payment.status}` };
  }

  const observed: Payment = Object.freeze({
    ...payment,
    creditedAmountInBaseUnits: observation.creditedAmountInBaseUnits,
    settlingBlockHeight: observation.settlingBlockHeight,
    confirmationsObserved: observation.confirmations,
    finalityConfirmed: observation.finalityIsOpen,
  });

  const target = chooseTarget(observed, observation.finalityIsOpen);

  if (target.status === payment.status) {
    if (
      observed.creditedAmountInBaseUnits === payment.creditedAmountInBaseUnits &&
      observed.confirmationsObserved === payment.confirmationsObserved &&
      observed.settlingBlockHeight === payment.settlingBlockHeight &&
      observed.finalityConfirmed === payment.finalityConfirmed
    ) {
      return { kind: 'unchanged', reason: 'nothing observed has changed' };
    }
    return { kind: 'progressed', payment: observed };
  }

  const allowed = transition(payment.status, target.status, target.trigger);
  if (allowed.kind !== 'allowed') {
    return {
      kind: 'unchanged',
      reason: `${payment.status} to ${target.status} is not a transition this system permits`,
    };
  }

  const isCompletion = target.status === 'completed' || target.status === 'overpaid';
  const moved: Payment = Object.freeze({
    ...observed,
    status: target.status,
    statusVersion: payment.statusVersion + 1,
    completedAt: isCompletion ? now : payment.completedAt,
  });

  return {
    kind: 'transitioned',
    payment: moved,
    trigger: target.trigger,
    events: [
      {
        type: `payment.${target.status}`,
        paymentId: moved.identifier,
        statusVersion: moved.statusVersion,
      },
    ],
  };
}
