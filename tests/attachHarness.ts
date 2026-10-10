import { onTestFinished } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clientId, paneId } from '../src/ids.ts';
import {
  createFrameDecoder,
  encodeControl,
  encodeFrame,
  FrameKind,
  parseControl,
} from '../src/protocol/protocol.ts';
import type { ControlMessage } from '../src/protocol/protocol.ts';
import { cellWords, decodePaneInput, encodeRowUpdate } from '../src/rows/rows.ts';
import { createTerminal } from '../src/vt/vt.ts';

export interface AttachHarness {
  statusBar: () => string | undefined;
  type: (input: string | Uint8Array) => void;
  receivedBytes: () => Buffer;
  receivedText: () => string;
  until: (condition: () => boolean) => Promise<undefined>;
}

const pane = {
  id: paneId(1),
  lifecycle: 'running',
  generation: 1,
  size: { columns: 80, rows: 23 },
  exitCode: undefined,
} as const;

const failureTimeoutMs = 10_000;

const control = (message: ControlMessage) => encodeFrame(FrameKind.control, encodeControl(message));

const paneRows = (modes: number) => {
  const columns = 80;
  const cells = new Uint32Array(1 + columns * cellWords);

  return encodeFrame(
    FrameKind.rowUpdate,
    encodeRowUpdate({
      pane: 1,
      sequence: 1,
      size: { columns, rows: 23 },
      cursor: { x: 0, y: 0, visible: true },
      modes,
      epoch: 1,
      first: 0,
      activeTop: 0,
      rowCount: 1,
      cells,
      graphemes: new Uint32Array(),
    }),
  );
};

export const setupAttach = async (modes: number): Promise<AttachHarness> => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-attach-input-'));
  const socketPath = join(directory, 'phi.sock');
  const decoder = createFrameDecoder();
  const received: Uint8Array[] = [];
  const waiters = new Set<() => void>();

  const changed = () => {
    for (const waiter of waiters) {
      waiter();
    }
  };

  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data: (socket, bytes) => {
        const decoded = decoder.push(bytes);

        if (!decoded.ok) {
          return;
        }

        for (const frame of decoded.frames) {
          if (frame.kind === FrameKind.input) {
            const input = decodePaneInput(frame.payload);

            if (input.ok) {
              received.push(input.input.bytes);
              changed();
            }

            continue;
          }

          const parsed = parseControl(frame.payload);

          if (parsed.ok && parsed.message.type === 'hello') {
            socket.write(control({ type: 'welcome' }));
            socket.write(paneRows(modes));

            socket.write(
              control({
                type: 'snapshot',
                snapshot: {
                  revision: 1,
                  pane,
                  attachedClientId: clientId(1),
                  clients: [],
                },
              }),
            );
          }
        }
      },
    },
  });

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

        changed();

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
    listener.stop(true);
    await rm(directory, { recursive: true, force: true });
  });

  const statusBar = () =>
    screen
      .text()
      .split('\n')
      .findLast((line) => line.trim() !== '');

  const until = (condition: () => boolean): Promise<undefined> => {
    const done = Promise.withResolvers<undefined>();

    const check = () => {
      if (condition()) {
        waiters.delete(check);
        done.resolve(undefined);
      }
    };

    const timer = setTimeout(() => {
      waiters.delete(check);
      done.reject(new Error('The condition did not hold in time.'));
    }, failureTimeoutMs);

    waiters.add(check);
    check();

    return done.promise.finally(() => {
      clearTimeout(timer);
    });
  };

  const type = (input: string | Uint8Array) => {
    client.terminal?.write(input);
  };

  const receivedBytes = () => Buffer.concat(received);

  const receivedText = () => receivedBytes().toString();

  return { statusBar, type, receivedBytes, receivedText, until };
};
