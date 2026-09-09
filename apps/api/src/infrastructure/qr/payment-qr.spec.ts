import { buildPaymentUri, NATIVE_ASSET_REFERENCE, type PaymentUriRequest } from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import { renderPaymentQrCode } from './qr-code.js';
import { decodeQrCode } from './qr-decoder.test-helper.js';

/**
 * The six combinations a customer can actually be shown, each drawn as a real QR image and scanned
 * back out of it with an independent decoder.
 *
 * Asserting the string the builder returned would only prove the builder agrees with itself. The
 * failure this catches is a URI that is correct in a test and unreadable on a phone, and the one it
 * caught for real is a checkout that drew every payment as a token transfer, so a native POL
 * payment produced a QR asking the wallet to call `transfer` on a contract that does not exist.
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
