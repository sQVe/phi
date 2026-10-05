import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import packageJson from '../package.json' with { type: 'json' };
import { helloServer } from './client/client.ts';
import type { ServerSession } from './client/client.ts';
import { invariant } from './invariant.ts';
import type { BuildVersion } from './protocol/protocol.ts';
import {
  claimSocketPath,
  createLog,
  logPathFor,
  runServer,
  socketPathFor,
} from './server/server.ts';
import { createTerminal, ghosttyCommit } from './vt/vt.ts';

type VersionsResult = { ok: true; versions: BuildVersion } | { ok: false; message: string };

type ServerAction = 'run' | 'start' | 'stop';

type Command =
  | { kind: 'version'; json: boolean }
  | { kind: 'server'; action: ServerAction; json: boolean; socket: string | undefined };

type Outcome = { ok: true } | { ok: false; message: string };

type SessionResult = { ok: true; session: ServerSession } | { ok: false; message: string };

type Environment = Record<string, string | undefined>;

// What every server command needs, resolved once from the arguments and the environment.
interface ServerContext {
  json: boolean;
  socketPath: string;
  logPath: string;
  version: BuildVersion;
  environment: Environment;
}

const usage = `Usage:
  phi --version [--json]
  phi server run [--socket <path>] [--json]
  phi server start [--socket <path>] [--json]
  phi server stop [--socket <path>] [--json]`;

const serverActions: readonly string[] = ['run', 'start', 'stop'] satisfies ServerAction[];

const statusQuery = new TextEncoder().encode('\u001B[5n');

const statusReply = '\u001B[0n';

const probeColumns = 80;

const probeRows = 24;

const probeScrollbackBytes = 0;

const helloTimeoutMs = 2000;

const serverStartTimeoutMs = 10_000;

// Covers the server's wait for pane processes that ignore SIGHUP.
const serverStopTimeoutMs = 10_000;

const pollIntervalMs = 25;

// Loads the terminal library and parses a query with it, so the versions printed are the ones that
// work in this binary.
const readVersions = (): VersionsResult => {
  const created = createTerminal(probeColumns, probeRows, probeScrollbackBytes);

  if (!created.ok) {
    const detail = created.reason === 'library-missing' ? `: ${created.detail}` : '';

    return {
      ok: false,
      message: `phi: cannot load the terminal library (${created.reason})${detail}`,
    };
  }

  using terminal = created.terminal;
  const reply = terminal.write(statusQuery);
  const replyText = reply === undefined ? '' : new TextDecoder().decode(reply);

  if (replyText !== statusReply) {
    return { ok: false, message: 'phi: the terminal library did not answer a status query.' };
  }

  const commit = ghosttyCommit();

  if (!commit.ok) {
    return { ok: false, message: `phi: cannot load the terminal library: ${commit.detail}` };
  }

  return { ok: true, versions: { version: packageJson.version, ghostty: commit.commit } };
};

const isServerAction = (action: string | undefined): action is ServerAction =>
  action !== undefined && serverActions.includes(action);

const parseCommand = (): Command | string => {
  try {
    const { values, positionals } = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        version: { type: 'boolean' },
        json: { type: 'boolean' },
        socket: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });

    const json = values.json === true;
    const [group, action, ...rest] = positionals;

    if (values.version === true) {
      const hasExtra = positionals.length > 0 || values.socket !== undefined;

      return hasExtra ? '--version takes only --json.' : { kind: 'version', json };
    }

    if (group !== 'server' || !isServerAction(action)) {
      return 'Unknown command.';
    }

    if (rest.length > 0) {
      return `Unexpected argument '${rest.join(' ')}'.`;
    }

    return { kind: 'server', action, json, socket: values.socket };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const print = (json: boolean, value: Record<string, unknown>, text: string): void => {
  const output = json ? JSON.stringify(value) : text;

  process.stdout.write(`${output}\n`);
};

const describeBuild = (build: BuildVersion): string =>
  `${build.version} (ghostty ${build.ghostty})`;

const refusalMessage = (socketPath: string, client: BuildVersion, server: BuildVersion): string =>
  [
    `The server on ${socketPath} is from another build.`,
    `  this phi: ${describeBuild(client)}`,
    `  server:   ${describeBuild(server)}`,
    'Run `phi server stop` and then `phi server start` to restart the server. This ends every pane.',
  ].join('\n');

const millisecondsPerSecond = 1000;

const resolveSocketPath = (requested: string | undefined, environment: Environment): string => {
  const userId = process.getuid?.();

  invariant(userId !== undefined, 'The platform has no user ids.');

  return resolve(socketPathFor(requested, environment.XDG_RUNTIME_DIR, userId));
};

const seconds = (milliseconds: number): number => milliseconds / millisecondsPerSecond;

// Calls attempt until it returns a value, or returns undefined once timeoutMs passes.
const poll = async <Value>(
  attempt: () => Promise<Value | undefined> | Value | undefined,
  timeoutMs: number,
): Promise<Value | undefined> => {
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each attempt must follow the last wait.
    const value = await attempt();

    if (value !== undefined) {
      return value;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- each attempt must follow the last wait.
    await Bun.sleep(pollIntervalMs);
  }

  return undefined;
};

const openSession = async (socketPath: string, version: BuildVersion): Promise<SessionResult> => {
  const hello = await helloServer(socketPath, version, helloTimeoutMs);

  if (hello.ok) {
    return hello;
  }

  if (hello.reason === 'noServer') {
    return { ok: false, message: `No server runs on ${socketPath}.` };
  }

  if (hello.reason === 'noAnswer') {
    return { ok: false, message: `The server on ${socketPath} did not answer.` };
  }

  return { ok: false, message: refusalMessage(socketPath, hello.client, hello.server) };
};

const runInForeground = async (context: ServerContext): Promise<Outcome> => {
  const { socketPath, version, environment } = context;
  const log = createLog(context.logPath, Date.now);

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

  print(
    context.json,
    { socket: socketPath, pid: process.pid },
    `Server ${process.pid} runs on ${socketPath}.`,
  );

  await result.server.stopped;

  return { ok: true };
};

// A compiled binary runs its embedded entry file, which it serves from /$bunfs/, on its own.
const ownCommand = (): string[] =>
  Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main];

// Returns undefined while the server starts and does not answer yet.
const checkStarted = async (
  context: ServerContext,
  server: Bun.Subprocess,
): Promise<Outcome | undefined> => {
  const { socketPath, logPath } = context;

  if (server.exitCode !== null) {
    return {
      ok: false,
      message: `The server exited with code ${server.exitCode} before it answered. See ${logPath}.`,
    };
  }

  const hello = await helloServer(socketPath, context.version, helloTimeoutMs);

  if (hello.ok) {
    hello.session.close();

    return { ok: true };
  }

  if (hello.reason === 'refused') {
    return { ok: false, message: refusalMessage(socketPath, hello.client, hello.server) };
  }

  return undefined;
};

const startInBackground = async (context: ServerContext): Promise<Outcome> => {
  const { socketPath, logPath } = context;
  // Checks the path here, because the server's own errors go only to its log.
  const claimed = await claimSocketPath(socketPath);

  if (!claimed.ok) {
    return claimed;
  }

  // The server gets its own session, so closing this terminal does not reach it.
  const server = Bun.spawn([...ownCommand(), 'server', 'run', '--socket', socketPath], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: context.environment,
  });

  const started = await poll(() => checkStarted(context, server), serverStartTimeoutMs);

  if (started === undefined) {
    server.kill('SIGTERM');

    return {
      ok: false,
      message: `The server did not answer within ${seconds(serverStartTimeoutMs)} seconds. See ${logPath}.`,
    };
  }

  if (!started.ok) {
    return started;
  }

  server.unref();

  print(
    context.json,
    { socket: socketPath, pid: server.pid },
    `Started server ${server.pid} on ${socketPath}.`,
  );

  return { ok: true };
};

const socketGone = (socketPath: string): true | undefined =>
  lstatSync(socketPath, { throwIfNoEntry: false }) === undefined ? true : undefined;

const stopServer = async (context: ServerContext): Promise<Outcome> => {
  const { socketPath } = context;
  const opened = await openSession(socketPath, context.version);

  if (!opened.ok) {
    return opened;
  }

  opened.session.send({ type: 'stop' });

  const gone = await poll(() => socketGone(socketPath), serverStopTimeoutMs);

  opened.session.close();

  if (gone === undefined) {
    return {
      ok: false,
      message: `The server on ${socketPath} did not stop within ${seconds(serverStopTimeoutMs)} seconds.`,
    };
  }

  print(context.json, { stopped: true }, `Stopped the server on ${socketPath}.`);

  return { ok: true };
};

const runServerAction = (
  command: Extract<Command, { kind: 'server' }>,
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

const main = async (): Promise<number> => {
  const command = parseCommand();

  if (typeof command === 'string') {
    process.stderr.write(`phi: ${command}\n${usage}\n`);

    return 2;
  }

  const result = readVersions();

  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);

    return 1;
  }

  if (command.kind === 'version') {
    const { version, ghostty } = result.versions;

    print(command.json, { version, ghostty }, `phi ${version} (ghostty ${ghostty})`);

    return 0;
  }

  // oxlint-disable-next-line node/no-process-env -- the command line is where the environment enters.
  const outcome = await runServerAction(command, result.versions, process.env);

  if (!outcome.ok) {
    process.stderr.write(`phi: ${outcome.message}\n`);

    return 1;
  }

  return 0;
};

process.exitCode = await main();
