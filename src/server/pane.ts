import type { TerminalSize } from '../layout.ts';
import { createTerminal } from '../vt/vt.ts';
import type { Terminal } from '../vt/vt.ts';
import { sessionGroups } from './processGroups.ts';

type Environment = Record<string, string | undefined>;

interface SpawnPaneOptions {
  generation: number;
  size: TerminalSize;
  environment: Environment;
  directory: string;
  onOutput: () => void;
}

export interface PaneRuntime {
  generation: number;
  terminal: Terminal;
  // Resolves with the shell's exit code once it has exited.
  exited: Promise<number>;
  write: (bytes: Uint8Array) => void;
  text: () => string;
  // Sends SIGHUP to every process group in the shell's session, then SIGKILL to what is left after
  // the grace time.
  stop: () => Promise<void>;
  // Kills the shell's session at once and frees the terminal.
  [Symbol.dispose]: () => void;
}

type SpawnPaneResult = { ok: true; pane: PaneRuntime } | { ok: false; message: string };

type OnOutput = (pty: Bun.Terminal, bytes: Uint8Array) => void;

// 10 MiB of history per pane.
const paneScrollbackBytes = 0xa0_00_00;

// How long a pane's processes get to exit after SIGHUP before they get SIGKILL.
const hangupGraceMs = 1000;

const sessionPollMs = 10;

const terminalName = 'xterm-256color';

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const signalGroup = (group: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-group, signal);
  } catch {
    // The group ended.
  }
};

// The PTY makes the shell a session leader, so its process id names its session and its own
// process group. Job control moves the shell's jobs to other groups in the same session.
// The shell's own group gets the signal first, since it needs no /proc scan, which can fail.
const signalSession = (session: number, signal: NodeJS.Signals): void => {
  signalGroup(session, signal);

  for (const group of sessionGroups(session)) {
    if (group !== session) {
      signalGroup(group, signal);
    }
  }
};

const waitForSessionExit = async (session: number, graceMs: number): Promise<void> => {
  const deadline = performance.now() + graceMs;

  while (performance.now() < deadline && sessionGroups(session).length > 0) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each check must follow the last wait.
    await Bun.sleep(sessionPollMs);
  }
};

const shellOf = (environment: Environment): string => environment.SHELL ?? '/bin/sh';

const spawnShell = (options: SpawnPaneOptions, onOutput: OnOutput) => {
  const { size, environment, directory } = options;

  return Bun.spawn([shellOf(environment)], {
    cwd: directory,
    env: { ...environment, TERM: terminalName },
    terminal: {
      cols: size.columns,
      rows: size.rows,
      name: terminalName,
      data: onOutput,
    },
  });
};

// Spawns the shell in a PTY at size, and parses every byte it writes.
export const spawnPane = (options: SpawnPaneOptions): SpawnPaneResult => {
  const created = createTerminal(options.size.columns, options.size.rows, paneScrollbackBytes);

  if (!created.ok) {
    return { ok: false, message: `Cannot create the pane terminal: ${created.reason}` };
  }

  const { terminal } = created;
  let disposed = false;

  const onOutput: OnOutput = (pty, bytes) => {
    if (disposed) {
      return;
    }

    const reply = terminal.write(bytes);

    if (reply !== undefined) {
      pty.write(reply);
    }

    terminal.stableRows();
    options.onOutput();
  };

  let shell: ReturnType<typeof spawnShell>;

  try {
    shell = spawnShell(options, onOutput);
  } catch (error) {
    terminal[Symbol.dispose]();

    return {
      ok: false,
      message: `Cannot start ${shellOf(options.environment)}: ${describeError(error)}`,
    };
  }

  const session = shell.pid;

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;

    try {
      signalSession(session, 'SIGKILL');
    } finally {
      shell.terminal?.close();
      terminal[Symbol.dispose]();
    }
  };

  const stop = async (): Promise<void> => {
    signalSession(session, 'SIGHUP');
    await waitForSessionExit(session, hangupGraceMs);
    dispose();
    await shell.exited;
  };

  const pane: PaneRuntime = {
    generation: options.generation,
    terminal,
    exited: shell.exited,
    write: (bytes) => {
      shell.terminal?.write(bytes);
    },
    text: () => terminal.text(),
    stop,
    [Symbol.dispose]: dispose,
  };

  return { ok: true, pane };
};
