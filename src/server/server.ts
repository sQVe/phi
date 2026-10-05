import { rmSync } from 'node:fs';

import type { PaneId } from '../ids.ts';
import type { BuildVersion, ControlMessage } from '../protocol/protocol.ts';
import { applyFact, applyIntent, createState, snapshot } from '../store/store.ts';
import type { Change, Fact, Intent, Pane, State } from '../store/store.ts';
import { createConnection } from './connection.ts';
import type { Connection } from './connection.ts';
import type { Log } from './log.ts';
import { spawnPane } from './pane.ts';
import type { PaneRuntime } from './pane.ts';
import { claimSocketPath, restrictSocket } from './socketPath.ts';

export { createLog, logPathFor } from './log.ts';
export { claimSocketPath, socketPathFor } from './socketPath.ts';

interface ServerOptions {
  socketPath: string;
  version: BuildVersion;
  log: Log;
  // The environment and directory the server started in. The pane's shell starts with both.
  environment: Record<string, string | undefined>;
  directory: string;
}

export interface Server {
  // Resolves once the panes have ended, the connections are closed, and the socket is gone.
  stopped: Promise<void>;
  stop: () => void;
  // For tests: write to the pane's PTY and read the pane's text while the pane runs.
  writeToPane: (text: string) => void;
  paneText: () => string | undefined;
}

type ClaimFailure = Extract<Awaited<ReturnType<typeof claimSocketPath>>, { ok: false }>;

type RunServerResult =
  | { ok: true; server: Server }
  | ClaimFailure
  | { ok: false; reason: 'listenFailed'; message: string };

interface ConnectionData {
  id: number;
  connection: Connection;
}

type Listener = Bun.UnixSocketListener<ConnectionData>;

// PTYs, parsers, and sockets. The store holds none of them.
interface Runtime {
  panes: Map<PaneId, PaneRuntime>;
  connections: Map<number, Connection>;
  listener: Listener | undefined;
  nextConnectionId: number;
}

interface ServerContext {
  options: ServerOptions;
  // The store's current state. Only report and dispatch replace it.
  state: State;
  runtime: Runtime;
  stopped: PromiseWithResolvers<undefined>;
  releaseSignals: () => void;
}

// Effects report facts with this, and report starts effects, so effects take it as an argument.
type Report = (context: ServerContext, fact: Fact) => void;

// 1 MiB of frames a client has not read yet.
const connectionQueueLimitBytes = 0x10_00_00;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const disposePane = (context: ServerContext, id: PaneId, generation: number): void => {
  const pane = context.runtime.panes.get(id);

  if (pane?.generation !== generation) {
    return;
  }

  context.runtime.panes.delete(id);
  pane[Symbol.dispose]();
};

const startPane = (context: ServerContext, pane: Pane, report: Report): void => {
  const { log } = context.options;
  const { id, generation } = pane;

  const spawned = spawnPane({
    generation,
    size: pane.size,
    environment: context.options.environment,
    directory: context.options.directory,
  });

  if (!spawned.ok) {
    log.error('The pane failed to start.', { paneId: id, message: spawned.message });
    report(context, { type: 'paneFailedToStart', paneId: id, generation });

    return;
  }

  context.runtime.panes.set(id, spawned.pane);
  log.info('Started the pane.', { paneId: id });

  spawned.pane.exited
    .then((exitCode) => {
      log.info('The pane exited.', { paneId: id, exitCode });
      report(context, { type: 'paneExited', paneId: id, generation, exitCode });
    })
    .catch((error: unknown) => {
      log.error('Handling the pane exit failed.', { paneId: id, error: describeError(error) });
    });

  report(context, { type: 'paneStarted', paneId: id, generation });
};

const shutDown = async (context: ServerContext): Promise<void> => {
  const { runtime, options } = context;
  const panes = [...runtime.panes.values()];

  options.log.info('Stopping the server.');

  try {
    await Promise.all(panes.map((pane) => pane.stop()));
    runtime.panes.clear();

    for (const connection of runtime.connections.values()) {
      connection.close();
    }

    runtime.connections.clear();
    runtime.listener?.stop(true);
    rmSync(options.socketPath, { force: true });
    options.log.info('Stopped the server.');
  } finally {
    context.releaseSignals();
    context.stopped.resolve(undefined);
  }
};

const stopServer = (context: ServerContext): void => {
  shutDown(context).catch((error: unknown) => {
    context.options.log.error('Stopping the server failed.', { error: describeError(error) });
  });
};

const runEffects = (context: ServerContext, changes: readonly Change[], report: Report): void => {
  for (const change of changes) {
    if (change.type === 'paneAdded') {
      startPane(context, change.pane, report);
    }

    if (change.type === 'serverStopping') {
      stopServer(context);
    }
  }
};

const report = (context: ServerContext, fact: Fact): void => {
  const result = applyFact(context.state, fact);

  context.state = result.state;

  if (result.kind === 'ignored') {
    disposePane(context, result.dispose.paneId, result.dispose.generation);

    return;
  }

  runEffects(context, result.changes, report);
};

const dispatch = (context: ServerContext, intent: Intent): void => {
  const result = applyIntent(context.state, intent);

  context.state = result.state;

  if (result.kind === 'rejected') {
    context.options.log.warn('Refused an intent.', { intent: intent.type, reason: result.reason });

    return;
  }

  runEffects(context, result.changes, report);
};

const handleMessage = (
  context: ServerContext,
  message: ControlMessage,
  connection: Connection,
): void => {
  if (message.type === 'stop') {
    dispatch(context, { type: 'stopServer' });

    return;
  }

  if (message.type === 'resync') {
    connection.send({ type: 'snapshot', snapshot: snapshot(context.state) });

    return;
  }

  context.options.log.debug('Ignored a message the server does not handle yet.', {
    type: message.type,
  });
};

const openConnection = (context: ServerContext, socket: Bun.Socket<ConnectionData>): void => {
  const { runtime, options } = context;
  const id = runtime.nextConnectionId;

  runtime.nextConnectionId += 1;

  const connection = createConnection({
    socket,
    version: options.version,
    log: options.log,
    queueLimitBytes: connectionQueueLimitBytes,
    onMessage: (message, from) => {
      handleMessage(context, message, from);
    },
  });

  socket.data = { id, connection };
  runtime.connections.set(id, connection);
};

const closeConnection = (context: ServerContext, id: number): void => {
  context.runtime.connections.get(id)?.close();
  context.runtime.connections.delete(id);
};

const listen = (context: ServerContext): Listener | string => {
  try {
    return Bun.listen<ConnectionData>({
      unix: context.options.socketPath,
      socket: {
        open: (socket) => {
          openConnection(context, socket);
        },
        data: (socket, bytes) => {
          socket.data.connection.receive(bytes);
        },
        drain: (socket) => {
          socket.data.connection.drain();
        },
        close: (socket) => {
          closeConnection(context, socket.data.id);
        },
      },
    });
  } catch (error) {
    return describeError(error);
  }
};

// The server has no terminal, so a hangup is no reason to stop.
const handleSignals = (context: ServerContext): void => {
  const { log } = context.options;

  const stopOnSignal = (signal: NodeJS.Signals): void => {
    log.info('Stopping on a signal.', { signal });
    dispatch(context, { type: 'stopServer' });
  };

  const ignoreHangup = (): void => {
    log.debug('Ignored SIGHUP.');
  };

  process.on('SIGTERM', stopOnSignal);
  process.on('SIGINT', stopOnSignal);
  process.on('SIGHUP', ignoreHangup);

  context.releaseSignals = () => {
    process.off('SIGTERM', stopOnSignal);
    process.off('SIGINT', stopOnSignal);
    process.off('SIGHUP', ignoreHangup);
  };
};

const currentPane = (context: ServerContext): PaneRuntime | undefined => {
  const id = context.state.pane?.id;

  return id === undefined ? undefined : context.runtime.panes.get(id);
};

const serverOf = (context: ServerContext): Server => ({
  stopped: context.stopped.promise,
  stop: () => {
    dispatch(context, { type: 'stopServer' });
  },
  writeToPane: (text) => {
    currentPane(context)?.write(new TextEncoder().encode(text));
  },
  paneText: () => currentPane(context)?.text(),
});

// Runs a server in this process on the socket path, with one pane. It stops on a stop message,
// SIGTERM, SIGINT, or the shell exiting.
export const runServer = async (options: ServerOptions): Promise<RunServerResult> => {
  const claimed = await claimSocketPath(options.socketPath);

  if (!claimed.ok) {
    return claimed;
  }

  const context: ServerContext = {
    options,
    state: createState(),
    runtime: { panes: new Map(), connections: new Map(), listener: undefined, nextConnectionId: 1 },
    stopped: Promise.withResolvers(),
    releaseSignals: () => undefined,
  };

  const listener = listen(context);

  if (typeof listener === 'string') {
    return {
      ok: false,
      reason: 'listenFailed',
      message: `Cannot listen on ${options.socketPath}: ${listener}`,
    };
  }

  context.runtime.listener = listener;
  restrictSocket(options.socketPath);
  handleSignals(context);
  options.log.info('Listening.', { socketPath: options.socketPath });
  dispatch(context, { type: 'startPane' });

  return { ok: true, server: serverOf(context) };
};
