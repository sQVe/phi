import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;

type Write = (message: string, fields?: LogFields) => void;

export interface Log {
  debug: Write;
  info: Write;
  warn: Write;
  error: Write;
}

type CreateLogResult =
  | { ok: true; log: Log }
  | { ok: false; reason: 'logUnavailable'; message: string };

// 5 MiB.
const maxLogBytes = 0x50_00_00;

const logFileMode = 0o600;

const encoder = new TextEncoder();

// The XDG spec says to ignore a state directory that is not an absolute path.
const usableStateHome = (stateHome: string | undefined): string | undefined =>
  stateHome !== undefined && isAbsolute(stateHome) ? stateHome : undefined;

export const logPathFor = (stateHome: string | undefined, home: string): string => {
  const state = usableStateHome(stateHome) ?? join(home, '.local', 'state');

  return join(state, 'phi', 'server.log');
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Creates the log file if it is missing, so a path the server cannot write fails before it starts.
const openedSize = (path: string): number | string => {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    const descriptor = openSync(path, 'a', logFileMode);

    try {
      return fstatSync(descriptor).size;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    return describeError(error);
  }
};

const logWriter = (path: string, now: () => number, limitBytes: number, openSize: number): Log => {
  let size = openSize;

  const append = (line: string): void => {
    const lineBytes = encoder.encode(line).length;

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    if (size > 0 && size + lineBytes > limitBytes) {
      renameSync(path, `${path}.1`);
      size = 0;
    }

    appendFileSync(path, line, { mode: logFileMode });
    size += lineBytes;
  };

  const writer =
    (level: LogLevel): Write =>
    (message, fields = {}) => {
      const time = new Date(now()).toISOString();
      const line = `${JSON.stringify({ time, level, message, fields })}\n`;

      // A detached server has no other place to report a failed log write, and a full disk must
      // not stop the panes.
      try {
        append(line);
      } catch {
        // Drop the line.
      }
    };

  return {
    debug: writer('debug'),
    info: writer('info'),
    warn: writer('warn'),
    error: writer('error'),
  };
};

// Rotates to one old file before a line would take the log past limitBytes.
export const createLog = (
  path: string,
  now: () => number,
  limitBytes = maxLogBytes,
): CreateLogResult => {
  const size = openedSize(path);

  if (typeof size === 'string') {
    return {
      ok: false,
      reason: 'logUnavailable',
      message: `Cannot write the log ${path}: ${size}`,
    };
  }

  return { ok: true, log: logWriter(path, now, limitBytes, size) };
};
