import { expect, it, onTestFinished } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readVersions } from '../src/cli/versions.ts';
import {
  createFrameDecoder,
  encodeControl,
  encodeFrame,
  FrameKind,
  parseControl,
} from '../src/protocol/protocol.ts';
import { CellFlag, cellWords } from '../src/rows/rows.ts';
import { createTerminal } from '../src/vt/vt.ts';
import { endServersIn, waitFor } from './serverProcesses.ts';

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-attach-'));
  const socketPath = join(directory, 'phi.sock');

  const command = async (...commandArguments: string[]) => {
    const child = Bun.spawn(
      [process.execPath, 'src/index.ts', ...commandArguments, '--socket', socketPath],
      {
        env: {
          ...process.env,
          SHELL: '/bin/sh',
          PS1: 'attach-prompt> ',
          XDG_STATE_HOME: join(directory, 'state'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const text = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();

    expect(await child.exited).toBe(0);
    expect(error).toBe('');

    return text;
  };

  onTestFinished(async () => {
    await endServersIn(directory);
    await rm(directory, { recursive: true, force: true });
  });

  await command('server', 'start');

  const result = createTerminal(80, 24, 0);

  if (!result.ok) {
    throw new Error(result.reason);
  }

  const screen = result.terminal;

  const client = Bun.spawn([process.execPath, 'src/index.ts', 'attach', '--socket', socketPath], {
    env: { ...process.env, TERM: 'xterm-256color' },
    terminal: {
      cols: 80,
      rows: 24,
      data: (terminal, bytes) => {
        const reply = screen.write(bytes);

        if (reply !== undefined) {
          terminal.write(reply);
        }
      },
    },
  });

  onTestFinished(async () => {
    client.kill();
    await client.exited;
    client.terminal?.close();
    screen[Symbol.dispose]();
  });

  return { command, client, screen, socketPath };
};

const readPaneSize = async (socketPath: string) => {
  const versions = readVersions();

  if (!versions.ok) {
    throw new Error(versions.message);
  }

  const answer = Promise.withResolvers<{ columns: number; rows: number } | undefined>();
  const decoder = createFrameDecoder();

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data: (_socket, bytes) => {
        const decoded = decoder.push(bytes);

        if (!decoded.ok) {
          answer.reject(new Error(decoded.reason));

          return;
        }

        for (const frame of decoded.frames) {
          const parsed = parseControl(frame.payload);

          if (parsed.ok && parsed.message.type === 'snapshot') {
            answer.resolve(parsed.message.snapshot.pane?.size);
          }
        }
      },
      close: () => {
        answer.reject(new Error('Connection closed before snapshot.'));
      },
    },
  });

  const hello = encodeControl({ type: 'hello', version: versions.versions, size: undefined });

  socket.write(encodeFrame(FrameKind.control, hello));

  try {
    return await answer.promise;
  } finally {
    socket.end();
  }
};

it('shows the shell screen and cursor', async () => {
  const { command, screen } = await setup();

  await command('pane', 'send', 'echo phi-attach-ok\r');

  expect(await waitFor(() => screen.text().includes('\nphi-attach-ok\n'), 3000)).toBe(true);

  const rows = screen.text().split('\n');
  const outputRow = rows.indexOf('phi-attach-ok');

  expect(rows[outputRow + 1]).toContain('attach-prompt>');
  expect(screen.text()).toContain('INSERT');
  screen.markAllDirty();

  const frame = screen.frame();

  const stride = 1 + 80 * cellWords;
  const promptColumn = 'attach-prompt> '.length;
  const cursorFlags = frame.cells[(outputRow + 1) * stride + 1 + promptColumn * cellWords + 3] ?? 0;

  expect(cursorFlags & CellFlag.inverse).toBe(CellFlag.inverse);
});

it('resizes the pane to the client size less the status bar', async () => {
  const { client, screen, socketPath, command } = await setup();

  expect(await waitFor(() => screen.text().includes('INSERT'))).toBe(true);
  screen.resize(100, 30);
  client.terminal?.resize(100, 30);
  await command('pane', 'send', 'echo resized-screen\r');

  expect(await waitFor(() => screen.text().split('\n')[29] === 'INSERT')).toBe(true);
  expect(await readPaneSize(socketPath)).toEqual({ columns: 100, rows: 29 });
  expect(screen.text()).toContain('resized-screen');
});

it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
  'restores the terminal and leaves the shell running on %s',
  async (signal) => {
    const { client, screen, command } = await setup();

    expect(await waitFor(() => screen.text().includes('INSERT'))).toBe(true);
    expect(screen.stableRows().alternate).toBe(true);
    client.kill(signal);

    expect(await client.exited).toBe(0);
    expect(await waitFor(() => !screen.stableRows().alternate)).toBe(true);
    expect(screen.frame().cursor.visible).toBe(true);
    await command('pane', 'send', 'echo still-running\r');

    const rows = await command('pane', 'read');

    expect(rows).toContain('still-running');
  },
);

it('exits with code one and reports a connection failure after the handshake', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-attach-failure-'));
  const socketPath = join(directory, 'phi.sock');
  const stderrPath = join(directory, 'stderr');
  const decoder = createFrameDecoder();
  let receivedResize = false;

  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data: (socket, bytes) => {
        const decoded = decoder.push(bytes);

        if (!decoded.ok) {
          socket.end();

          return;
        }

        for (const frame of decoded.frames) {
          const parsed = parseControl(frame.payload);

          if (!parsed.ok) {
            socket.end();

            return;
          }

          if (parsed.message.type === 'hello') {
            socket.write(encodeFrame(FrameKind.control, encodeControl({ type: 'welcome' })));

            socket.write(
              encodeFrame(
                FrameKind.control,
                encodeControl({
                  type: 'snapshot',
                  snapshot: {
                    revision: 0,
                    pane: undefined,
                    attachedClientId: undefined,
                    clients: [],
                  },
                }),
              ),
            );
          }

          if (parsed.message.type === 'resize') {
            receivedResize = true;
            socket.write(encodeFrame(FrameKind.control, new TextEncoder().encode('{')));
          }
        }
      },
    },
  });

  const client = Bun.spawn(
    [
      '/bin/sh',
      '-c',
      'exec "$1" src/index.ts attach --socket "$2" 2>"$3"',
      'phi-attach-test',
      process.execPath,
      socketPath,
      stderrPath,
    ],
    {
      env: { ...process.env, TERM: 'xterm-256color' },
      terminal: { cols: 80, rows: 24, data: () => undefined },
    },
  );

  onTestFinished(async () => {
    client.kill();
    await client.exited;
    client.terminal?.close();
    listener.stop(true);
    await rm(directory, { recursive: true, force: true });
  });

  expect(await client.exited).toBe(1);
  expect(receivedResize).toBe(true);

  const error = await readFile(stderrPath, 'utf8');

  expect(error).toContain(socketPath);
  expect(error).toContain('failed');
});

it('exits with code zero when the server stops', async () => {
  const { client, screen, command } = await setup();

  expect(await waitFor(() => screen.text().includes('INSERT'))).toBe(true);
  await command('server', 'stop');

  expect(await client.exited).toBe(0);
  expect(await waitFor(() => !screen.stableRows().alternate)).toBe(true);
  expect(screen.frame().cursor.visible).toBe(true);
});
