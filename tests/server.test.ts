import { expect, it, onTestFinished, spyOn } from 'bun:test';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { paneId } from '../src/ids.ts';
import { createFrameDecoder, encodeFrame, FrameKind } from '../src/protocol/frames.ts';
import { encodeControl, parseControl } from '../src/protocol/messages.ts';
import type { BuildVersion, ControlMessage } from '../src/protocol/messages.ts';
import { cellWords, decodeRowUpdate } from '../src/rows/rows.ts';
import type { RowUpdate } from '../src/rows/rows.ts';
import { createLog } from '../src/server/log.ts';
import type { Log } from '../src/server/log.ts';
import * as processGroups from '../src/server/processGroups.ts';
import { runServer } from '../src/server/server.ts';
import type { Server } from '../src/server/server.ts';
import { claimSocketPath } from '../src/server/socketPath.ts';
import { Terminal } from '../src/vt/vt.ts';
import type { ReadRowsResult } from '../src/vt/vt.ts';

interface TestClient {
  messages: ControlMessage[];
  updates: RowUpdate[];
  nextUpdate: () => Promise<RowUpdate>;
  closed: Promise<void>;
  close: () => void;
  send: (message: ControlMessage) => void;
  sendTogether: (messages: ControlMessage[]) => void;
  nextMessage: () => Promise<ControlMessage>;
}

const logLineSchema = z.object({ level: z.string(), fields: z.record(z.string(), z.unknown()) });

const build: BuildVersion = { version: '1.2.3', ghostty: 'abc123' };

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-server-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return directory;
};

const waitFor = async (condition: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;

  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error('The condition did not hold in time.');
    }

    await Bun.sleep(10);
  }
};

const commandLineOf = (processId: string): string | undefined => {
  try {
    return readFileSync(join('/proc', processId, 'cmdline'), 'utf8')
      .replaceAll('\0', ' ')
      .trim();
  } catch {
    return undefined;
  }
};

const processesRunning = (commandLine: string): string[] =>
  readdirSync('/proc').filter((name) => commandLineOf(name) === commandLine);

// True until the process is reaped, so an exited process that nobody has waited for still counts.
const processExists = (processId: number): boolean => {
  try {
    process.kill(processId, 0);

    return true;
  } catch {
    return false;
  }
};

const isRoot = process.getuid?.() === 0;

const openLog = (path: string): Log => {
  const created = createLog(path, Date.now);

  if (!created.ok) {
    throw new Error(created.message);
  }

  return created.log;
};

const startServer = async (
  directory: string,
  shell = '/bin/sh',
): Promise<{ server: Server; socketPath: string; logPath: string }> => {
  const socketPath = join(directory, 'run', 'phi.sock');
  const logPath = join(directory, 'state', 'phi', 'server.log');
  const log = openLog(logPath);

  const result = await runServer({
    socketPath,
    version: build,
    log,
    environment: { ...process.env, SHELL: shell },
    directory,
    holdLimitMs: 60_000,
  });

  if (!result.ok) {
    throw new Error(result.message);
  }

  const { server } = result;

  // The server logs while it stops, so the directory goes after it.
  onTestFinished(async () => {
    server.stop();
    await server.stopped;
    await rm(directory, { recursive: true, force: true });
  });

  return { server, socketPath, logPath };
};

const createReader = <Item>(
  items: Item[],
  waiting: (() => void)[],
  isClosed: () => boolean,
): (() => Promise<Item>) => {
  let read = 0;

  return async () => {
    while (items.length <= read) {
      if (isClosed()) {
        throw new Error('The connection closed before an item arrived.');
      }

      const { promise, resolve } = Promise.withResolvers<undefined>();

      waiting.push(() => {
        resolve(undefined);
      });

      await promise;
    }

    const item = items[read];

    read += 1;

    if (item === undefined) {
      throw new Error('No item arrived.');
    }

    return item;
  };
};

const connect = async (socketPath: string): Promise<TestClient> => {
  const decoder = createFrameDecoder();
  const messages: ControlMessage[] = [];
  const updates: RowUpdate[] = [];
  const waiting: (() => void)[] = [];
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<undefined>();
  let isClosed = false;

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data: (_socket, bytes) => {
        const decoded = decoder.push(bytes);

        if (!decoded.ok) {
          throw new Error(decoded.reason);
        }

        for (const frame of decoded.frames) {
          if (frame.kind === FrameKind.rowUpdate) {
            const parsed = decodeRowUpdate(frame.payload);

            if (!parsed.ok) {
              throw new Error(parsed.reason);
            }

            updates.push(parsed.update);

            continue;
          }

          const parsed = parseControl(frame.payload);

          if (!parsed.ok) {
            throw new Error(parsed.reason);
          }

          messages.push(parsed.message);
        }

        for (const wake of waiting.splice(0)) {
          wake();
        }
      },
      close: () => {
        isClosed = true;
        markClosed(undefined);

        for (const wake of waiting.splice(0)) {
          wake();
        }
      },
    },
  });

  onTestFinished(() => {
    socket.end();
  });

  const nextMessage = createReader(messages, waiting, () => isClosed);
  const nextUpdate = createReader(updates, waiting, () => isClosed);

  const send = (message: ControlMessage): void => {
    socket.write(encodeFrame(FrameKind.control, encodeControl(message)));
  };

  const sendTogether = (batch: ControlMessage[]): void => {
    const frames = batch.map((message) => encodeFrame(FrameKind.control, encodeControl(message)));

    socket.write(Buffer.concat(frames));
  };

  return {
    messages,
    updates,
    nextUpdate,
    closed,
    close: () => {
      socket.end();
    },
    send,
    sendTogether,
    nextMessage,
  };
};

const serverModule = join(import.meta.dir, '..', 'src', 'server', 'server.ts');

const logModule = join(import.meta.dir, '..', 'src', 'server', 'log.ts');

// Runs a server in its own process, so the test can signal it. Lines on stdin go to the pane.
const serverScript = (socketPath: string): string => `
  import { createLog, logPathFor } from ${JSON.stringify(logModule)};
  import { runServer } from ${JSON.stringify(serverModule)};

  const created = createLog(logPathFor(process.env.XDG_STATE_HOME, '/nonexistent'), Date.now);

  if (!created.ok) {
    console.error(created.message);
    process.exit(1);
  }

  const result = await runServer({
    socketPath: ${JSON.stringify(socketPath)},
    version: ${JSON.stringify(build)},
    log: created.log,
    environment: { ...process.env, SHELL: '/bin/sh' },
    directory: process.cwd(),
  });

  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }

  process.stdin.on('data', (bytes) => result.server.writeToPane(bytes.toString()));
  console.log('listening');
  await result.server.stopped;
  process.exit(0);
`;

const readUntil = async (stream: ReadableStream<Uint8Array>, text: string): Promise<void> => {
  const decoder = new TextDecoder();
  let read = '';

  for await (const chunk of stream) {
    read += decoder.decode(chunk);

    if (read.includes(text)) {
      return;
    }
  }

  throw new Error(`The output ended before ${text}: ${read}`);
};

const startServerProcess = async (directory: string) => {
  const socketPath = join(directory, 'run', 'phi.sock');

  const child = Bun.spawn([process.execPath, '--eval', serverScript(socketPath)], {
    cwd: directory,
    env: { ...process.env, XDG_STATE_HOME: join(directory, 'state') },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });

  onTestFinished(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
    }

    await child.exited;
  });

  await readUntil(child.stdout, 'listening');

  return { child, socketPath };
};

it.each(['paneRead', 'paneSend'] as const)(
  'refuses %s for a pane other than the live pane without changing it',
  async (type) => {
    const directory = await temporaryDirectory();
    const { server, socketPath } = await startServer(directory);

    server.writeToPane("printf 'ready-marker\\n'\n");
    await waitFor(() => server.paneText()?.includes('ready-marker') === true);

    const client = await connect(socketPath);

    client.send({ type: 'hello', version: build, size: undefined });
    expect(await client.nextMessage()).toEqual({ type: 'welcome' });
    await client.nextMessage();

    const before = server.snapshot();
    const missing = paneId(99);

    const message: ControlMessage =
      type === 'paneRead'
        ? { type, paneId: missing }
        : { type, paneId: missing, text: 'must-not-reach-live-pane' };

    client.send(message);

    expect(await client.nextMessage()).toEqual({ type: 'paneMissing', paneId: missing });
    expect(server.snapshot()).toEqual(before);

    client.send({ type: 'paneRead', paneId: paneId(1) });

    const read = await client.nextMessage();

    expect(read.type).toBe('paneRows');

    if (read.type !== 'paneRows') {
      throw new Error('Expected the live pane rows.');
    }

    expect(read.rows.join('\n')).toContain('ready-marker');
    expect(read.rows.join('\n')).not.toContain('must-not-reach-live-pane');
  },
);

it('answers paneRead during a synchronized-output hold only after the hold ends', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const client = await connect(socketPath);

  client.send({ type: 'hello', version: build, size: undefined });
  expect(await client.nextMessage()).toEqual({ type: 'welcome' });
  await client.nextMessage();

  server.writeToPane('printf \'\\033[?2026hhalf-\'"drawn"\n');
  await waitFor(() => server.paneText()?.includes('half-drawn') === true);

  // The server handles frames in order, so this answer shows it took the read before it.
  client.sendTogether([
    { type: 'paneRead', paneId: paneId(1) },
    { type: 'paneSend', paneId: paneId(1), text: '' },
  ]);

  expect(await client.nextMessage()).toEqual({ type: 'paneSent', paneId: paneId(1) });
  expect(client.messages.map((message) => message.type)).not.toContain('paneRows');

  server.writeToPane("printf '\\033[2J\\033[Hfull-'\"drawn\"'\\033[?2026l'\n");

  const read = await client.nextMessage();

  if (read.type !== 'paneRows') {
    throw new Error('Expected the live pane rows.');
  }

  const text = read.rows.join('\n');

  expect(text).toContain('full-drawn');
  expect(text).not.toContain('half-drawn');
});

it.each(['paneSend', 'stop'] as const)(
  'answers paneRead with rows before a %s in the same write',
  async (type) => {
    const directory = await temporaryDirectory();
    const { server, socketPath } = await startServer(directory);
    const client = await connect(socketPath);

    client.send({ type: 'hello', version: build, size: undefined });
    expect(await client.nextMessage()).toEqual({ type: 'welcome' });
    await client.nextMessage();

    server.writeToPane("printf 'ready-marker\\n'\n");
    await waitFor(() => server.paneText()?.includes('ready-marker') === true);

    const next: ControlMessage =
      type === 'paneSend' ? { type, paneId: paneId(1), text: '' } : { type };

    client.sendTogether([{ type: 'paneRead', paneId: paneId(1) }, next]);

    const read = await client.nextMessage();

    if (read.type !== 'paneRows') {
      throw new Error('Expected the live pane rows.');
    }

    expect(read.rows.join('\n')).toContain('ready-marker');

    if (type === 'paneSend') {
      expect(await client.nextMessage()).toEqual({ type: 'paneSent', paneId: paneId(1) });
    }
  },
);

it('removes the socket it bound even when its symlink route changes', async () => {
  const directory = await temporaryDirectory();
  const real = join(directory, 'real');
  const link = join(directory, 'link');
  await mkdir(real, { mode: 0o700 });
  await mkdir(join(directory, 'other'), { mode: 0o700 });
  await symlink(real, link);

  const result = await runServer({
    socketPath: join(link, 'phi', 'phi.sock'),
    version: build,
    log: openLog(join(directory, 'state', 'phi', 'server.log')),
    environment: { ...process.env, SHELL: '/bin/sh' },
    directory,
  });

  if (!result.ok) {
    throw new Error(result.message);
  }

  await symlink(join(directory, 'other'), join(directory, 'next'));
  await rename(join(directory, 'next'), link);
  result.server.stop();
  await result.server.stopped;

  expect(existsSync(join(real, 'phi', 'phi.sock'))).toBe(false);
});

it('creates the socket for its owner only, whatever the umask', async () => {
  const directory = await temporaryDirectory();
  const previous = process.umask(0);

  onTestFinished(() => {
    process.umask(previous);
  });

  const { socketPath } = await startServer(directory);

  process.umask(previous);

  expect(statSync(socketPath).mode & 0o777).toBe(0o600);
});

it('welcomes a client from the same build and removes the socket when it stops', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const client = await connect(socketPath);

  client.send({ type: 'hello', version: build, size: undefined });

  expect(await client.nextMessage()).toEqual({ type: 'welcome' });

  server.stop();

  expect(await server.stopped).toEqual({ ok: true });
  expect(existsSync(socketPath)).toBe(false);
});

it('sends a snapshot after welcome and each later change in revision order', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const client = await connect(socketPath);

  client.send({ type: 'hello', version: build, size: undefined });

  expect(await client.nextMessage()).toEqual({ type: 'welcome' });

  const initial = await client.nextMessage();

  expect(initial.type).toBe('snapshot');

  if (initial.type !== 'snapshot') {
    throw new Error('Expected a snapshot.');
  }

  expect(initial.snapshot.pane?.id).toBe(paneId(1));

  server.writeToPane('exit\n');
  await server.stopped;
  await client.closed;

  expect(client.messages.slice(2)).toEqual([
    {
      type: 'change',
      revision: initial.snapshot.revision + 1,
      change: { type: 'paneStateChanged', paneId: paneId(1), lifecycle: 'exited', exitCode: 0 },
    },
    {
      type: 'change',
      revision: initial.snapshot.revision + 2,
      change: { type: 'serverStopping' },
    },
  ]);
});

it('resyncs after dropping a change inside a multi-change transition', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const client = await connect(socketPath);

  server.writeToPane("trap '' HUP; echo ready-$((6 * 7))\n");
  await waitFor(() => server.paneText()?.includes('ready-42') === true);
  client.send({ type: 'hello', version: build, size: undefined });
  await client.nextMessage();

  const initial = await client.nextMessage();

  if (initial.type !== 'snapshot') {
    throw new Error('Expected a snapshot.');
  }

  server.stop();

  const dropped = await client.nextMessage();
  const received = await client.nextMessage();

  expect(dropped).toMatchObject({ type: 'change', change: { type: 'paneStateChanged' } });

  if (received.type !== 'change') {
    throw new Error('Expected a change.');
  }

  const hasGap = received.revision > initial.snapshot.revision + 1;

  expect(hasGap).toBe(true);

  if (hasGap) {
    client.send({ type: 'resync' });
  }

  const recovered = await client.nextMessage();

  expect(recovered).toEqual({ type: 'snapshot', snapshot: server.snapshot() });

  expect(recovered).toMatchObject({
    snapshot: { revision: received.revision, pane: { lifecycle: 'closing' } },
  });

  server.writeToPane('exit\n');
  await server.stopped;
});

it('broadcasts changes to every welcomed client but not a connection waiting for hello', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const first = await connect(socketPath);
  const second = await connect(socketPath);
  const waiting = await connect(socketPath);

  first.send({ type: 'hello', version: build, size: undefined });
  second.send({ type: 'hello', version: build, size: undefined });
  await first.nextMessage();
  await second.nextMessage();

  const initial = await first.nextMessage();

  expect(await second.nextMessage()).toEqual(initial);

  server.writeToPane('exit\n');
  await server.stopped;
  await Promise.all([first.closed, second.closed, waiting.closed]);

  expect(first.messages.slice(2)).toHaveLength(2);
  expect(second.messages).toEqual(first.messages);
  expect(waiting.messages).toEqual([]);
});

it('sends no snapshot or changes to a stop-only connection', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const client = await connect(socketPath);

  client.send({ type: 'stop' });
  await server.stopped;
  await client.closed;

  expect(client.messages).toEqual([]);
});

const applyRows = (rows: Map<number, string>, update: RowUpdate): void => {
  const stride = 1 + update.size.columns * cellWords;

  for (let start = 0; start < update.cells.length; start += stride) {
    const points: number[] = [];

    for (let column = 0; column < update.size.columns; column += 1) {
      points.push(update.cells[start + 1 + column * cellWords] ?? 0);
    }

    const offset = (update.cells[start] ?? 0) | 0;

    const text = String.fromCodePoint(...points)
      .replaceAll('\0', ' ')
      .trimEnd();

    rows.set(update.activeTop + offset, text);
  }
};

const receiveText = async (
  client: TestClient,
  rows: Map<number, string>,
  text: string,
): Promise<void> => {
  while (![...rows.values()].some((row) => row.includes(text))) {
    const update = await client.nextUpdate();

    applyRows(rows, update);
  }
};

it('publishes ordered rows to terminal clients but not CLI clients', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const terminal = await connect(socketPath);
  const cli = await connect(socketPath);

  terminal.send({ type: 'hello', version: build, size: { columns: 100, rows: 30 } });
  cli.send({ type: 'hello', version: build, size: undefined });

  expect(await terminal.nextMessage()).toEqual({ type: 'welcome' });
  expect(await cli.nextMessage()).toEqual({ type: 'welcome' });
  expect(await terminal.nextMessage()).toMatchObject({ type: 'snapshot' });
  expect(await cli.nextMessage()).toMatchObject({ type: 'snapshot' });

  const first = await terminal.nextUpdate();
  const rows = new Map<number, string>();

  applyRows(rows, first);

  expect(first.pane).toBe(1);
  expect(first.size).toEqual({ columns: 100, rows: 29 });
  expect(first.rowCount).toBe(29);

  server.writeToPane('echo first-$((6 * 7))\n');
  await receiveText(terminal, rows, 'first-42');
  server.writeToPane('echo second-$((7 * 7))\n');
  await receiveText(terminal, rows, 'second-49');

  expect([...rows.values()].some((row) => row.includes('first-42'))).toBe(true);
  expect(terminal.updates.length).toBeGreaterThan(1);

  for (let index = 1; index < terminal.updates.length; index += 1) {
    expect(terminal.updates[index]?.sequence).toBeGreaterThan(
      terminal.updates[index - 1]?.sequence ?? 0,
    );
  }

  cli.send({ type: 'resync' });
  await cli.nextMessage();

  expect(cli.updates).toEqual([]);
});

const nextPaneResize = async (client: TestClient) => {
  for (;;) {
    const message = await client.nextMessage();

    if (message.type === 'change' && message.change.type === 'paneResized') {
      return message.change;
    }
  }
};

it('resizes the pane to the client size less the status bar when a sized hello arrives', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const client = await connect(socketPath);

  client.send({ type: 'hello', version: build, size: { columns: 100, rows: 30 } });

  const resized = await nextPaneResize(client);

  expect(resized.size).toEqual({ columns: 100, rows: 29 });
  expect(server.snapshot().pane?.size).toEqual({ columns: 100, rows: 29 });

  const update = await client.nextUpdate();

  expect(update.size).toEqual({ columns: 100, rows: 29 });
});

it('keeps change revisions consecutive when a stalled terminal overflows its write queue', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const stalled = createConnection(socketPath);

  stalled.on('error', () => undefined);
  onTestFinished(() => stalled.destroy());
  await once(stalled, 'connect');
  stalled.pause();

  stalled.write(
    encodeFrame(
      FrameKind.control,
      encodeControl({
        type: 'hello',
        version: build,
        size: { columns: 80, rows: 1 },
      }),
    ),
  );

  await waitFor(() => server.snapshot().clients.length === 1);

  const observer = await connect(socketPath);

  observer.send({ type: 'hello', version: build, size: undefined });
  await observer.nextMessage();

  const initial = await observer.nextMessage();

  if (initial.type !== 'snapshot') {
    throw new Error('Expected the initial snapshot.');
  }

  const frames = Array.from({ length: 100 }, (_, index) =>
    encodeFrame(
      FrameKind.control,
      encodeControl({ type: 'resize', size: { columns: 80, rows: (index % 2) + 1 } }),
    ),
  );

  const batch = Buffer.concat(frames);
  let latest = initial.snapshot;

  for (let sent = 0; sent < 40_000 && latest.clients.length > 0; sent += frames.length) {
    stalled.write(batch);
    observer.send({ type: 'resync' });

    for (;;) {
      const message = await observer.nextMessage();

      if (message.type === 'snapshot') {
        latest = message.snapshot;

        break;
      }
    }
  }

  expect(latest.clients).toEqual([]);
  expect(latest.attachedClientId).toBeUndefined();

  const changes = observer.messages.flatMap((message) =>
    message.type === 'change' ? [message] : [],
  );

  const revisions = changes.map((message) => message.revision);
  const expected = revisions.map((_, index) => initial.snapshot.revision + index + 1);

  expect(revisions).toEqual(expected);
  expect(changes.at(-1)?.change).toMatchObject({ type: 'clientDetached', reason: 'requested' });
  expect(revisions.at(-1)).toBe(latest.revision);
});

it('removes a closed terminal client from subsequent snapshots', async () => {
  const directory = await temporaryDirectory();
  const { socketPath } = await startServer(directory);
  const first = await connect(socketPath);

  first.send({ type: 'hello', version: build, size: { columns: 100, rows: 30 } });
  await nextPaneResize(first);
  first.close();
  await first.closed;

  const second = await connect(socketPath);

  second.send({ type: 'hello', version: build, size: undefined });
  expect(await second.nextMessage()).toEqual({ type: 'welcome' });

  expect(await second.nextMessage()).toMatchObject({
    type: 'snapshot',
    snapshot: { attachedClientId: undefined, clients: [] },
  });
});

it('attaches after a closed terminal without a takeover change', async () => {
  const directory = await temporaryDirectory();
  const { socketPath } = await startServer(directory);
  const first = await connect(socketPath);

  first.send({ type: 'hello', version: build, size: { columns: 100, rows: 30 } });
  await nextPaneResize(first);
  first.close();
  await first.closed;

  const second = await connect(socketPath);

  second.send({ type: 'hello', version: build, size: { columns: 90, rows: 20 } });
  await nextPaneResize(second);

  const changes = second.messages.flatMap((message) =>
    message.type === 'change' ? [message.change] : [],
  );

  expect(changes.some((change) => change.type === 'clientAttached')).toBe(true);
  expect(changes.filter((change) => change.type === 'clientDetached')).toEqual([]);
});

it('resizes the pane when an attached client sends resize', async () => {
  const directory = await temporaryDirectory();
  const { socketPath } = await startServer(directory);
  const client = await connect(socketPath);

  client.send({ type: 'hello', version: build, size: { columns: 100, rows: 30 } });
  await nextPaneResize(client);
  client.send({ type: 'resize', size: { columns: 90, rows: 20 } });

  const resized = await nextPaneResize(client);

  expect(resized.size).toEqual({ columns: 90, rows: 19 });

  await waitFor(() => client.updates.some((update) => update.size.columns === 90));

  const latest = client.updates.at(-1);

  expect(latest?.size).toEqual({ columns: 90, rows: 19 });
});

it('ignores resize from a connection without a client', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const cli = await connect(socketPath);

  cli.send({ type: 'hello', version: build, size: undefined });
  await cli.nextMessage();
  await cli.nextMessage();
  cli.send({ type: 'resize', size: { columns: 90, rows: 20 } });
  cli.send({ type: 'resync' });

  const answer = await cli.nextMessage();

  expect(answer).toMatchObject({ type: 'snapshot' });
  expect(server.snapshot().pane?.size).toEqual({ columns: 80, rows: 24 });
});

it('publishes every changed row when range reads run between pane writes', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const client = await connect(socketPath);
  const rows = new Map<number, string>();
  const reads: ReadRowsResult[] = [];
  const originalWrite = Terminal.prototype.write;

  const write = spyOn(Terminal.prototype, 'write').mockImplementation(function (
    this: Terminal,
    bytes: Uint8Array,
  ) {
    const reply = originalWrite.call(this, bytes);
    const stable = this.stableRows();

    reads.push(this.readRows(stable.epoch, stable.activeTop, 24));

    return reply;
  });

  onTestFinished(() => {
    write.mockRestore();
  });

  client.send({ type: 'hello', version: build, size: { columns: 80, rows: 24 } });
  applyRows(rows, await client.nextUpdate());

  server.writeToPane('echo range-$((6 * 7))\n');
  await receiveText(client, rows, 'range-42');
  server.writeToPane('echo range-$((7 * 7))\n');
  await receiveText(client, rows, 'range-49');

  expect(reads.length).toBeGreaterThan(1);
  expect(reads.every((read) => read.ok)).toBe(true);
  expect([...rows.values()].some((row) => row.includes('range-42'))).toBe(true);
});

it('fails and leaves no socket when the shell cannot start', async () => {
  const directory = await temporaryDirectory();
  const socketPath = join(directory, 'run', 'phi.sock');

  const result = await runServer({
    socketPath,
    version: build,
    log: openLog(join(directory, 'state', 'phi', 'server.log')),
    environment: { ...process.env, SHELL: join(directory, 'missing-shell') },
    directory,
  });

  expect(result).toMatchObject({ ok: false, reason: 'paneFailedToStart' });
  expect(existsSync(socketPath)).toBe(false);
});

it('refuses a client from another build with both versions and closes the connection', async () => {
  const directory = await temporaryDirectory();
  const { socketPath } = await startServer(directory);
  const client = await connect(socketPath);
  const other: BuildVersion = { version: '1.2.4', ghostty: 'def456' };

  client.send({ type: 'hello', version: other, size: undefined });

  expect(await client.nextMessage()).toEqual({ type: 'refused', client: other, server: build });

  await client.closed;

  expect(client.messages).toEqual([{ type: 'refused', client: other, server: build }]);
});

it('parses what the shell writes to its PTY', async () => {
  const directory = await temporaryDirectory();
  const { server } = await startServer(directory);

  server.writeToPane('echo phi-$((6 * 7))\n');

  // The PTY echoes the command, and a shell without line editing prints its prompt before the
  // output, so look for text only the command's output holds.
  await waitFor(() => server.paneText()?.includes('phi-42') === true);
});

it('ends a pane job that ignores SIGHUP within the bounded wait and removes the socket', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  // A unique duration, so the test finds only its own sleep.
  const command = `sleep 1000.${process.pid}${Date.now()}`;

  server.writeToPane(`trap '' HUP; ${command}\n`);
  await waitFor(() => processesRunning(command).length > 0);

  const started = performance.now();

  server.stop();
  await server.stopped;

  expect(performance.now() - started).toBeLessThan(3000);
  await waitFor(() => processesRunning(command).length === 0, 1000);
  expect(existsSync(socketPath)).toBe(false);
});

it('keeps running after SIGHUP and stops when the shell exits', async () => {
  const directory = await temporaryDirectory();
  const { child, socketPath } = await startServerProcess(directory);

  child.kill('SIGHUP');

  const client = await connect(socketPath);

  client.send({ type: 'hello', version: build, size: undefined });

  expect(await client.nextMessage()).toEqual({ type: 'welcome' });

  await child.stdin.write('exit\n');
  await child.stdin.flush();

  expect(await child.exited).toBe(0);
  expect(existsSync(socketPath)).toBe(false);
});

it.each(['SIGTERM', 'SIGINT'] as const)('stops on %s and removes the socket', async (signal) => {
  const directory = await temporaryDirectory();
  const { child, socketPath } = await startServerProcess(directory);

  child.kill(signal);

  expect(await child.exited).toBe(0);
  expect(existsSync(socketPath)).toBe(false);
});

it('stops when a client sends stop', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const client = await connect(socketPath);

  client.send({ type: 'hello', version: build, size: undefined });
  await client.nextMessage();
  client.send({ type: 'stop' });

  await server.stopped;
  await client.closed;

  expect(existsSync(socketPath)).toBe(false);
});

const logLinesOf = (logPath: string) => {
  if (!existsSync(logPath)) {
    return [];
  }

  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => logLineSchema.parse(JSON.parse(line)));
};

const hasQueueWarning = (logPath: string): boolean =>
  logLinesOf(logPath).some((line) => line.level === 'warn' && line.fields.limitBytes !== undefined);

it('closes a connection that never reads once its queue is full, and keeps parsing the pane', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath, logPath } = await startServer(directory);
  const socket = createConnection(socketPath);
  const closed = Promise.withResolvers<undefined>();

  socket.once('close', () => {
    closed.resolve(undefined);
  });

  // The server closes the socket while this test still writes requests.
  socket.on('error', () => undefined);

  onTestFinished(() => {
    socket.destroy();
  });

  await once(socket, 'connect');
  socket.pause();

  const resync = encodeFrame(FrameKind.control, encodeControl({ type: 'resync' }));
  const requests = Array.from({ length: 40_000 }, () => resync);
  const hello = encodeControl({ type: 'hello', version: build, size: undefined });

  socket.write(encodeFrame(FrameKind.control, hello));
  socket.write(Buffer.concat(requests));

  await waitFor(() => hasQueueWarning(logPath));

  server.writeToPane('echo phi-$((6 * 7))\n');
  await waitFor(() => server.paneText()?.includes('phi-42') === true);

  socket.resume();
  await closed.promise;
});

it('ends the pane, closes connections, and removes the socket when stopping the pane fails', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath, logPath } = await startServer(directory);
  const client = await connect(socketPath);
  // A unique duration, so the test finds only its own sleep.
  const command = `sleep 1000.${process.pid}${Date.now()}`;

  client.send({ type: 'hello', version: build, size: undefined });
  await client.nextMessage();
  server.writeToPane(`exec ${command}\n`);
  await waitFor(() => processesRunning(command).length > 0);

  const [shellProcess] = processesRunning(command);

  const scan = spyOn(processGroups, 'sessionGroups').mockImplementation(() => {
    throw new Error('No /proc here.');
  });

  onTestFinished(() => {
    scan.mockRestore();
  });

  server.stop();

  const stopped = await server.stopped;

  expect(processExists(Number(shellProcess))).toBe(false);
  await client.closed;
  expect(stopped).toMatchObject({ ok: false, reason: 'cleanupFailed' });
  expect(existsSync(socketPath)).toBe(false);
  expect(logLinesOf(logPath).some((line) => line.fields.error === 'No /proc here.')).toBe(true);
});

it('starts a new server on the socket path after the first one stops', async () => {
  const directory = await temporaryDirectory();
  const first = await startServer(directory);

  first.server.stop();
  await first.server.stopped;

  const second = await startServer(directory);
  const client = await connect(second.socketPath);

  client.send({ type: 'hello', version: build, size: undefined });

  expect(await client.nextMessage()).toEqual({ type: 'welcome' });
});

it.skipIf(isRoot)(
  'releases the lock and reports the failure when it cannot remove its socket',
  async () => {
    const directory = await temporaryDirectory();
    const { server, socketPath, logPath } = await startServer(directory);
    const socketDirectory = join(directory, 'run');

    await chmod(socketDirectory, 0o500);

    let stopped: Awaited<Server['stopped']>;

    try {
      server.stop();
      stopped = await server.stopped;
    } finally {
      await chmod(socketDirectory, 0o700);
    }

    // The socket is left behind, and the next claim removes it as stale.
    const claimed = await claimSocketPath(socketPath);

    if (claimed.ok) {
      claimed.release();
    }

    expect(stopped).toMatchObject({ ok: false, reason: 'cleanupFailed' });
    expect(logLinesOf(logPath).some((line) => line.level === 'error')).toBe(true);
    expect(claimed).toMatchObject({ ok: true, path: socketPath });
  },
);
