import type { PaymentStatus } from '@cryptopay/shared';

/**
 * One descriptor per payment status, and every surface reads from it.
 *
 * The badge, the chart series, the table row accent and the timeline dot all take their colour from
 * the same entry, so a payment cannot look completed in one place and confirming in another. When a
 * status is added to the domain, this record fails to compile until it is described here, which is
 * the point: a status with no visual identity would otherwise render as an unstyled grey pill.
 *
 * Colour never carries the meaning alone. Each entry pairs its token with a glyph, because a red
 * pill and a green pill are the same pill to a colour-blind reader, and because a screenshot pasted
 * into a support thread loses hue long before it loses shape.
 */

export interface StatusDescriptor {
  readonly label: string;
  /** Written for a merchant reading it once, not for someone who knows the state machine. */
  readonly summary: string;
  readonly token: string;
  readonly softToken: string;
  readonly glyph: string;
  /** Terminal statuses stop the confirmation meter and the countdown. */
  readonly isFinal: boolean;
  /** Whether money is currently credited to the payment. Drives the amount emphasis. */
  readonly holdsFunds: boolean;
}

const STATUS_DESCRIPTORS: Readonly<Record<PaymentStatus, StatusDescriptor>> = Object.freeze({
  pending: {
    label: 'Pending',
    summary: 'Waiting for the customer to send payment.',
    token: 'var(--color-status-pending)',
    softToken: 'var(--color-status-pending-soft)',
    glyph: '○',
    isFinal: false,
    holdsFunds: false,
  },
  partially_funded: {
    label: 'Partially funded',
    summary: 'Some money arrived, but less than the amount requested.',
    token: 'var(--color-status-partially-funded)',
    softToken: 'var(--color-status-partially-funded-soft)',
    glyph: '◐',
    isFinal: false,
    holdsFunds: true,
  },
  confirming: {
    label: 'Confirming',
    summary: 'Funded. Waiting for the chain to confirm and finalize the block.',
    token: 'var(--color-status-confirming)',
    softToken: 'var(--color-status-confirming-soft)',
    glyph: '◍',
    isFinal: false,
    holdsFunds: true,
  },
  completed: {
    label: 'Completed',
    summary: 'Paid in full and final on chain. Safe to fulfil.',
    token: 'var(--color-status-completed)',
    softToken: 'var(--color-status-completed-soft)',
    glyph: '✓',
    isFinal: true,
    holdsFunds: true,
  },
  overpaid: {
    label: 'Overpaid',
    summary:
      'More arrived than was requested. Reported separately so it is never pocketed quietly.',
    token: 'var(--color-status-overpaid)',
    softToken: 'var(--color-status-overpaid-soft)',
    glyph: '⇈',
    isFinal: true,
    holdsFunds: true,
  },
  underpaid: {
    label: 'Underpaid',
    summary: 'The window closed with money credited but below the accepted amount.',
    token: 'var(--color-status-underpaid)',
    softToken: 'var(--color-status-underpaid-soft)',
    glyph: '⇊',
    isFinal: true,
    holdsFunds: true,
  },
  expired: {
    label: 'Expired',
    summary: 'The window closed with nothing received.',
    token: 'var(--color-status-expired)',
    softToken: 'var(--color-status-expired-soft)',
    glyph: '⊘',
    isFinal: true,
    holdsFunds: false,
  },
  canceled: {
    label: 'Canceled',
    summary: 'Cancelled before any money arrived.',
    token: 'var(--color-status-canceled)',
    softToken: 'var(--color-status-canceled-soft)',
    glyph: '×',
    isFinal: true,
    holdsFunds: false,
  },
});

export function describeStatus(status: PaymentStatus): StatusDescriptor {
  return STATUS_DESCRIPTORS[status];
}

/**
 * The order a merchant scans a status filter in: live states first, because those are the ones with
 * something still to do, then the outcomes.
 */
export const STATUS_DISPLAY_ORDER: readonly PaymentStatus[] = Object.freeze([
  'pending',
  'partially_funded',
  'confirming',
  'completed',
  'overpaid',
  'underpaid',
  'expired',
  'canceled',
]);
