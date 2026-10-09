import { expect, it } from 'bun:test';

import { clientId, paneId } from '../ids.ts';
import { applyChange } from './snapshot.ts';
import type { StoreSnapshot } from './snapshot.ts';

const size = { columns: 80, rows: 24 };

const first = { id: clientId(1), size };

const second = { id: clientId(2), size };

const snapshot: StoreSnapshot = {
  revision: 3,
  pane: { id: paneId(1), lifecycle: 'running', generation: 1, size, exitCode: undefined },
  attachedClientId: first.id,
  clients: [first],
};

it('replaces the attached client when a client takes over', () => {
  const detached = applyChange(snapshot, {
    type: 'clientDetached',
    clientId: first.id,
    reason: 'takenOver',
  });

  const attached = applyChange(detached, { type: 'clientAttached', client: second });

  expect(attached.clients).toEqual([second]);
  expect(attached.attachedClientId).toBe(second.id);
});

it('records the exit of the pane', () => {
  const exited = applyChange(snapshot, {
    type: 'paneStateChanged',
    paneId: paneId(1),
    lifecycle: 'exited',
    exitCode: 3,
  });

  expect(exited.pane?.lifecycle).toBe('exited');
  expect(exited.pane?.exitCode).toBe(3);
});

it('resizes only the client the change names', () => {
  const resized = { columns: 100, rows: 30 };
  const both = { ...snapshot, clients: [first, second] };
  const next = applyChange(both, { type: 'clientResized', clientId: second.id, size: resized });

  expect(next.clients).toEqual([first, { ...second, size: resized }]);
});
