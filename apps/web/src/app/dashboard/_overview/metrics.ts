import { isPaymentStatus, type Payment, type PaymentStatus } from '@cryptopay/shared';

import { formatAmount } from '@/lib/format';
import { describeStatus, STATUS_DISPLAY_ORDER } from '@/lib/payment-status';

/**
 * Every figure on the overview is derived in the browser from one page of payments, because the API
 * exposes no analytics endpoint and a screen that invents one is a screen that invents numbers.
 *
 * That constraint is visible in the output rather than hidden by it. A comparison needs fourteen
 * days of history; when the page does not reach that far back the direction is reported as unknown
 * instead of being computed against a window that is only partly present.
 */

const DAY_MILLISECONDS = 86_400_000;
const WINDOW_MILLISECONDS = 7 * DAY_MILLISECONDS;

/** Money is credited in full only in these two outcomes; the rest never became revenue. */
const SUCCESSFUL_STATUSES: readonly PaymentStatus[] = Object.freeze(['completed', 'overpaid']);

/**
 * The contract types `status` as a plain string, because its enum is built from the shared status
 * list through a cast. A value outside the eight would be a contract violation, and this screen
 * excludes one rather than rendering a status it has no description, colour or glyph for.
 */
export type OverviewPayment = Omit<Payment, 'status'> & { readonly status: PaymentStatus };

function withKnownStatus(payments: readonly Payment[]): readonly OverviewPayment[] {
  return payments.flatMap((payment) => {
    const status = payment.status;
    if (!isPaymentStatus(status)) {
      return [];
    }
    return [{ ...payment, status }];
  });
}

export type ChangeDirection = 'up' | 'down' | 'flat' | 'unknown';

export interface MetricChange {
  readonly direction: ChangeDirection;
  readonly magnitude: string;
}

export interface Kpi {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly unit: string | null;
  readonly context: string;
  readonly change: MetricChange;
}

export interface StatusShare {
  readonly status: PaymentStatus;
  readonly count: number;
  readonly share: number;
}

export interface OverviewMetrics {
  readonly kpis: readonly Kpi[];
  readonly distribution: readonly StatusShare[];
  readonly recent: readonly OverviewPayment[];
  readonly windowNote: string;
}

const UNKNOWN_CHANGE: MetricChange = Object.freeze({ direction: 'unknown', magnitude: '' });

function directionOf(current: number, previous: number): ChangeDirection {
  if (current > previous) {
    return 'up';
  }
  if (current < previous) {
    return 'down';
  }
  return 'flat';
}

function baseUnitsDirection(current: bigint, previous: bigint): ChangeDirection {
  if (current > previous) {
    return 'up';
  }
  if (current < previous) {
    return 'down';
  }
  return 'flat';
}

/** Base units to a decimal string, kept in bigint and string space the whole way. */
function toDisplay(baseUnits: bigint, decimals: number): string {
  const digits = baseUnits.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  if (decimals === 0) {
    return whole;
  }
  return `${whole}.${digits.slice(digits.length - decimals)}`;
}

export function formatSeconds(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  if (rounded < 60) {
    return `${rounded.toString()}s`;
  }
  if (rounded < 3600) {
    const minutes = Math.floor(rounded / 60);
    return `${minutes.toString()}m ${(rounded % 60).toString()}s`;
  }
  const hours = Math.floor(rounded / 3600);
  return `${hours.toString()}h ${Math.floor((rounded % 3600) / 60).toString()}m`;
}

function createdAtMilliseconds(payment: OverviewPayment): number {
  return Date.parse(payment.createdAt);
}

function withinWindow(payment: OverviewPayment, from: number, until: number): boolean {
  const createdAt = createdAtMilliseconds(payment);
  return createdAt >= from && createdAt < until;
}

function isSuccessful(payment: OverviewPayment): boolean {
  return SUCCESSFUL_STATUSES.includes(payment.status);
}

interface AssetVolume {
  readonly reference: string;
  readonly symbol: string;
  readonly decimals: number;
  total: bigint;
  count: number;
}

/**
 * Totals are keyed on the contract address, never on the symbol: bridged USDC.e reports the
 * byte-identical symbol "USDC", so a total keyed on the symbol quietly adds two different assets.
 */
function volumeByAsset(payments: readonly OverviewPayment[]): readonly AssetVolume[] {
  const totals: AssetVolume[] = [];
  for (const payment of payments) {
    if (!isSuccessful(payment)) {
      continue;
    }
    const reference = payment.asset.reference;
    const credited = BigInt(payment.creditedAmount.baseUnits);
    const existing = totals.find((candidate) => candidate.reference === reference);
    if (existing === undefined) {
      totals.push({
        reference,
        symbol: payment.asset.symbol,
        decimals: payment.asset.decimals,
        total: credited,
        count: 1,
      });
      continue;
    }
    existing.total += credited;
    existing.count += 1;
  }
  return totals;
}

function medianSeconds(payments: readonly OverviewPayment[]): number | null {
  const durations = payments
    .flatMap((payment) => {
      const completedAt = payment.completedAt;
      if (completedAt === null) {
        return [];
      }
      return [(Date.parse(completedAt) - createdAtMilliseconds(payment)) / 1000];
    })
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0)
    .toSorted((first, second) => first - second);

  if (durations.length === 0) {
    return null;
  }
  const middle = Math.floor(durations.length / 2);
  const upper = durations[middle] ?? 0;
  if (durations.length % 2 === 1) {
    return upper;
  }
  return ((durations[middle - 1] ?? 0) + upper) / 2;
}

function completionRate(payments: readonly OverviewPayment[]): number | null {
  const resolved = payments.filter((payment) => describeStatus(payment.status).isFinal);
  if (resolved.length === 0) {
    return null;
  }
  return (resolved.filter((payment) => isSuccessful(payment)).length / resolved.length) * 100;
}

function buildCreatedKpi(
  current: readonly OverviewPayment[],
  previous: readonly OverviewPayment[],
  comparable: boolean,
): Kpi {
  return {
    key: 'created',
    label: 'Payments created',
    value: current.length.toString(),
    unit: null,
    context: 'Created in the last 7 days.',
    change: comparable
      ? {
          direction: directionOf(current.length, previous.length),
          magnitude: Math.abs(current.length - previous.length).toString(),
        }
      : UNKNOWN_CHANGE,
  };
}

function buildVolumeKpi(
  current: readonly OverviewPayment[],
  previous: readonly OverviewPayment[],
  comparable: boolean,
): Kpi {
  const ranked = volumeByAsset(current).toSorted((first, second) => second.count - first.count);
  const leading = ranked[0];

  if (leading === undefined) {
    return {
      key: 'volume',
      label: 'Volume completed',
      value: '0',
      unit: null,
      context: 'Nothing was paid in full in the last 7 days.',
      change: UNKNOWN_CHANGE,
    };
  }

  const otherAssets = ranked.length - 1;
  const previousTotal =
    volumeByAsset(previous).find((candidate) => candidate.reference === leading.reference)?.total ??
    0n;
  const difference =
    leading.total > previousTotal ? leading.total - previousTotal : previousTotal - leading.total;

  return {
    key: 'volume',
    label: 'Volume completed',
    value: formatAmount(toDisplay(leading.total, leading.decimals)),
    unit: leading.symbol,
    context:
      otherAssets === 0
        ? `Credited across ${leading.count.toString()} completed or overpaid payments.`
        : `Credited across ${leading.count.toString()} payments. ${otherAssets.toString()} further asset${otherAssets === 1 ? ' is' : 's are'} counted separately.`,
    change: comparable
      ? {
          direction: baseUnitsDirection(leading.total, previousTotal),
          magnitude: `${formatAmount(toDisplay(difference, leading.decimals))} ${leading.symbol}`,
        }
      : UNKNOWN_CHANGE,
  };
}

function buildRateKpi(
  current: readonly OverviewPayment[],
  previous: readonly OverviewPayment[],
  comparable: boolean,
): Kpi {
  const currentRate = completionRate(current);

  if (currentRate === null) {
    return {
      key: 'completion-rate',
      label: 'Completion rate',
      value: 'n/a',
      unit: null,
      context: 'No payment reached a final status in the last 7 days.',
      change: UNKNOWN_CHANGE,
    };
  }

  const previousRate = completionRate(previous);
  if (!comparable || previousRate === null) {
    return {
      key: 'completion-rate',
      label: 'Completion rate',
      value: currentRate.toFixed(1),
      unit: '%',
      context: 'Of the payments that reached a final status, the share paid in full.',
      change: UNKNOWN_CHANGE,
    };
  }

  return {
    key: 'completion-rate',
    label: 'Completion rate',
    value: currentRate.toFixed(1),
    unit: '%',
    context: 'Of the payments that reached a final status, the share paid in full.',
    change: {
      direction: directionOf(currentRate, previousRate),
      magnitude: `${Math.abs(currentRate - previousRate).toFixed(1)} points`,
    },
  };
}

function buildMedianKpi(
  current: readonly OverviewPayment[],
  previous: readonly OverviewPayment[],
  comparable: boolean,
): Kpi {
  const currentMedian = medianSeconds(current);

  if (currentMedian === null) {
    return {
      key: 'median-time',
      label: 'Median time to completion',
      value: 'n/a',
      unit: null,
      context: 'No payment completed in the last 7 days.',
      change: UNKNOWN_CHANGE,
    };
  }

  const context = 'From creation to completion, measured on completed payments only.';
  const previousMedian = medianSeconds(previous);
  if (!comparable || previousMedian === null) {
    return {
      key: 'median-time',
      label: 'Median time to completion',
      value: formatSeconds(currentMedian),
      unit: null,
      context,
      change: UNKNOWN_CHANGE,
    };
  }

  return {
    key: 'median-time',
    label: 'Median time to completion',
    value: formatSeconds(currentMedian),
    unit: null,
    context,
    change: {
      direction: directionOf(currentMedian, previousMedian),
      magnitude: formatSeconds(Math.abs(currentMedian - previousMedian)),
    },
  };
}

function buildDistribution(payments: readonly OverviewPayment[]): readonly StatusShare[] {
  const counts = new Map<PaymentStatus, number>();
  for (const payment of payments) {
    counts.set(payment.status, (counts.get(payment.status) ?? 0) + 1);
  }
  return STATUS_DISPLAY_ORDER.flatMap((status) => {
    const count = counts.get(status) ?? 0;
    if (count === 0) {
      return [];
    }
    return [{ status, count, share: (count / payments.length) * 100 }];
  });
}

export function buildOverview(
  page: readonly Payment[],
  hasMore: boolean,
  now: number,
): OverviewMetrics {
  const payments = withKnownStatus(page);
  const currentFrom = now - WINDOW_MILLISECONDS;
  const previousFrom = now - 2 * WINDOW_MILLISECONDS;

  const current = payments.filter((payment) => withinWindow(payment, currentFrom, now + 1));
  const previous = payments.filter((payment) => withinWindow(payment, previousFrom, currentFrom));

  let oldest = Infinity;
  for (const payment of payments) {
    oldest = Math.min(oldest, createdAtMilliseconds(payment));
  }
  // A truncated page cannot carry a comparison: what it drops is the oldest payments, which is
  // exactly the half the earlier window is made of, so the change would read low every time.
  const comparable = !hasMore || oldest <= previousFrom;

  return {
    kpis: [
      buildCreatedKpi(current, previous, comparable),
      buildVolumeKpi(current, previous, comparable),
      buildRateKpi(current, previous, comparable),
      buildMedianKpi(current, previous, comparable),
    ],
    distribution: buildDistribution(payments),
    recent: payments
      .toSorted((first, second) => createdAtMilliseconds(second) - createdAtMilliseconds(first))
      .slice(0, 10),
    windowNote: hasMore
      ? `Derived from the ${payments.length.toString()} most recent payments on this key. Older payments exist and are not counted.`
      : `Derived from all ${payments.length.toString()} payments on this key.`,
  };
}
