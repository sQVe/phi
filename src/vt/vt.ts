import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi';

// A compiled binary embeds the library and dlopen reads the embedded path. From source this is the
// path of the built file.
import libraryPath from '../../build/libphi-vt.so' with { type: 'file' };
import { invariant } from '../invariant.ts';
import { cellWords } from '../rows/rows.ts';

export type CreateTerminalResult =
  | { ok: true; terminal: Terminal }
  | { ok: false; reason: 'library-missing'; detail: string }
  | { ok: false; reason: 'terminal-refused' };

export type GhosttyCommitResult =
  | { ok: true; commit: string }
  | { ok: false; reason: 'library-missing'; detail: string };

// Numbers of primary-screen rows. A number stays with its row until the epoch changes.
export interface StableRows {
  // The number of the oldest history row.
  first: number;
  // The number of the active screen's top row.
  activeTop: number;
  epoch: number;
  // The alternate screen has no history, so while it is active both numbers stay at the primary
  // screen's active top.
  alternate: boolean;
}

export interface Scrollback {
  // History rows the active screen retains. The alternate screen has none, so this is 0 while it
  // is active.
  rows: number;
  limitBytes: number;
  // Memory the primary screen's pages use, history and active screen together.
  usedBytes: number;
}

export interface Frame {
  // The number of rows in cells.
  rowCount: number;
  // Each changed row as one word with its viewport row, then cellWords words per column.
  cells: Uint32Array;
  // Each cluster longer than one code point as one word with the index in cells of its cell's
  // code point, one word with its length, then its code points, base first.
  graphemes: Uint32Array;
  cursor: { x: number; y: number; visible: boolean };
  // The ModeFlag bits that are on.
  modes: number;
}

// Rows read by their stable numbers, in the layout of Frame.cells and Frame.graphemes, except
// that each row's first word is its offset from the first row read.
export interface RowRange {
  rowCount: number;
  cells: Uint32Array;
  graphemes: Uint32Array;
}

// pruned: the first row asked for is gone from the history, or is in the primary screen's history
// while the alternate screen is active.
export type ReadRowsResult =
  | { ok: true; rows: RowRange }
  | { ok: false; reason: 'staleEpoch' }
  | { ok: false; reason: 'pruned' };

// An 80x24 screen of ASCII text fits in one pass.
const firstTextBufferBytes = 4096;

// pane_resize returns this when libghostty-vt refuses the size.
const resizeRefused = -2;

// pane_frame returns these instead of a row count.
const frameDoesNotFit = -1;

const frameUpdateFailed = -2;

// pane_read_rows returns these instead of a row count. It shares frameDoesNotFit.
const readRowsStaleEpoch = -2;

const readRowsPruned = -3;

const readRowsFailed = -4;

const maxRowCount = 0xff_ff_ff_ff;

const firstFrameColumns = 80;

const firstFrameRows = 24;

// A whole screen of the first frame size without clusters fits the first buffers.
const firstCellWords = firstFrameRows * (1 + firstFrameColumns * cellWords);

const firstGraphemeWords = 1024;

const frameInfoWords = 6;

// Frame.graphemes holds each cell index in one 32-bit word, so a frame has at most this many cell
// words.
const maxFrameWords = 0xff_ff_ff_ff;

const stableRowsWords = 4;

const scrollbackWords = 3;

// Two words for each of the 256 palette slots and the default foreground and background.
const maxColorWords = 516;

const maxDimension = 65_535;

const largestColor = 0xff_ff_ff;

const paletteSize = 16;

const isColor = (value: number) => Number.isInteger(value) && value >= 0 && value <= largestColor;

// The FFI passes sizes as u16 and would wrap anything outside that range to another size.
const fitsDimension = (value: number) =>
  Number.isInteger(value) && value >= 0 && value <= maxDimension;

const assertDimensions = (cols: number, rows: number) => {
  invariant(fitsDimension(cols), `Terminal columns must be an integer in 0..65535, got ${cols}.`);
  invariant(fitsDimension(rows), `Terminal rows must be an integer in 0..65535, got ${rows}.`);
};

const assertScrollbackBytes = (scrollbackBytes: number) => {
  invariant(
    Number.isSafeInteger(scrollbackBytes) && scrollbackBytes >= 0,
    `The scrollback limit must be a whole number of bytes, got ${scrollbackBytes}.`,
  );
};

const assertRowNumber = (value: number, name: string) => {
  invariant(
    Number.isSafeInteger(value) && value >= 0,
    `The ${name} must be a whole number, got ${value}.`,
  );
};

const grown = (buffer: Uint32Array<ArrayBuffer>, wordsNeeded: number) =>
  wordsNeeded > buffer.length ? new Uint32Array(wordsNeeded) : buffer;

// info starts with the cell words a read needed.
const grownCells = (cells: Uint32Array<ArrayBuffer>, info: BigUint64Array) => {
  const wordsNeeded = Number(info[0]);

  invariant(
    wordsNeeded <= maxFrameWords,
    `A read of ${wordsNeeded} cell words cannot index its cells with 32-bit words.`,
  );

  return grown(cells, wordsNeeded);
};

const loadLibrary = () =>
  dlopen(libraryPath, {
    pane_new: { args: [FFIType.u16, FFIType.u16, FFIType.u64], returns: FFIType.ptr },
    pane_free: { args: [FFIType.ptr], returns: FFIType.void },
    pane_write: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    pane_reply: { args: [FFIType.ptr], returns: FFIType.ptr },
    pane_clear_reply: { args: [FFIType.ptr], returns: FFIType.void },
    pane_resize: { args: [FFIType.ptr, FFIType.u16, FFIType.u16], returns: FFIType.i64 },
    pane_text: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    pane_frame: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    pane_read_rows: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.u64,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
      ],
      returns: FFIType.i64,
    },
    pane_mark_all_dirty: { args: [FFIType.ptr], returns: FFIType.void },
    pane_render_held: { args: [FFIType.ptr], returns: FFIType.bool },
    pane_end_render_hold: { args: [FFIType.ptr], returns: FFIType.void },
    pane_stable_rows: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    pane_scrollback: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    pane_colors: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    pane_set_default_colors: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    shim_ghostty_commit: { args: [], returns: FFIType.cstring },
  }).symbols;

type Symbols = ReturnType<typeof loadLibrary>;

type Handle = NonNullable<ReturnType<ReturnType<typeof loadLibrary>['pane_new']>>;

let library: Symbols | undefined;

// Owns one libghostty-vt terminal. The terminal answers queries such as DSR and DA with replies
// that the caller sends back to the program.
export class Terminal {
  private handle: Handle | undefined;

  private cells = new Uint32Array(firstCellWords);

  private graphemes = new Uint32Array(firstGraphemeWords);

  // Cell words used, grapheme words used, cursor x, cursor y, cursor visible, and mode bits.
  private readonly frameInfo = new BigUint64Array(frameInfoWords);

  // Rows read by number use their own arrays, so a read does not overwrite the last frame.
  private rangeCells = new Uint32Array(firstCellWords);

  private rangeGraphemes = new Uint32Array(firstGraphemeWords);

  // Cell words and grapheme words the last range read needed.
  private readonly rangeInfo = new BigUint64Array(2);

  private readonly stableRowsInfo = new BigUint64Array(stableRowsWords);

  private readonly colorWords = new Uint32Array(maxColorWords);

  private readonly scrollbackInfo = new BigUint64Array(scrollbackWords);

  constructor(
    private readonly symbols: Symbols,
    handle: Handle,
  ) {
    this.handle = handle;
  }

  private live(): Handle {
    invariant(this.handle !== undefined, 'The terminal was used after dispose.');

    return this.handle;
  }

  private takeReply(handle: Handle, length: number): Uint8Array | undefined {
    invariant(length >= 0, 'libghostty-vt could not hold a reply in memory.');

    if (length === 0) {
      return undefined;
    }

    const replyPointer = this.symbols.pane_reply(handle);

    invariant(replyPointer !== null, 'libghostty-vt reported a reply without a buffer.');

    const reply = new Uint8Array(toArrayBuffer(replyPointer, 0, length)).slice();

    this.symbols.pane_clear_reply(handle);

    return reply;
  }

  write(bytes: Uint8Array): Uint8Array | undefined {
    const handle = this.live();
    const length = Number(this.symbols.pane_write(handle, bytes, bytes.length));

    return this.takeReply(handle, length);
  }

  resize(cols: number, rows: number): Uint8Array | undefined {
    assertDimensions(cols, rows);

    const handle = this.live();
    const length = Number(this.symbols.pane_resize(handle, cols, rows));

    invariant(
      length !== resizeRefused,
      `libghostty-vt refused to resize the terminal to ${cols}x${rows}.`,
    );

    return this.takeReply(handle, length);
  }

  // Returns the history and the active screen as plain text, with trailing spaces trimmed.
  text(): string {
    const handle = this.live();

    for (let buffer = new Uint8Array(firstTextBufferBytes); ;) {
      const length = Number(this.symbols.pane_text(handle, buffer, buffer.length));

      invariant(length >= 0, 'libghostty-vt could not format the screen.');

      if (length <= buffer.length) {
        return new TextDecoder().decode(buffer.subarray(0, length));
      }

      buffer = new Uint8Array(length);
    }
  }

  // Returns the rows that changed since the last frame. The next frame reuses the arrays. During a
  // render hold it returns rows and the cursor from the frame captured when the hold began.
  frame(): Frame {
    const handle = this.live();

    for (;;) {
      const rowCount = this.symbols.pane_frame(
        handle,
        this.cells,
        this.cells.length,
        this.graphemes,
        this.graphemes.length,
        this.frameInfo,
      );

      invariant(rowCount !== frameUpdateFailed, 'libghostty-vt could not update the render state.');

      if (rowCount !== frameDoesNotFit) {
        return this.readFrame(rowCount);
      }

      this.growFrameBuffers();
    }
  }

  // The next frame returns every row.
  markAllDirty(): void {
    this.symbols.pane_mark_all_dirty(this.live());
  }

  // Whether synchronized output holds the frame. Does not consume dirty rows.
  renderHeld(): boolean {
    return this.symbols.pane_render_held(this.live());
  }

  // Turns off synchronized output, so the next frame shows the screen as it is.
  endRenderHold(): void {
    this.symbols.pane_end_render_hold(this.live());
  }

  // Numbers rows by following the active top from the last call, so the server must call this
  // after every write, also while no client reads rows. Otherwise a burst larger than the history
  // loses the row it follows, and the epoch changes.
  stableRows(): StableRows {
    const tracked = this.symbols.pane_stable_rows(this.live(), this.stableRowsInfo);

    invariant(tracked, 'libghostty-vt could not track the active screen top.');

    const [first = 0n, activeTop = 0n, epoch = 0n, alternate] = this.stableRowsInfo;

    return {
      first: Number(first),
      activeTop: Number(activeTop),
      epoch: Number(epoch),
      alternate: alternate === 1n,
    };
  }

  // Reads up to count rows from the row numbered first in epoch, as stableRows numbers them. It
  // stops at the last row. Unlike frame, it leaves dirty rows dirty, and it returns new arrays.
  readRows(epoch: number, first: number, count: number): ReadRowsResult {
    assertRowNumber(epoch, 'epoch');
    assertRowNumber(first, 'first row number');

    invariant(
      Number.isInteger(count) && count >= 0 && count <= maxRowCount,
      `A row count must be an integer in 0..${maxRowCount}, got ${count}.`,
    );

    const handle = this.live();

    for (;;) {
      const rowCount = Number(
        this.symbols.pane_read_rows(
          handle,
          BigInt(epoch),
          BigInt(first),
          count,
          this.rangeCells,
          this.rangeCells.length,
          this.rangeGraphemes,
          this.rangeGraphemes.length,
          this.rangeInfo,
        ),
      );

      invariant(rowCount !== readRowsFailed, 'libghostty-vt could not read the rows.');

      if (rowCount === readRowsStaleEpoch) {
        return { ok: false, reason: 'staleEpoch' };
      }

      if (rowCount === readRowsPruned) {
        return { ok: false, reason: 'pruned' };
      }

      if (rowCount !== frameDoesNotFit) {
        return { ok: true, rows: this.copyRange(rowCount) };
      }

      this.growRangeBuffers();
    }
  }

  scrollback(): Scrollback {
    this.symbols.pane_scrollback(this.live(), this.scrollbackInfo);

    const [rows = 0n, limitBytes = 0n, usedBytes = 0n] = this.scrollbackInfo;

    return { rows: Number(rows), limitBytes: Number(limitBytes), usedBytes: Number(usedBytes) };
  }

  // The colors the program set with OSC 4, 10, and 11, as two words for each: the slot, then
  // the color as 0x1000000 plus the 0xRRGGBB value. Slots 0-255 are palette indexes, and
  // defaultForegroundSlot and defaultBackgroundSlot are the default colors. A color set to its
  // default value is listed too.
  colors(): Uint32Array {
    const words = Number(this.symbols.pane_colors(this.live(), this.colorWords));

    return this.colorWords.slice(0, words);
  }

  // Sets the colors that OSC 4, 10, and 11 queries answer and that cells without a color use, as
  // 0xRRGGBB numbers: the foreground, the background, and palette indexes 0-15. Colors a program
  // set stay in place and do not show in colors().
  setDefaultColors(foreground: number, background: number, palette: readonly number[]): void {
    invariant(
      palette.length === paletteSize,
      `Palette must have ${paletteSize} colors, got ${palette.length}.`,
    );

    const colors = [foreground, background, ...palette];

    for (const color of colors) {
      invariant(isColor(color), `Color must be an integer in 0..0xffffff, got ${color}.`);
    }

    this.symbols.pane_set_default_colors(this.live(), Uint32Array.from(colors));
  }

  private growFrameBuffers(): void {
    this.cells = grownCells(this.cells, this.frameInfo);
    this.graphemes = grown(this.graphemes, Number(this.frameInfo[1]));
  }

  private growRangeBuffers(): void {
    this.rangeCells = grownCells(this.rangeCells, this.rangeInfo);
    this.rangeGraphemes = grown(this.rangeGraphemes, Number(this.rangeInfo[1]));
  }

  private copyRange(rowCount: number): RowRange {
    const [cellWordsUsed = 0n, graphemeWordsUsed = 0n] = this.rangeInfo;

    return {
      rowCount,
      cells: this.rangeCells.slice(0, Number(cellWordsUsed)),
      graphemes: this.rangeGraphemes.slice(0, Number(graphemeWordsUsed)),
    };
  }

  private readFrame(rowCount: number): Frame {
    const [
      cellWordsUsed = 0n,
      graphemeWordsUsed = 0n,
      cursorX = 0n,
      cursorY = 0n,
      cursorVisible,
      modes = 0n,
    ] = this.frameInfo;

    return {
      rowCount,
      cells: this.cells.subarray(0, Number(cellWordsUsed)),
      graphemes: this.graphemes.subarray(0, Number(graphemeWordsUsed)),
      cursor: { x: Number(cursorX), y: Number(cursorY), visible: cursorVisible === 1n },
      modes: Number(modes),
    };
  }

  [Symbol.dispose](): void {
    if (this.handle === undefined) {
      return;
    }

    this.symbols.pane_free(this.handle);
    this.handle = undefined;
  }
}

const openLibrary = (): Symbols | string => {
  try {
    library ??= loadLibrary();

    return library;
  } catch (error) {
    return String(error);
  }
};

// scrollbackBytes caps the memory the history holds. libghostty-vt prunes whole pages, so the
// history can hold more than the limit.
export const createTerminal = (
  cols: number,
  rows: number,
  scrollbackBytes: number,
): CreateTerminalResult => {
  assertDimensions(cols, rows);
  assertScrollbackBytes(scrollbackBytes);

  const symbols = openLibrary();

  if (typeof symbols === 'string') {
    return { ok: false, reason: 'library-missing', detail: symbols };
  }

  const handle = symbols.pane_new(cols, rows, scrollbackBytes);

  if (handle === null) {
    return { ok: false, reason: 'terminal-refused' };
  }

  return { ok: true, terminal: new Terminal(symbols, handle) };
};

export const ghosttyCommit = (): GhosttyCommitResult => {
  const symbols = openLibrary();

  if (typeof symbols === 'string') {
    return { ok: false, reason: 'library-missing', detail: symbols };
  }

  const commit = symbols.shim_ghostty_commit();

  invariant(commit !== null, 'The shim returned no Ghostty commit.');

  return { ok: true, commit };
};
