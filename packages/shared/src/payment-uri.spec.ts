import { describe, expect, it } from 'vitest';

import {
  buildPaymentUri,
  NATIVE_ASSET_REFERENCE,
  UnsupportedPaymentUriError,
  type PaymentUriRequest,
} from './payment-uri.js';

/**
 * The one builder both the API and the hosted checkout draw their payment URI from.
 *
 * Three standards with nothing in common beyond being URIs, so each family is asserted against the
 * specification it answers to rather than against the shape of its neighbour. That the resulting
 * string survives a real QR image is asserted beside the renderer, which is where the renderer is.
 *
 * The addresses are real: Circle USDC on Polygon and Solana, Tether on TRON.
 */

const POLYGON_RECIPIENT = '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d';
const POLYGON_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const TRON_RECIPIENT = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SOLANA_RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function request(overrides: Partial<PaymentUriRequest>): PaymentUriRequest {
  return {
    networkFamily: 'polygon',
    evmChainId: 137,
    destinationAccount: POLYGON_RECIPIENT,
    assetReference: POLYGON_USDC,
    assetDecimals: 6,
    amountInBaseUnits: '25000000',
    memo: null,
    ...overrides,
  };
}

const POLYGON_TOKEN = request({});
const POLYGON_NATIVE = request({
  destinationAccount: POLYGON_RECIPIENT,
  assetReference: NATIVE_ASSET_REFERENCE,
  assetDecimals: 18,
  amountInBaseUnits: '1500000000000000000',
});
const TRON_TOKEN = request({
  networkFamily: 'tron',
  evmChainId: null,
  destinationAccount: TRON_RECIPIENT,
  assetReference: TRON_USDT,
});
const TRON_NATIVE = request({
  networkFamily: 'tron',
  evmChainId: null,
  destinationAccount: TRON_RECIPIENT,
  assetReference: NATIVE_ASSET_REFERENCE,
  amountInBaseUnits: '12500000',
});
const SOLANA_TOKEN = request({
  networkFamily: 'solana',
  evmChainId: null,
  destinationAccount: SOLANA_RECIPIENT,
  assetReference: SOLANA_USDC,
});
const SOLANA_NATIVE = request({
  networkFamily: 'solana',
  evmChainId: null,
  destinationAccount: SOLANA_RECIPIENT,
  assetReference: NATIVE_ASSET_REFERENCE,
  assetDecimals: 9,
  amountInBaseUnits: '2500000000',
});

describe('the URI each family understands', () => {
  it('builds the EIP-681 token transfer form for Polygon', () => {
    expect(buildPaymentUri(POLYGON_TOKEN)).toBe(
      `ethereum:${POLYGON_USDC}@137/transfer?address=${POLYGON_RECIPIENT}&uint256=25000000`,
    );
  });

  it('builds the EIP-681 plain value form for native POL', () => {
    expect(buildPaymentUri(POLYGON_NATIVE)).toBe(
      `ethereum:${POLYGON_RECIPIENT}@137?value=1500000000000000000`,
    );
  });

  it('names the contract separately for a TRC-20 payment', () => {
    expect(buildPaymentUri(TRON_TOKEN)).toBe(
      `tron:${TRON_RECIPIENT}?contractAddress=${TRON_USDT}&amount=25000000`,
    );
  });

  it('omits the contract for a native TRX payment', () => {
    expect(buildPaymentUri(TRON_NATIVE)).toBe(`tron:${TRON_RECIPIENT}?amount=12500000`);
  });

  /**
   * The one field on any of the three standards that is not base units. Solana Pay asks for whole
   * tokens, so sending lamports here would request a billion times the intended amount.
   */
  it('writes the Solana Pay amount in whole tokens, not base units', () => {
    expect(buildPaymentUri(SOLANA_TOKEN)).toBe(
      `solana:${SOLANA_RECIPIENT}?amount=25&spl-token=${SOLANA_USDC}`,
    );
    expect(buildPaymentUri(SOLANA_NATIVE)).toBe(`solana:${SOLANA_RECIPIENT}?amount=2.5`);
  });

  it('carries a reference on Solana Pay, which is the only family with a field for one', () => {
    expect(buildPaymentUri({ ...SOLANA_TOKEN, memo: 'order-12345' })).toContain(
      'reference=order-12345',
    );
  });
});

/**
 * The acceptance criterion the brief states directly: QR generation is not complete until all three
 * networks pass, for native and token alike, and the QR must decode back to the expected URI.
 */
describe('what a builder refuses rather than fakes', () => {
  it('refuses an EVM URI with no chain to name', () => {
    expect(() => buildPaymentUri(request({ evmChainId: null }))).toThrow(
      UnsupportedPaymentUriError,
    );
  });

  /** A memo silently dropped is a payment that arrives and cannot be attributed to anyone. */
  it.each([
    ['polygon' as const, 137],
    ['tron' as const, null],
  ])('refuses a memo on %s, which has no field for one', (networkFamily, evmChainId) => {
    expect(() =>
      buildPaymentUri(request({ networkFamily, evmChainId, memo: 'order-12345' })),
    ).toThrow(/no field for a memo/);
  });

  // Four rows, not one row of four columns: written the other way, only the empty string ran and
  // the three interesting cases were never executed.
  it.each([[''], ['not-a-number'], ['-1'], ['1.5'], ['1e18'], [' 25000000']])(
    'refuses the amount %s',
    (amountInBaseUnits) => {
      expect(() => buildPaymentUri(request({ amountInBaseUnits }))).toThrow(
        /must be a base-unit integer/,
      );
    },
  );
});
