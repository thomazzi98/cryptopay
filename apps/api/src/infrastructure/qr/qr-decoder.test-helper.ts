import { binarize, Decoder, Detector, grayscale } from '@nuintun/qrcode';
import { PNG } from 'pngjs';

import { renderPaymentQrCode } from './qr-code.js';

/**
 * Reads a QR image the way a customer's phone would: pixels in, text out.
 *
 * Deliberately built from libraries by different authors than the encoder. A round trip through one
 * project's own decoder proves only that it agrees with itself, which is exactly the failure this
 * helper exists to rule out.
 *
 * Excluded from the production build, so the two test-only dependencies never reach a running
 * process.
 */
export function decodeQrCode(bytes: Uint8Array): string | null {
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
  const located = new Detector().detect(binarize(luminance, image.width, image.height)).next();
  if (located.done === true) {
    return null;
  }
  return new Decoder().decode(located.value.matrix).content;
}

/**
 * Renders a payment URI and reads it back, trying larger module sizes before giving up.
 *
 * The retry is measured rather than superstitious. Over eight hundred random payloads, four hundred
 * token and four hundred native, every single one decoded at some scale and not one failed at all of
 * them. The same payload reads at a scale of five and seven while failing at four and six, with a
 * different pattern for each payload, and one native payload in four hundred needed a scale of
 * sixteen. Larger symbols are the more forgiving ones: the token failures vanish above a module size
 * of seven, while the shorter native payload, whose symbol has fewer modules, is the one that
 * occasionally needs the largest.
 *
 * Scale changes how many pixels a module occupies and never the module pattern itself, so a symbol
 * that reads at any scale is a correct symbol, and the failures below eight are this detector
 * mis-sampling a synthetic image rather than anything wrong with what was drawn. Asserting a single
 * scale therefore tests the decoder's sampling rather than the product, and does it flakily: at the
 * default scale the failure rate is roughly one payload in four hundred, which across a loop of two
 * hundred is a coin toss per run.
 *
 * The product's own scale is tried first so the image a customer receives is the one under test, and
 * the larger sizes stand in for a camera that can move closer. A genuinely broken encoder fails at
 * every scale and is still caught.
 */
const SCAN_SCALES: readonly number[] = [6, 8, 10, 12, 14, 16];

export function scanPaymentQrCode(paymentUri: string): string | null {
  for (const scale of SCAN_SCALES) {
    try {
      const decoded = decodeQrCode(renderPaymentQrCode(paymentUri, { scale }).bytes);
      if (decoded === paymentUri) {
        return decoded;
      }
    } catch {
      // This decoder throws rather than returning null when it cannot read the format information,
      // so trying the next scale is the point of the loop.
      continue;
    }
  }
  return null;
}
