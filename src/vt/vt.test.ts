import { describe, expect, it } from 'bun:test';

import {
  CellFlag,
  CellWidth,
  cellWidthMask,
  cellWords,
  defaultBackgroundSlot,
  defaultForegroundSlot,
  ModeFlag,
} from '../rows/rows.ts';
import type { Frame, StableRows, Terminal } from './vt.ts';
import { createTerminal } from './vt.ts';

type DecodedRows = Pick<Frame, 'cells' | 'graphemes' | 'rowCount'>;

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

const writesOf = (input: string) =>
  [
    ['a whole write', [input]],
    ['two writes', [input.slice(0, -2), input.slice(-2)]],
    ['byte-by-byte writes', input.split('')],
  ] as const;

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

const readCell = (frame: DecodedRows, clusters: Map<number, number[]>, index: number): Cell => {
  const codePoint = frame.cells[index] ?? 0;
  const codePoints = clusters.get(index) ?? (codePoint === 0 ? [] : [codePoint]);

  return {
    text: String.fromCodePoint(...codePoints),
    foreground: frame.cells[index + 1] ?? 0,
    background: frame.cells[index + 2] ?? 0,
    flags: frame.cells[index + 3] ?? 0,
  };
};

// Decodes a frame or a row range into its rows, keyed by the word before each row.
const decodeRows = (frame: DecodedRows, cols: number) => {
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

const rowTexts = (rows: DecodedRows, cols = 80) =>
  [...decodeRows(rows, cols).values()].map((cells) => rowText(cells));

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
  ['set', '\u001B[?3h'],
  ['reset', '\u001B[?3l'],
])('DECCOLM %s', (_mode, deccolm) => {
  describe('with mode 40 off', () => {
    const before = '\u001B[?40l\u001B[5;5Hhello';

    it.each(writesOf(`${before}${deccolm}`))(
      'leaves the screen and the cursor untouched in %s',
      (_writes, chunks) => {
        using terminal = openTerminal();
        using untouched = openTerminal();

        writeChunks(terminal, [...chunks]);
        writeChunks(untouched, [before]);

        expect(terminal.text()).toBe(untouched.text());
        expect(writeChunks(terminal, ['\u001B[6n'])).toBe('\u001B[5;10R');
      },
    );
  });

  describe('with mode 40 on', () => {
    it.each(writesOf(`\u001B[?40h\u001B[5;5Hhello${deccolm}`))(
      'erases the screen, homes the cursor, and keeps 80x24 in %s',
      (_writes, chunks) => {
        using terminal = openTerminal();

        writeChunks(terminal, [...chunks]);

        expect(terminal.text()).toBe('');
        expect(writeChunks(terminal, ['\u001B[6n'])).toBe('\u001B[1;1R');
        expect(writeChunks(terminal, [cursorAtLastColumn])).toBe('\u001B[1;80R');
        expect(writeChunks(terminal, [cursorAtBottomRight])).toBe('\u001B[24;80R');
      },
    );

    it('resets the margins so origin mode homes to the first row', () => {
      using terminal = openTerminal();

      writeChunks(terminal, [
        `\u001B[?40h\u001B[?69h\u001B[5;20r\u001B[10;40s\u001B[?6h${deccolm}X`,
      ]);

      expect(terminal.text()).toBe('X');
    });
  });
});

it('reports the 132 column mode a program asked for with mode 40 on', () => {
  using terminal = openTerminal();

  expect(writeChunks(terminal, ['\u001B[?40h\u001B[?3h\u001B[?3$p'])).toBe('\u001B[?3;1$y');
  expect(writeChunks(terminal, ['\u001B[?3l\u001B[?3$p'])).toBe('\u001B[?3;2$y');
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

  const rows = decodeRows(terminal.frame(), 80);

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

  const [styled, plain] = decodeRows(terminal.frame(), 80).get(0) ?? [];

  expect(styled).toEqual({ text: 'S', foreground: 0, background: 0, flags: flag });
  expect(plain).toEqual({ text: 'T', foreground: 0, background: 0, flags: 0 });
});

it('returns 256-color and 24-bit foreground colors', () => {
  using terminal = openTerminal();

  writeChunks(terminal, ['\u001B[38;5;196mP\u001B[38;2;10;20;30mR']);

  const [palette, rgb] = decodeRows(terminal.frame(), 80).get(0) ?? [];

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

  const [wide, spacer] = decodeRows(terminal.frame(), 80).get(0) ?? [];

  expect(wide?.text).toBe('漢');
  expect(widthOf(wide)).toBe('wide');
  expect(widthOf(spacer)).toBe('spacerTail');
});

it.each([
  ['a combining cluster', 'e\u0301'],
  ['an emoji ZWJ sequence', '\u{1F469}\u200D\u{1F4BB}'],
])('returns %s whole in one cell on a new terminal', (_name, cluster) => {
  using terminal = openTerminal();

  writeChunks(terminal, [`${cluster}x`]);

  const cells = decodeRows(terminal.frame(), 80).get(0) ?? [];

  expect(cells[0]?.text).toBe(cluster);
  expect((cells[0]?.flags ?? 0) & CellFlag.grapheme).toBe(CellFlag.grapheme);
  expect(rowText(cells)).toBe(`${cluster}x`);
});

it('splits an emoji ZWJ sequence into cells after a program turns off grapheme clustering', () => {
  using terminal = openTerminal();
  const cluster = '\u{1F469}\u200D\u{1F4BB}';

  writeChunks(terminal, [`\u001B[?2027l${cluster}x`]);

  const cells = decodeRows(terminal.frame(), 80).get(0) ?? [];

  expect(cells[0]?.text).not.toBe(cluster);
  expect(rowText(cells)).toBe(`${cluster}x`);
});

it('returns a whole screen of clusters that does not fit the first buffers', () => {
  using terminal = openTerminal();
  const cluster = 'e\u0301';

  writeChunks(terminal, [cluster.repeat(80 * 24)]);

  const frame = terminal.frame();
  const rows = decodeRows(frame, 80);
  const expected = Array.from({ length: 24 }, (_, row) => [row, cluster.repeat(80)]);

  expect(frame.graphemes.length).toBe(80 * 24 * 4);
  expect([...rows].map(([row, cells]) => [row, rowText(cells)])).toEqual(expected);
  expect(terminal.frame().rowCount).toBe(0);
});

it('returns every row of a screen larger than the first buffers', () => {
  using terminal = openTerminal(200, 60);
  const row = 'x'.repeat(200);

  writeChunks(terminal, [row.repeat(60)]);

  const rows = decodeRows(terminal.frame(), 200);
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

  const rows = decodeRows(terminal.frame(), 80);

  expect([...rows.keys()]).toEqual(Array.from({ length: 24 }, (_, row) => row));
  expect(rowText(rows.get(0) ?? [])).toBe('hello');
});

const isHeld = (frame: Frame) => (frame.modes & ModeFlag.renderHeld) !== 0;

describe('a render hold', () => {
  const startHold = '\u001B[?2026h';
  const endHold = '\u001B[?2026l';
  const clearScreen = '\u001B[2J\u001B[H';

  it('hides a redraw split across two writes until the program ends the hold', () => {
    using terminal = openTerminal();

    writeChunks(terminal, ['old']);
    terminal.frame();
    writeChunks(terminal, [`${startHold}${clearScreen}new`]);

    const during = terminal.frame();

    expect(during.rowCount).toBe(0);
    expect(isHeld(during)).toBe(true);

    writeChunks(terminal, [`\r\nfinished${endHold}`]);

    const after = terminal.frame();

    expect(rowTexts(after).slice(0, 2)).toEqual(['new', 'finished']);
    expect(isHeld(after)).toBe(false);
  });

  it('returns the frame from the start of the hold when the hold starts in the middle of a write', () => {
    using terminal = openTerminal();

    writeChunks(terminal, [`old${startHold}${clearScreen}new\r\nhalf`]);

    const frame = terminal.frame();

    expect(rowText(decodeRows(frame, 80).get(0) ?? [])).toBe('old');
    expect(rowTexts(frame)).not.toContain('half');
    expect(frame.cursor).toEqual({ x: 3, y: 0, visible: true });
  });

  it.each([
    ['a full reset', (terminal: Terminal) => writeChunks(terminal, ['\u001Bcdone'])],
    ['a resize', (terminal: Terminal) => terminal.resize(80, 25)],
  ])('shows the screen as it is after %s ends the hold', (_name, end) => {
    using terminal = openTerminal();

    writeChunks(terminal, [`${startHold}${clearScreen}done`]);
    terminal.frame();
    end(terminal);

    const frame = terminal.frame();

    expect(rowText(decodeRows(frame, 80).get(0) ?? [])).toBe('done');
    expect(isHeld(frame)).toBe(false);
  });

  it('shows the screen as it is after endRenderHold ends a hold the program never ends', () => {
    using terminal = openTerminal();

    writeChunks(terminal, [`${startHold}${clearScreen}stuck`]);
    terminal.frame();
    terminal.endRenderHold();

    const frame = terminal.frame();

    expect(rowText(decodeRows(frame, 80).get(0) ?? [])).toBe('stuck');
    expect(isHeld(frame)).toBe(false);
  });

  it('holds again when the program starts a new hold after endRenderHold', () => {
    using terminal = openTerminal();

    writeChunks(terminal, [startHold]);
    terminal.endRenderHold();
    terminal.frame();
    writeChunks(terminal, [`${startHold}${clearScreen}next`]);

    const frame = terminal.frame();

    expect(frame.rowCount).toBe(0);
    expect(isHeld(frame)).toBe(true);
  });

  it('returns every row of the captured frame after markAllDirty', () => {
    using terminal = openTerminal();

    writeChunks(terminal, ['old']);
    terminal.frame();
    writeChunks(terminal, [`${startHold}${clearScreen}new`]);
    terminal.markAllDirty();

    const frame = terminal.frame();
    const rows = decodeRows(frame, 80);

    expect([...rows.keys()]).toEqual(Array.from({ length: 24 }, (_, row) => row));
    expect(rowText(rows.get(0) ?? [])).toBe('old');
    expect(rowTexts(frame)).not.toContain('new');
  });
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

it('changes the epoch once when one write bursts past the history and enters the alternate screen', () => {
  using terminal = openTerminal(80, 24, 1);

  terminal.write(encoder.encode(numberedLines(0, 100)));

  const before = terminal.stableRows();

  terminal.write(encoder.encode(`${numberedLines(100, 20_000)}\u001B[?1049h`));

  const alternate = terminal.stableRows();
  const again = terminal.stableRows();

  terminal.write(encoder.encode('\u001B[?1049l'));

  const primary = terminal.stableRows();

  expect(alternate.epoch).not.toBe(before.epoch);
  expect(alternate.activeTop).toBeGreaterThan(before.activeTop + 23);
  expect(again).toEqual(alternate);
  expect(primary).toEqual({ ...alternate, first: primary.first, alternate: false });
});

it.each([
  ['a reset', (terminal: Terminal) => terminal.write(encoder.encode('\u001BcNEW'))],
  ['a resize', (terminal: Terminal) => terminal.resize(70, 20)],
])('changes the epoch on %s after the anchor is lost on the alternate screen', (_name, change) => {
  using terminal = openTerminal(80, 24, 1);

  terminal.write(encoder.encode(numberedLines(0, 100)));
  terminal.stableRows();
  terminal.write(encoder.encode(`${numberedLines(100, 20_000)}\u001B[?1049hOLD`));

  const alternate = terminal.stableRows();

  change(terminal);

  const after = terminal.stableRows();

  expect(after.epoch).not.toBe(alternate.epoch);

  expect(terminal.readRows(alternate.epoch, alternate.activeTop, 1)).toEqual({
    ok: false,
    reason: 'staleEpoch',
  });
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

// With a limit of many pages, libghostty-vt keeps whole pages within it, so the pages never use
// more than the limit.
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

it('reads a row that scrolled into history by its stable number', () => {
  using terminal = openTerminal();
  const { epoch } = terminal.stableRows();

  terminal.write(encoder.encode(numberedLines(1, 50)));

  const read = terminal.readRows(epoch, 0, 1);

  expect(read.ok && rowTexts(read.rows)).toEqual(['line 1']);
});

// Rows from the oldest history row to the last screen row.
const readAllRows = (terminal: Terminal) => {
  const { epoch, first } = terminal.stableRows();
  const read = terminal.readRows(epoch, first, 0xff_ff_ff_ff);

  if (!read.ok) {
    throw new Error(read.reason);
  }

  return read.rows;
};

const textLines = (terminal: Terminal) => terminal.text().split('\n');

it('returns the same rows twice and leaves dirty rows for the next frame', () => {
  using terminal = openTerminal();
  using unread = openTerminal();

  for (const each of [terminal, unread]) {
    each.write(encoder.encode(numberedLines(0, 40)));
    each.frame();
    each.write(encoder.encode('\u001B[5;1Hchanged'));
  }

  const { epoch, first } = terminal.stableRows();
  const once = terminal.readRows(epoch, first, 100);
  const twice = terminal.readRows(epoch, first, 100);
  const rows = decodeRows(terminal.frame(), 80);

  expect(once.ok && once.rows.rowCount).toBe(41);
  expect(twice).toEqual(once);
  expect(rows).toEqual(decodeRows(unread.frame(), 80));
  expect(rowText(rows.get(4) ?? [])).toBe('changed');
});

it('reads a row from history with the cells the frame returned while it was on screen', () => {
  using terminal = openTerminal();
  const cluster = '\u{1F469}\u200D\u{1F4BB}';

  terminal.write(
    encoder.encode(`\u001B[1;38;5;196;48;2;10;20;30mred\u001B[0m 漢 ${cluster}e\u0301\r\n`),
  );

  const { epoch, activeTop } = terminal.stableRows();
  const onScreen = decodeRows(terminal.frame(), 80).get(0);

  terminal.write(encoder.encode(numberedLines(0, 40)));

  const read = terminal.readRows(epoch, activeTop, 1);
  const fromHistory = read.ok ? decodeRows(read.rows, 80).get(0) : undefined;

  expect(terminal.stableRows().first).toBe(activeTop);
  expect(rowText(onScreen ?? [])).toBe(`red 漢 ${cluster}e\u0301`);
  expect(fromHistory).toEqual(onScreen);
});

it('refuses a read with an epoch from before a resize and reads with the new epoch', () => {
  using terminal = openTerminal();

  terminal.write(encoder.encode(numberedLines(0, 40)));

  const before = terminal.stableRows();

  terminal.resize(60, 20);

  const after = terminal.stableRows();
  const read = terminal.readRows(after.epoch, after.first, 1);

  expect(terminal.readRows(before.epoch, before.first, 1)).toEqual({
    ok: false,
    reason: 'staleEpoch',
  });

  expect(read.ok && rowTexts(read.rows, 60)).toEqual(['line 0']);
});

it('refuses a read of a pruned row and reads the oldest surviving row', () => {
  using terminal = openTerminal(80, 24, 1);
  const start = terminal.stableRows();

  for (let line = 0; line < 20_000; line += 100) {
    terminal.write(encoder.encode(numberedLines(line, 100)));
    terminal.stableRows();
  }

  const { epoch, first } = terminal.stableRows();
  const oldest = terminal.readRows(epoch, first, 1);

  expect(terminal.readRows(epoch, first - 1, 2)).toEqual({ ok: false, reason: 'pruned' });
  expect(oldest.ok && rowTexts(oldest.rows)).toEqual([`line ${first - start.first}`]);
});

it('reads the alternate screen by the primary active top and the history again after leaving it', () => {
  using terminal = openTerminal();

  terminal.write(encoder.encode(numberedLines(0, 40)));

  const { epoch, first, activeTop } = terminal.stableRows();

  terminal.write(encoder.encode('\u001B[?1049h\u001B[Halternate'));

  const onAlternate = terminal.readRows(epoch, first, 1);
  const alternateTop = terminal.readRows(epoch, activeTop, 1);

  terminal.write(encoder.encode('\u001B[?1049l'));

  const afterLeaving = terminal.readRows(epoch, first, 1);

  expect(onAlternate).toEqual({ ok: false, reason: 'pruned' });
  expect(alternateTop.ok && rowTexts(alternateTop.rows)).toEqual(['alternate']);
  expect(afterLeaving.ok && rowTexts(afterLeaving.rows)).toEqual(['line 0']);
});

it('numbers rows the same when one write scrolls the primary screen and enters the alternate screen as when two writes do', () => {
  const output = Array.from({ length: 19 }, (_, line) => `line ${line}\r\n`).join('');
  const enter = '\u001B[?1049h\u001B[HALT';

  const readAfter = (chunks: string[]) => {
    using terminal = openTerminal(20, 5);

    terminal.write(encoder.encode('CACHED-ROW\r\n'));

    const cached = terminal.stableRows();

    for (const chunk of chunks) {
      terminal.write(encoder.encode(chunk));
      terminal.stableRows();
    }

    return {
      stable: terminal.stableRows(),
      read: terminal.readRows(cached.epoch, cached.activeTop, 1),
    };
  };

  const whole = readAfter([output + enter]);

  expect(whole).toEqual(readAfter([output, enter]));
  expect(whole.read).toEqual({ ok: false, reason: 'pruned' });
});

it('returns no rows past the last screen row', () => {
  using terminal = openTerminal();
  const { epoch, activeTop } = terminal.stableRows();

  const read = terminal.readRows(epoch, activeTop + 24, 10);

  expect(read.ok && read.rows.rowCount).toBe(0);
});

it('returns a range dense with clusters whole when it does not fit the first buffers', () => {
  using terminal = openTerminal();
  const clusters = 'e\u0301'.repeat(70);

  const lines = Array.from(
    { length: 120 },
    (_, line) => `g${String(line).padStart(3, '0')} ${clusters}`,
  );

  terminal.write(encoder.encode(lines.map((line) => `${line}\r\n`).join('')));

  const rows = readAllRows(terminal);

  expect(rows.graphemes.length).toBe(120 * 70 * 4);
  expect(rowTexts(rows).slice(0, 120)).toEqual(lines);
});

// A cell keeps at most 65 code points of a cluster and drops the rest; the next character still
// goes to the next cell.
it.each([
  ['frame', (terminal: Terminal) => terminal.frame()],
  ['row range', (terminal: Terminal) => readAllRows(terminal)],
])('keeps 65 code points of a cluster in one cell through a %s', (_name, read) => {
  using terminal = openTerminal();
  const longest = `e${'\u0301'.repeat(64)}`;

  terminal.write(encoder.encode(`${longest}x\r\n${longest}\u0301\u0301y`));

  const rows = decodeRows(read(terminal), 80);
  const [whole, wholeNext] = rows.get(0) ?? [];
  const [kept, keptNext] = rows.get(1) ?? [];

  expect(whole?.text).toBe(longest);
  expect(wholeNext?.text).toBe('x');
  expect(kept?.text).toBe(longest);
  expect(keptNext?.text).toBe('y');
});

// A line as a program prints it: colored, with wide characters, and 15 to 74 columns long.
const coloredLines = (count: number, prefix: string) =>
  Array.from(
    { length: count },
    (_, line) =>
      `\u001B[3${line % 8};4${(line + 3) % 8}m${prefix} ${line} 宽字 ${'x'.repeat(line % 60)}\u001B[0m\r\n`,
  ).join('');

// Writes in PTY-sized chunks so sequences cross write boundaries, and numbers rows after each.
const writeAsPty = (terminal: Terminal, text: string) => {
  const bytes = encoder.encode(text);

  for (let offset = 0; offset < bytes.length; offset += 4093) {
    terminal.write(bytes.subarray(offset, offset + 4093));
    terminal.stableRows();
  }
};

// Draws a full screen the way Neovim redraws: absolute moves, no scrolling.
const fullScreenDraw = (rows: number, label: string) =>
  Array.from(
    { length: rows },
    (_, row) =>
      `\u001B[${row + 1};1H\u001B[1;3${(row + 1) % 8}m${label} ${row + 1}\u001B[K\u001B[0m`,
  ).join('');

const withoutTrailingBlanks = (lines: string[]) => lines.join('\n').trimEnd().split('\n');

describe('reading history', () => {
  it.each([
    ['no history', 1_000_000, [coloredLines(10, 'line'), coloredLines(20, 'more')]],
    ['history below the limit', 1_000_000, [coloredLines(100, 'line'), coloredLines(50, 'more')]],
    ['history beyond the limit', 100_000, [coloredLines(2000, 'line'), coloredLines(200, 'more')]],
    [
      'a sequence split between writes',
      100_000,
      [`${coloredLines(2000, 'line')}\u001B[3`, `1mred\r\n${coloredLines(200, 'more')}`],
    ],
  ])('reads every row as the screen text with %s', (_name, scrollbackBytes, writes) => {
    using terminal = openTerminal(78, 38, scrollbackBytes);

    for (const text of writes) {
      writeAsPty(terminal, text);
    }

    expect(withoutTrailingBlanks(rowTexts(readAllRows(terminal), 78))).toEqual(
      withoutTrailingBlanks(textLines(terminal)),
    );
  });

  it.each([
    [
      'a full alternate-screen redraw, its exit, and more output',
      [
        coloredLines(2000, 'line'),
        `\u001B[?1049h\u001B[H\u001B[2J${fullScreenDraw(38, 'nvim')}`,
        fullScreenDraw(38, 'redraw'),
        '\u001B[?1049l',
        coloredLines(200, 'more'),
      ],
    ],
    [
      'three resizes with output between them',
      [
        coloredLines(2000, 'line'),
        [100, 30],
        coloredLines(100, 'wide'),
        [60, 45],
        coloredLines(200, 'more'),
        [78, 38],
        coloredLines(50, 'last'),
      ],
    ],
  ] as [string, (string | [number, number])[]][])(
    'reads every row as the screen text after each step of %s',
    (_name, steps) => {
      using terminal = openTerminal(78, 38, 100_000);
      let cols = 78;

      const stages = steps.map((step) => {
        if (typeof step === 'string') {
          writeAsPty(terminal, step);
        } else {
          [cols] = step;
          terminal.resize(...step);
        }

        return {
          rows: withoutTrailingBlanks(rowTexts(readAllRows(terminal), cols)),
          text: withoutTrailingBlanks(textLines(terminal)),
        };
      });

      expect(stages.map((stage) => stage.rows)).toEqual(stages.map((stage) => stage.text));
      expect(stages.every((stage) => stage.rows.length > 1)).toBe(true);
    },
  );

  it('reads the row a write changed and scrolled into history in the same write', () => {
    using terminal = openTerminal();

    terminal.write(encoder.encode('OLD-CACHED-ROW'));

    const { epoch, activeTop } = terminal.stableRows();

    terminal.frame();
    terminal.write(encoder.encode('\u001B[HNEW-HISTORY-ROW\u001B[24;1H\r\nFINISHED\r\n'));

    const read = terminal.readRows(epoch, activeTop, 1);

    expect(read.ok && rowTexts(read.rows)).toEqual(['NEW-HISTORY-ROW']);
  });

  it('reads reflowed history after narrowing, and after widening on the alternate screen', () => {
    using terminal = openTerminal(78, 24);

    const lines = Array.from(
      { length: 200 },
      (_, line) => `hist${String(line).padStart(3, '0')} ${'y'.repeat(52)}`,
    );

    writeAsPty(terminal, lines.map((line) => `${line}\r\n`).join(''));
    terminal.resize(58, 24);

    const narrow = rowTexts(readAllRows(terminal), 58);

    writeAsPty(terminal, '\u001B[?1049h\u001B[HALTERNATE');
    terminal.resize(160, 40);

    const alternate = rowTexts(readAllRows(terminal), 160);

    writeAsPty(terminal, '\u001B[?1049l');

    const wide = rowTexts(readAllRows(terminal), 160);

    expect(narrow.slice(0, 400)).toEqual(
      lines.flatMap((line) => [line.slice(0, 58), line.slice(58)]),
    );

    expect(alternate[0]).toBe('ALTERNATE');
    expect(alternate).toHaveLength(40);
    expect(wide.slice(0, 200)).toEqual(lines);
  });

  it('keeps the width and the history when a program asks for 132 columns', () => {
    using terminal = openTerminal();
    const lines = Array.from({ length: 100 }, (_, line) => `deccolm ${line}`);

    writeAsPty(terminal, lines.map((line) => `${line}\r\n`).join(''));

    const before = terminal.stableRows();

    writeAsPty(terminal, '\u001B[?40h\u001B[?3hafter-deccolm\r\n\u001B[?3hsecond-deccolm\r\n');

    const rows = readAllRows(terminal);

    expect(terminal.stableRows().epoch).toBe(before.epoch);
    expect(rows.cells.length).toBe(rows.rowCount * (1 + 80 * cellWords));
    expect(rowTexts(rows).slice(0, 77)).toEqual(lines.slice(0, 77));
  });

  it('keeps the history rows when one write asks for 132 columns and then 80', () => {
    using terminal = openTerminal();

    const lines = Array.from(
      { length: 60 },
      (_, line) => `wrap${String(line).padStart(3, '0')} ${'z'.repeat(122)}`,
    );

    writeAsPty(terminal, lines.map((line) => `${line}\r\n`).join(''));

    const { epoch, first, activeTop } = terminal.stableRows();
    const history = terminal.readRows(epoch, first, activeTop - first);

    writeAsPty(terminal, '\u001B[?40h\u001B[?3h\u001B[?3lround-trip\r\n');

    expect(terminal.readRows(epoch, first, activeTop - first)).toEqual(history);
    expect(history.ok && rowTexts(history.rows)[0]).toBe(lines[0]?.slice(0, 80));
  });

  it.each([
    [
      'split after mode 40',
      (bytes: Uint8Array, splitAt: number) => [bytes.subarray(0, splitAt), bytes.subarray(splitAt)],
    ],
    [
      'byte by byte',
      (bytes: Uint8Array) => Array.from(bytes, (_, index) => bytes.subarray(index, index + 1)),
    ],
  ])('reads the same rows from bytes with DECCOLM written %s as from one write', (_name, split) => {
    const history = Array.from(
      { length: 12 },
      (_, line) => `hist ${line} ${'x'.repeat(line)}\r\n`,
    ).join('');

    const bytes = encoder.encode(`${history}KEEP-ME\r\n\u001B[?40h\u001B[?3hAFTER`);
    const splitAt = encoder.encode(`${history}KEEP-ME\r\n\u001B[?40h`).length;

    const readAfter = (chunks: Uint8Array[]) => {
      using terminal = openTerminal(20, 5);

      terminal.stableRows();

      for (const chunk of chunks) {
        terminal.write(chunk);
        terminal.stableRows();
      }

      return { stable: terminal.stableRows(), rows: readAllRows(terminal) };
    };

    const whole = readAfter([bytes]);

    expect(readAfter(split(bytes, splitAt))).toEqual(whole);

    expect(rowTexts(whole.rows, 20).slice(0, 10)).toEqual([
      ...Array.from({ length: 9 }, (_, line) => `hist ${line} ${'x'.repeat(line)}`.trimEnd()),
      'AFTER',
    ]);
  });
});

const rgb = (value: number) => 0x1_00_00_00 + value;

describe('colors', () => {
  const changeAll = (terminal: Terminal) =>
    writeChunks(terminal, [
      '\u001B]4;1;rgb:12/34/56\u001B\\',
      '\u001B]10;rgb:aa/bb/cc\u001B\\',
      '\u001B]11;rgb:01/02/03\u001B\\',
    ]);

  it('returns an empty list for a new terminal', () => {
    using terminal = openTerminal();

    expect([...terminal.colors()]).toEqual([]);
  });

  it('returns a palette entry a program changes with OSC 4', () => {
    using terminal = openTerminal();
    writeChunks(terminal, ['\u001B]4;1;rgb:12/34/56\u001B\\']);

    expect([...terminal.colors()]).toEqual([1, rgb(0x12_34_56)]);
  });

  it('returns a default color a program sets to its seeded value', () => {
    using terminal = openTerminal();
    writeChunks(terminal, ['\u001B]11;rgb:00/00/00\u001B\\']);

    expect([...terminal.colors()]).toEqual([defaultBackgroundSlot, rgb(0)]);
  });

  it('returns a palette entry a program sets to its default value', () => {
    using terminal = openTerminal();
    writeChunks(terminal, ['\u001B]4;1;rgb:cc/66/66\u001B\\']);

    expect([...terminal.colors()]).toEqual([1, rgb(0xcc_66_66)]);
  });

  it('returns the default colors a program changes with OSC 10 and 11', () => {
    using terminal = openTerminal();
    writeChunks(terminal, ['\u001B]10;rgb:aa/bb/cc\u001B\\', '\u001B]11;rgb:01/02/03\u001B\\']);

    expect([...terminal.colors()]).toEqual([
      defaultForegroundSlot,
      rgb(0xaa_bb_cc),
      defaultBackgroundSlot,
      rgb(0x01_02_03),
    ]);
  });

  it('returns an empty list after a reset with RIS', () => {
    using terminal = openTerminal();
    changeAll(terminal);

    writeChunks(terminal, ['\u001Bc']);

    expect([...terminal.colors()]).toEqual([]);
  });

  it('removes only the slot OSC 104 resets', () => {
    using terminal = openTerminal();

    writeChunks(terminal, [
      '\u001B]4;1;rgb:12/34/56\u001B\\',
      '\u001B]4;2;rgb:65/43/21\u001B\\',
      '\u001B]104;1\u001B\\',
    ]);

    expect([...terminal.colors()]).toEqual([2, rgb(0x65_43_21)]);
  });

  it('removes the default colors OSC 110 and 111 reset', () => {
    using terminal = openTerminal();
    changeAll(terminal);

    writeChunks(terminal, ['\u001B]110\u001B\\']);

    expect([...terminal.colors()]).toEqual([
      1,
      rgb(0x12_34_56),
      defaultBackgroundSlot,
      rgb(0x01_02_03),
    ]);

    writeChunks(terminal, ['\u001B]111\u001B\\']);

    expect([...terminal.colors()]).toEqual([1, rgb(0x12_34_56)]);
  });
});
