import { describe, expect, it } from 'vitest';

import type { PaymentStatus } from './payment-status.js';
import {
  hasCreditedValue,
  isPaymentStatus,
  isTerminalPaymentStatus,
  PAYMENT_STATUSES,
} from './payment-status.js';

const TERMINAL: readonly PaymentStatus[] = [
  'completed',
  'overpaid',
  'underpaid',
  'expired',
  'canceled',
];
const NON_TERMINAL: readonly PaymentStatus[] = ['pending', 'partially_funded', 'confirming'];

const byName = (left: PaymentStatus, right: PaymentStatus): number => left.localeCompare(right);

describe('payment statuses', () => {
  it('declares exactly eight states, each listed once', () => {
    expect(PAYMENT_STATUSES).toHaveLength(8);
    expect(new Set(PAYMENT_STATUSES).size).toBe(8);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PAYMENT_STATUSES)).toBe(true);
  });

  it.each(TERMINAL)('%s is terminal', (status) => {
    expect(isPaymentStatus(status)).toBe(true);
    expect(isTerminalPaymentStatus(status)).toBe(true);
  });

  it.each(NON_TERMINAL)('%s is not terminal', (status) => {
    expect(isPaymentStatus(status)).toBe(true);
    expect(isTerminalPaymentStatus(status)).toBe(false);
  });

  // The two sets must partition the declared statuses: a state added later without being classified
  // would otherwise sit in neither list and silently never stop the dashboard from polling.
  it('partitions every declared status into terminal or non-terminal', () => {
    expect([...TERMINAL, ...NON_TERMINAL].toSorted(byName)).toStrictEqual(
      [...PAYMENT_STATUSES].toSorted(byName),
    );
  });

  it.each(['COMPLETED', 'paid', 'failed', 'refunded', ''])('rejects %s', (candidate) => {
    expect(isPaymentStatus(candidate)).toBe(false);
  });

  it.each<PaymentStatus>(['partially_funded', 'confirming', 'completed', 'overpaid', 'underpaid'])(
    '%s may hold credited value',
    (status) => {
      expect(hasCreditedValue(status)).toBe(true);
    },
  );

  it.each<PaymentStatus>(['pending', 'expired', 'canceled'])(
    '%s never held credited value',
    (status) => {
      expect(hasCreditedValue(status)).toBe(false);
    },
  );
});
