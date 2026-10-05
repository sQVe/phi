import { expect, it } from 'bun:test';

import { decodeRowUpdate, encodeRowUpdate } from '../src/rows/rows.ts';
import { createTerminal } from '../src/vt/vt.ts';

const columns = 80;

const rows = 24;

it('carries a vt frame through a row update with its cells and graphemes', () => {
  const created = createTerminal(columns, rows, 1_000_000);

  if (!created.ok) {
    throw new Error(created.reason);
  }

  using terminal = created.terminal;

  terminal.write(new TextEncoder().encode('\u001B[1mbold\u001B[0m 中文 👨‍👩‍👧 e\u0301\r\nnext'));

  const frame = terminal.frame();
  const stable = terminal.stableRows();

  const update = {
    ...frame,
    pane: 1,
    sequence: 1,
    size: { columns, rows },
    epoch: stable.epoch,
    first: stable.first,
    activeTop: stable.activeTop,
  };

  const result = decodeRowUpdate(encodeRowUpdate(update));

  expect(frame.rowCount).toBe(rows);
  expect(frame.graphemes.length).toBeGreaterThan(0);
  expect(result).toEqual({ ok: true, update });
});
