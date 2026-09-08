import qrcode from 'qrcode-generator';

import { encodeGreyscalePng } from './png-writer.js';

/**
 * Turns a payment URI into a scannable image.
 *
 * This module knows nothing about any blockchain, and that is the point: each network adapter builds
 * its own payment URI, and the only thing that happens here is drawing a string. If a chain-specific
 * branch ever appears in this file, the adapter above it is incomplete.
 *
 * Error correction level M recovers roughly 15% of the symbol. Level L makes a smaller image that a
 * scuffed phone screen at an angle fails to read, and a payment nobody can scan is worth less than a
 * few hundred extra bytes.
 */

const ERROR_CORRECTION_LEVEL = 'M';

/** Four modules of white on every side. Below four, scanners lose the symbol against the page. */
const QUIET_ZONE_MODULES = 4;

const WHITE = 255;
const BLACK = 0;

export interface QrCodeImage {
  readonly bytes: Uint8Array;
  readonly dataUri: string;
  readonly widthInPixels: number;
  readonly moduleCount: number;
}

export interface QrCodeOptions {
  /** Pixels per QR module. Six keeps a dense Solana Pay URI readable on a phone screen. */
  readonly scale?: number;
}

const DEFAULT_SCALE = 6;
const MAXIMUM_SCALE = 16;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Paints one QR module as a `scale` by `scale` block, offset by the quiet zone. */
function paintModule(
  pixels: Uint8Array,
  widthInPixels: number,
  scale: number,
  row: number,
  column: number,
): void {
  const left = (column + QUIET_ZONE_MODULES) * scale;
  for (let line = 0; line < scale; line += 1) {
    const start = ((row + QUIET_ZONE_MODULES) * scale + line) * widthInPixels + left;
    pixels.fill(BLACK, start, start + scale);
  }
}

export function renderPaymentQrCode(paymentUri: string, options: QrCodeOptions = {}): QrCodeImage {
  if (paymentUri.length === 0) {
    throw new Error('A payment URI is required to render a QR code');
  }
  const scale = options.scale ?? DEFAULT_SCALE;
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > MAXIMUM_SCALE) {
    throw new Error(`QR scale must be an integer between 1 and ${MAXIMUM_SCALE}, got ${scale}`);
  }

  // Type number 0 asks the encoder to pick the smallest symbol that fits. Byte mode is stated rather
  // than inferred: a URI that happened to be all uppercase would otherwise be encoded as
  // alphanumeric, which cannot represent the lowercase and mixed-case forms the next one will have.
  const symbol = qrcode(0, ERROR_CORRECTION_LEVEL);
  symbol.addData(paymentUri, 'Byte');
  symbol.make();

  const moduleCount = symbol.getModuleCount();
  const widthInModules = moduleCount + QUIET_ZONE_MODULES * 2;
  const widthInPixels = widthInModules * scale;

  const pixels = new Uint8Array(widthInPixels * widthInPixels).fill(WHITE);
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (symbol.isDark(row, column)) {
        paintModule(pixels, widthInPixels, scale, row, column);
      }
    }
  }

  const bytes = encodeGreyscalePng(pixels, widthInPixels, widthInPixels);
  return {
    bytes,
    dataUri: `data:image/png;base64,${toBase64(bytes)}`,
    widthInPixels,
    moduleCount,
  };
}
