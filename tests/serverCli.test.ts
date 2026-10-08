import { expect, it, onTestFinished } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { createFrameDecoder, encodeFrame, FrameKind } from '../src/protocol/frames.ts';
import { encodeControl, parseControl } from '../src/protocol/messages.ts';
import type { ControlMessage } from '../src/protocol/messages.ts';
import { decodeRowUpdate, rowsToText } from '../src/rows/rows.ts';
import type { RowUpdate } from '../src/rows/rows.ts';
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

const paneOutputSchema = z.object({ pane: z.string(), rows: z.array(z.string()) });

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
  'reads 24 visible rows and the shell prompt without a terminal client',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');
    const environment = { ...environmentFor(directory), SHELL: '/bin/sh', PS1: 'phi-test> ' };

    const started = await runCli(
      ['server', 'start', '--socket', socketPath],
      directory,
      environment,
    );

    expect(started.exitCode).toBe(0);

    let text: CliRun = { exitCode: -1, stdout: '', stderr: '' };

    for (let attempt = 0; attempt < 30; attempt += 1) {
      text = await runCli(['pane', 'read', '--socket', socketPath], directory);

      if (text.stdout.includes('phi-test>')) {
        break;
      }
    }

    const json = await runCli(['pane', 'read', '--socket', socketPath, '--json'], directory);

    expect(json.exitCode).toBe(0);
    const output = paneOutputSchema.parse(JSON.parse(json.stdout));

    expect(output.pane).toBe('pane-1');
    expect(output.rows).toHaveLength(24);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('phi-test>');
    expect(text.stdout.split('\n')).toHaveLength(25);
  },
  cliTestTimeoutMs,
);

it(
  'sends text to the pane without a terminal client and reads the result',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');

    await startServer(directory, socketPath);

    const sent = await runCli(
      ['pane', 'send', 'agent-text-中文-é', '--socket', socketPath, '--json'],
      directory,
    );

    expect(sent).toEqual({ exitCode: 0, stdout: '{"sent":true}\n', stderr: '' });

    const read = await runCli(['pane', 'read', '--socket', socketPath, '--json'], directory);

    expect(read.exitCode).toBe(0);
    const output = paneOutputSchema.parse(JSON.parse(read.stdout));

    expect(output.rows.join('\n')).toContain('agent-text-中文-é');

    const silent = await runCli(['pane', 'send', '', '--socket', socketPath], directory);

    expect(silent).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  },
  cliTestTimeoutMs,
);

it(
  'reads the active screen rather than history after scrolling and on the alternate screen',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');
    const environment = { ...environmentFor(directory), SHELL: '/bin/sh', PS1: '' };

    const started = await runCli(
      ['server', 'start', '--socket', socketPath],
      directory,
      environment,
    );

    expect(started.exitCode).toBe(0);

    const lines = Array.from({ length: 35 }, (_, row) => `line-${row}`);
    const screen = lines.join('\\r\\n');
    const text = `printf '\\033[2J\\033[H${screen}'; : > primary-ready\n`;
    const sent = await runCli(['pane', 'send', text, '--socket', socketPath], directory);

    expect(sent.exitCode).toBe(0);
    expect(await waitFor(() => existsSync(join(directory, 'primary-ready')))).toBe(true);

    const primary = await runCli(['pane', 'read', '--socket', socketPath, '--json'], directory);
    const primaryOutput = paneOutputSchema.parse(JSON.parse(primary.stdout));

    expect(primaryOutput.rows).toEqual(lines.slice(-24));

    const alternateText = "printf '\\033[?1049h\\033[Halternate-screen'; : > alternate-ready\n";

    const alternateSent = await runCli(
      ['pane', 'send', alternateText, '--socket', socketPath],
      directory,
    );

    expect(alternateSent.exitCode).toBe(0);
    expect(await waitFor(() => existsSync(join(directory, 'alternate-ready')))).toBe(true);

    const alternate = await runCli(['pane', 'read', '--socket', socketPath, '--json'], directory);
    const alternateOutput = paneOutputSchema.parse(JSON.parse(alternate.stdout));

    expect(alternateOutput.rows).toEqual([
      'alternate-screen',
      ...Array.from({ length: 23 }, () => ''),
    ]);
  },
  cliTestTimeoutMs,
);

const connectTerminal = async (socketPath: string) => {
  const decoder = createFrameDecoder();
  const updates: RowUpdate[] = [];
  const failures: string[] = [];

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data: (_socket, bytes) => {
        const decoded = decoder.push(bytes);

        if (!decoded.ok) {
          failures.push(decoded.reason);

          return;
        }

        for (const frame of decoded.frames) {
          if (frame.kind !== FrameKind.rowUpdate) {
            continue;
          }

          const result = decodeRowUpdate(frame.payload);

          if (result.ok) {
            updates.push(result.update);
          } else {
            failures.push(result.reason);
          }
        }
      },
    },
  });

  onTestFinished(() => {
    socket.end();
  });

  const hello = encodeControl({
    type: 'hello',
    version: buildVersion(),
    size: { columns: 80, rows: 24 },
  });

  socket.write(encodeFrame(FrameKind.control, hello));

  return { updates, failures };
};

it(
  'keeps publishing every changed row to a connected terminal during repeated agent reads',
  async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, 'run', 'phi.sock');
    const environment = { ...environmentFor(directory), SHELL: '/bin/sh', PS1: '' };

    expect(
      (await runCli(['server', 'start', '--socket', socketPath], directory, environment)).exitCode,
    ).toBe(0);

    const terminal = await connectTerminal(socketPath);

    expect(await waitFor(() => terminal.updates.length > 0)).toBe(true);
    expect(terminal.updates[0]?.rowCount).toBe(24);

    for (let change = 0; change < 3; change += 1) {
      const expected = Array.from({ length: 20 }, (_, row) => `change-${change}-row-${row}`);
      const screen = expected.join('\\r\\n');
      const command = `printf '\\033[2J\\033[H${screen}'\n`;
      const start = terminal.updates.length;
      const sent = runCli(['pane', 'send', command, '--socket', socketPath], directory);

      const reads = Array.from({ length: 5 }, () =>
        runCli(['pane', 'read', '--socket', socketPath, '--json'], directory),
      );

      const results = await Promise.all([sent, ...reads]);

      expect(results.every((result) => result.exitCode === 0)).toBe(true);

      const receivedRows = () =>
        terminal.updates.slice(start).flatMap((update) => rowsToText(update, update.size.columns));

      expect(await waitFor(() => expected.every((row) => receivedRows().includes(row)))).toBe(true);
      const received = receivedRows();

      for (const row of expected) {
        expect(received).toContain(row);
      }

      const read = await runCli(['pane', 'read', '--socket', socketPath, '--json'], directory);

      const output = paneOutputSchema.parse(JSON.parse(read.stdout));

      expect(output.rows.slice(0, 20)).toEqual(expected);
    }

    expect(terminal.failures).toEqual([]);
  },
  cliTestTimeoutMs,
);

it.each(['read', 'send'] as const)(
  'exits 1 without output when pane %s finds no server',
  async (action) => {
    const directory = await temporaryDirectory();
    const argumentsForAction = ['pane', action];

    if (action === 'send') {
      argumentsForAction.push('text');
    }

    const result = await runCli(
      [...argumentsForAction, '--socket', join(directory, 'absent.sock'), '--json'],
      directory,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('absent.sock');
  },
  cliTestTimeoutMs,
);

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

it.skipIf(process.getuid?.() === 0)(
  'exits 1 with a message when run cannot remove its socket on stop',
  async () => {
    const directory = await temporaryDirectory();
    const socketDirectory = join(directory, 'run');
    const socketPath = join(socketDirectory, 'phi.sock');

    const child = Bun.spawn(
      ['bun', join(root, 'src/index.ts'), 'server', 'run', '--socket', socketPath, '--json'],
      {
        cwd: directory,
        env: environmentFor(directory),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const ready = await child.stdout.getReader().read();

    await chmod(socketDirectory, 0o500);

    let exitCode: number;
    let stderr: string;

    try {
      child.kill('SIGTERM');
      [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    } finally {
      await chmod(socketDirectory, 0o700);
    }

    expect(new TextDecoder().decode(ready.value)).toContain(socketPath);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(socketPath);
  },
  cliTestTimeoutMs,
);

it.skipIf(process.getuid?.() === 0)(
  'exits 1 at once with a message when stop finds the socket left behind',
  async () => {
    const directory = await temporaryDirectory();
    const socketDirectory = join(directory, 'run');
    const socketPath = join(socketDirectory, 'phi.sock');

    await startServer(directory, socketPath);
    await chmod(socketDirectory, 0o500);

    let stopped: CliRun;

    const started = performance.now();

    try {
      stopped = await runCli(['server', 'stop', '--socket', socketPath], directory);
    } finally {
      await chmod(socketDirectory, 0o700);
    }

    const elapsed = performance.now() - started;

    // Well under the stop timeout of 10 seconds.
    expect(elapsed).toBeLessThan(5000);
    expect(stopped.exitCode).toBe(1);
    expect(stopped.stdout).toBe('');
    expect(stopped.stderr).toContain(`left its socket at ${socketPath}`);
  },
  cliTestTimeoutMs,
);

it(
  'waits for a server that is still stopping, even when a free lock file is left',
  async () => {
    const directory = await temporaryDirectory();
    const socketDirectory = join(directory, 'run');
    const socketPath = join(socketDirectory, 'phi.sock');

    await mkdir(socketDirectory, { mode: 0o700 });
    // An earlier server left the lock file, and this server comes from a build without the lock.
    await writeFile(`${socketPath}.lock`, '', { mode: 0o600 });

    const listener = Bun.listen({
      unix: socketPath,
      socket: {
        data: () => {
          // The listener removes its own path on stop.
          setTimeout(() => {
            listener.stop(true);
          }, 300);
        },
      },
    });

    onTestFinished(() => {
      listener.stop(true);
    });

    const stopped = await runCli(['server', 'stop', '--socket', socketPath], directory);

    expect(stopped).toEqual({
      exitCode: 0,
      stdout: `Stopped the server on ${socketPath}.\n`,
      stderr: '',
    });
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

it.each([
  'server',
  'server restart',
  'server stop now',
  'server stop --socket',
  'pane',
  'pane read text',
  'pane send',
  'pane send one two',
  'pane read --socket',
])(
  'exits 2 on bad arguments: %s',
  async (commandLine) => {
    const directory = await temporaryDirectory();

    const run = await runCli(commandLine.split(' '), directory);

    expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({ exitCode: 2, stdout: '' });
  },
  cliTestTimeoutMs,
);

it(
  'refuses pane commands from another build, then stops that server and removes its socket',
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

    for (const command of [
      ['pane', 'read'],
      ['pane', 'send', 'must-not-be-written'],
    ]) {
      const refused = await runCli([...command, '--socket', socketPath, '--json'], directory);
      const local = buildVersion();

      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain(local.version);
      expect(refused.stderr).toContain(local.ghostty);
      expect(refused.stderr).toContain(other.version);
      expect(refused.stderr).toContain(other.ghostty);
      expect(refused.stderr).toContain('phi server stop');
      expect(refused.stderr).toContain('followed by phi');
      expect(refused.stderr).toContain('ends every pane');
      expect(result.server.paneText()).not.toContain('must-not-be-written');
    }

    const stopped = await runCli(['server', 'stop', '--socket', socketPath, '--json'], directory);

    expect(stopped).toEqual({ exitCode: 0, stdout: '{"stopped":true}\n', stderr: '' });
    await result.server.stopped;
    expect(existsSync(socketPath)).toBe(false);
  },
  cliTestTimeoutMs,
);
