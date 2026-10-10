import type { ControlMessage } from '../protocol/protocol.ts';

export type StoreSnapshot = Extract<ControlMessage, { type: 'snapshot' }>['snapshot'];

export type StoreChange = Extract<ControlMessage, { type: 'change' }>['change'];

const applyPaneChange = (snapshot: StoreSnapshot, change: StoreChange): StoreSnapshot => {
  const { pane } = snapshot;

  if (change.type === 'paneAdded') {
    return { ...snapshot, pane: change.pane };
  }

  if (change.type === 'paneStateChanged' && pane?.id === change.paneId) {
    const { lifecycle, exitCode } = change;

    return { ...snapshot, pane: { ...pane, lifecycle, exitCode } };
  }

  if (change.type === 'paneResized' && pane?.id === change.paneId) {
    return { ...snapshot, pane: { ...pane, size: change.size } };
  }

  return snapshot;
};

const applyClientChange = (snapshot: StoreSnapshot, change: StoreChange): StoreSnapshot => {
  if (change.type === 'clientAttached') {
    return {
      ...snapshot,
      attachedClientId: change.client.id,
      clients: [...snapshot.clients, change.client],
    };
  }

  if (change.type === 'clientResized') {
    const clients = snapshot.clients.map((client) =>
      client.id === change.clientId ? { ...client, size: change.size } : client,
    );

    return { ...snapshot, clients };
  }

  if (change.type === 'clientThemeChanged') {
    const clients = snapshot.clients.map((client) =>
      client.id === change.clientId ? { ...client, theme: change.theme } : client,
    );

    return { ...snapshot, clients };
  }

  if (change.type === 'clientDetached') {
    const detachedAttached = snapshot.attachedClientId === change.clientId;

    return {
      ...snapshot,
      attachedClientId: detachedAttached ? undefined : snapshot.attachedClientId,
      clients: snapshot.clients.filter((client) => client.id !== change.clientId),
    };
  }

  return snapshot;
};

export const applyChange = (snapshot: StoreSnapshot, change: StoreChange): StoreSnapshot =>
  applyClientChange(applyPaneChange(snapshot, change), change);
