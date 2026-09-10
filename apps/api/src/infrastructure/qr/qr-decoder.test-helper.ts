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
 * Renders a payment URI and reads it back, trying other module sizes before giving up.
 *
 * Scale changes how many pixels a module occupies and never the module pattern, so a symbol that
 * reads at any size is a correct symbol, and a size at which it does not read is this detector
 * mis-sampling a synthetic image. Trying several stands in for a camera that can move closer, and it
 * is what makes the fixed examples reliable rather than a coin toss: at a single size roughly one
 * payload in a few hundred is not read.
 *
 * The sizes span both parities on evidence. The list was six even numbers, and a payload turned up
 * that failed at every one of them while reading correctly at 5, 7, 9, 11, 13 and 15: failures are
 * scattered, but for a given payload they correlate, so sampling one parity can miss a symbol that
 * is fine.
 *
 * What this does not do is guarantee a read. Payloads exist that this decoder will not read at any
 * size tried, and with only one decoder available here there is no way to tell such a symbol being
 * malformed from this decoder refusing a symbol that is fine. That limit is why the round-trip
 * corpus is derived from a fixed seed rather than drawn fresh: a failure has to name an input
 * somebody can render again and decide about.
 *
 * The product's own scale is tried first so the image a customer receives is the one under test. A
 * genuinely broken encoder fails at every size and is still caught.
 */
const SCAN_SCALES: readonly number[] = [6, 7, 8, 9, 11, 13, 15, 16];

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
