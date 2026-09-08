import { deflateSync } from 'node:zlib';

/**
 * A minimal PNG writer for the one image this service produces: a square, two-tone QR code.
 *
 * Greyscale at 8 bits with no filtering, which is the smallest encoder that is still a conformant
 * PNG. A general image library would be several megabytes of dependency for a picture that has two
 * colours, and every byte of it would sit in the dependency surface of a service that moves money.
 *
 * The output is verified by decoding it, not by inspecting it: the test reads these bytes back with
 * an independent PNG reader and an independent QR decoder and compares the recovered text to the
 * payment URI that went in.
 */

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_POLYNOMIAL = 0xed_b8_83_20;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let entry = 0; entry < 256; entry += 1) {
    let remainder = entry;
    for (let bit = 0; bit < 8; bit += 1) {
      const isOdd = (remainder & 1) === 1;
      remainder = isOdd ? CRC_POLYNOMIAL ^ (remainder >>> 1) : remainder >>> 1;
    }
    table[entry] = remainder >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let remainder = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    remainder = (CRC_TABLE[(remainder ^ byte) & 0xff] ?? 0) ^ (remainder >>> 8);
  }
  return (remainder ^ 0xff_ff_ff_ff) >>> 0;
}

/**
 * A PNG chunk is length, type, payload, then a CRC over the type and payload but not the length.
 * Getting the allocation wrong by even a few bytes appends trailing content that a lenient reader
 * ignores and a strict one rejects, so the size is derived rather than written twice.
 */
function encodeChunk(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + payload.length);
  body.set(typeBytes, 0);
  body.set(payload, typeBytes.length);

  const chunk = new Uint8Array(4 + body.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length);
  chunk.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return chunk;
}

const BIT_DEPTH_EIGHT = 8;
const COLOUR_TYPE_GREYSCALE = 0;

function encodeHeader(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = BIT_DEPTH_EIGHT;
  header[9] = COLOUR_TYPE_GREYSCALE;
  return header;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * `pixels` is one byte per pixel in row-major order, 0 for black and 255 for white.
 */
export function encodeGreyscalePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  if (pixels.length !== width * height) {
    throw new Error(
      `Expected ${width * height} pixels for ${width}x${height}, got ${pixels.length}`,
    );
  }

  // Every PNG scanline carries a leading filter byte. Zero means the row is stored as-is, which for
  // large flat runs of one colour costs nothing once deflate has seen them.
  const scanlines = new Uint8Array((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const source = pixels.subarray(row * width, (row + 1) * width);
    scanlines.set(source, row * (width + 1) + 1);
  }

  const compressed = new Uint8Array(deflateSync(scanlines, { level: 9 }));
  return concatenate([
    PNG_SIGNATURE,
    encodeChunk('IHDR', encodeHeader(width, height)),
    encodeChunk('IDAT', compressed),
    encodeChunk('IEND', new Uint8Array(0)),
  ]);
}
