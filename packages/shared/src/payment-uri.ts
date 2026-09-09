import { formatBaseUnits } from './money.js';
import type { NetworkFamily } from './network-descriptor.js';

/**
 * What a native currency carries instead of a contract address. Native payments have no contract to
 * name, and every layer that matches on an asset needs one value that unambiguously means "the
 * chain's own currency" rather than an empty string that reads as missing data.
 */
export const NATIVE_ASSET_REFERENCE = 'native';

/**
 * The request a wallet reads when it scans a payment.
 *
 * One builder per family, selected by a lookup rather than a chain of conditions, because the three
 * standards have nothing in common beyond being URIs. EIP-681 names the chain by number and the
 * amount in base units; Solana Pay names the amount in decimal units and the token by mint; TRON
 * has no ratified standard at all, which is stated here rather than papered over.
 *
 * Nothing downstream of this file knows which chain it is drawing. The QR renderer takes a string.
 */

export interface PaymentUriRequest {
  readonly networkFamily: NetworkFamily;
  /** Required by EIP-681 and meaningless elsewhere. */
  readonly evmChainId: number | null;
  readonly destinationAccount: string;
  /** A contract or mint address, or the native sentinel. */
  readonly assetReference: string;
  readonly assetDecimals: number;
  readonly amountInBaseUnits: string;
  /**
   * A reference the payer's wallet should carry back. Only Solana Pay has a field for it; a memo
   * requested on a family that cannot express one is refused rather than silently dropped, because
   * a dropped memo is a payment nobody can attribute.
   */
  readonly memo: string | null;
}

export class UnsupportedPaymentUriError extends Error {
  constructor(family: NetworkFamily, reason: string) {
    super(`No payment URI can be built for ${family}: ${reason}`);
    this.name = 'UnsupportedPaymentUriError';
  }
}

function isNative(request: PaymentUriRequest): boolean {
  return request.assetReference === NATIVE_ASSET_REFERENCE;
}

/**
 * EIP-681. The token form targets the contract and carries the recipient as the first argument;
 * the native form targets the recipient directly. Amounts are base units in both, which is what
 * keeps the string free of any rounding this system did not already do.
 */
function buildEvmUri(request: PaymentUriRequest): string {
  if (request.evmChainId === null) {
    throw new UnsupportedPaymentUriError('polygon', 'EIP-681 names the chain by number');
  }
  const chain = request.evmChainId.toString();
  if (isNative(request)) {
    return `ethereum:${request.destinationAccount}@${chain}?value=${request.amountInBaseUnits}`;
  }
  const query = `address=${request.destinationAccount}&uint256=${request.amountInBaseUnits}`;
  return `ethereum:${request.assetReference}@${chain}/transfer?${query}`;
}

/**
 * Solana Pay permits trailing zeros but nothing needs them, and a shorter string is a smaller QR
 * symbol, which is a QR a phone reads on the first try rather than the third.
 */
function trimTrailingZeros(amount: string): string {
  if (!amount.includes('.')) {
    return amount;
  }
  return amount.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Solana Pay, which differs from the other two in a way that is easy to get wrong: `amount` is a
 * decimal figure in whole tokens, not base units. Sending lamports in that field would ask for a
 * billion times the intended amount.
 */
function buildSolanaUri(request: PaymentUriRequest): string {
  const amount = trimTrailingZeros(
    formatBaseUnits(BigInt(request.amountInBaseUnits), request.assetDecimals),
  );
  const parameters = [`amount=${amount}`];
  if (!isNative(request)) {
    parameters.push(`spl-token=${request.assetReference}`);
  }
  if (request.memo !== null) {
    parameters.push(`reference=${request.memo}`);
  }
  return `solana:${request.destinationAccount}?${parameters.join('&')}`;
}

/**
 * TRON publishes no ratified payment URI standard, so this is a stated convention rather than a
 * specification, and the network's capability flag says so. The form mirrors what TRON wallets
 * accept in practice: the recipient in the scheme, the contract named separately when the payment
 * is TRC-20, and the amount in base units.
 */
function buildTronUri(request: PaymentUriRequest): string {
  const parameters = [`amount=${request.amountInBaseUnits}`];
  if (!isNative(request)) {
    parameters.unshift(`contractAddress=${request.assetReference}`);
  }
  return `tron:${request.destinationAccount}?${parameters.join('&')}`;
}

const BUILDERS: Readonly<Record<NetworkFamily, (request: PaymentUriRequest) => string>> =
  Object.freeze({
    polygon: buildEvmUri,
    solana: buildSolanaUri,
    tron: buildTronUri,
  });

/** Families whose standard has somewhere to put a reference the payer carries back. */
const FAMILIES_WITH_MEMO: ReadonlySet<NetworkFamily> = new Set<NetworkFamily>(['solana']);

export function buildPaymentUri(request: PaymentUriRequest): string {
  if (request.amountInBaseUnits === '' || !/^\d+$/.test(request.amountInBaseUnits)) {
    throw new UnsupportedPaymentUriError(
      request.networkFamily,
      'an amount must be a base-unit integer',
    );
  }
  if (request.memo !== null && !FAMILIES_WITH_MEMO.has(request.networkFamily)) {
    throw new UnsupportedPaymentUriError(
      request.networkFamily,
      'this family has no field for a memo, and dropping one loses the attribution',
    );
  }
  return BUILDERS[request.networkFamily](request);
}
