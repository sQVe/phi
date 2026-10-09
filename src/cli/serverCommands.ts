import { homedir } from 'node:os';

import { z } from 'zod';

import type { BuildVersion } from '../protocol/protocol.ts';
import { createLog, logPathFor, runServer } from '../server/server.ts';
import { resolveSocketPath } from './environment.ts';
import type { Environment } from './environment.ts';
import { print } from './output.ts';
import type { Outcome } from './output.ts';
import type { ServerCommand } from './parse.ts';
import { seconds } from './serverContext.ts';
import type { ServerContext } from './serverContext.ts';
import { stopServer } from './serverStop.ts';

type StartFailure =
  | { kind: 'exited' }
  | { kind: 'timedOut' }
  | { kind: 'badReadiness'; line: string };

type ServerProcess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

const serverStartTimeoutMs = 10_000;

// What `phi server run --json` prints once it listens, and what start reads as readiness.
const runningSchema = z.object({ socket: z.string(), pid: z.number().int().positive() });

type RunningLine = z.infer<typeof runningSchema>;

const runInForeground = async (context: ServerContext): Promise<Outcome> => {
  const { socketPath, version, environment } = context;
  const created = createLog(context.logPath, Date.now);

  if (!created.ok) {
    return created;
  }

  const { log } = created;

  const result = await runServer({
    socketPath,
    version,
    log,
    environment,
    directory: process.cwd(),
  });

  if (!result.ok) {
    log.error('Cannot start the server.', { reason: result.reason, message: result.message });

    return result;
  }

  print(context.json, {
    json: { socket: socketPath, pid: process.pid },
    text: `Server ${process.pid} runs on ${socketPath}.`,
  });

  return result.server.stopped;
};

// A compiled binary runs its embedded entry file, which it serves from /$bunfs/, on its own.
const ownCommand = (): string[] =>
  Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main];

const firstLine = async (stream: ReadableStream<Uint8Array>): Promise<string | undefined> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  while (!text.includes('\n')) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each read must follow the last one.
    const chunk = await reader.read();

    if (chunk.done) {
      return undefined;
    }

    text += decoder.decode(chunk.value, { stream: true });
  }

  await reader.cancel();

  return text.slice(0, text.indexOf('\n'));
};

const parseRunning = (line: string): RunningLine | undefined => {
  try {
    const parsed = runningSchema.safeParse(JSON.parse(line));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

// The server prints its readiness line only after it listens on the socket with a running pane,
// so a line from this child, and not an answer on the socket, proves this child started.
const waitForReady = async (server: ServerProcess): Promise<StartFailure | undefined> => {
  const timedOut = Promise.withResolvers<StartFailure>();

  const timer = setTimeout(() => {
    timedOut.resolve({ kind: 'timedOut' });
  }, serverStartTimeoutMs);

  const ready = firstLine(server.stdout).then((line): StartFailure | undefined => {
    if (line === undefined) {
      return { kind: 'exited' };
    }

    const running = parseRunning(line);

    return running?.pid === server.pid ? undefined : { kind: 'badReadiness', line };
  });

  try {
    return await Promise.race([ready, timedOut.promise]);
  } finally {
    clearTimeout(timer);
  }
};

const failureMessage = async (
  context: ServerContext,
  server: ServerProcess,
  failure: StartFailure,
): Promise<string> => {
  if (failure.kind === 'timedOut') {
    return `The server did not become ready within ${seconds(serverStartTimeoutMs)} seconds. See ${context.logPath}.`;
  }

  if (failure.kind === 'badReadiness') {
    return `The server reported readiness that start cannot read: ${failure.line}`;
  }

  const [exitCode, detail] = await Promise.all([server.exited, new Response(server.stderr).text()]);

  return `The server exited with code ${exitCode} before it was ready:\n${detail.trimEnd()}`;
};

const startInBackground = async (context: ServerContext): Promise<Outcome> => {
  const { socketPath } = context;

  // The server gets its own session, so closing this terminal does not reach it. Its stderr
  // reaches start only until it is ready.
  const server = Bun.spawn([...ownCommand(), 'server', 'run', '--socket', socketPath, '--json'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: context.environment,
  });

  const failure = await waitForReady(server);

  if (failure !== undefined) {
    const message = await failureMessage(context, server, failure);

    server.kill('SIGTERM');

    return { ok: false, message };
  }

  await server.stderr.cancel();
  server.unref();

  print(context.json, {
    json: { socket: socketPath, pid: server.pid },
    text: `Started server ${server.pid} on ${socketPath}.`,
  });

  return { ok: true };
};

export const runServerAction = (
  command: ServerCommand,
  version: BuildVersion,
  environment: Environment,
): Promise<Outcome> => {
  const context: ServerContext = {
    json: command.json,
    socketPath: resolveSocketPath(command.socket, environment),
    logPath: logPathFor(environment.XDG_STATE_HOME, homedir()),
    version,
    environment,
  };

  if (command.action === 'run') {
    return runInForeground(context);
  }

  if (command.action === 'start') {
    return startInBackground(context);
  }

  return stopServer(context);
};
