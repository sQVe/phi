import { expect, it, onTestFinished } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectAttach } from '../src/client/client.ts';
import { clientId, paneId } from '../src/ids.ts';
import {
  createFrameDecoder,
  encodeControl,
  encodeFrame,
  FrameKind,
  parseControl,
} from '../src/protocol/protocol.ts';
import type { ControlMessage } from '../src/protocol/protocol.ts';
import { cellWords, encodeRowUpdate } from '../src/rows/rows.ts';
import type { RowUpdate } from '../src/rows/rows.ts';

type Reply = (Uint8Array | ControlMessage)[] | undefined;

const version = { version: 'test', ghostty: 'test-ghostty' };

const size = { columns: 100, rows: 30 };

const pane = {
  id: paneId(7),
  lifecycle: 'running',
  generation: 1,
  size: { columns: 100, rows: 29 },
  exitCode: undefined,
} as const;

const snapshotAt = (revision: number, clients = 0) => ({
  revision,
  pane,
  attachedClientId: undefined,
  clients: Array.from({ length: clients }, (_, index) => ({
    id: clientId(index + 1),
    size,
  })),
});

const snapshotMessage = (revision: number, clients = 0): ControlMessage => ({
  type: 'snapshot',
  snapshot: {
    revision,
    pane,
    attachedClientId: undefined,
    clients: Array.from({ length: clients }, (_, index) => ({
      id: clientId(index + 1),
      size,
    })),
  },
});

const control = (message: ControlMessage) => encodeFrame(FrameKind.control, encodeControl(message));

const toBytes = (reply: Uint8Array | ControlMessage): Uint8Array =>
  reply instanceof Uint8Array ? reply : control(reply);

const listen = async (respond: (message: ControlMessage) => Reply) => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-attach-client-'));
  const socketPath = join(directory, 'phi.sock');
  const received: ControlMessage[] = [];
  const decoder = createFrameDecoder();
  const sockets: Bun.Socket[] = [];

  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open: (socket) => {
        sockets.push(socket);
      },
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

          received.push(parsed.message);

          const replies = respond(parsed.message);

          if (replies === undefined) {
            socket.end();

            return;
          }

          for (const reply of replies) {
            socket.write(toBytes(reply));
          }
        }
      },
    },
  });

  onTestFinished(async () => {
    listener.stop(true);
    await rm(directory, { recursive: true, force: true });
  });

  return { socketPath, received, sockets };
};

const untilState = async (
  session: { subscribe: (listener: () => void) => () => void },
  isReady: () => boolean,
) => {
  const ready = Promise.withResolvers<undefined>();

  const unsubscribe = session.subscribe(() => {
    if (isReady()) {
      ready.resolve(undefined);
    }
  });

  if (isReady()) {
    ready.resolve(undefined);
  }

  await ready.promise;
  unsubscribe();
};

const attach = async (server: { socketPath: string }) => {
  const result = await connectAttach(server.socketPath, version, size);

  if (!result.ok) {
    throw new Error(`Attach failed: ${result.reason}`);
  }

  onTestFinished(() => {
    result.session.close();
  });

  return result.session;
};

const welcomeWith = (...replies: (Uint8Array | ControlMessage)[]) => {
  return (message: ControlMessage): Reply =>
    message.type === 'hello' ? [{ type: 'welcome' }, ...replies] : [];
};

it('sends the terminal size in the hello', async () => {
  const server = await listen(welcomeWith(snapshotMessage(1)));

  await attach(server);

  expect(server.received).toEqual([{ type: 'hello', version, size }]);
});

it('sends resync after a revision gap and applies the next snapshot', async () => {
  const server = await listen((message) => {
    if (message.type === 'hello') {
      return [
        { type: 'welcome' },
        snapshotMessage(2),
        {
          type: 'change',
          revision: 4,
          change: { type: 'paneResized', paneId: pane.id, size: { columns: 50, rows: 10 } },
        },
      ];
    }

    return message.type === 'resync' ? [snapshotMessage(5, 1)] : [];
  });

  const session = await attach(server);

  await untilState(session, () => session.getState().snapshot.revision === 5);

  expect(server.received.map((message) => message.type)).toEqual(['hello', 'resync']);
  expect(session.getState()).toEqual({ snapshot: snapshotAt(5, 1), inputMode: 'normal' });
});

it('applies a change whose revision follows the snapshot', async () => {
  const resized = { columns: 50, rows: 10 };

  const server = await listen(
    welcomeWith(snapshotMessage(2), {
      type: 'change',
      revision: 3,
      change: { type: 'paneResized', paneId: pane.id, size: resized },
    }),
  );

  const session = await attach(server);

  await untilState(session, () => session.getState().snapshot.revision === 3);

  expect(session.getState().snapshot.pane?.size).toEqual(resized);
  expect(server.received.map((message) => message.type)).toEqual(['hello']);
});

const rowUpdate = (overrides: Partial<RowUpdate> = {}): RowUpdate => {
  const columns = 3;
  const cells = new Uint32Array(1 + columns * cellWords);

  cells[1] = 'h'.codePointAt(0) ?? 0;

  return {
    pane: 7,
    sequence: 1,
    size: { columns, rows: 2 },
    cursor: { x: 1, y: 0, visible: true },
    modes: 0,
    epoch: 1,
    first: 0,
    activeTop: 10,
    rowCount: 1,
    cells,
    graphemes: new Uint32Array(),
    ...overrides,
  };
};

it('fills the row cache from row updates', async () => {
  const server = await listen(
    welcomeWith(encodeFrame(FrameKind.rowUpdate, encodeRowUpdate(rowUpdate())), snapshotMessage(1)),
  );

  const session = await attach(server);
  const cache = session.rowCache(paneId(7));

  expect(cache?.size()).toEqual({ columns: 3, rows: 2 });
  expect(cache?.cursor()).toEqual({ x: 1, y: 0, visible: true });
  expect(cache?.row(0)?.cells[0]).toBe('h'.codePointAt(0));
  expect(cache?.row(1)).toBeUndefined();
});

it('sends a resize message', async () => {
  const resized = { columns: 120, rows: 40 };
  const arrived = Promise.withResolvers<undefined>();

  const server = await listen((message) => {
    if (message.type === 'resize') {
      arrived.resolve(undefined);
    }

    return message.type === 'hello' ? [{ type: 'welcome' }, snapshotMessage(1)] : [];
  });

  const session = await attach(server);

  session.resize(resized);

  await arrived.promise;

  expect(server.received).toEqual([
    { type: 'hello', version, size },
    { type: 'resize', size: resized },
  ]);
});

it('returns both versions when the server refuses the build', async () => {
  const serverVersion = { version: 'other', ghostty: 'other-ghostty' };

  const server = await listen(() => [{ type: 'refused', client: version, server: serverVersion }]);

  const result = await connectAttach(server.socketPath, version, size);

  expect(result).toEqual({ ok: false, reason: 'refused', client: version, server: serverVersion });
});

it('returns noServer when no server listens', async () => {
  const result = await connectAttach('/nonexistent/phi.sock', version, size);

  expect(result).toEqual({ ok: false, reason: 'noServer' });
});

it('resolves closed when the server ends the socket', async () => {
  const server = await listen(welcomeWith(snapshotMessage(1)));
  const session = await attach(server);

  for (const socket of server.sockets) {
    socket.end();
  }

  expect(await session.closed).toBe('serverClosed');
});

it('closes with connectionFailed after a frame it cannot parse', async () => {
  const server = await listen(
    welcomeWith(snapshotMessage(1), encodeFrame(FrameKind.control, new TextEncoder().encode('{'))),
  );

  const session = await attach(server);

  expect(await session.closed).toBe('connectionFailed');
});
