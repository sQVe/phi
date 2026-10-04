import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi';
import { fileURLToPath } from 'node:url';

import { invariant } from '../invariant.ts';

export type CreateTerminalResult =
  | { ok: true; terminal: Terminal }
  | { ok: false; reason: 'library-missing'; detail: string }
  | { ok: false; reason: 'terminal-refused' };

// An 80x24 screen of ASCII text fits in one pass.
const firstTextBufferBytes = 4096;

const libraryPath = fileURLToPath(new URL('../../build/libphi-vt.so', import.meta.url));

const loadLibrary = () =>
  dlopen(libraryPath, {
    pane_new: { args: [FFIType.u16, FFIType.u16], returns: FFIType.ptr },
    pane_free: { args: [FFIType.ptr], returns: FFIType.void },
    pane_write: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    pane_reply: { args: [FFIType.ptr], returns: FFIType.ptr },
    pane_clear_reply: { args: [FFIType.ptr], returns: FFIType.void },
    pane_resize: { args: [FFIType.ptr, FFIType.u16, FFIType.u16], returns: FFIType.void },
    pane_text: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  }).symbols;

type Symbols = ReturnType<typeof loadLibrary>;

type Handle = NonNullable<ReturnType<ReturnType<typeof loadLibrary>['pane_new']>>;

let library: Symbols | undefined;

// Owns one libghostty-vt terminal. The terminal answers queries such as DSR and DA with replies
// that the caller sends back to the program.
export class Terminal {
  private handle: Handle | undefined;

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

  // Parses program output and returns every reply the terminal sent while parsing it, if any.
  write(bytes: Uint8Array): Uint8Array | undefined {
    const handle = this.live();
    const length = Number(this.symbols.pane_write(handle, bytes, bytes.length));

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

  resize(cols: number, rows: number): void {
    this.symbols.pane_resize(this.live(), cols, rows);
  }

  // Returns the active screen as plain text, with trailing spaces trimmed.
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

export const createTerminal = (cols: number, rows: number): CreateTerminalResult => {
  const symbols = openLibrary();

  if (typeof symbols === 'string') {
    return { ok: false, reason: 'library-missing', detail: symbols };
  }

  const handle = symbols.pane_new(cols, rows);

  if (handle === null) {
    return { ok: false, reason: 'terminal-refused' };
  }

  return { ok: true, terminal: new Terminal(symbols, handle) };
};
