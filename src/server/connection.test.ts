import { expect, it } from 'bun:test';

import {
  createFrameDecoder,
  encodeControl,
  encodeFrame,
  FrameKind,
  parseControl,
} from '../protocol/protocol.ts';
import type { ControlMessage } from '../protocol/protocol.ts';
import { createConnection } from './connection.ts';
import type { Connection } from './connection.ts';
import type { Log } from './log.ts';

const build = { version: '1.2.3', ghostty: 'abc123' };

const hello: ControlMessage = { type: 'hello', version: build, size: undefined };

const frameOf = (message: ControlMessage): Uint8Array =>
  encodeFrame(FrameKind.control, encodeControl(message));

const createRecordingLog = () => {
  const entries: { level: string; message: string }[] = [];

  const writer = (level: string) => (message: string) => {
    entries.push({ level, message });
  };

  const log: Log = {
    debug: writer('debug'),
    info: writer('info'),
    warn: writer('warn'),
    error: writer('error'),
  };

  return { log, entries };
};

// A socket that takes `room` bytes, or every byte when room is undefined.
const createSocket = (room?: number) => {
  const written: number[] = [];
  let available = room ?? Number.POSITIVE_INFINITY;
  let ended = false;

  return {
    written,
    isEnded: () => ended,
    grow: (bytes: number) => {
      available += bytes;
    },
    write: (bytes: Uint8Array): number => {
      const taken = Math.min(available, bytes.length);

      written.push(...bytes.subarray(0, taken));
      available -= taken;

      return taken;
    },
    end: () => {
      ended = true;
    },
  };
};

const messagesIn = (bytes: number[]): ControlMessage[] => {
  const decoded = createFrameDecoder().push(Uint8Array.from(bytes));

  if (!decoded.ok) {
    throw new Error(decoded.reason);
  }

  return decoded.frames.map((frame) => {
    const parsed = parseControl(frame.payload);

    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }

    return parsed.message;
  });
};

const open = (
  socket: ReturnType<typeof createSocket>,
  onMessage: (message: ControlMessage, connection: Connection) => void = () => undefined,
  onWelcome: (connection: Connection) => void = () => undefined,
) => {
  const { log, entries } = createRecordingLog();

  const connection = createConnection({
    socket,
    version: build,
    log,
    queueLimitBytes: 1024,
    onMessage,
    onWelcome,
  });

  return { connection, entries };
};

it('welcomes a hello from the same build and passes on later messages', () => {
  const socket = createSocket();
  const received: ControlMessage[] = [];
  const { connection } = open(socket, (message) => received.push(message));

  connection.receive(frameOf(hello));
  connection.receive(frameOf({ type: 'stop' }));

  expect(messagesIn(socket.written)).toEqual([{ type: 'welcome' }]);
  expect(received).toEqual([{ type: 'stop' }]);
  expect(socket.isEnded()).toBe(false);
});

const sendSnapshot = (connection: Connection): void => {
  connection.send({
    type: 'snapshot',
    snapshot: { revision: 0, pane: undefined, clients: [], attachedClientId: undefined },
  });
};

it('notifies welcome once and queues its snapshot after welcome even across partial writes', () => {
  const socket = createSocket(4);
  const welcomed: Connection[] = [];

  const { connection } = open(socket, undefined, (from) => {
    welcomed.push(from);
    sendSnapshot(from);
  });

  connection.receive(frameOf(hello));
  connection.receive(frameOf(hello));
  socket.grow(1000);
  connection.drain();

  expect(welcomed).toEqual([connection]);
  expect(connection.isWelcomed()).toBe(true);

  expect(messagesIn(socket.written)).toEqual([
    { type: 'welcome' },
    {
      type: 'snapshot',
      snapshot: { revision: 0, pane: undefined, clients: [], attachedClientId: undefined },
    },
  ]);
});

it.each([{ ...hello, version: { version: 'other', ghostty: 'other' } }, { type: 'stop' } as const])(
  'does not notify welcome or send a snapshot for $type without a matching hello',
  (message) => {
    const socket = createSocket();
    const welcomed: Connection[] = [];

    const { connection } = open(socket, undefined, (from) => {
      welcomed.push(from);
      sendSnapshot(from);
    });

    connection.receive(frameOf(message));

    expect(welcomed).toEqual([]);
    expect(connection.isWelcomed()).toBe(false);
    expect(messagesIn(socket.written).some((answer) => answer.type === 'snapshot')).toBe(false);
  },
);

it('does not notify welcome when its response exceeds the write queue limit', () => {
  const socket = createSocket(0);
  const { log } = createRecordingLog();
  const welcomed: Connection[] = [];

  const connection = createConnection({
    socket,
    version: build,
    log,
    queueLimitBytes: 1,
    onMessage: () => undefined,
    onWelcome: (from) => {
      welcomed.push(from);
    },
  });

  connection.receive(frameOf(hello));

  expect(welcomed).toEqual([]);
  expect(connection.isClosed()).toBe(true);
  expect(connection.isWelcomed()).toBe(false);
  expect(socket.written).toEqual([]);
});

it('accepts a hello split across reads', () => {
  const socket = createSocket();
  const { connection } = open(socket);
  const bytes = frameOf(hello);

  connection.receive(bytes.subarray(0, 3));
  connection.receive(bytes.subarray(3));

  expect(messagesIn(socket.written)).toEqual([{ type: 'welcome' }]);
});

it('refuses a hello from another build and closes once the refusal is written', () => {
  const socket = createSocket(4);
  const received: ControlMessage[] = [];
  const { connection } = open(socket, (message) => received.push(message));
  const other = { version: '1.2.4', ghostty: 'def456' };

  connection.receive(
    Uint8Array.from([...frameOf({ ...hello, version: other }), ...frameOf({ type: 'stop' })]),
  );

  expect(socket.isEnded()).toBe(false);

  socket.grow(1000);
  connection.drain();

  expect(messagesIn(socket.written)).toEqual([{ type: 'refused', client: other, server: build }]);
  expect(socket.isEnded()).toBe(true);
  expect(received).toEqual([]);
});

it('passes on stop as the first message without a hello', () => {
  const socket = createSocket();
  const received: ControlMessage[] = [];
  const { connection } = open(socket, (message) => received.push(message));

  connection.receive(frameOf({ type: 'stop' }));

  expect(received).toEqual([{ type: 'stop' }]);
  expect(socket.written).toEqual([]);
});

it('closes a connection whose first message is not hello or stop, without an answer', () => {
  const socket = createSocket();
  const received: ControlMessage[] = [];
  const { connection } = open(socket, (message) => received.push(message));

  connection.receive(frameOf({ type: 'resync' }));
  connection.receive(frameOf(hello));

  expect(socket.written).toEqual([]);
  expect(socket.isEnded()).toBe(true);
  expect(received).toEqual([]);
});

it('closes a connection whose first frame is not a control frame', () => {
  const socket = createSocket();
  const { connection } = open(socket);

  connection.receive(encodeFrame(FrameKind.input, Uint8Array.of(1)));

  expect(socket.written).toEqual([]);
  expect(socket.isEnded()).toBe(true);
});

it('logs and closes a connection that sends a frame of an unknown kind', () => {
  const socket = createSocket();
  const { connection, entries } = open(socket);

  connection.receive(frameOf(hello));
  connection.receive(Uint8Array.of(99, 0, 0, 0, 0));

  expect(socket.isEnded()).toBe(true);
  expect(entries.map((entry) => entry.level)).toContain('warn');
});

it('logs and closes a connection that sends an invalid message', () => {
  const socket = createSocket();
  const { connection, entries } = open(socket);

  connection.receive(frameOf(hello));
  connection.receive(encodeFrame(FrameKind.control, new TextEncoder().encode('{"type":"shout"}')));

  expect(socket.isEnded()).toBe(true);
  expect(entries.map((entry) => entry.level)).toContain('warn');
});

it('closes only the connection whose handler throws, and logs the error', () => {
  const failing = createSocket();
  const working = createSocket();
  const received: ControlMessage[] = [];

  const onMessage = (message: ControlMessage, connection: Connection): void => {
    if (message.type === 'stop') {
      throw new Error('handler failed');
    }

    received.push(message);
    connection.send({ type: 'takenOver' });
  };

  const first = open(failing, onMessage);
  const second = open(working, onMessage);

  first.connection.receive(frameOf(hello));
  second.connection.receive(frameOf(hello));

  first.connection.receive(
    Uint8Array.from([...frameOf({ type: 'stop' }), ...frameOf({ type: 'resync' })]),
  );

  second.connection.receive(frameOf({ type: 'resync' }));

  expect(failing.isEnded()).toBe(true);
  expect(first.entries.map((entry) => entry.level)).toContain('error');
  expect(working.isEnded()).toBe(false);
  expect(received).toEqual([{ type: 'resync' }]);
  expect(messagesIn(working.written)).toEqual([{ type: 'welcome' }, { type: 'takenOver' }]);
});

it('closes a connection whose write queue passes the limit', () => {
  const socket = createSocket(0);
  const { connection, entries } = open(socket);

  connection.receive(frameOf(hello));

  for (let sent = 0; sent < 100; sent += 1) {
    connection.send({ type: 'takenOver' });
  }

  expect(connection.isClosed()).toBe(true);
  expect(socket.isEnded()).toBe(true);
  expect(entries.map((entry) => entry.level)).toContain('warn');
});
