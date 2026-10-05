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
import { claimSocketPath } from './socketPath.ts';

export { createLog, logPathFor } from './log.ts';
export { socketPathFor } from './socketPath.ts';

interface ServerOptions {
  socketPath: string;
  version: BuildVersion;
  log: Log;
  // The environment and directory the server started in. The pane's shell starts with both.
  environment: Record<string, string | undefined>;
  directory: string;
}

// A failed step does not stop the steps after it, and the lock is always released.
type StopResult = { ok: true } | { ok: false; reason: 'cleanupFailed'; message: string };

export interface Server {
  // Resolves once every shutdown step has run, and never rejects. On success the panes have ended,
  // the connections are closed, and the socket is gone.
  stopped: Promise<StopResult>;
  stop: () => void;
  // For tests: write to the pane's PTY and read the pane's text while the pane runs.
  writeToPane: (text: string) => void;
  paneText: () => string | undefined;
}

type ClaimFailure = Extract<Awaited<ReturnType<typeof claimSocketPath>>, { ok: false }>;

type RunServerResult =
  | { ok: true; server: Server }
  | ClaimFailure
  | { ok: false; reason: 'listenFailed'; message: string }
  | { ok: false; reason: 'paneFailedToStart'; message: string };

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
  // The claimed socket path with its symlinks resolved. The server binds and removes only this.
  socketPath: string;
  // Releases the socket path's lock. Call it only after the socket is gone.
  releaseLock: () => void;
  // The store's current state. Only report and dispatch replace it.
  state: State;
  runtime: Runtime;
  stopped: PromiseWithResolvers<StopResult>;
  releaseSignals: () => void;
  // Why the first pane failed to start, so runServer can report it.
  paneStartFailure: string | undefined;
}

// Effects report facts with this, and report starts effects, so effects take it as an argument.
type Report = (context: ServerContext, fact: Fact) => void;

// How long a pane whose stop failed gets to exit after it is killed.
const paneExitWaitMs = 1000;

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
    context.paneStartFailure = spawned.message;
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

// Runs one shutdown step, and logs and records its failure instead of throwing.
const runStep = (
  context: ServerContext,
  failures: string[],
  step: string,
  run: () => void,
): void => {
  try {
    run();
  } catch (error) {
    const message = `${step}: ${describeError(error)}`;

    context.options.log.error(`${step} failed.`, { error: describeError(error) });
    failures.push(message);
  }
};

const exitedWithin = async (pane: PaneRuntime, waitMs: number): Promise<boolean> => {
  const timedOut = Bun.sleep(waitMs).then(() => false);
  const exited = pane.exited.then(() => true);

  return Promise.race([exited, timedOut]);
};

// A failed stop still kills the pane and waits a bounded time for its shell, so the rest of the
// shutdown can go on. Returns what failed.
const stopPane = async (
  context: ServerContext,
  id: PaneId,
  pane: PaneRuntime,
): Promise<string[]> => {
  const { log } = context.options;
  const failures: string[] = [];

  try {
    await pane.stop();

    return failures;
  } catch (error) {
    log.error('Stopping the pane failed.', { paneId: id, error: describeError(error) });
    failures.push(`Stopping pane ${id}: ${describeError(error)}`);
  }

  runStep(context, failures, `Ending pane ${id}`, () => {
    pane[Symbol.dispose]();
  });

  if (!(await exitedWithin(pane, paneExitWaitMs))) {
    log.error('The pane did not exit in time.', { paneId: id, waitMs: paneExitWaitMs });
    failures.push(`Pane ${id} did not exit within ${paneExitWaitMs} ms`);
  }

  return failures;
};

const stopResultOf = (failures: readonly string[]): StopResult => {
  if (failures.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'cleanupFailed',
    message: `The server stopped, but its cleanup failed. ${failures.join('. ')}.`,
  };
};

// Every step runs even when an earlier one fails. The lock and the signal handlers go last.
const shutDown = async (context: ServerContext): Promise<StopResult> => {
  const { runtime, options } = context;
  const panes = [...runtime.panes.entries()];
  const paneFailures = await Promise.all(panes.map(([id, pane]) => stopPane(context, id, pane)));
  const failures = paneFailures.flat();

  runtime.panes.clear();

  for (const connection of runtime.connections.values()) {
    runStep(context, failures, 'Closing a connection', () => {
      connection.close();
    });
  }

  runtime.connections.clear();

  runStep(context, failures, 'Stopping the listener', () => {
    runtime.listener?.stop(true);
  });

  runStep(context, failures, `Removing the socket ${context.socketPath}`, () => {
    rmSync(context.socketPath, { force: true });
  });

  runStep(context, failures, 'Releasing the socket lock', context.releaseLock);
  runStep(context, failures, 'Releasing the signal handlers', context.releaseSignals);

  const result = stopResultOf(failures);

  if (result.ok) {
    options.log.info('Stopped the server.');
  }

  return result;
};

const stopServer = (context: ServerContext): void => {
  context.options.log.info('Stopping the server.');

  shutDown(context)
    .then((result) => {
      context.stopped.resolve(result);
    })
    .catch((error: unknown) => {
      const message = `Stopping the server failed: ${describeError(error)}`;

      context.options.log.error('Stopping the server failed.', { error: describeError(error) });
      context.stopped.resolve({ ok: false, reason: 'cleanupFailed', message });
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

// Clears every bit but the owner's read and write, so the socket is 0600 from its bind.
const ownerOnlyUmask = 0o177;

// Binds with a restrictive umask, so the socket never exists with a wider mode.
const listen = (context: ServerContext, path: string): Listener | string => {
  const previousUmask = process.umask(ownerOnlyUmask);

  try {
    return Bun.listen<ConnectionData>({
      unix: path,
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
  } finally {
    process.umask(previousUmask);
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
// SIGTERM, SIGINT, or the shell exiting. When the pane fails to start, it stops before it returns.
export const runServer = async (options: ServerOptions): Promise<RunServerResult> => {
  const claimed = await claimSocketPath(options.socketPath);

  if (!claimed.ok) {
    return claimed;
  }

  const { path: socketPath, release: releaseLock } = claimed;

  const context: ServerContext = {
    options,
    socketPath,
    releaseLock,
    state: createState(),
    runtime: { panes: new Map(), connections: new Map(), listener: undefined, nextConnectionId: 1 },
    stopped: Promise.withResolvers(),
    releaseSignals: () => undefined,
    paneStartFailure: undefined,
  };

  const listener = listen(context, socketPath);

  if (typeof listener === 'string') {
    releaseLock();

    return {
      ok: false,
      reason: 'listenFailed',
      message: `Cannot listen on ${socketPath}: ${listener}`,
    };
  }

  context.runtime.listener = listener;
  handleSignals(context);
  options.log.info('Listening.', { socketPath });
  dispatch(context, { type: 'startPane' });

  if (context.paneStartFailure !== undefined) {
    await context.stopped.promise;

    return { ok: false, reason: 'paneFailedToStart', message: context.paneStartFailure };
  }

  return { ok: true, server: serverOf(context) };
};
