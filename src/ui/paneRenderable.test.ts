import { afterEach, expect, it } from 'bun:test';

import { TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import type { TestRendererSetup } from '@opentui/core/testing';

import { createRowCache } from '../client/client.ts';
import { cellWords } from '../rows/rows.ts';
import type { RowUpdate } from '../rows/rows.ts';
import { PaneRenderable } from './paneRenderable.ts';

interface TestCell {
  column: number;
  codePoint: number;
  background?: number;
  flags?: number;
}

const columns = 6;

const stride = 1 + columns * cellWords;

const wideTail = 0x2_00;

const wideHead = 0x1_00;

const rowUpdate = (cells: TestCell[], cursorVisible = false): RowUpdate => {
  const words = new Uint32Array(stride);

  for (const cell of cells) {
    const start = 1 + cell.column * cellWords;

    words[start] = cell.codePoint;
    words[start + 2] = cell.background ?? 0;
    words[start + 3] = cell.flags ?? 0;
  }

  return {
    pane: 1,
    sequence: 1,
    size: { columns, rows: 1 },
    cursor: { x: 0, y: 0, visible: cursorVisible },
    modes: 0,
    epoch: 1,
    first: 0,
    activeTop: 0,
    rowCount: 1,
    cells: words,
    graphemes: new Uint32Array(),
    colors: new Uint32Array(),
  };
};

let setup: TestRendererSetup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

const startPane = async () => {
  const created = await createTestRenderer({ width: columns, height: 1 });
  const cache = createRowCache({ rowLimit: 10 });
  const pane = new PaneRenderable(created.renderer, { cache, width: columns, height: 1 });

  setup = created;
  created.renderer.root.add(pane);

  const show = async (update: RowUpdate): Promise<string> => {
    pane.draw(cache.apply(update));
    await created.renderOnce();

    return created.captureCharFrame();
  };

  return { show, created };
};

it('leaves no stale half when a wide character moves one column left', async () => {
  const { show } = await startPane();

  await show(
    rowUpdate([
      { column: 2, codePoint: 0x4e2d, flags: wideHead },
      { column: 3, codePoint: 0, flags: wideTail },
    ]),
  );

  const frame = await show(
    rowUpdate([
      { column: 1, codePoint: 0x4e2d, flags: wideHead },
      { column: 2, codePoint: 0, flags: wideTail },
    ]),
  );

  expect(frame.trimEnd()).toBe(' 中');
  expect(frame).toBe(' 中   \n');
});

it('draws a combining cluster whole in one cell', async () => {
  const { show } = await startPane();

  const update = rowUpdate([
    { column: 1, codePoint: 0x65, flags: 0x1_00_00 },
    { column: 2, codePoint: 0x78 },
  ]);

  const base = 1 + 1 * cellWords;

  update.graphemes = new Uint32Array([base, 2, 0x65, 0x301]);

  const frame = await show(update);

  expect(frame.trimEnd()).toBe(' e\u0301x');
});

it('shows the erased background of a cell with no character', async () => {
  const { show, created } = await startPane();

  await show(rowUpdate([{ column: 1, codePoint: 0x7a }]));
  await show(rowUpdate([{ column: 2, codePoint: 0, background: 0x1_00_00_00 + 0xff_00_00 }]));

  const spans = created.captureSpans().lines[0]?.spans ?? [];
  const red = spans.find((span) => span.bg.toInts()[0] === 255 && span.text.includes(' '));

  expect(created.captureCharFrame().trim()).toBe('');
  expect(red).toBeDefined();
});

it('moves the cursor inside one row without new rows', async () => {
  const { show, created } = await startPane();

  const invertedColumns = (): number[] => {
    const spans = created.captureSpans().lines[0]?.spans ?? [];
    let column = 0;
    const inverted: number[] = [];

    for (const span of spans) {
      if ((span.attributes & TextAttributes.INVERSE) !== 0) {
        inverted.push(column);
      }

      column += span.width;
    }

    return inverted;
  };

  await show(rowUpdate([{ column: 0, codePoint: 0x61 }], true));
  expect(invertedColumns()).toEqual([0]);

  const moved = rowUpdate([], true);

  moved.rowCount = 0;
  moved.cells = new Uint32Array();
  moved.cursor = { x: 2, y: 0, visible: true };
  await show(moved);

  expect(invertedColumns()).toEqual([2]);
});

it('reports the newest drawn sequence once, only after a render', async () => {
  const drawn: number[] = [];
  const created = await createTestRenderer({ width: columns, height: 1 });
  const cache = createRowCache({ rowLimit: 10 });

  const pane = new PaneRenderable(created.renderer, {
    cache,
    width: columns,
    height: 1,
    onDrawn: (sequence) => {
      drawn.push(sequence);
    },
  });

  setup = created;
  created.renderer.root.add(pane);

  pane.draw(cache.apply(rowUpdate([{ column: 0, codePoint: 0x61 }])), 1);
  pane.draw(cache.apply(rowUpdate([{ column: 1, codePoint: 0x62 }])), 2);

  expect(drawn).toEqual([]);

  await created.renderOnce();

  expect(drawn).toEqual([2]);

  await created.renderOnce();

  expect(drawn).toEqual([2]);
});
