import { cellWords, ModeFlag } from '../rows/rows.ts';
import type { RowUpdate } from '../rows/rows.ts';

interface CachedRow {
  // cellWords words per column. Each column's first word is its base code point.
  cells: Uint32Array;
  // The text of each cluster longer than one code point, by the column of its cell.
  clusters: ReadonlyMap<number, string>;
}

export interface RowCache {
  // Stores the update's rows. Returns the indexes, from the active screen's top, of the active
  // screen rows that changed.
  apply: (update: RowUpdate) => number[];
  // One row of the active screen, or undefined while the cache has not received it.
  row: (index: number) => CachedRow | undefined;
  size: () => { columns: number; rows: number } | undefined;
  cursor: () => { x: number; y: number; visible: boolean } | undefined;
  // The ModeFlag bits that are on.
  modes: () => number;
  heldRowCount: () => number;
}

interface RowCacheOptions {
  rowLimit: number;
}

const clustersOf = (graphemes: Uint32Array, rowStart: number, stride: number) => {
  const clusters = new Map<number, string>();

  for (let index = 0; index < graphemes.length;) {
    const cellIndex = graphemes[index] ?? 0;
    const length = graphemes[index + 1] ?? 0;

    if (cellIndex >= rowStart && cellIndex < rowStart + stride) {
      const column = (cellIndex - rowStart - 1) / cellWords;
      const codePoints = graphemes.subarray(index + 2, index + 2 + length);

      clusters.set(column, String.fromCodePoint(...codePoints));
    }

    index += 2 + length;
  }

  return clusters;
};

export const createRowCache = ({ rowLimit }: RowCacheOptions): RowCache => {
  const rows = new Map<number, CachedRow>();
  let epoch: number | undefined;
  let activeTop = 0;
  let size: { columns: number; rows: number } | undefined;
  let cursor: { x: number; y: number; visible: boolean } | undefined;
  let modes = 0;

  const dropOldest = (): void => {
    if (rows.size <= rowLimit) {
      return;
    }

    const ascending = [...rows.keys()].toSorted((left, right) => left - right);

    for (const rowNumber of ascending.slice(0, rows.size - rowLimit)) {
      rows.delete(rowNumber);
    }
  };

  const changedScreen = (update: RowUpdate): boolean => {
    const bit = ModeFlag.alternateScreen;

    return epoch !== update.epoch || (modes & bit) !== (update.modes & bit);
  };

  const storeRows = (update: RowUpdate): Set<number> => {
    const stride = 1 + update.size.columns * cellWords;
    const stored = new Set<number>();

    for (let index = 0; index < update.rowCount; index++) {
      const start = index * stride;
      const offset = (update.cells[start] ?? 0) | 0;
      const rowNumber = update.activeTop + offset;

      rows.set(rowNumber, {
        cells: update.cells.slice(start + 1, start + stride),
        clusters: clustersOf(update.graphemes, start, stride),
      });

      stored.add(rowNumber);
    }

    return stored;
  };

  const apply = (update: RowUpdate): number[] => {
    if (changedScreen(update)) {
      rows.clear();
    }

    const scrolled = activeTop !== update.activeTop;

    epoch = update.epoch;
    activeTop = update.activeTop;
    size = update.size;
    cursor = update.cursor;
    modes = update.modes;

    const stored = storeRows(update);

    dropOldest();

    const changed: number[] = [];

    for (let index = 0; index < update.size.rows; index++) {
      const reported = scrolled || stored.has(activeTop + index);

      if (reported && rows.has(activeTop + index)) {
        changed.push(index);
      }
    }

    return changed;
  };

  return {
    apply,
    row: (index) => rows.get(activeTop + index),
    size: () => size,
    cursor: () => cursor,
    modes: () => modes,
    heldRowCount: () => rows.size,
  };
};
