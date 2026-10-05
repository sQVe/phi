import { clientId, paneId } from '../ids.ts';
import type { ClientId, PaneId } from '../ids.ts';
import { invariant } from '../invariant.ts';
import { paneSize } from '../layout.ts';
import type { TerminalSize } from '../layout.ts';

type PaneLifecycle = 'starting' | 'running' | 'exited' | 'closing';

export interface Pane {
  id: PaneId;
  lifecycle: PaneLifecycle;
  size: TerminalSize;
  generation: number;
  exitCode: number | undefined;
}

export interface Client {
  id: ClientId;
  size: TerminalSize;
}

export interface State {
  pane: Pane | undefined;
  attachedClientId: ClientId | undefined;
  clients: readonly Client[];
  stopping: boolean;
  nextPaneNumber: number;
  nextClientNumber: number;
  nextGeneration: number;
  revision: number;
}

export type Intent =
  | { type: 'startPane' }
  | { type: 'attachClient'; size: TerminalSize }
  | { type: 'resizeClient'; clientId: ClientId; size: TerminalSize }
  | { type: 'detachClient'; clientId: ClientId }
  | { type: 'stopServer' };

export type Fact =
  | { type: 'paneStarted'; paneId: PaneId; generation: number }
  | { type: 'paneFailedToStart'; paneId: PaneId; generation: number }
  | { type: 'paneExited'; paneId: PaneId; generation: number; exitCode: number };

export type DetachReason = 'requested' | 'takenOver';

export type Change =
  | { type: 'paneAdded'; pane: Pane }
  | {
      type: 'paneStateChanged';
      paneId: PaneId;
      lifecycle: PaneLifecycle;
      exitCode: number | undefined;
    }
  | { type: 'paneResized'; paneId: PaneId; size: TerminalSize }
  | { type: 'clientAttached'; client: Client }
  | { type: 'clientResized'; clientId: ClientId; size: TerminalSize }
  | { type: 'clientDetached'; clientId: ClientId; reason: DetachReason }
  | { type: 'serverStopping' };

type RejectReason = 'paneExists' | 'serverStopping' | 'unknownClient';

// Whatever an effect still holds for this pane generation, such as its process and PTY.
interface PaneProcess {
  paneId: PaneId;
  generation: number;
}

export interface Applied {
  kind: 'applied';
  state: State;
  changes: readonly Change[];
}

export interface Rejected {
  kind: 'rejected';
  state: State;
  reason: RejectReason;
}

export interface Ignored {
  kind: 'ignored';
  state: State;
  dispose: PaneProcess;
}

export interface Snapshot {
  revision: number;
  pane: Pane | undefined;
  attachedClientId: ClientId | undefined;
  clients: readonly Client[];
}

export const createState = (): State => ({
  pane: undefined,
  attachedClientId: undefined,
  clients: [],
  stopping: false,
  nextPaneNumber: 1,
  nextClientNumber: 1,
  nextGeneration: 1,
  revision: 0,
});

export const snapshot = (state: State): Snapshot => ({
  revision: state.revision,
  pane: state.pane,
  attachedClientId: state.attachedClientId,
  clients: state.clients,
});

const commit = (state: State, changes: readonly Change[]): Applied => {
  const revision = changes.length === 0 ? state.revision : state.revision + 1;

  return { kind: 'applied', state: { ...state, revision }, changes };
};

const reject = (state: State, reason: RejectReason): Rejected => ({
  kind: 'rejected',
  state,
  reason,
});

const sameSize = (left: TerminalSize, right: TerminalSize): boolean =>
  left.columns === right.columns && left.rows === right.rows;

const isLive = (pane: Pane): boolean =>
  pane.lifecycle === 'starting' || pane.lifecycle === 'running';

const attachedClientOf = (state: State): Client | undefined =>
  state.clients.find((client) => client.id === state.attachedClientId);

const fitPane = (state: State): { pane: Pane | undefined; changes: Change[] } => {
  const { pane } = state;
  const client = attachedClientOf(state);

  if (pane === undefined || client === undefined || !isLive(pane)) {
    return { pane, changes: [] };
  }

  const size = paneSize(client.size);

  if (sameSize(size, pane.size)) {
    return { pane, changes: [] };
  }

  return {
    pane: { ...pane, size },
    changes: [{ type: 'paneResized', paneId: pane.id, size }],
  };
};

const startPane = (state: State): Applied | Rejected => {
  if (state.stopping) {
    return reject(state, 'serverStopping');
  }

  if (state.pane !== undefined) {
    return reject(state, 'paneExists');
  }

  const pane: Pane = {
    id: paneId(state.nextPaneNumber),
    lifecycle: 'starting',
    size: paneSize(attachedClientOf(state)?.size),
    generation: state.nextGeneration,
    exitCode: undefined,
  };

  const next: State = {
    ...state,
    pane,
    nextPaneNumber: state.nextPaneNumber + 1,
    nextGeneration: state.nextGeneration + 1,
  };

  return commit(next, [{ type: 'paneAdded', pane }]);
};

const attachClient = (state: State, size: TerminalSize): Applied => {
  const client: Client = { id: clientId(state.nextClientNumber), size };
  const previous = state.attachedClientId;
  const changes: Change[] = [];

  if (previous !== undefined) {
    changes.push({ type: 'clientDetached', clientId: previous, reason: 'takenOver' });
  }

  changes.push({ type: 'clientAttached', client });

  const attached: State = {
    ...state,
    attachedClientId: client.id,
    clients: [...state.clients.filter((known) => known.id !== previous), client],
    nextClientNumber: state.nextClientNumber + 1,
  };

  const fitted = fitPane(attached);

  return commit({ ...attached, pane: fitted.pane }, [...changes, ...fitted.changes]);
};

const resizeClient = (state: State, id: ClientId, size: TerminalSize): Applied | Rejected => {
  const resizing = state.clients.find((known) => known.id === id);

  if (resizing === undefined) {
    return reject(state, 'unknownClient');
  }

  if (sameSize(resizing.size, size)) {
    return commit(state, []);
  }

  const resized: State = {
    ...state,
    clients: state.clients.map((client) => (client.id === id ? { ...client, size } : client)),
  };

  const fitted = fitPane(resized);

  return commit({ ...resized, pane: fitted.pane }, [
    { type: 'clientResized', clientId: id, size },
    ...fitted.changes,
  ]);
};

// The pane keeps its size after a detach, so the next attach redraws the same screen.
const detachClient = (state: State, id: ClientId): Applied | Rejected => {
  if (!state.clients.some((client) => client.id === id)) {
    return reject(state, 'unknownClient');
  }

  const attachedClientId = state.attachedClientId === id ? undefined : state.attachedClientId;

  const next: State = {
    ...state,
    attachedClientId,
    clients: state.clients.filter((client) => client.id !== id),
  };

  return commit(next, [{ type: 'clientDetached', clientId: id, reason: 'requested' }]);
};

const stopServer = (state: State): Applied => {
  if (state.stopping) {
    return commit(state, []);
  }

  const { pane } = state;
  const changes: Change[] = [];
  let nextPane = pane;

  if (pane !== undefined && isLive(pane)) {
    nextPane = { ...pane, lifecycle: 'closing' };

    changes.push({
      type: 'paneStateChanged',
      paneId: pane.id,
      lifecycle: 'closing',
      exitCode: undefined,
    });
  }

  changes.push({ type: 'serverStopping' });

  return commit({ ...state, pane: nextPane, stopping: true }, changes);
};

export const applyIntent = (state: State, intent: Intent): Applied | Rejected => {
  if (intent.type === 'startPane') {
    return startPane(state);
  }

  if (intent.type === 'attachClient') {
    return attachClient(state, intent.size);
  }

  if (intent.type === 'resizeClient') {
    return resizeClient(state, intent.clientId, intent.size);
  }

  if (intent.type === 'detachClient') {
    return detachClient(state, intent.clientId);
  }

  return stopServer(state);
};

const ignore = (state: State, fact: Fact): Ignored => ({
  kind: 'ignored',
  state,
  dispose: { paneId: fact.paneId, generation: fact.generation },
});

const isCurrent = (pane: Pane | undefined, fact: Fact): pane is Pane =>
  pane?.id === fact.paneId && pane.generation === fact.generation;

// The pane is the last one, so its end stops the server.
const endPane = (state: State, pane: Pane, exitCode: number | undefined): Applied => {
  const changes: Change[] = [
    { type: 'paneStateChanged', paneId: pane.id, lifecycle: 'exited', exitCode },
  ];

  if (!state.stopping) {
    changes.push({ type: 'serverStopping' });
  }

  const next: State = {
    ...state,
    pane: { ...pane, lifecycle: 'exited', exitCode },
    stopping: true,
  };

  return commit(next, changes);
};

const markRunning = (state: State, pane: Pane): Applied => {
  const next: State = { ...state, pane: { ...pane, lifecycle: 'running' } };

  return commit(next, [
    { type: 'paneStateChanged', paneId: pane.id, lifecycle: 'running', exitCode: undefined },
  ]);
};

export const applyFact = (state: State, fact: Fact): Applied | Ignored => {
  const { pane } = state;

  if (!isCurrent(pane, fact)) {
    return ignore(state, fact);
  }

  // The effect that runs a pane generation reports its end once.
  invariant(pane.lifecycle !== 'exited', `Pane ${pane.id} reported ${fact.type} after it exited.`);

  if (fact.type === 'paneExited') {
    return endPane(state, pane, fact.exitCode);
  }

  if (fact.type === 'paneFailedToStart') {
    return endPane(state, pane, undefined);
  }

  return pane.lifecycle === 'starting' ? markRunning(state, pane) : ignore(state, fact);
};
