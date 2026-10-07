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
import { createLog } from '../src/server/log.ts';
import type { Log } from '../src/server/log.ts';
import * as processGroups from '../src/server/processGroups.ts';
import { runServer } from '../src/server/server.ts';
import type { Server } from '../src/server/server.ts';
import { claimSocketPath } from '../src/server/socketPath.ts';

interface TestClient {
  messages: ControlMessage[];
  closed: Promise<void>;
  send: (message: ControlMessage) => void;
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

const connect = async (socketPath: string): Promise<TestClient> => {
  const decoder = createFrameDecoder();
  const messages: ControlMessage[] = [];
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

  let read = 0;

  const nextMessage = async (): Promise<ControlMessage> => {
    while (messages.length <= read) {
      if (isClosed) {
        throw new Error('The connection closed before a message arrived.');
      }

      const { promise, resolve } = Promise.withResolvers<undefined>();

      waiting.push(() => {
        resolve(undefined);
      });

      await promise;
    }

    const message = messages[read];
    read += 1;

    if (message === undefined) {
      throw new Error('No message arrived.');
    }

    return message;
  };

  const send = (message: ControlMessage): void => {
    socket.write(encodeFrame(FrameKind.control, encodeControl(message)));
  };

  return { messages, closed, send, nextMessage };
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
