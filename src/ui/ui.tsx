import { createCliRenderer } from '@opentui/core';
import type { BoxRenderable, CliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

import type { AttachSession, CloseReason } from '../client/client.ts';
import { PaneRenderable } from './paneRenderable.ts';
import { StatusBar } from './statusBar.tsx';

const mountPane = (session: AttachSession, renderer: CliRenderer, box: BoxRenderable) => {
  let pane: PaneRenderable | undefined;

  const draw = (rows?: readonly number[], sequence?: number): void => {
    const current = session.getState().snapshot.pane;
    const cache = current === undefined ? undefined : session.rowCache(current.id);
    const size = cache?.size();

    if (cache === undefined || size === undefined) {
      return;
    }

    if (pane === undefined) {
      pane = new PaneRenderable(renderer, {
        cache,
        width: size.columns,
        height: size.rows,
        onDrawn: session.acknowledge,
      });

      box.add(pane);
    }

    pane.resize(size.columns, size.rows);
    const changed = rows ?? Array.from({ length: size.rows }, (_, index) => index);

    pane.draw(changed, sequence);
  };

  const unsubscribe = session.subscribeRows(({ rows, sequence }) => {
    draw(rows, sequence);
  });

  const current = session.getState().snapshot.pane;
  const newest = current === undefined ? undefined : session.newestSequence(current.id);

  draw(undefined, newest);

  return unsubscribe;
};

export const runAttach = async (session: AttachSession): Promise<CloseReason> => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });
  const root = createRoot(renderer);
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  let unmountPane: (() => void) | undefined;

  const stop = (): void => {
    session.close();
  };

  const resize = (columns: number, rows: number): void => {
    session.resize({ columns, rows });
  };

  const placePane = (box: BoxRenderable | null): void => {
    unmountPane?.();

    if (box !== null) {
      unmountPane = mountPane(session, renderer, box);
    }
  };

  for (const signal of signals) {
    process.on(signal, stop);
  }

  renderer.on('resize', resize);
  resize(renderer.terminalWidth, renderer.terminalHeight);

  root.render(
    <box flexDirection="column" width="100%" height="100%">
      <box ref={placePane} flexGrow={1} />
      <StatusBar session={session} />
    </box>,
  );

  try {
    return await session.closed;
  } finally {
    for (const signal of signals) {
      process.off(signal, stop);
    }

    renderer.off('resize', resize);
    unmountPane?.();
    root.unmount();
    renderer.destroy();
    session.close();
  }
};
