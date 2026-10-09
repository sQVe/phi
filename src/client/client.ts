import type { PaneId } from '../ids.ts';
import {
  createFrameDecoder,
  encodeControl,
  encodeFrame,
  FrameKind,
  parseControl,
} from '../protocol/protocol.ts';
import type { BuildVersion, ControlMessage } from '../protocol/protocol.ts';

export { connectAttach } from './attach.ts';
export type { AttachSession } from './attach.ts';
export { createRowCache } from './rowCache.ts';
export type { RowCache } from './rowCache.ts';

type StopResult = { ok: true; close: () => void } | { ok: false; reason: 'noServer' };

export type PaneCommand = { action: 'read' } | { action: 'send'; text: string };

type PaneResult =
  | { ok: true; kind: 'rows'; paneId: PaneId; rows: string[] }
  | { ok: true; kind: 'sent' }
  | { ok: false; reason: 'noServer' | 'paneMissing' | 'connectionFailed' }
  | { ok: false; reason: 'refused'; client: BuildVersion; server: BuildVersion };

interface PaneSession {
  command: PaneCommand;
  welcomed: boolean;
  paneId: PaneId | undefined;
  send: (message: ControlMessage) => void;
  finish: (result: PaneResult) => void;
}

const handlePaneAnswer = (session: PaneSession, message: ControlMessage): void => {
  if (!('paneId' in message) || message.paneId !== session.paneId) {
    return;
  }

  if (message.type === 'paneMissing') {
    session.finish({ ok: false, reason: 'paneMissing' });
  }

  if (message.type === 'paneRows' && session.command.action === 'read') {
    session.finish({ ok: true, kind: 'rows', paneId: message.paneId, rows: message.rows });
  }

  if (message.type === 'paneSent' && session.command.action === 'send') {
    session.finish({ ok: true, kind: 'sent' });
  }
};

const handlePaneMessage = (session: PaneSession, message: ControlMessage): void => {
  if (!session.welcomed) {
    if (message.type === 'refused') {
      session.finish({
        ok: false,
        reason: 'refused',
        client: message.client,
        server: message.server,
      });

      return;
    }

    if (message.type !== 'welcome') {
      session.finish({ ok: false, reason: 'connectionFailed' });

      return;
    }

    session.welcomed = true;

    return;
  }

  if (message.type === 'snapshot' && session.paneId === undefined) {
    const pane = message.snapshot.pane;

    if (pane?.lifecycle !== 'running') {
      session.finish({ ok: false, reason: 'paneMissing' });

      return;
    }

    session.paneId = pane.id;

    const { command } = session;

    if (command.action === 'read') {
      session.send({ type: 'paneRead', paneId: pane.id });
    } else {
      session.send({ type: 'paneSend', paneId: pane.id, text: command.text });
    }

    return;
  }

  handlePaneAnswer(session, message);
};

const createPaneReceiver = (session: PaneSession, isFinished: () => boolean) => {
  const decoder = createFrameDecoder();

  return (_socket: Bun.Socket, bytes: Uint8Array): void => {
    const decoded = decoder.push(bytes);

    if (!decoded.ok) {
      session.finish({ ok: false, reason: 'connectionFailed' });

      return;
    }

    for (const frame of decoded.frames) {
      if (isFinished()) {
        return;
      }

      const parsed = parseControl(frame.payload);

      if (frame.kind !== FrameKind.control || !parsed.ok) {
        session.finish({ ok: false, reason: 'connectionFailed' });

        return;
      }

      handlePaneMessage(session, parsed.message);
    }
  };
};

const paneCommandTimeoutMs = 10_000;

export const runPaneCommand = async (
  socketPath: string,
  version: BuildVersion,
  command: PaneCommand,
): Promise<PaneResult> => {
  const answer = Promise.withResolvers<PaneResult>();
  let pending: Uint8Array = new Uint8Array();
  let finished = false;

  const finish = (result: PaneResult): void => {
    finished = true;
    answer.resolve(result);
  };

  const drain = (socket: Bun.Socket): void => {
    const written = socket.write(pending);

    if (written < 0) {
      finish({ ok: false, reason: 'connectionFailed' });

      return;
    }

    pending = pending.subarray(written);
  };

  const session: PaneSession = {
    command,
    welcomed: false,
    paneId: undefined,
    send: (message) => {
      pending = encodeFrame(FrameKind.control, encodeControl(message));
      drain(socket);
    },
    finish,
  };

  let socket: Bun.Socket;

  try {
    socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data: createPaneReceiver(session, () => finished),
        drain,
        close: () => {
          finish({ ok: false, reason: 'connectionFailed' });
        },
        error: () => {
          finish({ ok: false, reason: 'connectionFailed' });
        },
      },
    });
  } catch {
    return { ok: false, reason: 'noServer' };
  }

  const timer = setTimeout(() => {
    finish({ ok: false, reason: 'connectionFailed' });
  }, paneCommandTimeoutMs);

  session.send({ type: 'hello', version, size: undefined });

  try {
    return await answer.promise;
  } finally {
    clearTimeout(timer);
    socket.end();
  }
};

// Sends stop without a handshake, so it reaches a server of any build.
export const sendStop = async (socketPath: string): Promise<StopResult> => {
  let socket: Bun.Socket;

  try {
    socket = await Bun.connect({ unix: socketPath, socket: { data: () => undefined } });
  } catch {
    return { ok: false, reason: 'noServer' };
  }

  socket.write(encodeFrame(FrameKind.control, encodeControl({ type: 'stop' })));

  return {
    ok: true,
    close: () => {
      socket.end();
    },
  };
};
