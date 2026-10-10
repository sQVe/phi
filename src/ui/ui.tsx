import { createCliRenderer } from '@opentui/core';
import type { BoxRenderable, CliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

import type { AttachSession, CloseReason } from '../client/client.ts';
import { createInputRouter } from './input.ts';
import { PaneRenderable } from './paneRenderable.ts';
import { StatusBar } from './statusBar.tsx';
import { takeStdin } from './stdinInput.ts';
import { themeFromDetectedColors } from './terminalTheme.ts';

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

const paletteTimeoutMs = 500;

const paletteSize = 16;

// A terminal that does not answer the color queries leaves the server's default colors in place.
const reportTheme = async (session: AttachSession, renderer: CliRenderer): Promise<void> => {
  const colors = await renderer.getPalette({ size: paletteSize, timeout: paletteTimeoutMs });
  const theme = themeFromDetectedColors(colors);

  if (theme !== undefined) {
    session.setTheme(theme);
  }
};

const paneModes = (session: AttachSession): number => {
  const current = session.getState().snapshot.pane;

  return current === undefined ? 0 : (session.rowCache(current.id)?.modes() ?? 0);
};

const sendToPane = (session: AttachSession, bytes: Uint8Array): void => {
  const current = session.getState().snapshot.pane;

  if (current !== undefined && bytes.length > 0) {
    session.sendInput(current.id, bytes);
  }
};

const routeInput = (session: AttachSession) =>
  createInputRouter({
    mode: () => session.getState().inputMode,
    setMode: (mode) => {
      session.setInputMode(mode);
    },
    modes: () => paneModes(session),
    send: (bytes) => {
      sendToPane(session, bytes);
    },
  });

export const runAttach = async (session: AttachSession): Promise<CloseReason> => {
  // OpenTUI turns on Kitty key reporting for a null setting too. With every flag off, key.raw
  // stays the legacy bytes the pane expects.
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useKittyKeyboard: { disambiguate: false, alternateKeys: false },
    useMouse: false,
  });

  const releaseStdin = takeStdin(renderer, routeInput(session));

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

  reportTheme(session, renderer).catch(() => {
    // Detection is optional; the pane keeps the server's colors.
  });

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
    releaseStdin();
    unmountPane?.();
    root.unmount();
    renderer.destroy();
    session.close();
  }
};
