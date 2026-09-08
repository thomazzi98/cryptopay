import {
  USDC_DECIMALS,
  calculateAcceptanceBand,
  formatBaseUnits,
  parseAmountToBaseUnits,
} from '@cryptopay/shared';

/**
 * A tolerance in basis points means nothing to a merchant until it is money. Every figure here is
 * computed with the same function the API accepts payments with, so the worked example on screen
 * cannot drift from the band the ledger actually enforces.
 */

const EXAMPLE_INVOICE_DISPLAY = '25';

interface WorkedExample {
  readonly requested: string;
  readonly minimum: string;
  readonly maximum: string;
  readonly underpaymentAllowance: string;
  readonly overpaymentAllowance: string;
}

export function workExample(
  underpaymentToleranceBasisPoints: number,
  overpaymentToleranceBasisPoints: number,
): WorkedExample {
  const requested = parseAmountToBaseUnits(EXAMPLE_INVOICE_DISPLAY, USDC_DECIMALS);
  const band = calculateAcceptanceBand(
    requested,
    underpaymentToleranceBasisPoints,
    overpaymentToleranceBasisPoints,
  );
  return {
    requested: formatBaseUnits(requested, USDC_DECIMALS),
    minimum: formatBaseUnits(band.minimumInBaseUnits, USDC_DECIMALS),
    maximum: formatBaseUnits(band.maximumInBaseUnits, USDC_DECIMALS),
    underpaymentAllowance: formatBaseUnits(requested - band.minimumInBaseUnits, USDC_DECIMALS),
    overpaymentAllowance: formatBaseUnits(band.maximumInBaseUnits - requested, USDC_DECIMALS),
  };
}

export function formatBasisPoints(basisPoints: number): string {
  return `${(basisPoints / 100).toString()}%`;
}

export function describeLifetime(totalSeconds: number): string {
  if (totalSeconds % 3600 === 0) {
    const hours = totalSeconds / 3600;
    return `${hours.toString()} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  if (totalSeconds % 60 === 0) {
    const minutes = totalSeconds / 60;
    return `${minutes.toString()} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${totalSeconds.toString()} seconds`;
}
