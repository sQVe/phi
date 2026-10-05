import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { sendStop } from './client/client.ts';
import { invariant } from './invariant.ts';
import type { BuildVersion } from './protocol/protocol.ts';
import { createLog, logPathFor, runServer, socketPathFor } from './server/server.ts';
import { createTerminal, ghosttyCommit } from './vt/vt.ts';

type VersionsResult = { ok: true; versions: BuildVersion } | { ok: false; message: string };

type ServerAction = 'run' | 'start' | 'stop';

type Command =
  | { kind: 'version'; json: boolean }
  | { kind: 'server'; action: ServerAction; json: boolean; socket: string | undefined };

type Outcome = { ok: true } | { ok: false; message: string };

type Environment = Record<string, string | undefined>;

// How a stopping server let go of its socket path.
type Release = 'removed' | 'leftSocket';

// Why a server that start spawned did not become ready.
type Unready = { kind: 'exited' } | { kind: 'timedOut' } | { kind: 'badReadiness'; line: string };

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

const serverStartTimeoutMs = 10_000;

// Covers the server's wait for pane processes that ignore SIGHUP.
const serverStopTimeoutMs = 10_000;

const pollIntervalMs = 25;

// What `phi server run --json` prints once it listens, and what start reads as readiness.
const runningSchema = z.object({ socket: z.string(), pid: z.number().int().positive() });

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

  print(
    context.json,
    { socket: socketPath, pid: process.pid },
    `Server ${process.pid} runs on ${socketPath}.`,
  );

  return result.server.stopped;
};

// A compiled binary runs its embedded entry file, which it serves from /$bunfs/, on its own.
const ownCommand = (): string[] =>
  Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main];

// Returns the first line, or undefined when the stream ends without one.
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

const parseRunning = (line: string): z.infer<typeof runningSchema> | undefined => {
  try {
    const parsed = runningSchema.safeParse(JSON.parse(line));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

// The server prints its readiness line only after it listens on the socket with a running pane,
// so a line from this child, and not an answer on the socket, proves this child started.
const waitForReady = async (
  server: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
): Promise<Unready | undefined> => {
  const timedOut = Promise.withResolvers<Unready>();

  const timer = setTimeout(() => {
    timedOut.resolve({ kind: 'timedOut' });
  }, serverStartTimeoutMs);

  const ready = firstLine(server.stdout).then((line): Unready | undefined => {
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

const unreadyMessage = async (
  context: ServerContext,
  server: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  unready: Unready,
): Promise<string> => {
  if (unready.kind === 'timedOut') {
    return `The server did not become ready within ${seconds(serverStartTimeoutMs)} seconds. See ${context.logPath}.`;
  }

  if (unready.kind === 'badReadiness') {
    return `The server reported readiness that start cannot read: ${unready.line}`;
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

  const unready = await waitForReady(server);

  if (unready !== undefined) {
    const message = await unreadyMessage(context, server, unready);

    server.kill('SIGTERM');

    return { ok: false, message };
  }

  await server.stderr.cancel();
  server.unref();

  print(
    context.json,
    { socket: socketPath, pid: server.pid },
    `Started server ${server.pid} on ${socketPath}.`,
  );

  return { ok: true };
};

const socketInode = (socketPath: string): bigint | undefined =>
  lstatSync(socketPath, { bigint: true, throwIfNoEntry: false })?.ino;

// Only a refused connection proves that no server listens any more. The probe sends nothing and
// closes at once, so a server that is still stopping drops it with its other connections.
const connectionRefused = async (socketPath: string): Promise<boolean> => {
  try {
    const socket = await Bun.connect({ unix: socketPath, socket: { data: () => undefined } });

    socket.end();

    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED';
  }
};

// Works for a server of any build. A server closes its listener just before it removes its
// socket, so a refused socket gets one more interval to disappear. A new server may claim the path
// meanwhile, so only the same socket counts as left behind.
const releasedPath = async (socketPath: string): Promise<Release | undefined> => {
  const probed = socketInode(socketPath);

  if (probed === undefined) {
    return 'removed';
  }

  if (!(await connectionRefused(socketPath))) {
    return undefined;
  }

  await Bun.sleep(pollIntervalMs);

  return socketInode(socketPath) === probed ? 'leftSocket' : 'removed';
};

const stopServer = async (context: ServerContext): Promise<Outcome> => {
  const { socketPath } = context;
  const sent = await sendStop(socketPath);

  if (!sent.ok) {
    return { ok: false, message: `No server runs on ${socketPath}.` };
  }

  const released = await poll(() => releasedPath(socketPath), serverStopTimeoutMs);

  sent.close();

  if (released === undefined) {
    return {
      ok: false,
      message: `The server on ${socketPath} did not stop within ${seconds(serverStopTimeoutMs)} seconds.`,
    };
  }

  if (released === 'leftSocket') {
    return {
      ok: false,
      message: `The server stopped, but left its socket at ${socketPath}. The next start removes it.`,
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
