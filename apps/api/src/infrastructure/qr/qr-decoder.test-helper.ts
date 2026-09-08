import { binarize, Decoder, Detector, grayscale } from '@nuintun/qrcode';
import { PNG } from 'pngjs';

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
