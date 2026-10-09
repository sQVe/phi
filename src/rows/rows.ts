import { invariant } from '../invariant.ts';

// Changed rows of one pane. cells and graphemes use the layout of a vt frame, so the server sends
// a frame without converting it.
export interface RowUpdate {
  pane: number;
  sequence: number;
  size: { columns: number; rows: number };
  cursor: { x: number; y: number; visible: boolean };
  // The ModeFlag bits that are on.
  modes: number;
  epoch: number;
  // The stable number of the oldest history row.
  first: number;
  // The stable number of the active screen's top row.
  activeTop: number;
  rowCount: number;
  // Each row as one signed 32-bit word with its offset from the active top, negative for a row
  // that left the screen, then cellWords words per column. Read the offset with `| 0`.
  cells: Uint32Array;
  // Each cluster longer than one code point as one word with the index in cells of its cell's
  // code point, one word with its length, then its code points, base first.
  graphemes: Uint32Array;
  // The colors the program changed, as pairs of a slot (a palette index, defaultForegroundSlot, or
  // defaultBackgroundSlot) and 0x1000000 plus the 0xRRGGBB color. Every update has the full list.
  colors: Uint32Array;
}

type TextRows = Pick<RowUpdate, 'rowCount' | 'cells' | 'graphemes'>;

export type DecodeRowUpdateResult =
  | { ok: true; update: RowUpdate }
  | { ok: false; reason: 'wrongLength' }
  | { ok: false; reason: 'rowNumberTooLarge' }
  | { ok: false; reason: 'rowCountMismatch' }
  | { ok: false; reason: 'graphemePastEnd' }
  | { ok: false; reason: 'graphemePastCells' }
  | { ok: false; reason: 'graphemeOffCell' }
  | { ok: false; reason: 'graphemeTooShort' }
  | { ok: false; reason: 'colorPastEnd' }
  | { ok: false; reason: 'colorSlotInvalid' }
  | { ok: false; reason: 'colorInvalid' };

// Raw bytes for a pane's PTY.
export interface PaneInput {
  pane: number;
  bytes: Uint8Array;
}

export type DecodePaneInputResult =
  | { ok: true; input: PaneInput }
  | { ok: false; reason: 'wrongLength' };

type GraphemeProblem =
  | 'graphemePastEnd'
  | 'graphemePastCells'
  | 'graphemeOffCell'
  | 'graphemeTooShort';

// Words per cell in a row: the base code point, the foreground color, the background color, and
// the CellFlag and CellWidth bits. A color is 0 for the default color, 1-256 for a palette index
// plus 1, and 0x1000000 plus the 0xRRGGBB value for an RGB color.
export const cellWords = 4;

// Color slots beside the 256 palette indexes: the default foreground and background.
export const defaultForegroundSlot = 256;

export const defaultBackgroundSlot = 257;

// Bits of a cell's flags word.
export enum CellFlag {
  bold = 0x1,
  faint = 0x2,
  italic = 0x4,
  underline = 0x8,
  inverse = 0x10,
  // The cell's whole cluster is in the graphemes.
  grapheme = 0x1_00_00,
}

// A cell's width is its flags word masked with cellWidthMask. A wide character's cell is followed
// by a spacer tail cell. A spacer head ends a row whose wide character wrapped to the next row.
export enum CellWidth {
  narrow = 0,
  wide = 0x1_00,
  spacerTail = 0x2_00,
  spacerHead = 0x3_00,
}

export const cellWidthMask = 0x3_00;

// Bits of a pane's input modes.
export enum ModeFlag {
  applicationCursorKeys = 0x1,
  bracketedPaste = 0x2,
  x10Mouse = 0x4,
  normalMouse = 0x8,
  buttonMouse = 0x10,
  anyMouse = 0x20,
  sgrMouse = 0x40,
  alternateScreen = 0x80,
  // A render hold, such as synchronized output (mode 2026), keeps the frame the program last
  // finished. The terminal has no clock, so the caller ends a hold that lasts too long with
  // endRenderHold.
  renderHeld = 0x1_00,
}

// Messages are 32-bit words in the host's byte order. The server and its clients share one host.
const wordBytes = 4;

// Header words of a row update. A row number takes two words: the low 32 bits, then the rest. The
// header is followed by the color words, the cell words, then the grapheme words.
const header = {
  pane: 0,
  sequence: 1,
  columns: 2,
  rows: 3,
  cursorX: 4,
  cursorY: 5,
  cursorVisible: 6,
  modes: 7,
  epoch: 8,
  first: 9,
  activeTop: 11,
  rowCount: 13,
  colorCount: 14,
};

const headerWords = 15;

const colorMarker = 0x1_00_00_00;

const colorMask = 0xff_ff_ff;

const lowWordRange = 0x1_00_00_00_00;

// The high word of a row number below 2^53.
const maxHighWord = 0x1f_ff_ff;

const maxWord = 0xff_ff_ff_ff;

const fitsWord = (value: number) => Number.isInteger(value) && value >= 0 && value <= maxWord;

const assertWord = (value: number, name: string) => {
  invariant(fitsWord(value), `The ${name} must be an integer in 0..${maxWord}, got ${value}.`);
};

const assertRowNumber = (value: number, name: string) => {
  invariant(
    Number.isSafeInteger(value) && value >= 0,
    `The ${name} must be a whole number below 2^53, got ${value}.`,
  );
};

const isColorWord = (word: number) => (word & ~colorMask) >>> 0 === colorMarker;

const colorProblem = (colors: Uint32Array): 'colorSlotInvalid' | 'colorInvalid' | undefined => {
  for (let index = 0; index < colors.length; index += 2) {
    if ((colors[index] ?? 0) > defaultBackgroundSlot) {
      return 'colorSlotInvalid';
    }

    if (!isColorWord(colors[index + 1] ?? 0)) {
      return 'colorInvalid';
    }
  }

  return undefined;
};

const rowWords = (columns: number) => 1 + columns * cellWords;

const cellFlagsOffset = 3;

const clustersOf = (graphemes: Uint32Array): Map<number, string> => {
  const clusters = new Map<number, string>();

  for (let index = 0; index < graphemes.length;) {
    const cellIndex = graphemes[index] ?? 0;
    const length = graphemes[index + 1] ?? 0;
    const codePoints = graphemes.subarray(index + 2, index + 2 + length);

    clusters.set(cellIndex, String.fromCodePoint(...codePoints));
    index += 2 + length;
  }

  return clusters;
};

export const rowsToText = (range: TextRows, columns: number): string[] => {
  const clusters = clustersOf(range.graphemes);
  const rows: string[] = [];

  for (let row = 0; row < range.rowCount; row += 1) {
    let text = '';

    for (let column = 0; column < columns; column += 1) {
      const index = row * rowWords(columns) + 1 + column * cellWords;
      const width: CellWidth = (range.cells[index + cellFlagsOffset] ?? 0) & cellWidthMask;

      if (width === CellWidth.spacerHead || width === CellWidth.spacerTail) {
        continue;
      }

      const codePoint = range.cells[index] ?? 0;
      const character = codePoint === 0 ? ' ' : String.fromCodePoint(codePoint);
      const cluster = clusters.get(index) ?? character;

      text += cluster;
    }

    rows.push(text.replace(/ +$/, ''));
  }

  return rows;
};

const writeRowNumber = (words: Uint32Array, index: number, value: number) => {
  words[index] = value % lowWordRange;
  words[index + 1] = Math.floor(value / lowWordRange);
};

const readRowNumber = (words: Uint32Array, index: number) =>
  (words[index] ?? 0) + (words[index + 1] ?? 0) * lowWordRange;

const rowNumbersFit = (words: Uint32Array) =>
  (words[header.first + 1] ?? 0) <= maxHighWord &&
  (words[header.activeTop + 1] ?? 0) <= maxHighWord;

// Copies the bytes into aligned words. The caller may reuse its buffer after decoding.
const wordsOf = (bytes: Uint8Array) => {
  const words = new Uint32Array(bytes.length / wordBytes);

  new Uint8Array(words.buffer).set(bytes);

  return words;
};

const assertRowUpdate = (update: RowUpdate) => {
  assertWord(update.pane, 'pane number');
  assertWord(update.sequence, 'sequence number');
  assertWord(update.size.columns, 'column count');
  assertWord(update.size.rows, 'row count of the screen');
  assertWord(update.cursor.x, 'cursor x');
  assertWord(update.cursor.y, 'cursor y');
  assertWord(update.modes, 'mode bits');
  assertWord(update.epoch, 'epoch');
  assertRowNumber(update.first, 'first row number');
  assertRowNumber(update.activeTop, 'active top row number');
  assertWord(update.rowCount, 'row count');

  invariant(update.colors.length % 2 === 0, 'The colors must be pairs of a slot and a color.');

  const problem = colorProblem(update.colors);

  invariant(problem === undefined, `The colors are invalid: ${problem}.`);

  invariant(
    update.cells.length === update.rowCount * rowWords(update.size.columns),
    `${update.rowCount} rows of ${update.size.columns} columns do not fill ${update.cells.length} cell words.`,
  );
};

export const rowUpdateBytes = (update: RowUpdate): number =>
  (headerWords + update.cells.length + update.graphemes.length) * Uint32Array.BYTES_PER_ELEMENT;

export const encodeRowUpdate = (update: RowUpdate): Uint8Array => {
  assertRowUpdate(update);

  const words = new Uint32Array(
    headerWords + update.colors.length + update.cells.length + update.graphemes.length,
  );

  words[header.pane] = update.pane;
  words[header.sequence] = update.sequence;
  words[header.columns] = update.size.columns;
  words[header.rows] = update.size.rows;
  words[header.cursorX] = update.cursor.x;
  words[header.cursorY] = update.cursor.y;
  words[header.cursorVisible] = update.cursor.visible ? 1 : 0;
  words[header.modes] = update.modes;
  words[header.epoch] = update.epoch;
  writeRowNumber(words, header.first, update.first);
  writeRowNumber(words, header.activeTop, update.activeTop);
  words[header.rowCount] = update.rowCount;
  words[header.colorCount] = update.colors.length;

  const cellStart = headerWords + update.colors.length;

  words.set(update.colors, headerWords);
  words.set(update.cells, cellStart);
  words.set(update.graphemes, cellStart + update.cells.length);

  return new Uint8Array(words.buffer);
};

// A cluster's index must name the code point word of a cell in cells.
const graphemeProblem = (
  graphemes: Uint32Array,
  cellCount: number,
  columns: number,
): GraphemeProblem | undefined => {
  for (let index = 0; index < graphemes.length;) {
    if (index + 2 > graphemes.length) {
      return 'graphemePastEnd';
    }

    const cellIndex = graphemes[index] ?? 0;
    const length = graphemes[index + 1] ?? 0;
    const end = index + 2 + length;

    if (length < 2) {
      return 'graphemeTooShort';
    }

    if (end > graphemes.length) {
      return 'graphemePastEnd';
    }

    if (cellIndex >= cellCount) {
      return 'graphemePastCells';
    }

    if ((cellIndex % rowWords(columns)) % cellWords !== 1) {
      return 'graphemeOffCell';
    }

    index = end;
  }

  return undefined;
};

const readRowUpdate = (words: Uint32Array, colorCount: number, cellCount: number): RowUpdate => ({
  pane: words[header.pane] ?? 0,
  sequence: words[header.sequence] ?? 0,
  size: { columns: words[header.columns] ?? 0, rows: words[header.rows] ?? 0 },
  cursor: {
    x: words[header.cursorX] ?? 0,
    y: words[header.cursorY] ?? 0,
    visible: words[header.cursorVisible] === 1,
  },
  modes: words[header.modes] ?? 0,
  epoch: words[header.epoch] ?? 0,
  first: readRowNumber(words, header.first),
  activeTop: readRowNumber(words, header.activeTop),
  rowCount: words[header.rowCount] ?? 0,
  colors: words.subarray(headerWords, headerWords + colorCount),
  cells: words.subarray(headerWords + colorCount, headerWords + colorCount + cellCount),
  graphemes: words.subarray(headerWords + colorCount + cellCount),
});

// Returns an error for bytes the peer got wrong. It never throws.
export const decodeRowUpdate = (bytes: Uint8Array): DecodeRowUpdateResult => {
  if (bytes.length % wordBytes !== 0) {
    return { ok: false, reason: 'wrongLength' };
  }

  if (bytes.length < headerWords * wordBytes) {
    return { ok: false, reason: 'wrongLength' };
  }

  const words = wordsOf(bytes);

  if (!rowNumbersFit(words)) {
    return { ok: false, reason: 'rowNumberTooLarge' };
  }

  const colorCount = words[header.colorCount] ?? 0;

  if (colorCount % 2 !== 0 || headerWords + colorCount > words.length) {
    return { ok: false, reason: 'colorPastEnd' };
  }

  const colors = words.subarray(headerWords, headerWords + colorCount);
  const colorFault = colorProblem(colors);

  if (colorFault !== undefined) {
    return { ok: false, reason: colorFault };
  }

  const columns = words[header.columns] ?? 0;
  const cellCount = (words[header.rowCount] ?? 0) * rowWords(columns);
  const cellStart = headerWords + colorCount;

  if (cellStart + cellCount > words.length) {
    return { ok: false, reason: 'rowCountMismatch' };
  }

  const graphemes = words.subarray(cellStart + cellCount);
  const problem = graphemeProblem(graphemes, cellCount, columns);

  if (problem !== undefined) {
    return { ok: false, reason: problem };
  }

  return { ok: true, update: readRowUpdate(words, colorCount, cellCount) };
};

export const encodePaneInput = (input: PaneInput): Uint8Array => {
  assertWord(input.pane, 'pane number');

  const bytes = new Uint8Array(wordBytes + input.bytes.length);

  new Uint32Array(bytes.buffer, 0, 1)[0] = input.pane;
  bytes.set(input.bytes, wordBytes);

  return bytes;
};

// Returns an error for bytes the peer got wrong. It never throws.
export const decodePaneInput = (bytes: Uint8Array): DecodePaneInputResult => {
  if (bytes.length < wordBytes) {
    return { ok: false, reason: 'wrongLength' };
  }

  const pane = wordsOf(bytes.subarray(0, wordBytes))[0] ?? 0;

  return { ok: true, input: { pane, bytes: bytes.slice(wordBytes) } };
};
