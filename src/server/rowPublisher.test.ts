import { expect, it, onTestFinished } from 'bun:test';

import { cellWords, decodeRowUpdate, encodeRowUpdate, ModeFlag } from '../rows/rows.ts';
import type { RowUpdate } from '../rows/rows.ts';
import { createTerminal } from '../vt/vt.ts';
import type { Terminal } from '../vt/vt.ts';
import { createRowPublisher } from './rowPublisher.ts';

const encoder = new TextEncoder();

const terminalForTest = () => {
  const created = createTerminal(80, 24, 1_000_000);

  if (!created.ok) {
    throw new Error(created.reason);
  }

  onTestFinished(() => {
    created.terminal[Symbol.dispose]();
  });

  return created.terminal;
};

const publisherForTest = (terminal: Terminal, holdLimitMs = 1000) => {
  const publisher = createRowPublisher(
    terminal,
    1,
    { columns: 80, rows: 24 },
    {
      holdLimitMs,
      requestPublication: () => {
        publisher.publish();
      },
    },
  );

  onTestFinished(() => {
    publisher[Symbol.dispose]();
  });

  return publisher;
};

const rowsOf = (update: RowUpdate) => {
  const rows = new Map<number, string>();
  const stride = 1 + update.size.columns * cellWords;

  for (let start = 0; start < update.cells.length; start += stride) {
    const points: number[] = [];

    for (let column = 0; column < update.size.columns; column += 1) {
      points.push(update.cells[start + 1 + column * cellWords] ?? 0);
    }

    const text = String.fromCodePoint(...points)
      .replaceAll('\0', ' ')
      .trimEnd();

    rows.set((update.cells[start] ?? 0) | 0, text);
  }

  return rows;
};

const lastUpdate = (updates: RowUpdate[]): RowUpdate => {
  const update = updates.at(-1);

  if (update === undefined) {
    throw new Error('No row update arrived.');
  }

  return update;
};

it('sends the whole screen first, only changed rows next, and final departed rows', () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);
  const updates: RowUpdate[] = [];

  publisher.subscribe((update) => updates.push(update));
  publisher.publish();

  const first = lastUpdate(updates);

  expect(first.rowCount).toBe(24);
  expect([...rowsOf(first).keys()]).toEqual(Array.from({ length: 24 }, (_, index) => index));
  expect(first.cursor).toEqual({ x: 0, y: 0, visible: true });
  expect(first.epoch).toBe(terminal.stableRows().epoch);

  terminal.write(encoder.encode('hello'));
  terminal.stableRows();
  publisher.publish();

  const second = lastUpdate(updates);

  expect(second.rowCount).toBe(1);
  expect(rowsOf(second)).toEqual(new Map([[0, 'hello']]));
  expect(second.cursor).toEqual({ x: 5, y: 0, visible: true });
  expect(second.sequence).toBeGreaterThan(first.sequence);

  terminal.write(encoder.encode(' world\r\n' + 'line\r\n'.repeat(24)));
  terminal.stableRows();
  publisher.publish();

  const third = lastUpdate(updates);
  const departedOffset = first.activeTop - third.activeTop;

  expect(departedOffset).toBeLessThan(0);
  expect(rowsOf(third).get(departedOffset)).toBe('hello world');
  expect(third.sequence).toBeGreaterThan(second.sequence);
});

it('clears sent rows on an epoch change and sends the whole new screen', () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);
  const updates: RowUpdate[] = [];

  publisher.subscribe((update) => updates.push(update));
  terminal.write(encoder.encode('before'));
  terminal.stableRows();
  publisher.publish();

  const before = lastUpdate(updates);

  terminal.write(encoder.encode('\u001Bchello'));
  terminal.stableRows();
  publisher.publish();

  const after = lastUpdate(updates);

  expect(after.epoch).not.toBe(before.epoch);
  expect(after.rowCount).toBe(24);
  expect(rowsOf(after).get(0)).toBe('hello');
  expect([...rowsOf(after).keys()].every((offset) => offset >= 0)).toBe(true);
});

it('gives a later subscriber a full screen without taking changes from the first', () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);
  const first: RowUpdate[] = [];
  const second: RowUpdate[] = [];

  publisher.subscribe((update) => first.push(update));
  publisher.publish();
  terminal.write(encoder.encode('hello'));
  terminal.stableRows();
  publisher.subscribe((update) => second.push(update));
  publisher.publish();

  expect(lastUpdate(first).rowCount).toBe(1);
  expect(lastUpdate(second).rowCount).toBe(24);
  expect(rowsOf(lastUpdate(first)).get(0)).toBe('hello');
  expect(rowsOf(lastUpdate(second)).get(0)).toBe('hello');
  expect(lastUpdate(first).sequence).toBe(lastUpdate(second).sequence);
});

it('keeps changes after a range read and omits unchanged departed rows', () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);
  const updates: RowUpdate[] = [];

  publisher.subscribe((update) => updates.push(update));
  terminal.write(encoder.encode('hello'));
  terminal.stableRows();
  publisher.publish();
  terminal.write(encoder.encode('\r\nsecond'));

  const stable = terminal.stableRows();
  const read = terminal.readRows(stable.epoch, stable.activeTop, 24);

  expect(read.ok).toBe(true);

  publisher.publish();

  expect(rowsOf(lastUpdate(updates))).toEqual(new Map([[1, 'second']]));

  terminal.write(encoder.encode('\r\n'.repeat(24)));
  terminal.stableRows();
  publisher.publish();

  expect([...rowsOf(lastUpdate(updates)).keys()].every((offset) => offset >= 0)).toBe(true);
});

it('preserves changed grapheme clusters and rebases their indexes in departed rows', () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);
  const updates: RowUpdate[] = [];

  publisher.subscribe((update) => updates.push(update));
  terminal.write(encoder.encode('e\u0301'));
  terminal.stableRows();
  publisher.publish();
  terminal.write(encoder.encode('\re\u0300' + '\r\n'.repeat(24) + 'a\u0302'));
  terminal.stableRows();
  publisher.publish();

  const update = lastUpdate(updates);
  const decoded = decodeRowUpdate(encodeRowUpdate(update));
  const stride = 1 + 80 * cellWords;
  const clusters = new Map<number, number[]>();

  for (let index = 0; index < update.graphemes.length;) {
    const cellIndex = update.graphemes[index] ?? 0;
    const length = update.graphemes[index + 1] ?? 0;
    const rowStart = Math.floor(cellIndex / stride) * stride;
    const offset = (update.cells[rowStart] ?? 0) | 0;

    clusters.set(offset, Array.from(update.graphemes.subarray(index + 2, index + 2 + length)));
    index += 2 + length;
  }

  expect(decoded.ok).toBe(true);
  expect(clusters.get(-1)).toEqual([0x65, 0x3_00]);
  expect(clusters.get(23)).toEqual([0x61, 0x3_02]);
});

it('does not mix held frames with live row numbers and sends all changes when the hold ends', () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);
  const updates: RowUpdate[] = [];

  publisher.subscribe((update) => updates.push(update));
  terminal.write(encoder.encode('before'));
  terminal.stableRows();
  publisher.publish();
  terminal.write(encoder.encode(' changed\u001B[?2026h' + '\r\n'.repeat(24) + 'during'));
  terminal.stableRows();
  publisher.publish();

  expect(updates).toHaveLength(1);

  terminal.write(encoder.encode('\u001B[?2026l'));
  terminal.stableRows();
  publisher.publish();

  const update = lastUpdate(updates);

  expect(rowsOf(update).get(-1)).toBe('before changed');
  expect(rowsOf(update).get(23)).toBe('during');
  expect(update.modes & ModeFlag.renderHeld).toBe(0);
});

it('keeps primary and alternate screen rows separate even when their epoch is the same', () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);
  const updates: RowUpdate[] = [];

  publisher.subscribe((update) => updates.push(update));
  terminal.write(encoder.encode('primary'));
  terminal.stableRows();
  publisher.publish();

  const primary = lastUpdate(updates);

  terminal.write(encoder.encode('\u001B[?1049halternate'));
  terminal.stableRows();
  publisher.publish();

  const alternate = lastUpdate(updates);

  expect(alternate.epoch).toBe(primary.epoch);
  expect(alternate.rowCount).toBe(24);
  expect(alternate.modes & ModeFlag.alternateScreen).not.toBe(0);

  terminal.write(encoder.encode('\u001B[?1049l'));
  terminal.stableRows();
  publisher.publish();

  const restored = lastUpdate(updates);

  expect(restored.epoch).toBe(primary.epoch);
  expect(restored.rowCount).toBe(24);
  expect(rowsOf(restored).get(0)).toBe('primary');
  expect(restored.modes & ModeFlag.alternateScreen).toBe(0);
});

it('repairs a changed primary row after it departs during an alternate-screen visit', () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);
  const updates: RowUpdate[] = [];

  publisher.subscribe((update) => updates.push(update));
  terminal.write(encoder.encode('old'));
  terminal.stableRows();
  publisher.publish();

  const before = lastUpdate(updates);

  terminal.write(encoder.encode('\rnew' + '\r\n'.repeat(24) + '\u001B[?1049h\u001B[Halternate'));
  terminal.stableRows();
  publisher.publish();

  const alternate = lastUpdate(updates);

  expect(alternate.epoch).toBe(before.epoch);
  expect(rowsOf(alternate).get(0)).toBe('alternate');
  expect(rowsOf(alternate).has(-1)).toBe(false);

  terminal.write(encoder.encode('\u001B[?1049l'));
  terminal.stableRows();
  publisher.publish();

  const after = lastUpdate(updates);

  expect(after.epoch).toBe(before.epoch);
  expect(after.activeTop).toBe(before.activeTop + 1);
  expect(rowsOf(after).get(-1)).toBe('new');
  expect(rowsOf(after).get(0)).toBe('');
});

it('ends an overdue render hold without more output and gives a new subscriber its first screen', async () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal, 5);
  const updates: RowUpdate[] = [];
  const received = Promise.withResolvers<undefined>();

  terminal.write(encoder.encode('\u001B[?2026hheld'));
  terminal.stableRows();
  publisher.publish();

  publisher.subscribe((update) => {
    updates.push(update);
    received.resolve(undefined);
  });

  publisher.publish();

  expect(updates).toHaveLength(0);

  await Promise.race([received.promise, Bun.sleep(100)]);

  expect(updates).toHaveLength(1);

  const update = lastUpdate(updates);

  expect(update.rowCount).toBe(24);
  expect(rowsOf(update).get(0)).toBe('held');
  expect(update.modes & ModeFlag.renderHeld).toBe(0);
});

it('ends an overdue hold even before any subscriber joins', async () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal, 5);
  const updates: RowUpdate[] = [];

  terminal.write(encoder.encode('\u001B[?2026hready'));
  terminal.stableRows();
  publisher.publish();

  await Bun.sleep(20);

  publisher.subscribe((update) => updates.push(update));
  publisher.publish();

  expect(updates).toHaveLength(1);
  expect(rowsOf(lastUpdate(updates)).get(0)).toBe('ready');
});

const settled = async (promise: Promise<void>): Promise<boolean> =>
  Promise.race([promise.then(() => true), Bun.sleep(1).then(() => false)]);

it('resolves whenReleased at once when no hold is active', async () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);

  expect(await settled(publisher.whenReleased())).toBe(true);
});

it('resolves whenReleased after the program ends the hold', async () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);

  terminal.write(encoder.encode('\u001B[?2026hheld'));
  terminal.stableRows();
  publisher.publish();

  const released = publisher.whenReleased();

  expect(await settled(released)).toBe(false);

  terminal.write(encoder.encode('\u001B[?2026l'));
  terminal.stableRows();
  publisher.publish();

  expect(await settled(released)).toBe(true);
});

it('resolves whenReleased after the watchdog even if no publication saw the hold', async () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal, 5);

  terminal.write(encoder.encode('\u001B[?2026hheld'));
  terminal.stableRows();

  const released = publisher.whenReleased();

  expect(await settled(released)).toBe(false);

  await Promise.race([released, Bun.sleep(200)]);

  expect(await settled(released)).toBe(true);
  expect(terminal.renderHeld()).toBe(false);
});

it('resolves whenReleased on dispose', async () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);

  terminal.write(encoder.encode('\u001B[?2026hheld'));

  const released = publisher.whenReleased();

  publisher[Symbol.dispose]();

  expect(await settled(released)).toBe(true);
});

it.each(['release', 'dispose'] as const)('cancels the hold watchdog on %s', async (action) => {
  const terminal = terminalForTest();
  const requests: string[] = [];
  using publisher = createRowPublisher(
    terminal,
    1,
    { columns: 80, rows: 24 },
    {
      holdLimitMs: 5,
      requestPublication: () => {
        requests.push('publish');
      },
    },
  );

  terminal.write(encoder.encode('\u001B[?2026hheld'));
  terminal.stableRows();
  publisher.publish();

  if (action === 'release') {
    terminal.write(encoder.encode('\u001B[?2026l'));
    terminal.stableRows();
    publisher.publish();
  } else {
    publisher[Symbol.dispose]();
  }

  await Bun.sleep(20);

  expect(requests).toEqual([]);
});

it('sends cursor and mode changes without rows and stops sending after unsubscribe', () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);
  const updates: RowUpdate[] = [];
  const { unsubscribe } = publisher.subscribe((update) => updates.push(update));

  publisher.publish();
  terminal.write(encoder.encode('\u001B[3;4H\u001B[?25l\u001B[?2004h'));
  terminal.stableRows();
  publisher.publish();

  const update = lastUpdate(updates);

  expect(update.rowCount).toBe(0);
  expect(update.cursor).toEqual({ x: 3, y: 2, visible: false });
  expect(update.modes & ModeFlag.bracketedPaste).not.toBe(0);

  unsubscribe();
  terminal.write(encoder.encode('after'));
  terminal.stableRows();
  publisher.publish();

  expect(updates).toHaveLength(2);
});

it('sends the whole screen at the new size to every subscriber after a size change', () => {
  const terminal = terminalForTest();
  const publisher = publisherForTest(terminal);
  const first: RowUpdate[] = [];
  const second: RowUpdate[] = [];

  publisher.subscribe((update) => first.push(update));
  publisher.subscribe((update) => second.push(update));
  publisher.publish();
  terminal.write(encoder.encode('hello'));
  terminal.stableRows();
  publisher.publish();

  expect(lastUpdate(first).rowCount).toBe(1);

  terminal.resize(60, 10);
  publisher.resize({ columns: 60, rows: 10 });
  terminal.stableRows();
  publisher.publish();

  for (const updates of [first, second]) {
    const update = lastUpdate(updates);

    expect(update.size).toEqual({ columns: 60, rows: 10 });
    expect(update.rowCount).toBe(10);
    expect(rowsOf(update).get(0)).toBe('hello');
  }
});

it('pauses a subscriber at the in-flight limit and resumes it on an ack', () => {
  const terminal = terminalForTest();
  const requests: string[] = [];
  using publisher = createRowPublisher(
    terminal,
    1,
    { columns: 80, rows: 24 },
    {
      inFlightLimit: 3,
      requestPublication: () => {
        requests.push('publish');
      },
    },
  );

  const paused: RowUpdate[] = [];
  const running: RowUpdate[] = [];
  const subscription = publisher.subscribe((update) => paused.push(update));

  const acking = publisher.subscribe((update) => {
    running.push(update);
    acking.acknowledge(update.sequence);
  });

  for (let line = 0; line < 8; line += 1) {
    terminal.write(encoder.encode(`line ${line}\r\n`));
    terminal.stableRows();
    publisher.publish();
  }

  expect(paused).toHaveLength(3);
  expect(running).toHaveLength(8);
  expect(requests).toEqual([]);
  expect(subscription.acknowledge(lastUpdate(paused).sequence + 100)).toBe(false);
  expect(requests).toEqual([]);

  expect(subscription.acknowledge(lastUpdate(paused).sequence)).toBe(true);
  expect(subscription.acknowledge(lastUpdate(paused).sequence)).toBe(false);
  expect(requests).toEqual(['publish']);

  publisher.publish();

  expect(paused).toHaveLength(4);

  const rows = rowsOf(lastUpdate(paused));

  expect([...rows.values()]).toContain('line 7');
});
