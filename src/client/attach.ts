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
import { decodeRowUpdate, encodePaneInput } from '../rows/rows.ts';
import { createRowCache } from './rowCache.ts';
import type { RowCache } from './rowCache.ts';
import { applyChange } from './snapshot.ts';
import type { StoreChange, StoreSnapshot } from './snapshot.ts';

interface TerminalSize {
  columns: number;
  rows: number;
}

export type InputMode = 'insert' | 'normal';

interface AttachState {
  snapshot: StoreSnapshot;
  inputMode: InputMode;
}

export type CloseReason = 'serverClosed' | 'connectionFailed' | 'requested';

interface RowsChanged {
  pane: PaneId;
  // The indexes of the active screen rows that changed.
  rows: number[];
  // The sequence of the row update. Pass it to acknowledge once the rows are drawn.
  sequence: number;
}

// Colors as 0xRRGGBB numbers.
export interface TerminalTheme {
  foreground: number;
  background: number;
  // Palette indexes 0-15.
  palette: readonly number[];
}

export interface AttachSession {
  subscribe: (listener: () => void) => () => void;
  getState: () => AttachState;
  setInputMode: (mode: InputMode) => void;
  subscribeRows: (listener: (changed: RowsChanged) => void) => () => void;
  rowCache: (pane: PaneId) => RowCache | undefined;
  // The sequence of the newest row update applied to the pane's cache, drawn or not.
  newestSequence: (pane: PaneId) => number | undefined;
  resize: (size: TerminalSize) => void;
  // Tells the server the colors of the client's terminal.
  setTheme: (theme: TerminalTheme) => void;
  // Tells the server the client has drawn every row update up to this sequence.
  acknowledge: (sequence: number) => void;
  sendInput: (pane: PaneId, bytes: Uint8Array) => void;
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
  const newestSequences = new Map<PaneId, number>();
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

  const enqueue = (frame: Uint8Array): void => {
    const queued = new Uint8Array(pending.length + frame.length);

    queued.set(pending);
    queued.set(frame, pending.length);
    pending = queued;
    drain();
  };

  const send = (message: ControlMessage): void => {
    enqueue(encodeFrame(FrameKind.control, encodeControl(message)));
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
    setState({ snapshot, inputMode: state?.inputMode ?? 'insert' });
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

    newestSequences.set(pane, decoded.update.sequence);

    for (const listener of rowListeners) {
      listener({ pane, rows, sequence: decoded.update.sequence });
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
    setInputMode: (mode) => {
      invariant(state !== undefined, 'The attach session is only handed out after a snapshot.');

      if (state.inputMode !== mode) {
        setState({ ...state, inputMode: mode });
      }
    },
    subscribeRows: (listener) => {
      rowListeners.add(listener);

      return () => {
        rowListeners.delete(listener);
      };
    },
    rowCache: (pane) => rowCaches.get(pane),
    newestSequence: (pane) => newestSequences.get(pane),
    resize: (next) => {
      send({ type: 'resize', size: next });
    },
    setTheme: (theme) => {
      send({ type: 'theme', theme });
    },
    acknowledge: (sequence) => {
      if (!ended) {
        send({ type: 'ack', sequence });
      }
    },
    sendInput: (pane, bytes) => {
      const number = Number(pane.slice('pane-'.length));

      enqueue(encodeFrame(FrameKind.input, encodePaneInput({ pane: number, bytes })));
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
