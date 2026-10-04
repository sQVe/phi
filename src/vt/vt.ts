import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi';

// A compiled binary embeds the library and dlopen reads the embedded path. From source this is the
// path of the built file.
import libraryPath from '../../build/libphi-vt.so' with { type: 'file' };
import { invariant } from '../invariant.ts';

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
  // Each changed row as one word with its viewport row, then cellWords words per column: the
  // base code point, the foreground color, the background color, and the CellFlag and CellWidth
  // bits. A color is 0 for the default color, 1-256 for a palette index plus 1, and 0x1000000
  // plus the 0xRRGGBB value for an RGB color.
  cells: Uint32Array;
  // Each cluster longer than one code point as one word with the index in cells of its cell's
  // code point, one word with its length, then its code points, base first.
  graphemes: Uint32Array;
  cursor: { x: number; y: number; visible: boolean };
  // The ModeFlag bits that are on.
  modes: number;
}

// An 80x24 screen of ASCII text fits in one pass.
const firstTextBufferBytes = 4096;

// pane_resize returns this when libghostty-vt refuses the size.
const resizeRefused = -2;

// Words per cell in Frame.cells.
export const cellWords = 4;

// Bits of a cell's flags word.
export enum CellFlag {
  bold = 0x1,
  faint = 0x2,
  italic = 0x4,
  underline = 0x8,
  inverse = 0x10,
  // The cell's whole cluster is in Frame.graphemes.
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

// Bits of Frame.modes.
export enum ModeFlag {
  applicationCursorKeys = 0x1,
  bracketedPaste = 0x2,
  x10Mouse = 0x4,
  normalMouse = 0x8,
  buttonMouse = 0x10,
  anyMouse = 0x20,
  sgrMouse = 0x40,
  alternateScreen = 0x80,
}

// pane_frame returns these instead of a row count.
const frameDoesNotFit = -1;

const frameUpdateFailed = -2;

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

const maxDimension = 65_535;

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
    pane_mark_all_dirty: { args: [FFIType.ptr], returns: FFIType.void },
    pane_stable_rows: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    pane_scrollback: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
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

  private readonly stableRowsInfo = new BigUint64Array(stableRowsWords);

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

  // Returns the rows that changed since the last frame. The next frame reuses the arrays.
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

  scrollback(): Scrollback {
    this.symbols.pane_scrollback(this.live(), this.scrollbackInfo);

    const [rows = 0n, limitBytes = 0n, usedBytes = 0n] = this.scrollbackInfo;

    return { rows: Number(rows), limitBytes: Number(limitBytes), usedBytes: Number(usedBytes) };
  }

  private growFrameBuffers(): void {
    const cellWordsNeeded = Number(this.frameInfo[0]);
    const graphemeWordsNeeded = Number(this.frameInfo[1]);

    invariant(
      cellWordsNeeded <= maxFrameWords,
      `A frame of ${cellWordsNeeded} cell words cannot index its cells with 32-bit words.`,
    );

    if (cellWordsNeeded > this.cells.length) {
      this.cells = new Uint32Array(cellWordsNeeded);
    }

    if (graphemeWordsNeeded > this.graphemes.length) {
      this.graphemes = new Uint32Array(graphemeWordsNeeded);
    }
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
