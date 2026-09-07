import type { ObservedTransfer } from '@cryptopay/shared';

import type { Payment } from './payment.js';

/**
 * How an observed transfer is classified against the payment it was sent to.
 *
 * Classification is pure and happens before anything is written, so the rules that decide whether
 * money counts are readable in one place and testable without a chain.
 */

export type TransferClassification = 'credited' | 'late' | 'unexpected' | 'wrong_asset';

export interface ClassifiedTransfer {
  readonly transfer: ObservedTransfer;
  readonly classification: TransferClassification;
  readonly reason: string;
}

const TERMINAL_BUT_UNPAID = new Set(['expired', 'underpaid']);

/**
 * A transfer is credited only when every one of these holds. Each rejection is recorded rather than
 * discarded: a customer who sent the wrong token to the right address deserves an explanation, and
 * a merchant deserves to see that something arrived.
 */
export function classifyTransfer(
  payment: Payment,
  transfer: ObservedTransfer,
  allowedAssetReferences: readonly string[],
): ClassifiedTransfer {
  // Identity is the contract address. Bridged USDC.e reports the byte-identical symbol as native
  // USDC, so anything but an address comparison credits the wrong token.
  if (!allowedAssetReferences.includes(transfer.assetReference)) {
    return {
      transfer,
      classification: 'wrong_asset',
      reason: 'the asset is not one this network settles',
    };
  }
  if (transfer.assetReference !== payment.asset.reference) {
    return {
      transfer,
      classification: 'wrong_asset',
      reason: 'the asset is not the one this payment requested',
    };
  }
  if (transfer.destinationAccount !== payment.receivingAccount) {
    return {
      transfer,
      classification: 'unexpected',
      reason: 'the transfer was not sent to this payment address',
    };
  }

  // A late transfer never revives a finished payment. It is recorded so the funds are visible and
  // recoverable, and an event is emitted, but the status does not move.
  if (TERMINAL_BUT_UNPAID.has(payment.status)) {
    return { transfer, classification: 'late', reason: `the payment is already ${payment.status}` };
  }
  if (payment.status === 'completed' || payment.status === 'overpaid') {
    return {
      transfer,
      classification: 'unexpected',
      reason: `the payment is already ${payment.status}`,
    };
  }
  if (payment.status === 'canceled') {
    return { transfer, classification: 'unexpected', reason: 'the payment was canceled' };
  }

  return { transfer, classification: 'credited', reason: 'accepted' };
}

/**
 * The credited total is recomputed from the surviving transfers rather than incremented in place.
 *
 * Incrementing is how a double credit happens: one replayed event, one retried write, and the
 * balance is permanently wrong with no way to tell. A sum over rows can be recomputed from scratch
 * at any time and compared against what is stored, so drift is detectable rather than invisible.
 */
export function sumCreditedAmount(
  transfers: readonly {
    classification: TransferClassification;
    amountInBaseUnits: bigint;
    orphaned: boolean;
  }[],
): bigint {
  let total = 0n;
  for (const entry of transfers) {
    if (entry.classification === 'credited' && !entry.orphaned) {
      total += entry.amountInBaseUnits;
    }
  }
  return total;
}

/**
 * The block a payment settles at is the highest block holding a surviving credited transfer.
 *
 * Using the highest rather than the first is what makes a split payment safe: confirmations must be
 * counted from the last piece of money to arrive, not the first, or a payment completes while part
 * of it is still only one block deep.
 */
export function settlingBlockHeight(
  transfers: readonly {
    classification: TransferClassification;
    blockHeight: bigint;
    orphaned: boolean;
  }[],
): bigint | null {
  // A single pass, and no Math.max: these are bigints, and Math.max would throw on them rather
  // than compare them.
  let highest: bigint | null = null;
  for (const entry of transfers) {
    if (entry.classification !== 'credited' || entry.orphaned) {
      continue;
    }
    if (highest === null || entry.blockHeight > highest) {
      highest = entry.blockHeight;
    }
  }
  return highest;
}
