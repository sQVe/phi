import { describe, expect, it } from 'bun:test';

import type { Terminal } from './vt.ts';
import { createTerminal } from './vt.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const openTerminal = (cols = 80, rows = 24) => {
  const created = createTerminal(cols, rows);

  if (!created.ok) {
    throw new Error(created.reason);
  }

  return created.terminal;
};

const writeChunks = (terminal: Terminal, chunks: string[]) =>
  chunks
    .map((chunk) => terminal.write(encoder.encode(chunk)))
    .map((reply) => (reply === undefined ? '' : decoder.decode(reply)))
    .join('');

const splits = (input: string) =>
  Array.from({ length: input.length - 1 }, (_, index) => [
    input.slice(0, index + 1),
    input.slice(index + 1),
  ]);

const cursorAtLastColumn = '\u001B[1;80Hx\u001B[6n';
const cursorAtBottomRight = '\u001B[999;999H\u001B[6n';

it('replies to a cursor position query on a new terminal', () => {
  using terminal = openTerminal();

  expect(decoder.decode(terminal.write(encoder.encode('\u001B[6n')))).toBe('\u001B[1;1R');
});

describe.each([
  ['cursor position', '\u001B[6n', '\u001B[1;1R'],
  ['status', '\u001B[5n', '\u001B[0n'],
  ['primary device attributes', '\u001B[c', '\u001B[?62;22c'],
  ['foreground color', '\u001B]10;?\u001B\\', '\u001B]10;rgb:ffff/ffff/ffff\u001B\\'],
  ['background color', '\u001B]11;?\u0007', '\u001B]11;rgb:0000/0000/0000\u0007'],
])('the %s query', (_name, query, reply) => {
  it('gets a reply', () => {
    using terminal = openTerminal();

    expect(writeChunks(terminal, [query])).toBe(reply);
  });

  it('gets a reply when split across two writes', () => {
    using terminal = openTerminal();

    for (const chunks of splits(query)) {
      expect({ chunks, reply: writeChunks(terminal, chunks) }).toEqual({ chunks, reply });
    }
  });
});

it('returns every reply when the replies exceed 64 KiB', () => {
  using terminal = openTerminal();
  const count = 8000;

  const replies = writeChunks(terminal, ['\u001B[c'.repeat(count)]);

  expect(replies.length).toBeGreaterThan(64 * 1024);
  expect(replies).toBe('\u001B[?62;22c'.repeat(count));
  expect(writeChunks(terminal, ['\u001B[5n'])).toBe('\u001B[0n');
});

describe.each([
  ['on', '\u001B[?40h'],
  ['off', '\u001B[?40l'],
])('with mode 40 %s', (_name, mode40) => {
  describe.each([
    ['set', '\u001B[?3h'],
    ['reset', '\u001B[?3l'],
  ])('DECCOLM %s', (_mode, deccolm) => {
    const input = `${mode40}\u001B[5;5Hhello${deccolm}`;

    it.each([
      ['a whole write', [input]],
      ['two writes', [input.slice(0, -2), input.slice(-2)]],
      ['byte-by-byte writes', input.split('')],
    ])('erases the screen, homes the cursor, and keeps 80x24 in %s', (_writes, chunks) => {
      using terminal = openTerminal();

      writeChunks(terminal, chunks);

      expect(terminal.text()).toBe('');
      expect(writeChunks(terminal, ['\u001B[6n'])).toBe('\u001B[1;1R');
      expect(writeChunks(terminal, [cursorAtLastColumn])).toBe('\u001B[1;80R');
      expect(writeChunks(terminal, [cursorAtBottomRight])).toBe('\u001B[24;80R');
    });

    it('resets the margins so origin mode homes to the first row', () => {
      using terminal = openTerminal();

      writeChunks(terminal, [`${mode40}\u001B[?69h\u001B[5;20r\u001B[10;40s\u001B[?6h${deccolm}X`]);

      expect(terminal.text()).toBe('X');
    });
  });
});

it('resizes the terminal', () => {
  using terminal = openTerminal();

  terminal.resize(100, 30);

  expect(writeChunks(terminal, [cursorAtBottomRight])).toBe('\u001B[30;100R');
});

it('returns the size report a resize sends with in-band resize reports on', () => {
  using terminal = openTerminal();

  writeChunks(terminal, ['\u001B[?2048h']);

  expect(decoder.decode(terminal.resize(100, 30))).toBe('\u001B[48;30;100;30;100t');
});

it('returns no reply from a resize with in-band resize reports off', () => {
  using terminal = openTerminal();

  expect(terminal.resize(100, 30)).toBeUndefined();
});

it('refuses a resize to zero columns and keeps the size', () => {
  using terminal = openTerminal();

  expect(() => terminal.resize(0, 30)).toThrow();
  expect(writeChunks(terminal, [cursorAtBottomRight])).toBe('\u001B[24;80R');
});

describe.each([
  ['columns past the u16 range', 65_537, 30],
  ['rows past the u16 range', 100, 65_537],
  ['fractional columns', 80.5, 30],
  ['negative rows', 100, -1],
])('with %s', (_name, cols, rows) => {
  it('refuses a resize and keeps the size', () => {
    using terminal = openTerminal();

    expect(() => terminal.resize(cols, rows)).toThrow();
    expect(writeChunks(terminal, [cursorAtBottomRight])).toBe('\u001B[24;80R');
  });

  it('refuses to create a terminal', () => {
    expect(() => createTerminal(cols, rows)).toThrow();
  });
});

it('returns the whole screen as text when it is larger than the first buffer', () => {
  using terminal = openTerminal(200, 60);
  const row = 'x'.repeat(200);

  writeChunks(terminal, [row.repeat(60)]);

  expect(terminal.text()).toBe(Array.from({ length: 60 }, () => row).join('\n'));
});

it('refuses a terminal without columns', () => {
  const created = createTerminal(0, 24);

  expect(created).toEqual({ ok: false, reason: 'terminal-refused' });
});

it('refuses a write after dispose', () => {
  const terminal = openTerminal();

  terminal[Symbol.dispose]();

  expect(() => terminal.write(encoder.encode('\u001B[6n'))).toThrow();
});
