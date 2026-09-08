import { binarize, Decoder, Detector, grayscale } from '@nuintun/qrcode';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { renderPaymentQrCode } from './qr-code.js';

/**
 * A QR test that only asserts bytes were produced proves nothing: an encoder that emits a valid but
 * wrong image passes it. Every case here reads the emitted PNG back with an independent PNG reader
 * and decodes it with a QR decoder from a different project than the encoder, then compares the
 * recovered text to the exact URI that went in.
 *
 * Two real defects were caught this way while the encoder was being written, and neither was visible
 * from the outside: a chunk allocated four bytes too long, which appended trailing content after
 * IEND, and a greyscale sampling error that read the wrong byte of every pixel.
 */

/** Decodes the emitted image the way a customer's phone would: pixels in, text out. */
function decode(bytes: Uint8Array): string | null {
  const image = PNG.sync.read(Buffer.from(bytes));
  const data = new Uint8ClampedArray(image.width * image.height * 4);
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    // pngjs normalises every image to RGBA regardless of the source colour type, so the stride is
    // always four even though this PNG was written as single-channel greyscale.
    const grey = image.data[pixel * 4] ?? 0;
    data[pixel * 4] = grey;
    data[pixel * 4 + 1] = grey;
    data[pixel * 4 + 2] = grey;
    data[pixel * 4 + 3] = 255;
  }
  const luminance = grayscale({ data, width: image.width, height: image.height });
  const detected = new Detector().detect(binarize(luminance, image.width, image.height));
  const located = detected.next();
  if (located.done === true) {
    return null;
  }
  return new Decoder().decode(located.value.matrix).content;
}

const POLYGON_TOKEN_URI =
  'ethereum:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359@137/transfer?address=0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d&uint256=25000000';
const POLYGON_NATIVE_URI =
  'ethereum:0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d@137?value=1500000000000000000';
const TRON_TOKEN_URI =
  'tron:TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj?contractAddress=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t&amount=25000000';
const SOLANA_TOKEN_URI =
  'solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?amount=25&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('rendering a payment QR code', () => {
  it.each([
    ['a Polygon token transfer', POLYGON_TOKEN_URI],
    ['a Polygon native transfer', POLYGON_NATIVE_URI],
    ['a TRON token transfer', TRON_TOKEN_URI],
    ['a Solana Pay token transfer', SOLANA_TOKEN_URI],
  ])('decodes back to the exact URI for %s', (_label, uri) => {
    expect(decode(renderPaymentQrCode(uri).bytes)).toBe(uri);
  });

  /**
   * Base58 is case sensitive, so a TRON or Solana address that passed through the EVM lowercase
   * normaliser would be a different address that nobody controls. The QR path must be byte exact.
   */
  it('preserves base58 case, which is the whole identity of a TRON or Solana address', () => {
    const decoded = decode(renderPaymentQrCode(SOLANA_TOKEN_URI).bytes);
    expect(decoded).toContain('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(decoded).not.toContain('epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v');
  });

  it('emits a PNG data URI, because that is what the payment response carries', () => {
    const image = renderPaymentQrCode(POLYGON_TOKEN_URI);
    expect(image.dataUri.startsWith('data:image/png;base64,')).toBe(true);
    const encoded = image.dataUri.split(',', 2)[1] ?? '';
    expect(decode(Buffer.from(encoded, 'base64'))).toBe(POLYGON_TOKEN_URI);
  });

  it('writes a real PNG signature and ends cleanly at IEND', () => {
    const { bytes } = renderPaymentQrCode(POLYGON_NATIVE_URI);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(Buffer.from(bytes.subarray(-8)).toString('latin1')).toContain('IEND');
    // A reader that rejects trailing content is the one that catches an oversized chunk allocation.
    expect(() => PNG.sync.read(Buffer.from(bytes))).not.toThrow();
  });

  it('scales the image without changing what it says', () => {
    const small = renderPaymentQrCode(POLYGON_TOKEN_URI, { scale: 4 });
    const large = renderPaymentQrCode(POLYGON_TOKEN_URI, { scale: 10 });
    expect(large.widthInPixels).toBeGreaterThan(small.widthInPixels);
    expect(small.moduleCount).toBe(large.moduleCount);
    expect(decode(large.bytes)).toBe(decode(small.bytes));
  });

  it('refuses a scale that would produce an unreadable or absurd image', () => {
    expect(() => renderPaymentQrCode(POLYGON_TOKEN_URI, { scale: 0 })).toThrow(/between 1 and 16/);
    expect(() => renderPaymentQrCode(POLYGON_TOKEN_URI, { scale: 64 })).toThrow(/between 1 and 16/);
  });

  it('refuses to draw nothing', () => {
    expect(() => renderPaymentQrCode('')).toThrow(/payment URI is required/);
  });
});
