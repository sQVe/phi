import { expect, it, onTestFinished } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPaneCommand } from '../src/client/client.ts';
import { paneId } from '../src/ids.ts';
import {
  createFrameDecoder,
  encodeControl,
  encodeFrame,
  FrameKind,
  parseControl,
} from '../src/protocol/protocol.ts';
import type { ControlMessage } from '../src/protocol/protocol.ts';

const version = { version: 'test', ghostty: 'test-ghostty' };

const snapshot = (live: boolean): ControlMessage => ({
  type: 'snapshot',
  snapshot: {
    revision: 2,
    pane: live
      ? {
          id: paneId(7),
          lifecycle: 'running',
          generation: 1,
          size: { columns: 80, rows: 24 },
          exitCode: undefined,
        }
      : undefined,
    attachedClientId: undefined,
    clients: [],
  },
});

const listen = async (respond: (message: ControlMessage) => ControlMessage[] | undefined) => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-pane-client-'));
  const socketPath = join(directory, 'phi.sock');
  const received: ControlMessage[] = [];
  const failures: string[] = [];
  const decoder = createFrameDecoder();

  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data: (socket, bytes) => {
        const decoded = decoder.push(bytes);

        if (!decoded.ok) {
          failures.push(decoded.reason);
          socket.end();

          return;
        }

        for (const frame of decoded.frames) {
          const parsed = parseControl(frame.payload);

          if (!parsed.ok) {
            failures.push(parsed.reason);
            socket.end();

            return;
          }

          received.push(parsed.message);

          const responses = respond(parsed.message);

          if (responses === undefined) {
            socket.end();

            return;
          }

          for (const message of responses) {
            socket.write(encodeFrame(FrameKind.control, encodeControl(message)));
          }
        }
      },
    },
  });

  onTestFinished(async () => {
    listener.stop(true);
    await rm(directory, { recursive: true, force: true });
  });

  return { socketPath, received, failures };
};

it('returns a missing pane without sending a command when the snapshot has no live pane', async () => {
  const server = await listen(() => [{ type: 'welcome' }, snapshot(false)]);
  const result = await runPaneCommand(server.socketPath, version, { action: 'read' });

  expect(result).toEqual({ ok: false, reason: 'paneMissing' });
  expect(server.received).toEqual([{ type: 'hello', version, size: undefined }]);
  expect(server.failures).toEqual([]);
});

it.each(['read', 'send'] as const)(
  'uses the snapshot pane id and reports a pane lost before %s',
  async (action) => {
    const server = await listen((message) => {
      if (message.type === 'hello') {
        return [{ type: 'welcome' }, snapshot(true)];
      }

      return [{ type: 'paneMissing', paneId: paneId(7) }];
    });

    const command = action === 'read' ? { action } : { action, text: 'hello' };
    const result = await runPaneCommand(server.socketPath, version, command);

    const expected: ControlMessage =
      action === 'read'
        ? { type: 'paneRead', paneId: paneId(7) }
        : { type: 'paneSend', paneId: paneId(7), text: 'hello' };

    expect(result).toEqual({ ok: false, reason: 'paneMissing' });
    expect(server.received).toEqual([{ type: 'hello', version, size: undefined }, expected]);
    expect(server.failures).toEqual([]);
  },
);

it('returns a connection failure when the server closes before answering', async () => {
  const server = await listen(() => undefined);
  const result = await runPaneCommand(server.socketPath, version, { action: 'read' });

  expect(result).toEqual({ ok: false, reason: 'connectionFailed' });
  expect(server.received).toEqual([{ type: 'hello', version, size: undefined }]);
  expect(server.failures).toEqual([]);
});

it('rejects a snapshot sent before welcome without sending pane input', async () => {
  const server = await listen(() => [snapshot(true)]);

  const result = await runPaneCommand(server.socketPath, version, {
    action: 'send',
    text: 'not-sent',
  });

  expect(result).toEqual({ ok: false, reason: 'connectionFailed' });
  expect(server.received).toEqual([{ type: 'hello', version, size: undefined }]);
  expect(server.failures).toEqual([]);
});
