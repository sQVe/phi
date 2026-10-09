import { expect, it, onTestFinished } from 'bun:test';

import { createRowCache } from '../src/client/client.ts';
import { cellWords } from '../src/rows/rows.ts';
import type { RowUpdate } from '../src/rows/rows.ts';
import { createRowPublisher } from '../src/server/rowPublisher.ts';
import { createTerminal } from '../src/vt/vt.ts';

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

const lastUpdate = (updates: RowUpdate[]): RowUpdate => {
  const update = updates.at(-1);

  if (update === undefined) {
    throw new Error('No row update arrived.');
  }

  return update;
};

it('sends one update with the newest screen after an ack, matching the terminal', () => {
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

  const updates: RowUpdate[] = [];
  const subscription = publisher.subscribe((update) => updates.push(update));
  const cache = createRowCache({ rowLimit: 1000 });

  for (let line = 0; line < 8; line += 1) {
    terminal.write(encoder.encode(`line ${line}\r\n`));
    terminal.stableRows();
    publisher.publish();
  }

  expect(updates).toHaveLength(3);
  expect(requests).toEqual([]);

  for (const update of updates) {
    cache.apply(update);
  }

  subscription.acknowledge(lastUpdate(updates).sequence);

  expect(requests).toEqual(['publish']);

  publisher.publish();

  expect(updates).toHaveLength(4);

  cache.apply(lastUpdate(updates));

  const { epoch, activeTop } = terminal.stableRows();
  const read = terminal.readRows(epoch, activeTop, 24);

  if (!read.ok) {
    throw new Error('The active screen must be readable.');
  }

  const stride = 1 + 80 * cellWords;

  for (let index = 0; index < 24; index += 1) {
    const start = index * stride;
    const expected = read.rows.cells.subarray(start + 1, start + stride);

    expect(cache.row(index)?.cells).toEqual(expected);
  }
});

const expectCacheMatchesTerminal = (
  cache: ReturnType<typeof createRowCache>,
  terminal: ReturnType<typeof terminalForTest>,
): void => {
  const { epoch, activeTop } = terminal.stableRows();
  const read = terminal.readRows(epoch, activeTop, 24);

  if (!read.ok) {
    throw new Error('The active screen must be readable.');
  }

  const stride = 1 + 80 * cellWords;

  for (let index = 0; index < 24; index += 1) {
    const start = index * stride;
    const expected = read.rows.cells.subarray(start + 1, start + stride);

    expect(cache.row(index)?.cells).toEqual(expected);
  }
};

const pacedPublisher = (terminal: ReturnType<typeof terminalForTest>) => {
  const publisher = createRowPublisher(
    terminal,
    1,
    { columns: 80, rows: 24 },
    {
      inFlightLimit: 2,
      requestPublication: () => undefined,
    },
  );

  onTestFinished(() => {
    publisher[Symbol.dispose]();
  });

  const updates: RowUpdate[] = [];
  const cache = createRowCache({ rowLimit: 1000 });

  const subscription = publisher.subscribe((update) => {
    updates.push(update);
    cache.apply(update);
  });

  const publish = (text: string): void => {
    terminal.write(encoder.encode(text));
    terminal.stableRows();
    publisher.publish();
  };

  return { publisher, updates, cache, subscription, publish };
};

it('keeps the primary screen right after a paused client missed a return from the alternate screen', () => {
  const terminal = terminalForTest();
  const { publisher, updates, cache, subscription, publish } = pacedPublisher(terminal);

  publish('shell prompt');
  publish('\u001B[?1049hfull screen');
  publish('more');
  publish('\u001B[?1049l');

  expect(updates).toHaveLength(2);

  subscription.acknowledge(lastUpdate(updates).sequence);
  publisher.publish();

  expect(updates).toHaveLength(3);
  expectCacheMatchesTerminal(cache, terminal);
});

it('keeps the alternate screen right after a paused client missed the switch to it', () => {
  const terminal = terminalForTest();
  const { publisher, updates, cache, subscription, publish } = pacedPublisher(terminal);

  publish('shell prompt');
  publish('more');
  publish('\u001B[?1049hfull screen');

  expect(updates).toHaveLength(2);

  subscription.acknowledge(lastUpdate(updates).sequence);
  publisher.publish();

  expect(updates).toHaveLength(3);
  expectCacheMatchesTerminal(cache, terminal);
});

it('sends no more updates when acks open a window that skipped nothing', () => {
  const terminal = terminalForTest();
  let acking = false;
  const updates: RowUpdate[] = [];
  using publisher = createRowPublisher(
    terminal,
    1,
    { columns: 80, rows: 24 },
    {
      inFlightLimit: 2,
      requestPublication: () => {
        publisher.publish();
      },
    },
  );

  const subscription = publisher.subscribe((update) => {
    updates.push(update);

    if (acking && updates.length < 50) {
      subscription.acknowledge(update.sequence);
    }
  });

  publisher.publish();
  terminal.write(encoder.encode('x'));
  terminal.stableRows();
  publisher.publish();

  expect(updates).toHaveLength(2);

  acking = true;
  subscription.acknowledge(1);
  subscription.acknowledge(2);

  expect(updates).toHaveLength(2);
});

it('pauses on the byte budget before the update count limit', () => {
  const terminal = terminalForTest();
  using publisher = createRowPublisher(
    terminal,
    1,
    { columns: 80, rows: 24 },
    {
      inFlightLimit: 8,
      inFlightBytes: 70_000,
      requestPublication: () => undefined,
    },
  );

  const updates: RowUpdate[] = [];

  publisher.subscribe((update) => updates.push(update));

  for (const character of 'abcdef') {
    const line = character.repeat(80);

    terminal.write(encoder.encode(`\u001B[H${`${line}\r\n`.repeat(23)}${line}`));
    terminal.stableRows();
    publisher.publish();
  }

  expect(updates).toHaveLength(2);
});
