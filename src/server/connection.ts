import {
  answerHello,
  createFrameDecoder,
  encodeControl,
  encodeFrame,
  FrameKind,
  parseControl,
} from '../protocol/protocol.ts';
import type { BuildVersion, ControlMessage } from '../protocol/protocol.ts';
import type { Log } from './log.ts';
import { createWriteQueue } from './writeQueue.ts';

// The part of a Bun socket a connection uses.
interface ConnectionSocket {
  write: (bytes: Uint8Array) => number;
  end: () => void;
}

interface ConnectionOptions {
  socket: ConnectionSocket;
  version: BuildVersion;
  log: Log;
  queueLimitBytes: number;
  // Gets each control message after the handshake.
  onMessage: (message: ControlMessage, connection: Connection) => void;
}

export interface Connection {
  receive: (bytes: Uint8Array) => void;
  drain: () => void;
  send: (message: ControlMessage) => void;
  close: () => void;
  isClosed: () => boolean;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

// Runs the handshake and the frames of one socket. Any failure closes this connection only.
export const createConnection = (options: ConnectionOptions): Connection => {
  const { socket, version, log } = options;
  const decoder = createFrameDecoder();
  const queue = createWriteQueue(socket, options.queueLimitBytes);
  let welcomed = false;
  let closed = false;
  let closeWhenDrained = false;

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    socket.end();
  };

  const send = (message: ControlMessage): void => {
    if (closed) {
      return;
    }

    const sent = queue.send(encodeFrame(FrameKind.control, encodeControl(message)));

    if (!sent.ok) {
      log.warn('Closed a connection whose write queue is full.', {
        limitBytes: options.queueLimitBytes,
      });

      close();
    }
  };

  const drain = (): void => {
    queue.drain();

    if (closeWhenDrained && queue.isEmpty()) {
      close();
    }
  };

  const refuseStart = (fields: Record<string, unknown>): void => {
    log.warn('Closed a connection that did not start with hello.', fields);
    close();
  };

  // Returns undefined, and closes the connection, when the payload is not a valid message.
  const parseMessage = (payload: Uint8Array): ControlMessage | undefined => {
    const parsed = parseControl(payload);

    if (parsed.ok) {
      return parsed.message;
    }

    log.warn('Closed a connection that sent an invalid message.', { reason: parsed.reason });
    close();

    return undefined;
  };

  const greet = (message: ControlMessage): void => {
    if (message.type !== 'hello') {
      refuseStart({ type: message.type });

      return;
    }

    const answer = answerHello(version, message);

    send(answer);

    if (answer.type === 'welcome') {
      welcomed = true;

      return;
    }

    log.info('Refused a client from another build.', { client: answer.client });
    closeWhenDrained = true;
    drain();
  };

  const handleFrame = (kind: FrameKind, payload: Uint8Array): void => {
    if (kind !== FrameKind.control) {
      if (welcomed) {
        log.debug('Ignored a frame the server does not handle yet.', { kind });
      } else {
        refuseStart({ kind });
      }

      return;
    }

    const message = parseMessage(payload);

    if (message === undefined) {
      return;
    }

    if (welcomed) {
      options.onMessage(message, connection);
    } else {
      greet(message);
    }
  };

  // A refused client gets no answers while its refusal drains.
  const isDone = (): boolean => closed || closeWhenDrained;

  const receive = (bytes: Uint8Array): void => {
    if (isDone()) {
      return;
    }

    const decoded = decoder.push(bytes);

    if (!decoded.ok) {
      log.warn('Closed a connection that sent an invalid frame.', { reason: decoded.reason });
      close();

      return;
    }

    for (const frame of decoded.frames) {
      if (isDone()) {
        return;
      }

      try {
        handleFrame(frame.kind, frame.payload);
      } catch (error) {
        log.error('Closed a connection whose handler failed.', { error: describeError(error) });
        close();
      }
    }
  };

  const connection: Connection = { receive, drain, send, close, isClosed: () => closed };

  return connection;
};
