/**
 * A QR encoder written here rather than pulled from a package or an image host.
 *
 * The checkout must draw its code on the server, so that it is present with JavaScript disabled and
 * so no third party is shown the address a customer is about to send money to. Byte mode at error
 * correction level M: the payload is a lowercase URI, so alphanumeric mode cannot encode it, and
 * level M survives a phone camera held at an angle without inflating the module count.
 */

export interface QrMatrix {
  readonly size: number;
  /** Row-major, one entry per module. A one is a dark module. */
  readonly modules: Uint8Array;
}

class QrPayloadTooLongError extends Error {
  constructor(byteLength: number) {
    super(`A payload of ${byteLength.toString()} bytes does not fit a version 12 code`);
    this.name = 'QrPayloadTooLongError';
  }
}

const HIGHEST_VERSION = 12;

/** Level M, indexed by version minus one. Both tables are from the tables in ISO/IEC 18004. */
const ERROR_CORRECTION_CODEWORDS_PER_BLOCK: readonly number[] = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22,
];
const BLOCKS_PER_VERSION: readonly number[] = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8];

/** The primitive polynomial of the field the specification uses, x^8 + x^4 + x^3 + x^2 + 1. */
const FIELD_POLYNOMIAL = 285;
const FORMAT_GENERATOR = 0b101_0011_0111;
const FORMAT_MASK = 0b101_0100_0001_0010;
const VERSION_GENERATOR = 0b1_1111_0010_0101;
const FORMAT_BITS_LEVEL_M = 0b00;

const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER_LOOKALIKE = 40;
const PENALTY_IMBALANCE = 10;

function buildFieldTables(): { exponentials: Uint8Array; logarithms: Uint8Array } {
  const exponentials = new Uint8Array(256);
  const logarithms = new Uint8Array(256);
  let value = 1;
  for (let power = 0; power < 255; power += 1) {
    exponentials[power] = value;
    logarithms[value] = power;
    value <<= 1;
    if (value >= 256) {
      value ^= FIELD_POLYNOMIAL;
    }
  }
  return { exponentials, logarithms };
}

const FIELD = buildFieldTables();

function byteAt(values: Uint8Array, index: number): number {
  return values[index] ?? 0;
}

function numberAt(values: readonly number[], index: number): number {
  return values[index] ?? 0;
}

function multiplyInField(left: number, right: number): number {
  if (left === 0 || right === 0) {
    return 0;
  }
  const power = (byteAt(FIELD.logarithms, left) + byteAt(FIELD.logarithms, right)) % 255;
  return byteAt(FIELD.exponentials, power);
}

/** The divisor polynomial for `degree` error correction codewords, leading term omitted. */
function computeDivisor(degree: number): number[] {
  const divisor: number[] = Array.from({ length: degree }, (unused, index) =>
    index === degree - 1 ? 1 : 0,
  );
  let root = 1;
  for (let step = 0; step < degree; step += 1) {
    for (let index = 0; index < degree; index += 1) {
      divisor[index] = multiplyInField(numberAt(divisor, index), root);
      if (index + 1 < degree) {
        divisor[index] = numberAt(divisor, index) ^ numberAt(divisor, index + 1);
      }
    }
    root = multiplyInField(root, 2);
  }
  return divisor;
}

function computeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const remainder: number[] = Array.from({ length: divisor.length }, () => 0);
  for (const codeword of data) {
    const factor = codeword ^ numberAt(remainder, 0);
    remainder.shift();
    remainder.push(0);
    for (const [index, coefficient] of divisor.entries()) {
      remainder[index] = numberAt(remainder, index) ^ multiplyInField(coefficient, factor);
    }
  }
  return remainder;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) {
    return [];
  }
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let position = version * 4 + 10; positions.length < count; position -= step) {
    positions.splice(1, 0, position);
  }
  return positions;
}

function rawDataModules(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignmentCount = Math.floor(version / 7) + 2;
    modules -= (25 * alignmentCount - 10) * alignmentCount - 55;
  }
  if (version >= 7) {
    modules -= 36;
  }
  return modules;
}

function rawCodewordCount(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

function dataCodewordCount(version: number): number {
  const blocks = numberAt(BLOCKS_PER_VERSION, version - 1);
  const perBlock = numberAt(ERROR_CORRECTION_CODEWORDS_PER_BLOCK, version - 1);
  return rawCodewordCount(version) - blocks * perBlock;
}

function characterCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= HIGHEST_VERSION; version += 1) {
    const available = dataCodewordCount(version) * 8 - 4 - characterCountBits(version);
    if (byteLength * 8 <= available) {
      return version;
    }
  }
  throw new QrPayloadTooLongError(byteLength);
}

function appendBits(bits: number[], value: number, width: number): void {
  for (let position = width - 1; position >= 0; position -= 1) {
    bits.push((value >>> position) & 1);
  }
}

function toDataCodewords(payload: Uint8Array, version: number): number[] {
  const capacity = dataCodewordCount(version);
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, payload.length, characterCountBits(version));
  for (const value of payload) {
    appendBits(bits, value, 8);
  }

  appendBits(bits, 0, Math.min(4, capacity * 8 - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);

  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let offset = 0; offset < 8; offset += 1) {
      value = (value << 1) | numberAt(bits, index + offset);
    }
    codewords.push(value);
  }

  for (let index = 0; codewords.length < capacity; index += 1) {
    codewords.push(index % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

/** Splits the data into blocks, appends the error correction of each, and interleaves the result. */
function interleaveWithErrorCorrection(data: readonly number[], version: number): number[] {
  const blockCount = numberAt(BLOCKS_PER_VERSION, version - 1);
  const errorCorrectionLength = numberAt(ERROR_CORRECTION_CODEWORDS_PER_BLOCK, version - 1);
  const rawCodewords = rawCodewordCount(version);
  const shortBlockCount = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const divisor = computeDivisor(errorCorrectionLength);

  const blocks: number[][] = [];
  let consumed = 0;
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const dataLength =
      shortBlockLength - errorCorrectionLength + (blockIndex < shortBlockCount ? 0 : 1);
    const block = data.slice(consumed, consumed + dataLength);
    consumed += dataLength;
    const errorCorrection = computeRemainder(block, divisor);
    // A short block carries one filler slot so the interleave columns stay aligned.
    if (blockIndex < shortBlockCount) {
      block.push(0);
    }
    blocks.push([...block, ...errorCorrection]);
  }

  const fillerPosition = shortBlockLength - errorCorrectionLength;
  const interleaved: number[] = [];
  for (let position = 0; position <= shortBlockLength; position += 1) {
    interleaved.push(...interleaveColumn(blocks, position, fillerPosition, shortBlockCount));
  }
  return interleaved;
}

function interleaveColumn(
  blocks: readonly (readonly number[])[],
  position: number,
  fillerPosition: number,
  shortBlockCount: number,
): number[] {
  const column: number[] = [];
  for (const [blockIndex, block] of blocks.entries()) {
    const isFiller = position === fillerPosition && blockIndex < shortBlockCount;
    if (isFiller || position >= block.length) {
      continue;
    }
    column.push(numberAt(block, position));
  }
  return column;
}

/**
 * The module grid. State lives in the closure rather than on a passed-around record, so every write
 * goes through one of these methods and nothing reaches in to set a module directly.
 */
interface Grid {
  readonly size: number;
  readonly modules: Uint8Array;
  isDark(x: number, y: number): boolean;
  isReserved(x: number, y: number): boolean;
  paint(x: number, y: number, dark: boolean, reserve: boolean): void;
  invert(x: number, y: number): void;
  duplicate(): Grid;
}

function createGrid(size: number, seed: { dark: Uint8Array; reserved: Uint8Array } | null): Grid {
  const dark = seed === null ? new Uint8Array(size * size) : Uint8Array.from(seed.dark);
  const reserved = seed === null ? new Uint8Array(size * size) : Uint8Array.from(seed.reserved);
  const within = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < size && y < size;

  return {
    size,
    modules: dark,
    isDark: (x, y) => byteAt(dark, y * size + x) === 1,
    isReserved: (x, y) => byteAt(reserved, y * size + x) === 1,
    paint: (x, y, isDarkModule, reserve) => {
      if (!within(x, y)) {
        return;
      }
      dark[y * size + x] = isDarkModule ? 1 : 0;
      if (reserve) {
        reserved[y * size + x] = 1;
      }
    },
    invert: (x, y) => {
      dark[y * size + x] = byteAt(dark, y * size + x) === 1 ? 0 : 1;
    },
    duplicate: () => createGrid(size, { dark, reserved }),
  };
}

function drawFinderPattern(grid: Grid, centerX: number, centerY: number): void {
  for (let offsetY = -4; offsetY <= 4; offsetY += 1) {
    for (let offsetX = -4; offsetX <= 4; offsetX += 1) {
      const distance = Math.max(Math.abs(offsetX), Math.abs(offsetY));
      grid.paint(centerX + offsetX, centerY + offsetY, distance !== 2 && distance !== 4, true);
    }
  }
}

function drawAlignmentPattern(grid: Grid, centerX: number, centerY: number): void {
  for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      const distance = Math.max(Math.abs(offsetX), Math.abs(offsetY));
      grid.paint(centerX + offsetX, centerY + offsetY, distance !== 1, true);
    }
  }
}

function reserveFormatArea(grid: Grid): void {
  const last = grid.size - 1;
  // Row and column six carry the timing patterns, which run through the format region unbroken.
  for (let index = 0; index <= 8; index += 1) {
    if (index === 6) {
      continue;
    }
    grid.paint(index, 8, false, true);
    grid.paint(8, index, false, true);
  }
  for (let index = 0; index < 8; index += 1) {
    grid.paint(last - index, 8, false, true);
    grid.paint(8, last - index, false, true);
  }
}

/** BCH(15, 5), then the mask the specification applies so an all-zero format stays detectable. */
function formatInformation(mask: number): number {
  const data = (FORMAT_BITS_LEVEL_M << 3) | mask;
  let remainder = data;
  for (let step = 0; step < 10; step += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * FORMAT_GENERATOR);
  }
  return ((data << 10) | remainder) ^ FORMAT_MASK;
}

function versionInformation(version: number): number {
  let remainder = version;
  for (let step = 0; step < 12; step += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * VERSION_GENERATOR);
  }
  return (version << 12) | remainder;
}

function drawFormatBits(grid: Grid, mask: number): void {
  const bits = formatInformation(mask);
  const last = grid.size - 1;
  const bitAt = (index: number): boolean => ((bits >>> index) & 1) === 1;

  for (let index = 0; index <= 5; index += 1) {
    grid.paint(8, index, bitAt(index), true);
  }
  grid.paint(8, 7, bitAt(6), true);
  grid.paint(8, 8, bitAt(7), true);
  grid.paint(7, 8, bitAt(8), true);
  for (let index = 9; index < 15; index += 1) {
    grid.paint(14 - index, 8, bitAt(index), true);
  }

  for (let index = 0; index < 8; index += 1) {
    grid.paint(last - index, 8, bitAt(index), true);
  }
  for (let index = 8; index < 15; index += 1) {
    grid.paint(8, last - 14 + index, bitAt(index), true);
  }
  // The one module that is dark in every symbol ever produced.
  grid.paint(8, grid.size - 8, true, true);
}

/** Every alignment centre except the three the finder patterns already occupy. */
function alignmentCenters(version: number): { x: number; y: number }[] {
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  return positions.flatMap((y, rowIndex) =>
    positions
      .filter(
        (unused, columnIndex) =>
          !(
            (rowIndex === 0 && (columnIndex === 0 || columnIndex === last)) ||
            (rowIndex === last && columnIndex === 0)
          ),
      )
      .map((x) => ({ x, y })),
  );
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  for (let index = 0; index < grid.size; index += 1) {
    grid.paint(6, index, index % 2 === 0, true);
    grid.paint(index, 6, index % 2 === 0, true);
  }

  drawFinderPattern(grid, 3, 3);
  drawFinderPattern(grid, grid.size - 4, 3);
  drawFinderPattern(grid, 3, grid.size - 4);

  for (const center of alignmentCenters(version)) {
    drawAlignmentPattern(grid, center.x, center.y);
  }

  reserveFormatArea(grid);

  if (version >= 7) {
    const bits = versionInformation(version);
    for (let index = 0; index < 18; index += 1) {
      const dark = ((bits >>> index) & 1) === 1;
      const along = Math.floor(index / 3);
      const across = grid.size - 11 + (index % 3);
      grid.paint(across, along, dark, true);
      grid.paint(along, across, dark, true);
    }
  }
}

function drawCodewords(grid: Grid, codewords: readonly number[]): void {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;

  const placeNextBit = (x: number, y: number): void => {
    if (grid.isReserved(x, y) || bitIndex >= totalBits) {
      return;
    }
    const codeword = numberAt(codewords, bitIndex >>> 3);
    grid.paint(x, y, ((codeword >>> (7 - (bitIndex & 7))) & 1) === 1, false);
    bitIndex += 1;
  };

  for (let right = grid.size - 1; right >= 1; right -= 2) {
    // Column six is the vertical timing pattern, so the pair of columns shifts left around it and
    // every later pair shifts with it. Reading it as a one-off would visit one column twice.
    if (right === 6) {
      right = 5;
    }
    const upward = ((right + 1) & 2) === 0;
    for (let vertical = 0; vertical < grid.size; vertical += 1) {
      const y = upward ? grid.size - 1 - vertical : vertical;
      placeNextBit(right, y);
      placeNextBit(right - 1, y);
    }
  }
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMaskRow(grid: Grid, mask: number, y: number): void {
  for (let x = 0; x < grid.size; x += 1) {
    if (grid.isReserved(x, y) || !maskApplies(mask, x, y)) {
      continue;
    }
    grid.invert(x, y);
  }
}

function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < grid.size; y += 1) {
    applyMaskRow(grid, mask, y);
  }
}

function countFinderLookalikes(history: readonly number[]): number {
  const middle = numberAt(history, 1);
  const hasCore =
    middle > 0 &&
    numberAt(history, 2) === middle &&
    numberAt(history, 3) === middle * 3 &&
    numberAt(history, 4) === middle &&
    numberAt(history, 5) === middle;
  const leading = hasCore && numberAt(history, 0) >= middle * 4 && numberAt(history, 6) >= middle;
  const trailing = hasCore && numberAt(history, 6) >= middle * 4 && numberAt(history, 0) >= middle;
  return (leading ? 1 : 0) + (trailing ? 1 : 0);
}

function pushRun(history: number[], runLength: number, size: number): void {
  const padded = numberAt(history, 0) === 0 ? runLength + size : runLength;
  history.pop();
  history.unshift(padded);
}

function penaltyForLine(readModule: (position: number) => boolean, size: number): number {
  let penalty = 0;
  let runIsDark = false;
  let runLength = 0;
  const history = [0, 0, 0, 0, 0, 0, 0];

  for (let position = 0; position < size; position += 1) {
    const dark = readModule(position);
    if (dark === runIsDark) {
      runLength += 1;
      if (runLength === 5) {
        penalty += PENALTY_RUN;
      }
      if (runLength > 5) {
        penalty += 1;
      }
      continue;
    }
    pushRun(history, runLength, size);
    if (!runIsDark) {
      penalty += countFinderLookalikes(history) * PENALTY_FINDER_LOOKALIKE;
    }
    runIsDark = dark;
    runLength = 1;
  }

  let terminalRun = runLength;
  if (runIsDark) {
    pushRun(history, terminalRun, size);
    terminalRun = 0;
  }
  pushRun(history, terminalRun + size, size);
  return penalty + countFinderLookalikes(history) * PENALTY_FINDER_LOOKALIKE;
}

function penaltyScore(grid: Grid): number {
  let penalty = 0;

  for (let y = 0; y < grid.size; y += 1) {
    penalty += penaltyForLine((x) => grid.isDark(x, y), grid.size);
  }
  for (let x = 0; x < grid.size; x += 1) {
    penalty += penaltyForLine((y) => grid.isDark(x, y), grid.size);
  }

  for (let y = 0; y < grid.size - 1; y += 1) {
    for (let x = 0; x < grid.size - 1; x += 1) {
      const color = grid.isDark(x, y);
      if (
        color === grid.isDark(x + 1, y) &&
        color === grid.isDark(x, y + 1) &&
        color === grid.isDark(x + 1, y + 1)
      ) {
        penalty += PENALTY_BLOCK;
      }
    }
  }

  let darkModules = 0;
  for (const module of grid.modules) {
    darkModules += module;
  }
  const total = grid.size * grid.size;
  const deviation = Math.ceil(Math.abs(darkModules * 20 - total * 10) / total) - 1;
  return penalty + deviation * PENALTY_IMBALANCE;
}

export function encodeQrMatrix(text: string): QrMatrix {
  const payload = new TextEncoder().encode(text);
  const version = chooseVersion(payload.length);
  const codewords = interleaveWithErrorCorrection(toDataCodewords(payload, version), version);

  const size = version * 4 + 17;
  const base = createGrid(size, null);
  drawFunctionPatterns(base, version);
  drawCodewords(base, codewords);

  let best = base;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = base.duplicate();
    applyMask(candidate, mask);
    drawFormatBits(candidate, mask);
    const penalty = penaltyScore(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = candidate;
    }
  }

  return { size, modules: best.modules };
}
