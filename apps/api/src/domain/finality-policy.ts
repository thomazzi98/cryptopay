import type { ChainProgress } from '@cryptopay/shared';

import type { FinalityConfirmation } from '../application/ports/chain-gateway.port.js';
import { confirmationsFor, type Payment } from './payment.js';

/**
 * The gate a payment must pass before it is called complete.
 *
 * Two independent conditions, whichever is later. The confirmation count is what the customer
 * watches and what protects against a stale provider. The finality tag is the chain's own
 * deterministic statement, and it self-adjusts if block times change, which on Polygon they have
 * twice in eighteen months.
 *
 * Nothing here reads a clock or a network. Given a payment and a snapshot of chain progress, the
 * answer is a pure function, which is why every branch below is reachable in a unit test.
 */

export interface FinalityAssessment {
  readonly creditable: boolean;
  readonly confirmations: number;
  readonly reason: string;
}

export function assessFinality(
  payment: Payment,
  progress: ChainProgress,
  secondOpinion: FinalityConfirmation,
): FinalityAssessment {
  const height = payment.settlingBlockHeight;
  if (height === null) {
    return { creditable: false, confirmations: 0, reason: 'no settling block has been observed' };
  }

  const confirmations = confirmationsFor(payment, progress.tip.height);
  if (confirmations < payment.requiredConfirmations) {
    return {
      creditable: false,
      confirmations,
      reason: `${confirmations.toString()} of ${payment.requiredConfirmations.toString()} confirmations`,
    };
  }

  if (!payment.requiresFinalityTag) {
    return { creditable: true, confirmations, reason: 'confirmation count reached' };
  }

  // A provider that cannot answer must never be read as "nothing is final". Holding costs the
  // merchant a few seconds; guessing costs them the payment.
  if (progress.finalizedHeight === null) {
    return {
      creditable: false,
      confirmations,
      reason: 'the chain has not reported a finalized height',
    };
  }
  if (progress.finalizedHeight < height) {
    return {
      creditable: false,
      confirmations,
      reason: 'the settling block is not yet finalized',
    };
  }

  // The second opinion comes from a separately operated endpoint. It defeats a single lagging or
  // dishonest provider; it does not defeat a correlated failure, which is documented rather than
  // claimed away.
  if (secondOpinion === 'contradicted') {
    return {
      creditable: false,
      confirmations,
      reason: 'a second provider disagrees that the settling block is finalized',
    };
  }
  if (secondOpinion === 'unavailable') {
    return {
      creditable: false,
      confirmations,
      reason: 'no second provider could confirm finality',
    };
  }

  return { creditable: true, confirmations, reason: 'confirmed and finalized' };
}

/**
 * Whether a second provider is worth asking.
 *
 * Both local gates must already pass, so the extra request costs roughly one per completed payment
 * rather than one per poll. Asking on every tick would multiply the request budget by the polling
 * rate for an answer that cannot change the outcome until the local gates open.
 */
export function needsSecondOpinion(payment: Payment, progress: ChainProgress): boolean {
  const height = payment.settlingBlockHeight;
  if (height === null || !payment.requiresFinalityTag) {
    return false;
  }
  if (confirmationsFor(payment, progress.tip.height) < payment.requiredConfirmations) {
    return false;
  }
  if (progress.finalizedHeight === null) {
    return false;
  }
  return progress.finalizedHeight >= height;
}

/**
 * Whether the chain's finality view has stalled. A count cannot detect this: blocks keep arriving
 * while nothing finalizes, so confirmations climb and a count-only gate would complete payments the
 * chain has not actually settled. The answer to a stall is to alert and hold, never to fall back.
 */
export function finalityHasStalled(
  finalizedAdvancedAt: Date | null,
  now: Date,
  stallSeconds: number,
): boolean {
  if (finalizedAdvancedAt === null) {
    return false;
  }
  const elapsedSeconds = (now.getTime() - finalizedAdvancedAt.getTime()) / 1000;
  return elapsedSeconds > stallSeconds;
}
