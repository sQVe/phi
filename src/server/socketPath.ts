import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { invariant } from '../invariant.ts';

type DirectoryResult =
  | { ok: true }
  | { ok: false; reason: 'directoryUnavailable'; message: string }
  | { ok: false; reason: 'directorySymlink'; message: string }
  | { ok: false; reason: 'notDirectory'; message: string }
  | { ok: false; reason: 'directoryOwner'; message: string }
  | { ok: false; reason: 'directoryMode'; message: string };

type ClaimResult =
  | DirectoryResult
  | { ok: false; reason: 'symlink'; message: string }
  | { ok: false; reason: 'notSocket'; message: string }
  | { ok: false; reason: 'serverRunning'; message: string };

// Group and other read and write bits.
const sharedModeBits = 0o066;

const ownerOnlyMode = 0o600;

const currentUserId = (): number => {
  const userId = process.getuid?.();

  invariant(userId !== undefined, 'The platform has no user ids.');

  return userId;
};

// The XDG spec says to ignore a runtime directory that is not an absolute path.
const usableRuntimeDirectory = (runtimeDirectory: string | undefined): string | undefined =>
  runtimeDirectory !== undefined && isAbsolute(runtimeDirectory) ? runtimeDirectory : undefined;

export const socketPathFor = (
  requested: string | undefined,
  runtimeDirectory: string | undefined,
  userId: number,
): string => {
  if (requested !== undefined) {
    return requested;
  }

  const runtime = usableRuntimeDirectory(runtimeDirectory);

  if (runtime === undefined) {
    return join('/tmp', `phi-${userId}`, 'phi.sock');
  }

  return join(runtime, 'phi', 'phi.sock');
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const createdDirectory = (directory: string): Stats | string => {
  try {
    const existing = lstatSync(directory, { throwIfNoEntry: false });

    if (existing !== undefined) {
      return existing;
    }

    mkdirSync(directory, { recursive: true, mode: 0o700 });

    return lstatSync(directory);
  } catch (error) {
    return describeError(error);
  }
};

// Another user who controls the directory could swap the socket for their own.
const prepareSocketDirectory = (directory: string): DirectoryResult => {
  const stats = createdDirectory(directory);

  if (typeof stats === 'string') {
    return {
      ok: false,
      reason: 'directoryUnavailable',
      message: `Cannot create the socket directory ${directory}: ${stats}`,
    };
  }

  if (stats.isSymbolicLink()) {
    return {
      ok: false,
      reason: 'directorySymlink',
      message: `The socket directory ${directory} is a symlink.`,
    };
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      reason: 'notDirectory',
      message: `The socket directory ${directory} is not a directory.`,
    };
  }

  if (stats.uid !== currentUserId()) {
    return {
      ok: false,
      reason: 'directoryOwner',
      message: `The socket directory ${directory} belongs to another user.`,
    };
  }

  if ((stats.mode & sharedModeBits) !== 0) {
    return {
      ok: false,
      reason: 'directoryMode',
      message: `Other users can read or write the socket directory ${directory}. Set its mode to 0700.`,
    };
  }

  return { ok: true };
};

const serverAnswers = async (path: string): Promise<boolean> => {
  try {
    const socket = await Bun.connect({ unix: path, socket: { data: () => undefined } });

    socket.end();

    return true;
  } catch {
    return false;
  }
};

// Leaves the path free for a listener. Removes only a socket that no server answers on.
export const claimSocketPath = async (path: string): Promise<ClaimResult> => {
  const directory = prepareSocketDirectory(dirname(path));

  if (!directory.ok) {
    return directory;
  }

  const existing = lstatSync(path, { throwIfNoEntry: false });

  if (existing === undefined) {
    return { ok: true };
  }

  if (existing.isSymbolicLink()) {
    return { ok: false, reason: 'symlink', message: `The socket path ${path} is a symlink.` };
  }

  if (!existing.isSocket()) {
    return {
      ok: false,
      reason: 'notSocket',
      message: `The socket path ${path} holds a file that is not a socket.`,
    };
  }

  if (await serverAnswers(path)) {
    return {
      ok: false,
      reason: 'serverRunning',
      message: `A server already runs on ${path}.`,
    };
  }

  rmSync(path, { force: true });

  return { ok: true };
};

// Call after listening, since the listener creates the socket with the process umask.
export const restrictSocket = (path: string): void => {
  chmodSync(path, ownerOnlyMode);
};
