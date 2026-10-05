import { expect, it, onTestFinished } from 'bun:test';
import { existsSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { createFrameDecoder, encodeFrame, FrameKind } from '../src/protocol/frames.ts';
import { encodeControl, parseControl } from '../src/protocol/messages.ts';
import type { ControlMessage } from '../src/protocol/messages.ts';
import { createLog } from '../src/server/log.ts';
import { runServer } from '../src/server/server.ts';
import { ghosttyCommit } from '../src/vt/vt.ts';
import { endServersIn, isRunning, serverProcessesIn, waitFor } from './serverProcesses.ts';

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const root = fileURLToPath(new URL('..', import.meta.url));

const startOutputSchema = z.object({ socket: z.string(), pid: z.number().int().positive() });

// The machine may be busy, and every command here starts Bun and loads the terminal library.
const cliTestTimeoutMs = 30_000;

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-cli-'));

  onTestFinished(async () => {
    await endServersIn(directory);
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
};

const environmentFor = (directory: string): Record<string, string | undefined> => ({
  ...process.env,
  XDG_STATE_HOME: join(directory, 'state'),
  XDG_RUNTIME_DIR: join(directory, 'runtime'),
});

const runCli = async (
  commandArguments: string[],
  directory: string,
  environment = environmentFor(directory),
): Promise<CliRun> => {
  const child = Bun.spawn(['bun', join(root, 'src/index.ts'), ...commandArguments], {
    cwd: directory,
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const buildVersion = () => {
  const commit = ghosttyCommit();

  if (!commit.ok) {
    throw new Error(commit.detail);
  }

  return { version: packageJson.version, ghostty: commit.commit };
};

// Sends hello as a client of this build and returns the first answer.
const helloAnswer = async (socketPath: string): Promise<ControlMessage> => {
  const decoder = createFrameDecoder();
  const answer = Promise.withResolvers<ControlMessage>();

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data: (_socket, bytes) => {
        const decoded = decoder.push(bytes);
        const first = decoded.ok ? decoded.frames[0] : undefined;
        const parsed = first === undefined ? undefined : parseControl(first.payload);

        if (parsed?.ok === true) {
          answer.resolve(parsed.message);
        }
      },
      close: () => {
        answer.reject(new Error('The server closed the connection before it answered.'));
      },
    },
  });

  const hello = encodeControl({ type: 'hello', version: buildVersion(), size: undefined });

  socket.write(encodeFrame(FrameKind.control, hello));

  try {
    return await answer.promise;
  } finally {
    socket.end();
  }
};

const startServer = async (directory: string, socketPath: string) => {
  const started = await runCli(['server', 'start', '--socket', socketPath, '--json'], directory);

  expect({ exitCode: started.exitCode, stderr: started.stderr }).toEqual({
    exitCode: 0,
    stderr: '',
  });

  return startOutputSchema.parse(JSON.parse(started.stdout));
};

it(
  'starts a server in the background and stops it',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');

    const started = await startServer(directory, socketPath);

    expect(started.socket).toBe(socketPath);
    expect(isRunning(started.pid)).toBe(true);
    expect(await helloAnswer(socketPath)).toEqual({ type: 'welcome' });

    const stopped = await runCli(['server', 'stop', '--socket', socketPath, '--json'], directory);

    expect(stopped).toEqual({ exitCode: 0, stdout: '{"stopped":true}\n', stderr: '' });
    expect(existsSync(socketPath)).toBe(false);
    expect(await waitFor(() => !isRunning(started.pid))).toBe(true);
  },
  cliTestTimeoutMs,
);

it(
  'refuses a second start on the same socket while the first server runs',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');
    const first = await startServer(directory, socketPath);

    const second = await runCli(['server', 'start', '--socket', socketPath, '--json'], directory);

    expect({ exitCode: second.exitCode, stdout: second.stdout }).toEqual({
      exitCode: 1,
      stdout: '',
    });

    expect(second.stderr).toContain(socketPath);
    expect(serverProcessesIn(directory)).toEqual([first.pid]);
    expect(await helloAnswer(socketPath)).toEqual({ type: 'welcome' });
  },
  cliTestTimeoutMs,
);

it(
  'reports success to exactly one of several starts on one socket',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');
    const starts = 6;

    const runs = await Promise.all(
      Array.from({ length: starts }, () =>
        runCli(['server', 'start', '--socket', socketPath, '--json'], directory),
      ),
    );

    const exitCodes = runs.map((run) => run.exitCode).toSorted((left, right) => left - right);
    const succeeded = runs.filter((run) => run.exitCode === 0);
    const pids = succeeded.map((run) => startOutputSchema.parse(JSON.parse(run.stdout)).pid);

    expect(exitCodes).toEqual([0, 1, 1, 1, 1, 1]);
    expect(pids.every((pid) => isRunning(pid))).toBe(true);
    expect(serverProcessesIn(directory)).toEqual(pids);
  },
  cliTestTimeoutMs,
);

it.each([
  ['run', ['server', 'run']],
  ['start', ['server', 'start']],
] as const)(
  'exits 1 with a message and leaves no socket when %s cannot start the shell',
  async (_name, command) => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');
    const environment = { ...environmentFor(directory), SHELL: join(directory, 'missing-shell') };

    const run = await runCli(
      [...command, '--socket', socketPath, '--json'],
      directory,
      environment,
    );

    expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({ exitCode: 1, stdout: '' });
    expect(run.stderr).toContain('missing-shell');
    expect(existsSync(socketPath)).toBe(false);
    expect(serverProcessesIn(directory)).toEqual([]);
  },
  cliTestTimeoutMs,
);

it(
  'exits 1 with a message when start cannot write the log',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');
    const stateHome = join(directory, 'state');
    const environment = { ...environmentFor(directory), XDG_STATE_HOME: stateHome };

    await writeFile(stateHome, 'not a directory');

    const run = await runCli(['server', 'start', '--socket', socketPath], directory, environment);

    expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({ exitCode: 1, stdout: '' });
    expect(run.stderr).toContain(join(stateHome, 'phi', 'server.log'));
    expect(run.stderr).toContain('ENOTDIR');
    expect(existsSync(socketPath)).toBe(false);
    expect(serverProcessesIn(directory)).toEqual([]);
  },
  cliTestTimeoutMs,
);

it(
  'replaces a stale socket',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');
    const listening = join(directory, 'run', 'listening.sock');

    await mkdir(join(directory, 'run'), { mode: 0o700 });

    const listener = Bun.listen({ unix: listening, socket: { data: () => undefined } });

    // The listener removes its own path on stop, so a second link keeps the socket file stale.
    await link(listening, socketPath);
    listener.stop(true);

    await startServer(directory, socketPath);

    expect(await helloAnswer(socketPath)).toEqual({ type: 'welcome' });
  },
  cliTestTimeoutMs,
);

const placeSymlink = async (socketPath: string, directory: string): Promise<void> => {
  await symlink(join(directory, 'elsewhere.sock'), socketPath);
};

const placeFile = async (socketPath: string): Promise<void> => {
  await writeFile(socketPath, 'not a socket');
};

it.each([
  ['a symlink', placeSymlink],
  ['a regular file', placeFile],
] as const)(
  'refuses to start on %s and leaves it in place',
  async (_name, place) => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');

    await mkdir(join(directory, 'run'), { mode: 0o700 });
    await place(socketPath, directory);

    const before = await lstat(socketPath);
    const started = await runCli(['server', 'start', '--socket', socketPath, '--json'], directory);
    const after = await lstat(socketPath);

    expect({ exitCode: started.exitCode, stdout: started.stdout }).toEqual({
      exitCode: 1,
      stdout: '',
    });

    expect(started.stderr).toContain(socketPath);

    expect({ inode: after.ino, symlink: after.isSymbolicLink() }).toEqual({
      inode: before.ino,
      symlink: before.isSymbolicLink(),
    });

    expect(serverProcessesIn(directory)).toEqual([]);
  },
  cliTestTimeoutMs,
);

it(
  'keeps the contents of a regular file it refuses',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');

    await mkdir(join(directory, 'run'), { mode: 0o700 });
    await placeFile(socketPath);
    await runCli(['server', 'start', '--socket', socketPath], directory);

    expect(await readFile(socketPath, 'utf8')).toBe('not a socket');
  },
  cliTestTimeoutMs,
);

const placeStaleSocket = async (socketPath: string, directory: string): Promise<void> => {
  const listening = join(directory, 'run', 'listening.sock');
  const listener = Bun.listen({ unix: listening, socket: { data: () => undefined } });

  await link(listening, socketPath);
  listener.stop(true);
};

const placeNothing = async (): Promise<void> => {
  await Promise.resolve();
};

it.each([
  ['no socket', placeNothing],
  ['a stale socket', placeStaleSocket],
] as const)(
  'exits 1 when stop finds %s',
  async (_name, place) => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');

    await mkdir(join(directory, 'run'), { mode: 0o700 });
    await place(socketPath, directory);

    const stopped = await runCli(['server', 'stop', '--socket', socketPath, '--json'], directory);

    expect({ exitCode: stopped.exitCode, stdout: stopped.stdout }).toEqual({
      exitCode: 1,
      stdout: '',
    });

    expect(stopped.stderr).toContain(socketPath);
  },
  cliTestTimeoutMs,
);

it(
  'uses the socket in XDG_RUNTIME_DIR and the log in XDG_STATE_HOME by default',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'runtime', 'phi', 'phi.sock');

    await mkdir(join(directory, 'runtime'), { mode: 0o700 });

    const started = await runCli(['server', 'start', '--json'], directory);

    expect(startOutputSchema.parse(JSON.parse(started.stdout)).socket).toBe(socketPath);
    expect(existsSync(join(directory, 'state', 'phi', 'server.log'))).toBe(true);

    const stopped = await runCli(['server', 'stop'], directory);

    expect(stopped.exitCode).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
  },
  cliTestTimeoutMs,
);

it.each(['server', 'server restart', 'server stop now', 'server stop --socket'])(
  'exits 2 on bad arguments: %s',
  async (commandLine) => {
    const directory = await temporaryDirectory();

    const run = await runCli(commandLine.split(' '), directory);

    expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({ exitCode: 2, stdout: '' });
  },
  cliTestTimeoutMs,
);

it(
  'stops a server from another build and removes its socket',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');
    const other = { version: '9.9.9-other', ghostty: 'other-commit' };

    const created = createLog(join(directory, 'state', 'phi', 'server.log'), Date.now);

    if (!created.ok) {
      throw new Error(created.message);
    }

    const result = await runServer({
      socketPath,
      version: other,
      log: created.log,
      environment: { ...process.env, SHELL: '/bin/sh' },
      directory,
    });

    if (!result.ok) {
      throw new Error(result.message);
    }

    // The server logs while it stops, so the directory goes after it.
    onTestFinished(async () => {
      result.server.stop();
      await result.server.stopped;
      await rm(directory, { recursive: true, force: true });
    });

    const stopped = await runCli(['server', 'stop', '--socket', socketPath, '--json'], directory);

    expect(stopped).toEqual({ exitCode: 0, stdout: '{"stopped":true}\n', stderr: '' });
    await result.server.stopped;
    expect(existsSync(socketPath)).toBe(false);
  },
  cliTestTimeoutMs,
);
