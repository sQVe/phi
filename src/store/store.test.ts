import { expect, it } from 'bun:test';

import { clientId, paneId } from '../ids.ts';
import { applyFact, applyIntent, createState, snapshot } from './store.ts';
import type { Applied, Fact, Ignored, Intent, Pane, Rejected, State } from './store.ts';

const expectApplied = (result: Applied | Ignored | Rejected): Applied => {
  if (result.kind !== 'applied') {
    throw new Error(`Expected an applied transition, got ${result.kind}.`);
  }

  return result;
};

const intent = (state: State, next: Intent): Applied => expectApplied(applyIntent(state, next));

const fact = (state: State, next: Fact): Applied => expectApplied(applyFact(state, next));

const run = (intents: readonly Intent[]): State =>
  intents.reduce((state, next) => intent(state, next).state, createState());

const firstPane = { paneId: paneId(1), generation: 1 };

it('starts a pane at 80x24 when no client is attached', () => {
  const result = intent(createState(), { type: 'startPane' });

  const pane: Pane = {
    id: paneId(1),
    lifecycle: 'starting',
    size: { columns: 80, rows: 24 },
    generation: 1,
    exitCode: undefined,
  };

  expect(result.state.pane).toEqual(pane);
  expect(result.changes).toEqual([{ type: 'paneAdded', pane }]);
});

it('starts a pane at the layout size of the attached client', () => {
  const state = run([{ type: 'attachClient', size: { columns: 120, rows: 40 } }]);

  expect(intent(state, { type: 'startPane' }).state.pane?.size).toEqual({
    columns: 120,
    rows: 39,
  });
});

it('refuses a second pane and leaves state unchanged', () => {
  const state = run([{ type: 'startPane' }]);
  const result = applyIntent(state, { type: 'startPane' });

  expect(result).toEqual({ kind: 'rejected', state, reason: 'paneExists' });
});

it('refuses to start a pane while the server stops and leaves state unchanged', () => {
  const state = run([{ type: 'stopServer' }]);
  const result = applyIntent(state, { type: 'startPane' });

  expect(result).toEqual({ kind: 'rejected', state, reason: 'serverStopping' });
  expect(result.state.revision).toBe(state.revision);
});

it('resizes the pane to the layout size of a client that attaches', () => {
  const state = run([{ type: 'startPane' }]);
  const result = intent(state, { type: 'attachClient', size: { columns: 100, rows: 30 } });
  const client = { id: clientId(1), size: { columns: 100, rows: 30 } };

  expect(result.state.attachedClientId).toBe(clientId(1));
  expect(result.state.pane?.size).toEqual({ columns: 100, rows: 29 });

  expect(result.changes).toEqual([
    { type: 'clientAttached', client },
    { type: 'paneResized', paneId: paneId(1), size: { columns: 100, rows: 29 } },
  ]);
});

it('takes over from the attached client when a second client attaches', () => {
  const state = run([
    { type: 'startPane' },
    { type: 'attachClient', size: { columns: 100, rows: 30 } },
  ]);

  const result = intent(state, { type: 'attachClient', size: { columns: 90, rows: 20 } });
  const client = { id: clientId(2), size: { columns: 90, rows: 20 } };

  expect(result.state.attachedClientId).toBe(clientId(2));
  expect(result.state.clients).toEqual([client]);

  expect(result.changes).toEqual([
    { type: 'clientDetached', clientId: clientId(1), reason: 'takenOver' },
    { type: 'clientAttached', client },
    { type: 'paneResized', paneId: paneId(1), size: { columns: 90, rows: 19 } },
  ]);
});

it('reports the client size and the pane size when the attached client resizes', () => {
  const state = run([
    { type: 'startPane' },
    { type: 'attachClient', size: { columns: 100, rows: 30 } },
  ]);

  const result = intent(state, {
    type: 'resizeClient',
    clientId: clientId(1),
    size: { columns: 60, rows: 15 },
  });

  expect(result.state.pane?.size).toEqual({ columns: 60, rows: 14 });

  expect(result.changes).toEqual([
    { type: 'clientResized', clientId: clientId(1), size: { columns: 60, rows: 15 } },
    { type: 'paneResized', paneId: paneId(1), size: { columns: 60, rows: 14 } },
  ]);
});

it('reports a client resize that keeps the pane size, and raises the revision', () => {
  const state = run([
    { type: 'startPane' },
    { type: 'attachClient', size: { columns: 80, rows: 1 } },
  ]);

  const result = intent(state, {
    type: 'resizeClient',
    clientId: clientId(1),
    size: { columns: 80, rows: 2 },
  });

  expect(result.state.pane?.size).toEqual(state.pane?.size);

  expect(result.changes).toEqual([
    { type: 'clientResized', clientId: clientId(1), size: { columns: 80, rows: 2 } },
  ]);

  expect(result.state.revision).toBe(state.revision + 1);
});

it('treats a client resize to its current size as no change', () => {
  const state = run([
    { type: 'startPane' },
    { type: 'attachClient', size: { columns: 100, rows: 30 } },
  ]);

  const result = intent(state, {
    type: 'resizeClient',
    clientId: clientId(1),
    size: { columns: 100, rows: 30 },
  });

  expect(result.changes).toEqual([]);
  expect(result.state.revision).toBe(state.revision);
});

it('refuses to resize an unknown client and leaves state unchanged', () => {
  const state = run([{ type: 'startPane' }]);

  const result = applyIntent(state, {
    type: 'resizeClient',
    clientId: clientId(7),
    size: { columns: 60, rows: 15 },
  });

  expect(result).toEqual({ kind: 'rejected', state, reason: 'unknownClient' });
});

it('detaches a client on request and keeps the pane size', () => {
  const state = run([
    { type: 'startPane' },
    { type: 'attachClient', size: { columns: 100, rows: 30 } },
  ]);

  const result = intent(state, { type: 'detachClient', clientId: clientId(1) });

  expect(result.state.attachedClientId).toBeUndefined();
  expect(result.state.clients).toEqual([]);
  expect(result.state.pane?.size).toEqual({ columns: 100, rows: 29 });

  expect(result.changes).toEqual([
    { type: 'clientDetached', clientId: clientId(1), reason: 'requested' },
  ]);
});

it('refuses to detach an unknown client and leaves state unchanged', () => {
  const state = run([{ type: 'startPane' }]);

  const result = applyIntent(state, { type: 'detachClient', clientId: clientId(7) });

  expect(result).toEqual({ kind: 'rejected', state, reason: 'unknownClient' });
});

it('closes the pane and reports that the server should stop once', () => {
  const state = run([{ type: 'startPane' }]);
  const stopped = intent(state, { type: 'stopServer' });

  expect(stopped.state.pane?.lifecycle).toBe('closing');

  expect(stopped.changes).toEqual([
    { type: 'paneStateChanged', paneId: paneId(1), lifecycle: 'closing', exitCode: undefined },
    { type: 'serverStopping' },
  ]);

  expect(intent(stopped.state, { type: 'stopServer' }).changes).toEqual([]);
});

it('marks a started pane as running', () => {
  const state = run([{ type: 'startPane' }]);
  const result = fact(state, { type: 'paneStarted', ...firstPane });

  expect(result.state.pane?.lifecycle).toBe('running');

  expect(result.changes).toEqual([
    { type: 'paneStateChanged', paneId: paneId(1), lifecycle: 'running', exitCode: undefined },
  ]);
});

it('ignores a fact from an older generation and names the process to dispose', () => {
  const started = run([{ type: 'startPane' }]);
  const pane = started.pane;

  expect(pane).toBeDefined();

  const state: State = { ...started, pane: pane && { ...pane, generation: 2 } };
  const result = applyFact(state, { type: 'paneStarted', ...firstPane });

  expect(result).toEqual({ kind: 'ignored', state, dispose: firstPane } satisfies Ignored);
  expect(result.state.revision).toBe(state.revision);
});

it('ignores a pane that starts after the server began to stop, and names it for disposal', () => {
  const state = run([{ type: 'startPane' }, { type: 'stopServer' }]);
  const result = applyFact(state, { type: 'paneStarted', ...firstPane });

  expect(result).toEqual({ kind: 'ignored', state, dispose: firstPane });
});

it('reports that the server should stop when the last pane exits', () => {
  const state = fact(run([{ type: 'startPane' }]), { type: 'paneStarted', ...firstPane }).state;
  const result = fact(state, { type: 'paneExited', ...firstPane, exitCode: 3 });

  expect(result.state.pane?.lifecycle).toBe('exited');
  expect(result.state.pane?.exitCode).toBe(3);

  expect(result.changes).toEqual([
    { type: 'paneStateChanged', paneId: paneId(1), lifecycle: 'exited', exitCode: 3 },
    { type: 'serverStopping' },
  ]);
});

it('reports that the server should stop when the last pane fails to start', () => {
  const state = run([{ type: 'startPane' }]);
  const result = fact(state, { type: 'paneFailedToStart', ...firstPane });

  expect(result.state.pane?.lifecycle).toBe('exited');

  expect(result.changes).toEqual([
    { type: 'paneStateChanged', paneId: paneId(1), lifecycle: 'exited', exitCode: undefined },
    { type: 'serverStopping' },
  ]);
});

it('does not report a second stop when a closing pane exits', () => {
  const state = run([{ type: 'startPane' }, { type: 'stopServer' }]);
  const result = fact(state, { type: 'paneExited', ...firstPane, exitCode: 0 });

  expect(result.changes).toEqual([
    { type: 'paneStateChanged', paneId: paneId(1), lifecycle: 'exited', exitCode: 0 },
  ]);
});

it('raises the revision by one per transition with changes, and snapshots it', () => {
  const started = intent(createState(), { type: 'startPane' }).state;
  const refused = applyIntent(started, { type: 'startPane' }).state;
  const attached = intent(refused, { type: 'attachClient', size: { columns: 100, rows: 30 } });

  expect(started.revision).toBe(1);
  expect(refused.revision).toBe(1);
  expect(attached.changes).toHaveLength(2);
  expect(attached.state.revision).toBe(2);

  expect(snapshot(attached.state)).toEqual({
    revision: 2,
    pane: attached.state.pane,
    attachedClientId: clientId(1),
    clients: attached.state.clients,
  });
});
