import { describe, expect, it } from 'vitest';

import { renderPaymentQrCode } from '../qr/qr-code.js';
import { decodeQrCode } from '../qr/qr-decoder.test-helper.js';
import {
  buildPaymentUri,
  UnsupportedPaymentUriError,
  type PaymentUriRequest,
} from './payment-uri.js';
import { NATIVE_ASSET_REFERENCE } from './token-registry.js';

/**
 * Every case here is built from the real builder and then scanned back out of a real QR image, so a
 * change to a builder breaks the decode assertion rather than quietly shipping a URI no wallet can
 * read. Asserting the string alone would only prove the builder agrees with itself.
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
describe('scanning the QR code back', () => {
  it.each([
    ['Polygon, USDC', POLYGON_TOKEN],
    ['Polygon, native POL', POLYGON_NATIVE],
    ['TRON, USDT', TRON_TOKEN],
    ['TRON, native TRX', TRON_NATIVE],
    ['Solana, USDC', SOLANA_TOKEN],
    ['Solana, native SOL', SOLANA_NATIVE],
  ])('recovers exactly the URI the builder produced for %s', (_label, input) => {
    const uri = buildPaymentUri(input);
    const decoded = decodeQrCode(renderPaymentQrCode(uri).bytes);

    expect(decoded).toBe(uri);
    // The three facts a customer's money depends on, read back out of the image itself.
    expect(decoded).toContain(input.destinationAccount);
    expect(decoded).toContain(
      input.networkFamily === 'solana' ? 'amount=' : input.amountInBaseUnits,
    );
    // A native payment names no contract, so there is nothing to look for. Written as a value
    // rather than a branch, because an assertion inside a condition is one that can quietly stop
    // running.
    const contractInTheUri =
      input.assetReference === NATIVE_ASSET_REFERENCE ? '' : input.assetReference;
    expect(decoded ?? '').toContain(contractInTheUri);
  });

  it('carries base58 through the image with its case intact', () => {
    const decoded = decodeQrCode(renderPaymentQrCode(buildPaymentUri(TRON_TOKEN)).bytes);
    expect(decoded).toContain(TRON_USDT);
    expect(decoded).not.toContain(TRON_USDT.toLowerCase());
  });
});

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

  it.each([['', 'not-a-number', '-1', '1.5']])('refuses the amount %s', (amountInBaseUnits) => {
    expect(() => buildPaymentUri(request({ amountInBaseUnits }))).toThrow(
      /must be a base-unit integer/,
    );
  });
});
