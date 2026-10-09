import { expect, it } from 'bun:test';

import { cellWords, ModeFlag } from '../rows/rows.ts';
import type { RowUpdate } from '../rows/rows.ts';
import { createRowCache } from './rowCache.ts';

const columns = 4;

const stride = 1 + columns * cellWords;

// Each row is an offset from the active top and the text of its cells.
const rowUpdate = (rows: [number, string][], overrides: Partial<RowUpdate> = {}): RowUpdate => {
  const cells = new Uint32Array(rows.length * stride);

  for (const [index, [offset, text]] of rows.entries()) {
    cells[index * stride] = offset >>> 0;

    for (const [column, character] of text.split('').entries()) {
      cells[index * stride + 1 + column * cellWords] = character.codePointAt(0) ?? 0;
    }
  }

  return {
    pane: 1,
    sequence: 1,
    size: { columns, rows: 3 },
    cursor: { x: 0, y: 0, visible: true },
    modes: 0,
    epoch: 1,
    first: 0,
    activeTop: 100,
    rowCount: rows.length,
    cells,
    graphemes: new Uint32Array(),
    colors: new Uint32Array(),
    ...overrides,
  };
};

const firstWord = (cache: ReturnType<typeof createRowCache>, index: number) =>
  cache.row(index)?.cells[0];

it('stores rows at their stable numbers and reports the changed screen rows', () => {
  const cache = createRowCache({ rowLimit: 50 });

  expect(
    cache.apply(
      rowUpdate([
        [0, 'a'],
        [2, 'c'],
        [-1, 'z'],
      ]),
    ),
  ).toEqual([0, 2]);

  expect(firstWord(cache, 0)).toBe(97);
  expect(firstWord(cache, 1)).toBeUndefined();
  expect(firstWord(cache, 2)).toBe(99);
  expect(cache.heldRowCount()).toBe(3);

  const scrolled = rowUpdate([[1, 'd']], { activeTop: 101, sequence: 2 });

  expect(cache.apply(scrolled)).toEqual([1]);
  expect(firstWord(cache, 0)).toBeUndefined();
  expect(firstWord(cache, 1)).toBe(100);
  expect(firstWord(cache, -1)).toBe(97);
});

it('reports every held active row when the active top moves', () => {
  const cache = createRowCache({ rowLimit: 50 });

  cache.apply(
    rowUpdate([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ]),
  );

  const changed = cache.apply(rowUpdate([[2, 'd']], { activeTop: 101, sequence: 2 }));

  expect(changed).toEqual([0, 1, 2]);
});

it('keeps the latest size, cursor, and modes', () => {
  const cache = createRowCache({ rowLimit: 50 });

  cache.apply(rowUpdate([[0, 'a']]));

  const next = rowUpdate([], {
    size: { columns, rows: 5 },
    cursor: { x: 2, y: 1, visible: false },
    modes: ModeFlag.bracketedPaste,
  });

  cache.apply(next);

  expect(cache.size()).toEqual({ columns, rows: 5 });
  expect(cache.cursor()).toEqual({ x: 2, y: 1, visible: false });
  expect(cache.modes()).toBe(ModeFlag.bracketedPaste);
  expect(firstWord(cache, 0)).toBe(97);
});

it('reads a grapheme cluster by the column of its cell', () => {
  const cache = createRowCache({ rowLimit: 50 });
  const family = [0x1_f4_68, 0x20_0d, 0x1_f4_69];
  const second = stride + 1 + 2 * cellWords;

  const update = rowUpdate(
    [
      [0, 'ab'],
      [1, 'cdef'],
    ],
    {
      graphemes: Uint32Array.of(second, family.length, ...family),
    },
  );

  cache.apply(update);

  expect(cache.row(0)?.clusters.size).toBe(0);
  expect([...(cache.row(1)?.clusters ?? [])]).toEqual([[2, String.fromCodePoint(...family)]]);
});

it('clears the cache when the epoch changes', () => {
  const cache = createRowCache({ rowLimit: 50 });

  cache.apply(
    rowUpdate([
      [0, 'a'],
      [1, 'b'],
    ]),
  );

  cache.apply(rowUpdate([[2, 'c']], { epoch: 2 }));

  expect(firstWord(cache, 0)).toBeUndefined();
  expect(firstWord(cache, 1)).toBeUndefined();
  expect(firstWord(cache, 2)).toBe(99);
  expect(cache.heldRowCount()).toBe(1);
});

it('clears the cache when the alternate screen turns on or off', () => {
  const cache = createRowCache({ rowLimit: 50 });

  cache.apply(rowUpdate([[0, 'a']]));
  cache.apply(rowUpdate([[1, 'b']], { modes: ModeFlag.alternateScreen }));

  expect(firstWord(cache, 0)).toBeUndefined();
  expect(cache.heldRowCount()).toBe(1);

  cache.apply(rowUpdate([[2, 'c']], { modes: ModeFlag.alternateScreen | ModeFlag.bracketedPaste }));

  expect(firstWord(cache, 1)).toBe(98);
  expect(cache.heldRowCount()).toBe(2);

  cache.apply(rowUpdate([[0, 'd']]));

  expect(cache.heldRowCount()).toBe(1);
});

it('never holds more than rowLimit rows and drops the lowest row numbers first', () => {
  const cache = createRowCache({ rowLimit: 3 });

  cache.apply(
    rowUpdate([
      [-4, 'a'],
      [-3, 'b'],
      [-2, 'c'],
      [-1, 'd'],
      [0, 'e'],
    ]),
  );

  expect(cache.heldRowCount()).toBe(3);
  expect(firstWord(cache, -2)).toBe(99);
  expect(firstWord(cache, -3)).toBeUndefined();
  expect(firstWord(cache, 0)).toBe(101);

  cache.apply(rowUpdate([[1, 'f']], { sequence: 2 }));

  expect(cache.heldRowCount()).toBe(3);
  expect(firstWord(cache, -2)).toBeUndefined();
  expect(firstWord(cache, 1)).toBe(102);
});

it('does not report an active row that the limit dropped', () => {
  const cache = createRowCache({ rowLimit: 1 });

  expect(
    cache.apply(
      rowUpdate([
        [0, 'a'],
        [1, 'b'],
      ]),
    ),
  ).toEqual([1]);
});
