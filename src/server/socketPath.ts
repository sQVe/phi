import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { invariant } from '../invariant.ts';
import { lockExclusive } from './flock.ts';

type DirectoryResult =
  | { ok: true }
  | { ok: false; reason: 'directoryUnavailable'; message: string }
  | { ok: false; reason: 'directorySymlink'; message: string }
  | { ok: false; reason: 'notDirectory'; message: string }
  | { ok: false; reason: 'directoryOwner'; message: string }
  | { ok: false; reason: 'directoryMode'; message: string }
  | { ok: false; reason: 'ancestorMissing'; message: string }
  | { ok: false; reason: 'ancestorOwner'; message: string }
  | { ok: false; reason: 'ancestorMode'; message: string };

type DirectoryFailure = Extract<DirectoryResult, { ok: false }>;

type RouteResult = { ok: true; path: string } | DirectoryFailure;

// A walk through a path: the trusted directory reached so far and the names still to follow.
interface Route {
  current: string;
  pending: readonly string[];
  symlinksLeft: number;
}

type RouteStep = { kind: 'next'; route: Route } | { kind: 'done'; result: RouteResult };

type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'serverRunning'; message: string }
  | { ok: false; reason: 'lockSymlink'; message: string }
  | { ok: false; reason: 'lockFailed'; message: string };

type LockFailure = Extract<LockResult, { ok: false }>;

type FreeResult =
  | { ok: true }
  | { ok: false; reason: 'symlink'; message: string }
  | { ok: false; reason: 'notSocket'; message: string }
  | { ok: false; reason: 'socketOwner'; message: string }
  | { ok: false; reason: 'socketUnreachable'; message: string }
  | { ok: false; reason: 'serverRunning'; message: string }
  | { ok: false; reason: 'removeFailed'; message: string };

type ClaimResult =
  | { ok: true; path: string; release: () => void }
  | DirectoryFailure
  | LockFailure
  | Extract<FreeResult, { ok: false }>;

type Probe = { kind: 'answers' } | { kind: 'stale' } | { kind: 'unreachable'; detail: string };

// Every group and other bit, since others who can only enter the directory can still connect.
const sharedModeBits = 0o077;

// Group and other write bits.
const sharedWriteBits = 0o022;

const stickyBit = 0o1000;

// Connect errors that prove no server listens on the path.
const staleErrorCodes = new Set(['ECONNREFUSED', 'ENOENT']);

const ownerOnlyMode = 0o600;

// Linux stops following symlinks at the same depth.
const maxSymlinks = 40;

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

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

const componentsOf = (path: string): string[] =>
  path.split(sep).filter((name) => name !== '' && name !== '.');

const isTrustedOwner = (stats: Stats): boolean => stats.uid === 0 || stats.uid === currentUserId();

// The sticky bit stops other users from renaming or removing entries they do not own.
const othersCanReplaceEntries = (stats: Stats): boolean =>
  (stats.mode & sharedWriteBits) !== 0 && (stats.mode & stickyBit) === 0;

const checkAncestor = (ancestor: string, stats: Stats): DirectoryResult => {
  if (!stats.isDirectory()) {
    return {
      ok: false,
      reason: 'notDirectory',
      message: `The path ${ancestor} above the socket is not a directory.`,
    };
  }

  if (!isTrustedOwner(stats)) {
    return {
      ok: false,
      reason: 'ancestorOwner',
      message: `The directory ${ancestor} above the socket belongs to another user.`,
    };
  }

  if (othersCanReplaceEntries(stats)) {
    return {
      ok: false,
      reason: 'ancestorMode',
      message: `Other users can write to ${ancestor} above the socket. Choose a socket path under directories only you and root can change.`,
    };
  }

  return { ok: true };
};

// The directory that holds the symlink was checked before, so only the symlink's owner is left.
const followSymlink = (route: Route, link: string, stats: Stats, rest: string[]): RouteStep => {
  if (!isTrustedOwner(stats)) {
    return {
      kind: 'done',
      result: {
        ok: false,
        reason: 'ancestorOwner',
        message: `The symlink ${link} above the socket belongs to another user.`,
      },
    };
  }

  if (route.symlinksLeft === 0) {
    return {
      kind: 'done',
      result: {
        ok: false,
        reason: 'directoryUnavailable',
        message: `The socket path passes too many symlinks at ${link}.`,
      },
    };
  }

  const target = readlinkSync(link);
  const current = isAbsolute(target) ? sep : route.current;
  const pending = [...componentsOf(target), ...rest];

  return { kind: 'next', route: { current, pending, symlinksLeft: route.symlinksLeft - 1 } };
};

const stepRoute = (route: Route): RouteStep => {
  const [name, ...rest] = route.pending;

  if (name === undefined) {
    return { kind: 'done', result: { ok: true, path: route.current } };
  }

  const next = join(route.current, name);
  const stats = lstatSync(next, { throwIfNoEntry: false });

  if (stats === undefined) {
    return {
      kind: 'done',
      result: {
        ok: false,
        reason: 'ancestorMissing',
        message: `The directory ${next} above the socket does not exist. Create it, or choose another socket path.`,
      },
    };
  }

  if (stats.isSymbolicLink()) {
    return followSymlink(route, next, stats, rest);
  }

  const checked = checkAncestor(next, stats);

  if (!checked.ok) {
    return { kind: 'done', result: checked };
  }

  return { kind: 'next', route: { ...route, current: next, pending: rest } };
};

// Whoever can rename a directory on the way can swap the socket directory for their own. The walk
// checks every directory it passes, including each one that holds a symlink, before it follows
// that symlink, and returns the route with every symlink resolved.
const resolveTrustedRoute = (directory: string): RouteResult => {
  try {
    const root = checkAncestor(sep, lstatSync(sep));

    if (!root.ok) {
      return root;
    }

    let step: RouteStep = {
      kind: 'next',
      route: { current: sep, pending: componentsOf(directory), symlinksLeft: maxSymlinks },
    };

    while (step.kind === 'next') {
      step = stepRoute(step.route);
    }

    return step.result;
  } catch (error) {
    return {
      ok: false,
      reason: 'directoryUnavailable',
      message: `Cannot check the directories above ${directory}: ${describeError(error)}`,
    };
  }
};

// Creates only the socket directory itself. Every directory above it must already exist, so none
// can appear between the check and the create.
const createdDirectory = (directory: string): Stats | string => {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      return describeError(error);
    }
  }

  try {
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
      message: `Other users can read, write, or enter the socket directory ${directory}. Set its mode to 0700.`,
    };
  }

  return { ok: true };
};

const probeSocket = async (path: string): Promise<Probe> => {
  try {
    const socket = await Bun.connect({ unix: path, socket: { data: () => undefined } });

    socket.end();

    return { kind: 'answers' };
  } catch (error) {
    const code = errorCode(error);

    if (code !== undefined && staleErrorCodes.has(code)) {
      return { kind: 'stale' };
    }

    return { kind: 'unreachable', detail: code ?? describeError(error) };
  }
};

// The socket path with every symlink above the socket directory resolved, after checking that only
// trusted users can change the route.
const resolveSocketPath = (requested: string): RouteResult => {
  const absolute = resolve(requested);
  const socketDirectory = dirname(absolute);
  const route = resolveTrustedRoute(dirname(socketDirectory));

  if (!route.ok) {
    return route;
  }

  return { ok: true, path: join(route.path, basename(socketDirectory), basename(absolute)) };
};

const lockPathFor = (path: string): string => `${path}.lock`;

const openLockFile = (lockPath: string): number | LockFailure => {
  try {
    return openSync(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      ownerOnlyMode,
    );
  } catch (error) {
    if (errorCode(error) === 'ELOOP') {
      return {
        ok: false,
        reason: 'lockSymlink',
        message: `The lock file ${lockPath} is a symlink.`,
      };
    }

    return {
      ok: false,
      reason: 'lockFailed',
      message: `Cannot open the lock file ${lockPath}: ${describeError(error)}`,
    };
  }
};

// One server per socket path: the server holds the lock until it stops or its process exits. The
// lock file stays, since removing it would let two servers lock two different files.
const lockSocketPath = (path: string): LockResult => {
  const lockPath = lockPathFor(path);
  const fileDescriptor = openLockFile(lockPath);

  if (typeof fileDescriptor !== 'number') {
    return fileDescriptor;
  }

  let locked: ReturnType<typeof lockExclusive>;

  try {
    locked = lockExclusive(fileDescriptor);
  } catch (error) {
    closeSync(fileDescriptor);

    return {
      ok: false,
      reason: 'lockFailed',
      message: `Cannot lock ${lockPath}: ${describeError(error)}`,
    };
  }

  if (locked.kind === 'locked') {
    const release = (): void => {
      closeSync(fileDescriptor);
    };

    return { ok: true, release };
  }

  closeSync(fileDescriptor);

  if (locked.kind === 'held') {
    return {
      ok: false,
      reason: 'serverRunning',
      message: `A server already runs or is starting on ${path}.`,
    };
  }

  return {
    ok: false,
    reason: 'lockFailed',
    message: `Cannot lock ${lockPath} (errno ${locked.errno}).`,
  };
};

// Runs under the lock, so no other server can bind the path while this checks and removes.
const removeStaleSocket = (path: string): FreeResult => {
  try {
    rmSync(path, { force: true });

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'removeFailed',
      message: `Cannot remove the stale socket ${path}: ${describeError(error)}`,
    };
  }
};

const freeLockedPath = async (path: string): Promise<FreeResult> => {
  let existing: Stats | undefined;

  try {
    existing = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    return {
      ok: false,
      reason: 'socketUnreachable',
      message: `Cannot check the socket path ${path}: ${describeError(error)}`,
    };
  }

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

  if (existing.uid !== currentUserId()) {
    return {
      ok: false,
      reason: 'socketOwner',
      message: `The socket ${path} belongs to another user.`,
    };
  }

  const probe = await probeSocket(path);

  if (probe.kind === 'answers') {
    return {
      ok: false,
      reason: 'serverRunning',
      message: `A server already runs on ${path}.`,
    };
  }

  if (probe.kind === 'unreachable') {
    return {
      ok: false,
      reason: 'socketUnreachable',
      message: `Cannot tell whether a server runs on ${path} (${probe.detail}). Remove the socket if no server uses it.`,
    };
  }

  return removeStaleSocket(path);
};

const claimResolvedPath = async (path: string): Promise<ClaimResult> => {
  const directory = prepareSocketDirectory(dirname(path));

  if (!directory.ok) {
    return directory;
  }

  const lock = lockSocketPath(path);

  if (!lock.ok) {
    return lock;
  }

  // The lock goes to the caller only with a successful claim. Every other way out releases it.
  let claimed = false;

  try {
    const freed = await freeLockedPath(path);

    if (!freed.ok) {
      return freed;
    }

    claimed = true;

    return { ok: true, path, release: lock.release };
  } finally {
    if (!claimed) {
      lock.release();
    }
  }
};

// Locks the socket path and leaves it free for a listener. Returns the path with its symlinks
// resolved: use it for everything after, so a later symlink swap cannot redirect the server. Call
// release once the server has removed its socket. Removes only a socket that no server answers on.
export const claimSocketPath = async (requested: string): Promise<ClaimResult> => {
  const resolved = resolveSocketPath(requested);

  if (!resolved.ok) {
    return resolved;
  }

  return claimResolvedPath(resolved.path);
};
