import { invariant } from '../invariant.ts';
import type { TerminalSize } from '../layout.ts';
import { cellWords, ModeFlag } from '../rows/rows.ts';
import type { RowUpdate } from '../rows/rows.ts';
import type { Frame, RowRange, StableRows, Terminal } from '../vt/vt.ts';

export interface RowPublisher {
  subscribe: (send: (update: RowUpdate) => void) => () => void;
  publish: () => void;
  // Later updates use the size, and every subscriber gets the full screen again.
  resize: (size: TerminalSize) => void;
  whenReleased: () => Promise<void>;
  [Symbol.dispose]: () => void;
}

interface PublisherOptions {
  holdLimitMs?: number;
  requestPublication: () => void;
}

interface Subscriber {
  send: (update: RowUpdate) => void;
  primarySent: Map<number, bigint>;
  alternateSent: Map<number, bigint>;
}

interface Row {
  offset: number;
  cells: Uint32Array;
  graphemes: number[];
  hash: bigint;
}

interface Publication {
  pane: number;
  sequence: number;
  size: TerminalSize;
  stable: StableRows;
  frame: Frame;
  active: Row[];
  changedScreen: boolean;
}

const renderHoldLimitMs = 1000;

const sentRows = (subscriber: Subscriber, alternate: boolean): Map<number, bigint> =>
  alternate ? subscriber.alternateSent : subscriber.primarySent;

const splitRows = (source: RowRange, columns: number): Row[] => {
  const stride = 1 + columns * cellWords;
  const rows: Row[] = [];

  for (let start = 0; start < source.cells.length; start += stride) {
    rows.push({
      offset: source.cells[start] ?? 0,
      cells: source.cells.subarray(start, start + stride),
      graphemes: [],
      hash: 0n,
    });
  }

  for (let index = 0; index < source.graphemes.length;) {
    const cellIndex = source.graphemes[index] ?? 0;
    const length = source.graphemes[index + 1] ?? 0;
    const rowIndex = Math.floor(cellIndex / stride);
    const row = rows[rowIndex];

    invariant(row !== undefined, 'A terminal grapheme must belong to a returned row.');

    row.graphemes.push(cellIndex % stride, length);
    row.graphemes.push(...source.graphemes.subarray(index + 2, index + 2 + length));
    index += 2 + length;
  }

  for (const row of rows) {
    const cellsHash = Bun.hash.xxHash64(row.cells.subarray(1));

    row.hash = Bun.hash.xxHash64(Uint32Array.from(row.graphemes), cellsHash);
  }

  return rows;
};

const joinRows = (rows: readonly Row[], columns: number): RowRange => {
  const stride = 1 + columns * cellWords;
  const cells = new Uint32Array(rows.length * stride);
  const graphemes: number[] = [];
  let start = 0;

  for (const row of rows) {
    cells.set(row.cells, start);
    cells[start] = row.offset;

    for (let index = 0; index < row.graphemes.length;) {
      const cellIndex = row.graphemes[index] ?? 0;
      const length = row.graphemes[index + 1] ?? 0;

      graphemes.push(start + cellIndex, length);
      graphemes.push(...row.graphemes.slice(index + 2, index + 2 + length));
      index += 2 + length;
    }

    start += stride;
  }

  return { rowCount: rows.length, cells, graphemes: Uint32Array.from(graphemes) };
};

const departedRows = (
  terminal: Terminal,
  sent: Map<number, bigint>,
  stable: StableRows,
  columns: number,
): Row[] => {
  const departed: Row[] = [];

  for (const [number, hash] of sent) {
    if (number >= stable.activeTop) {
      continue;
    }

    sent.delete(number);

    if (number < stable.first) {
      continue;
    }

    const read = terminal.readRows(stable.epoch, number, 1);

    if (!read.ok) {
      continue;
    }

    const [row] = splitRows(read.rows, columns);

    if (row !== undefined && row.hash !== hash) {
      departed.push({ ...row, offset: number - stable.activeTop });
    }
  }

  return departed;
};

const changedRows = (
  sent: Map<number, bigint>,
  active: readonly Row[],
  activeTop: number,
  changedScreen: boolean,
): Row[] => {
  const changed: Row[] = [];

  for (const row of active) {
    const number = activeTop + row.offset;

    if (changedScreen || sent.get(number) !== row.hash) {
      changed.push(row);
      sent.set(number, row.hash);
    }
  }

  return changed;
};

const updateFor = (
  terminal: Terminal,
  subscriber: Subscriber,
  publication: Publication,
): RowUpdate => {
  const { pane, sequence, size, stable, frame, active, changedScreen } = publication;
  const sent = sentRows(subscriber, stable.alternate);
  const departed = stable.alternate ? [] : departedRows(terminal, sent, stable, size.columns);
  const changed = changedRows(sent, active, stable.activeTop, changedScreen);
  const rows = joinRows([...departed, ...changed], size.columns);

  return {
    pane,
    sequence,
    size,
    cursor: frame.cursor,
    modes: frame.modes,
    epoch: stable.epoch,
    first: stable.first,
    activeTop: stable.activeTop,
    ...rows,
  };
};

const clearInvalidTracking = (
  subscribers: ReadonlySet<Subscriber>,
  changedEpoch: boolean,
  changedScreen: boolean,
): void => {
  for (const subscriber of subscribers) {
    if (changedScreen) {
      subscriber.alternateSent.clear();
    }

    if (changedEpoch) {
      subscriber.primarySent.clear();
      subscriber.alternateSent.clear();
    }
  }
};

export const createRowPublisher = (
  terminal: Terminal,
  pane: number,
  initialSize: TerminalSize,
  options: PublisherOptions,
): RowPublisher => {
  let size = initialSize;
  const subscribers = new Set<Subscriber>();
  let previous: StableRows | undefined;
  let sequence = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let holdExpired = false;
  let disposed = false;
  let waiters: (() => void)[] = [];

  const clearHold = (): void => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
    holdExpired = false;
  };

  const releaseWaiters = (): void => {
    const released = waiters;

    waiters = [];

    for (const resolve of released) {
      resolve();
    }
  };

  const watchHold = (): void => {
    if (holdTimer !== undefined || holdExpired) {
      return;
    }

    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      holdExpired = true;
      options.requestPublication();
    }, options.holdLimitMs ?? renderHoldLimitMs);
  };

  const subscribe = (send: (update: RowUpdate) => void): (() => void) => {
    const subscriber: Subscriber = { send, primarySent: new Map(), alternateSent: new Map() };

    subscribers.add(subscriber);

    return () => {
      subscribers.delete(subscriber);
    };
  };

  const whenReleased = async (): Promise<void> => {
    if (disposed || !terminal.renderHeld()) {
      return;
    }

    const released = new Promise<void>((resolve) => {
      waiters.push(resolve);
    });

    watchHold();

    await released;
  };

  const publish = (): void => {
    if (disposed) {
      return;
    }

    if (holdExpired) {
      terminal.endRenderHold();
      clearHold();
      releaseWaiters();
    }

    const stable = terminal.stableRows();
    const changedScreen = previous?.alternate !== stable.alternate;
    const changedEpoch = previous?.epoch !== stable.epoch;

    const hasNewSubscriber = [...subscribers].some((subscriber) => {
      const sent = sentRows(subscriber, stable.alternate);

      return sent.size === 0;
    });

    if (changedEpoch || changedScreen || hasNewSubscriber) {
      terminal.markAllDirty();
    }

    const frame = terminal.frame();

    // A held frame predates the live stable row numbers. Keep both from the last publication.
    if ((frame.modes & ModeFlag.renderHeld) !== 0) {
      terminal.markAllDirty();
      watchHold();

      return;
    }

    clearHold();
    releaseWaiters();

    if (subscribers.size === 0) {
      return;
    }

    clearInvalidTracking(subscribers, changedEpoch, changedScreen);

    const active = splitRows(frame, size.columns);

    sequence += 1;
    previous = stable;

    const publication: Publication = { pane, sequence, size, stable, frame, active, changedScreen };

    for (const subscriber of subscribers) {
      subscriber.send(updateFor(terminal, subscriber, publication));
    }
  };

  const resize = (next: TerminalSize): void => {
    size = next;

    for (const subscriber of subscribers) {
      subscriber.primarySent.clear();
      subscriber.alternateSent.clear();
    }
  };

  const dispose = (): void => {
    disposed = true;
    clearHold();
    releaseWaiters();
    subscribers.clear();
  };

  return { subscribe, publish, resize, whenReleased, [Symbol.dispose]: dispose };
};
