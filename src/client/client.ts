import {
  createFrameDecoder,
  encodeControl,
  encodeFrame,
  FrameKind,
  parseControl,
} from '../protocol/protocol.ts';
import type { BuildVersion, ControlMessage } from '../protocol/protocol.ts';

export interface ServerSession {
  send: (message: ControlMessage) => void;
  close: () => void;
}

type HelloResult =
  | { ok: true; session: ServerSession }
  | { ok: false; reason: 'noServer' }
  | { ok: false; reason: 'refused'; client: BuildVersion; server: BuildVersion }
  | { ok: false; reason: 'noAnswer' };

type Answer = Extract<ControlMessage, { type: 'welcome' | 'refused' }> | undefined;

type ClientSocket = Bun.Socket;

const connectSocket = async (
  socketPath: string,
  onAnswer: (answer: Answer) => void,
): Promise<ClientSocket | undefined> => {
  const decoder = createFrameDecoder();

  const receive = (bytes: Uint8Array): void => {
    const decoded = decoder.push(bytes);
    const first = decoded.ok ? decoded.frames[0] : undefined;
    const parsed = first === undefined ? undefined : parseControl(first.payload);

    if (parsed === undefined) {
      return;
    }

    const message = parsed.ok ? parsed.message : undefined;
    const isAnswer = message?.type === 'welcome' || message?.type === 'refused';

    onAnswer(isAnswer ? message : undefined);
  };

  try {
    return await Bun.connect({
      unix: socketPath,
      socket: {
        data: (_socket, bytes) => {
          receive(bytes);
        },
        close: () => {
          onAnswer(undefined);
        },
      },
    });
  } catch {
    return undefined;
  }
};

// Connects and runs the version handshake. Gives up when the server does not answer within
// timeoutMs, so a hung server never blocks a command.
export const helloServer = async (
  socketPath: string,
  version: BuildVersion,
  timeoutMs: number,
): Promise<HelloResult> => {
  const answer = Promise.withResolvers<Answer>();
  const socket = await connectSocket(socketPath, answer.resolve);

  if (socket === undefined) {
    return { ok: false, reason: 'noServer' };
  }

  const timer = setTimeout(() => {
    answer.resolve(undefined);
  }, timeoutMs);

  socket.write(
    encodeFrame(FrameKind.control, encodeControl({ type: 'hello', version, size: undefined })),
  );

  const received = await answer.promise;

  clearTimeout(timer);

  if (received?.type === 'welcome') {
    return {
      ok: true,
      session: {
        send: (message) => {
          socket.write(encodeFrame(FrameKind.control, encodeControl(message)));
        },
        close: () => {
          socket.end();
        },
      },
    };
  }

  socket.end();

  if (received === undefined) {
    return { ok: false, reason: 'noAnswer' };
  }

  return { ok: false, reason: 'refused', client: received.client, server: received.server };
};
