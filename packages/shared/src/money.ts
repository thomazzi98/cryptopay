import type { AssetDescriptor } from './ledger-primitives.js';

/**
 * Amounts are integer base units in a bigint, always. No float ever touches a monetary value, and
 * `Number` is never used as an intermediate: USDC has six decimals, POL has eighteen, and mixing
 * them is a factor of a million.
 *
 * On the wire an amount travels as two decimal strings, `baseUnits` and `display`, so that no JSON
 * parser can round it. The checkout client re-derives one from the other and refuses to open a
 * wallet if they disagree, which is what makes a tampered payload harmless.
 */

export interface Money {
  readonly amountInBaseUnits: bigint;
  readonly asset: AssetDescriptor;
}

const DECIMAL_AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?$/;
const MAXIMUM_DECIMALS = 36;

export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

function assertUsableDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAXIMUM_DECIMALS) {
    throw new InvalidAmountError(`Unsupported decimals: ${decimals}`);
  }
}

/**
 * Converts a human decimal string into base units.
 *
 * Rejects rather than rounds when the input carries more precision than the asset can hold: a
 * payment request for 1.0000005 USDC is a mistake in the caller, and silently truncating it makes
 * the merchant's records disagree with the chain.
 */
export function parseAmountToBaseUnits(displayAmount: string, decimals: number): bigint {
  assertUsableDecimals(decimals);

  const trimmed = displayAmount.trim();
  const match = DECIMAL_AMOUNT_PATTERN.exec(trimmed);
  if (match === null) {
    throw new InvalidAmountError(
      `Amount must be a non-negative decimal number without exponent or separators: ${displayAmount}`,
    );
  }

  const wholePart = match[1] ?? '';
  const fractionalPart = match[2] ?? '';
  if (fractionalPart.length > decimals) {
    throw new InvalidAmountError(
      `Amount ${trimmed} carries ${fractionalPart.length} decimal places but the asset holds ${decimals}`,
    );
  }

  const paddedFraction = fractionalPart.padEnd(decimals, '0');
  return BigInt(`${wholePart}${paddedFraction}`);
}

/** Renders base units as a fixed-precision decimal string, always showing every decimal place. */
export function formatBaseUnits(amountInBaseUnits: bigint, decimals: number): string {
  assertUsableDecimals(decimals);

  if (amountInBaseUnits < 0n) {
    throw new InvalidAmountError(`Amount must not be negative: ${amountInBaseUnits}`);
  }
  if (decimals === 0) {
    return amountInBaseUnits.toString();
  }

  const scale = 10n ** BigInt(decimals);
  const wholePart = amountInBaseUnits / scale;
  const fractionalPart = amountInBaseUnits % scale;
  return `${wholePart}.${fractionalPart.toString().padStart(decimals, '0')}`;
}

export function createMoney(amountInBaseUnits: bigint, asset: AssetDescriptor): Money {
  if (amountInBaseUnits < 0n) {
    throw new InvalidAmountError(`Amount must not be negative: ${amountInBaseUnits}`);
  }
  return Object.freeze({ amountInBaseUnits, asset });
}

export function formatMoney(money: Money): string {
  return formatBaseUnits(money.amountInBaseUnits, money.asset.decimals);
}

/**
 * The tolerance band a payment is accepted within. Expressed in basis points so that a merchant can
 * absorb a fee-bearing transfer without either accepting a materially short payment or rejecting one
 * that is a rounding unit light.
 */
export interface AcceptanceBand {
  readonly minimumInBaseUnits: bigint;
  readonly maximumInBaseUnits: bigint;
}

const BASIS_POINTS_DENOMINATOR = 10_000n;

export function calculateAcceptanceBand(
  requestedAmountInBaseUnits: bigint,
  underpaymentToleranceBasisPoints: number,
  overpaymentToleranceBasisPoints: number,
): AcceptanceBand {
  if (requestedAmountInBaseUnits <= 0n) {
    throw new InvalidAmountError(
      `Requested amount must be positive: ${requestedAmountInBaseUnits}`,
    );
  }
  if (underpaymentToleranceBasisPoints < 0 || overpaymentToleranceBasisPoints < 0) {
    throw new InvalidAmountError('Tolerances must not be negative');
  }
  if (underpaymentToleranceBasisPoints > Number(BASIS_POINTS_DENOMINATOR)) {
    throw new InvalidAmountError('Underpayment tolerance must not exceed the full amount');
  }

  const underpaymentAllowance =
    (requestedAmountInBaseUnits * BigInt(underpaymentToleranceBasisPoints)) /
    BASIS_POINTS_DENOMINATOR;
  const overpaymentAllowance =
    (requestedAmountInBaseUnits * BigInt(overpaymentToleranceBasisPoints)) /
    BASIS_POINTS_DENOMINATOR;

  return Object.freeze({
    minimumInBaseUnits: requestedAmountInBaseUnits - underpaymentAllowance,
    maximumInBaseUnits: requestedAmountInBaseUnits + overpaymentAllowance,
  });
}
