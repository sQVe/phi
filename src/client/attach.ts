import { paneId } from '../ids.ts';
import type { PaneId } from '../ids.ts';
import { invariant } from '../invariant.ts';
import {
  createFrameDecoder,
  encodeControl,
  encodeFrame,
  FrameKind,
  parseControl,
} from '../protocol/protocol.ts';
import type { BuildVersion, ControlMessage } from '../protocol/protocol.ts';
import { decodeRowUpdate } from '../rows/rows.ts';
import { createRowCache } from './rowCache.ts';
import type { RowCache } from './rowCache.ts';
import { applyChange } from './snapshot.ts';
import type { StoreChange, StoreSnapshot } from './snapshot.ts';

interface TerminalSize {
  columns: number;
  rows: number;
}

interface AttachState {
  snapshot: StoreSnapshot;
  inputMode: 'normal';
}

type CloseReason = 'serverClosed' | 'connectionFailed' | 'requested';

interface RowsChanged {
  pane: PaneId;
  // The indexes of the active screen rows that changed.
  rows: number[];
}

export interface AttachSession {
  subscribe: (listener: () => void) => () => void;
  getState: () => AttachState;
  subscribeRows: (listener: (changed: RowsChanged) => void) => () => void;
  rowCache: (pane: PaneId) => RowCache | undefined;
  resize: (size: TerminalSize) => void;
  close: () => void;
  closed: Promise<CloseReason>;
}

export type AttachResult =
  | { ok: true; session: AttachSession }
  | { ok: false; reason: 'noServer' | 'connectionFailed' }
  | { ok: false; reason: 'refused'; client: BuildVersion; server: BuildVersion };

const rowCacheLimit = 10_000;

const handshakeTimeoutMs = 10_000;

export const connectAttach = async (
  socketPath: string,
  version: BuildVersion,
  size: TerminalSize,
): Promise<AttachResult> => {
  const handshake = Promise.withResolvers<AttachResult>();
  const closedSignal = Promise.withResolvers<CloseReason>();
  const decoder = createFrameDecoder();
  const rowCaches = new Map<PaneId, RowCache>();
  const stateListeners = new Set<() => void>();
  const rowListeners = new Set<(changed: RowsChanged) => void>();
  let pending: Uint8Array = new Uint8Array();
  let state: AttachState | undefined;
  let welcomed = false;
  let waitingForSnapshot = false;
  let ended = false;
  let socket: Bun.Socket | undefined;

  const drain = (): void => {
    if (socket === undefined || pending.length === 0) {
      return;
    }

    const written = socket.write(pending);

    pending = pending.subarray(Math.max(written, 0));
  };

  const send = (message: ControlMessage): void => {
    const frame = encodeFrame(FrameKind.control, encodeControl(message));
    const queued = new Uint8Array(pending.length + frame.length);

    queued.set(pending);
    queued.set(frame, pending.length);
    pending = queued;
    drain();
  };

  const end = (reason: CloseReason): void => {
    if (ended) {
      return;
    }

    ended = true;
    socket?.end();
    handshake.resolve({ ok: false, reason: 'connectionFailed' });
    closedSignal.resolve(reason);
  };

  const setState = (next: AttachState): void => {
    state = next;

    for (const listener of stateListeners) {
      listener();
    }
  };

  const takeSnapshot = (snapshot: StoreSnapshot): void => {
    waitingForSnapshot = false;
    setState({ snapshot, inputMode: 'normal' });
  };

  const takeChange = (revision: number, change: StoreChange): void => {
    if (state === undefined || waitingForSnapshot) {
      return;
    }

    if (revision !== state.snapshot.revision + 1) {
      waitingForSnapshot = true;
      send({ type: 'resync' });

      return;
    }

    const snapshot = { ...applyChange(state.snapshot, change), revision };

    setState({ ...state, snapshot });
  };

  const takeRows = (bytes: Uint8Array): void => {
    const decoded = decodeRowUpdate(bytes);

    if (!decoded.ok) {
      end('connectionFailed');

      return;
    }

    const pane = paneId(decoded.update.pane);
    const cache = rowCaches.get(pane) ?? createRowCache({ rowLimit: rowCacheLimit });

    rowCaches.set(pane, cache);

    const rows = cache.apply(decoded.update);

    for (const listener of rowListeners) {
      listener({ pane, rows });
    }
  };

  const takeHandshake = (message: ControlMessage): void => {
    if (message.type === 'refused') {
      handshake.resolve({
        ok: false,
        reason: 'refused',
        client: message.client,
        server: message.server,
      });

      end('connectionFailed');

      return;
    }

    if (message.type !== 'welcome') {
      end('connectionFailed');

      return;
    }

    welcomed = true;
  };

  const takeControl = (message: ControlMessage): void => {
    if (!welcomed) {
      takeHandshake(message);

      return;
    }

    if (message.type === 'snapshot') {
      const first = state === undefined;

      takeSnapshot(message.snapshot);

      if (first) {
        handshake.resolve({ ok: true, session });
      }

      return;
    }

    if (message.type === 'change') {
      takeChange(message.revision, message.change);
    }
  };

  const takeFrames = (bytes: Uint8Array): void => {
    const decoded = decoder.push(bytes);

    if (!decoded.ok) {
      end('connectionFailed');

      return;
    }

    for (const frame of decoded.frames) {
      if (ended) {
        return;
      }

      if (frame.kind === FrameKind.rowUpdate) {
        takeRows(frame.payload);

        continue;
      }

      const parsed = parseControl(frame.payload);

      if (frame.kind !== FrameKind.control || !parsed.ok) {
        end('connectionFailed');

        return;
      }

      takeControl(parsed.message);
    }
  };

  const session: AttachSession = {
    subscribe: (listener) => {
      stateListeners.add(listener);

      return () => {
        stateListeners.delete(listener);
      };
    },
    getState: () => {
      invariant(state !== undefined, 'The attach session is only handed out after a snapshot.');

      return state;
    },
    subscribeRows: (listener) => {
      rowListeners.add(listener);

      return () => {
        rowListeners.delete(listener);
      };
    },
    rowCache: (pane) => rowCaches.get(pane),
    resize: (next) => {
      send({ type: 'resize', size: next });
    },
    close: () => {
      end('requested');
    },
    closed: closedSignal.promise,
  };

  try {
    socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data: (_socket, bytes) => {
          takeFrames(bytes);
        },
        drain,
        close: () => {
          end('serverClosed');
        },
        error: () => {
          end('connectionFailed');
        },
      },
    });
  } catch {
    return { ok: false, reason: 'noServer' };
  }

  const timer = setTimeout(() => {
    end('connectionFailed');
  }, handshakeTimeoutMs);

  send({ type: 'hello', version, size });

  try {
    return await handshake.promise;
  } finally {
    clearTimeout(timer);
  }
};
