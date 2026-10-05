import { expect, it, onTestFinished } from 'bun:test';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { createFrameDecoder, encodeFrame, FrameKind } from '../src/protocol/frames.ts';
import { encodeControl, parseControl } from '../src/protocol/messages.ts';
import type { BuildVersion, ControlMessage } from '../src/protocol/messages.ts';
import { createLog } from '../src/server/log.ts';
import type { Log } from '../src/server/log.ts';
import { runServer } from '../src/server/server.ts';
import type { Server } from '../src/server/server.ts';

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

it('welcomes a client from the same build and removes the socket when it stops', async () => {
  const directory = await temporaryDirectory();
  const { server, socketPath } = await startServer(directory);
  const client = await connect(socketPath);

  client.send({ type: 'hello', version: build, size: undefined });

  expect(await client.nextMessage()).toEqual({ type: 'welcome' });

  server.stop();
  await server.stopped;

  expect(existsSync(socketPath)).toBe(false);
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
});

it('parses what the shell writes to its PTY', async () => {
  const directory = await temporaryDirectory();
  const { server } = await startServer(directory);

  server.writeToPane('echo phi-ready\n');

  // The PTY echoes the command too, so wait for the line the command prints.
  await waitFor(() => server.paneText()?.split('\n').includes('phi-ready') === true);
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

const hasQueueWarning = (logPath: string): boolean => {
  if (!existsSync(logPath)) {
    return false;
  }

  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => logLineSchema.parse(JSON.parse(line)))
    .some((line) => line.level === 'warn' && line.fields.limitBytes !== undefined);
};

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
