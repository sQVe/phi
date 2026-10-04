import { describe, expect, it } from 'bun:test';

import type { Frame, StableRows, Terminal } from './vt.ts';
import { CellFlag, CellWidth, cellWidthMask, cellWords, createTerminal, ModeFlag } from './vt.ts';

interface Cell {
  text: string;
  foreground: number;
  background: number;
  flags: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const defaultScrollbackBytes = 10_000_000;

const openTerminal = (cols = 80, rows = 24, scrollbackBytes = defaultScrollbackBytes) => {
  const created = createTerminal(cols, rows, scrollbackBytes);

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

const readClusters = (graphemes: Uint32Array) => {
  const clusters = new Map<number, number[]>();

  for (let index = 0; index < graphemes.length;) {
    const cellIndex = graphemes[index] ?? 0;
    const length = graphemes[index + 1] ?? 0;

    clusters.set(cellIndex, [...graphemes.subarray(index + 2, index + 2 + length)]);
    index += 2 + length;
  }

  return clusters;
};

const readCell = (frame: Frame, clusters: Map<number, number[]>, index: number): Cell => {
  const codePoint = frame.cells[index] ?? 0;
  const codePoints = clusters.get(index) ?? (codePoint === 0 ? [] : [codePoint]);

  return {
    text: String.fromCodePoint(...codePoints),
    foreground: frame.cells[index + 1] ?? 0,
    background: frame.cells[index + 2] ?? 0,
    flags: frame.cells[index + 3] ?? 0,
  };
};

// Decodes a frame into its rows, keyed by viewport row.
const readRows = (frame: Frame, cols: number) => {
  const clusters = readClusters(frame.graphemes);
  const rowWords = 1 + cols * cellWords;

  return new Map(
    Array.from({ length: frame.rowCount }, (_, row) => {
      const offset = row * rowWords;

      const cells = Array.from({ length: cols }, (_unused, column) =>
        readCell(frame, clusters, offset + 1 + column * cellWords),
      );

      return [frame.cells[offset], cells] as const;
    }),
  );
};

// The CellWidth name of the cell's width bits.
const widthOf = (cell: Cell | undefined) => CellWidth[(cell?.flags ?? 0) & cellWidthMask];

const isSpacerTail = (cell: Cell) => widthOf(cell) === 'spacerTail';

const rowText = (cells: Cell[]) =>
  cells
    .filter((cell) => !isSpacerTail(cell))
    .map((cell) => (cell.text === '' ? ' ' : cell.text))
    .join('')
    .trimEnd();

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
    expect(() => createTerminal(cols, rows, defaultScrollbackBytes)).toThrow();
  });
});

it('returns the whole screen as text when it is larger than the first buffer', () => {
  using terminal = openTerminal(200, 60);
  const row = 'x'.repeat(200);

  writeChunks(terminal, [row.repeat(60)]);

  expect(terminal.text()).toBe(Array.from({ length: 60 }, () => row).join('\n'));
});

it('refuses a terminal without columns', () => {
  const created = createTerminal(0, 24, defaultScrollbackBytes);

  expect(created).toEqual({ ok: false, reason: 'terminal-refused' });
});

it('refuses a write after dispose', () => {
  const terminal = openTerminal();

  terminal[Symbol.dispose]();

  expect(() => terminal.write(encoder.encode('\u001B[6n'))).toThrow();
});

it('returns no rows from a frame with no write since the last frame', () => {
  using terminal = openTerminal();

  terminal.write(encoder.encode('hello'));
  terminal.frame();

  expect(terminal.frame().rowCount).toBe(0);
});

it('returns only the row a write changed', () => {
  using terminal = openTerminal();

  writeChunks(terminal, ['\u001B[4;1H']);
  terminal.frame();
  writeChunks(terminal, ['row three']);

  const rows = readRows(terminal.frame(), 80);

  expect([...rows.keys()]).toEqual([3]);
  expect(rowText(rows.get(3) ?? [])).toBe('row three');
});

it.each([
  ['bold', '\u001B[1m', CellFlag.bold],
  ['faint', '\u001B[2m', CellFlag.faint],
  ['italic', '\u001B[3m', CellFlag.italic],
  ['underline', '\u001B[4m', CellFlag.underline],
  ['inverse', '\u001B[7m', CellFlag.inverse],
])('returns a %s cell with its style flag', (_name, style, flag) => {
  using terminal = openTerminal();

  writeChunks(terminal, [`${style}S\u001B[0mT`]);

  const [styled, plain] = readRows(terminal.frame(), 80).get(0) ?? [];

  expect(styled).toEqual({ text: 'S', foreground: 0, background: 0, flags: flag });
  expect(plain).toEqual({ text: 'T', foreground: 0, background: 0, flags: 0 });
});

it('returns 256-color and 24-bit foreground colors', () => {
  using terminal = openTerminal();

  writeChunks(terminal, ['\u001B[38;5;196mP\u001B[38;2;10;20;30mR']);

  const [palette, rgb] = readRows(terminal.frame(), 80).get(0) ?? [];

  expect(palette).toEqual({ text: 'P', foreground: 197, background: 0, flags: 0 });

  expect(rgb).toEqual({
    text: 'R',
    foreground: 0x1_00_00_00 + 0x0a_14_1e,
    background: 0,
    flags: 0,
  });
});

it('returns a wide character as a wide cell followed by a spacer cell', () => {
  using terminal = openTerminal();

  writeChunks(terminal, ['漢']);

  const [wide, spacer] = readRows(terminal.frame(), 80).get(0) ?? [];

  expect(wide?.text).toBe('漢');
  expect(widthOf(wide)).toBe('wide');
  expect(widthOf(spacer)).toBe('spacerTail');
});

// Mode 2027 makes the terminal join an emoji ZWJ sequence into one cell.
it.each([
  ['a combining cluster', 'e\u0301'],
  ['an emoji ZWJ sequence', '\u{1F469}\u200D\u{1F4BB}'],
])('returns %s whole in one cell', (_name, cluster) => {
  using terminal = openTerminal();

  writeChunks(terminal, [`\u001B[?2027h${cluster}x`]);

  const cells = readRows(terminal.frame(), 80).get(0) ?? [];

  expect(cells[0]?.text).toBe(cluster);
  expect((cells[0]?.flags ?? 0) & CellFlag.grapheme).toBe(CellFlag.grapheme);
  expect(rowText(cells)).toBe(`${cluster}x`);
});

it('returns a whole screen of clusters that does not fit the first buffers', () => {
  using terminal = openTerminal();
  const cluster = 'e\u0301';

  writeChunks(terminal, [cluster.repeat(80 * 24)]);

  const frame = terminal.frame();
  const rows = readRows(frame, 80);
  const expected = Array.from({ length: 24 }, (_, row) => [row, cluster.repeat(80)]);

  expect(frame.graphemes.length).toBe(80 * 24 * 4);
  expect([...rows].map(([row, cells]) => [row, rowText(cells)])).toEqual(expected);
  expect(terminal.frame().rowCount).toBe(0);
});

it('returns every row of a screen larger than the first buffers', () => {
  using terminal = openTerminal(200, 60);
  const row = 'x'.repeat(200);

  writeChunks(terminal, [row.repeat(60)]);

  const rows = readRows(terminal.frame(), 200);
  const expected = Array.from({ length: 60 }, (_, index) => [index, row]);

  expect([...rows].map(([index, cells]) => [index, rowText(cells)])).toEqual(expected);
});

it('returns the cursor position and visibility', () => {
  using terminal = openTerminal();

  writeChunks(terminal, ['\u001B[5;10Habc']);

  expect(terminal.frame().cursor).toEqual({ x: 12, y: 4, visible: true });

  writeChunks(terminal, ['\u001B[?25l']);

  expect(terminal.frame().cursor).toEqual({ x: 12, y: 4, visible: false });
});

describe.each([
  ['application cursor keys', '\u001B[?1h', '\u001B[?1l', ModeFlag.applicationCursorKeys],
  ['bracketed paste', '\u001B[?2004h', '\u001B[?2004l', ModeFlag.bracketedPaste],
  ['alternate screen', '\u001B[?1049h', '\u001B[?1049l', ModeFlag.alternateScreen],
  ['X10 mouse', '\u001B[?9h', '\u001B[?9l', ModeFlag.x10Mouse],
  ['normal mouse', '\u001B[?1000h', '\u001B[?1000l', ModeFlag.normalMouse],
  ['button mouse', '\u001B[?1002h', '\u001B[?1002l', ModeFlag.buttonMouse],
  ['any mouse', '\u001B[?1003h', '\u001B[?1003l', ModeFlag.anyMouse],
  ['SGR mouse', '\u001B[?1006h', '\u001B[?1006l', ModeFlag.sgrMouse],
])('the %s mode', (_name, set, reset, flag) => {
  it('reads on after its set sequence and off after its reset sequence', () => {
    using terminal = openTerminal();

    expect(terminal.frame().modes).toBe(0);

    writeChunks(terminal, [set]);

    expect(terminal.frame().modes).toBe(flag);

    writeChunks(terminal, [reset]);

    expect(terminal.frame().modes).toBe(0);
  });
});

it('returns every row after markAllDirty', () => {
  using terminal = openTerminal();

  writeChunks(terminal, ['hello']);
  terminal.frame();
  terminal.markAllDirty();

  const rows = readRows(terminal.frame(), 80);

  expect([...rows.keys()]).toEqual(Array.from({ length: 24 }, (_, row) => row));
  expect(rowText(rows.get(0) ?? [])).toBe('hello');
});

it('keeps the epoch and moves the active top one row per scrolled line', () => {
  using terminal = openTerminal();
  const first = terminal.stableRows();

  const reads = Array.from({ length: 30 }, (_, line) => {
    terminal.write(encoder.encode(`line ${line}\r\n`));

    return terminal.stableRows();
  });

  expect(reads.map((read) => read.epoch)).toEqual(reads.map(() => first.epoch));

  expect(reads.map((read) => read.activeTop)).toEqual(
    reads.map((_, line) => first.activeTop + Math.max(0, line - 22)),
  );
});

const numberedLines = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `line ${from + index}\r\n`).join('');

// Screen rows from the oldest history row, each labeled with the number its line had when written.
const expectLinesNumbered = (terminal: Terminal, start: StableRows) => {
  const { first } = terminal.stableRows();
  const lines = terminal.text().split('\n');

  expect(lines.length).toBeGreaterThan(1);
  expect(lines).toEqual(lines.map((_, y) => `line ${first + y - start.first}`));
};

it('keeps the number of each row while rows scroll into history', () => {
  using terminal = openTerminal();
  const start = terminal.stableRows();

  const numbers = Array.from({ length: 60 }, (_, line) => {
    terminal.write(encoder.encode(numberedLines(line, 1)));

    const { activeTop } = terminal.stableRows();
    const { cursor } = terminal.frame();

    return activeTop + cursor.y - 1;
  });

  const end = terminal.stableRows();

  expect(numbers).toEqual(numbers.map((_, line) => start.first + line));
  expect(end.first).toBe(start.first);
  expect(end.epoch).toBe(start.epoch);
  expectLinesNumbered(terminal, start);
});

it('keeps the numbers of surviving rows and the epoch when history is pruned', () => {
  using terminal = openTerminal(80, 24, 1);
  const start = terminal.stableRows();
  const epochs = new Set<number>();

  for (let line = 0; line < 20_000; line += 100) {
    terminal.write(encoder.encode(numberedLines(line, 100)));
    epochs.add(terminal.stableRows().epoch);
  }

  const end = terminal.stableRows();

  expect([...epochs]).toEqual([start.epoch]);
  expect(end.first).toBeGreaterThan(start.first);
  expect(end.activeTop - end.first).toBe(terminal.scrollback().rows);
  expectLinesNumbered(terminal, start);
});

it('changes the epoch and numbers rows above every earlier number after a burst larger than the history', () => {
  using terminal = openTerminal(80, 24, 1);

  terminal.write(encoder.encode(numberedLines(0, 100)));

  const before = terminal.stableRows();

  terminal.write(encoder.encode(numberedLines(100, 20_000)));

  const after = terminal.stableRows();

  expect(after.epoch).not.toBe(before.epoch);
  expect(after.first).toBeGreaterThan(before.activeTop + 23);
});

it('changes the epoch on a resize', () => {
  using terminal = openTerminal();

  terminal.write(encoder.encode(numberedLines(0, 40)));

  const before = terminal.stableRows();

  terminal.resize(60, 20);

  expect(terminal.stableRows().epoch).not.toBe(before.epoch);
});

it('changes the epoch on a reset', () => {
  using terminal = openTerminal();

  terminal.write(encoder.encode(numberedLines(0, 40)));

  const before = terminal.stableRows();

  terminal.write(encoder.encode('\u001Bc'));

  expect(terminal.stableRows().epoch).not.toBe(before.epoch);
});

it('reports the alternate screen and returns the primary numbers after leaving it', () => {
  using terminal = openTerminal();

  terminal.write(encoder.encode(numberedLines(0, 40)));

  const primary = terminal.stableRows();

  terminal.write(encoder.encode(`\u001B[?1049h${numberedLines(0, 40)}`));

  const alternate = terminal.stableRows();

  terminal.write(encoder.encode('\u001B[?1049l'));

  expect(alternate).toEqual({
    first: primary.activeTop,
    activeTop: primary.activeTop,
    epoch: primary.epoch,
    alternate: true,
  });

  expect(terminal.stableRows()).toEqual(primary);
});

it('reports no history on the alternate screen and the primary history after leaving it', () => {
  using terminal = openTerminal();

  terminal.write(encoder.encode(numberedLines(0, 40)));

  const primary = terminal.scrollback().rows;

  terminal.write(encoder.encode('\u001B[?1049h'));

  const alternate = terminal.scrollback().rows;

  terminal.write(encoder.encode('\u001B[?1049l'));

  expect(primary).toBeGreaterThan(0);
  expect(alternate).toBe(0);
  expect(terminal.scrollback().rows).toBe(primary);
});

// libghostty-vt rounds the limit down to whole pages, so the pages never use more than the limit.
it('keeps the memory of retained history within the limit after writing ten times the limit', () => {
  const limitBytes = 4_000_000;
  using terminal = openTerminal(80, 24, limitBytes);
  const chunk = encoder.encode(`${'x'.repeat(78)}\r\n`.repeat(1000));
  const used: number[] = [];

  for (let written = 0; written < limitBytes * 10; written += chunk.length) {
    terminal.write(chunk);
    terminal.stableRows();
    used.push(terminal.scrollback().usedBytes);
  }

  const { rows, limitBytes: reportedLimit } = terminal.scrollback();

  expect(Math.max(...used)).toBeLessThanOrEqual(limitBytes);
  expect(Math.max(...used)).toBeGreaterThan(limitBytes / 2);
  expect(rows).toBeGreaterThan(0);
  expect(reportedLimit).toBe(limitBytes);
});

it.each([
  ['a negative', -1],
  ['a fractional', 0.5],
])('refuses %s scrollback limit', (_name, scrollbackBytes) => {
  expect(() => createTerminal(80, 24, scrollbackBytes)).toThrow();
});
