import { expect, it } from 'bun:test';

import { paneSize } from './layout.ts';

it('gives the pane 80x24 without a client', () => {
  expect(paneSize(undefined)).toEqual({ columns: 80, rows: 24 });
});

it('leaves one client row for the status bar', () => {
  expect(paneSize({ columns: 120, rows: 40 })).toEqual({ columns: 120, rows: 39 });
});

it('keeps the pane at least 1x1', () => {
  expect(paneSize({ columns: 1, rows: 1 })).toEqual({ columns: 1, rows: 1 });
  expect(paneSize({ columns: 0, rows: 0 })).toEqual({ columns: 1, rows: 1 });
});
