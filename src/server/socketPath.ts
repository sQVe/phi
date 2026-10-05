import { randomUUID } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, mkdirSync, readlinkSync, rmSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { invariant } from '../invariant.ts';

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

type ClaimResult =
  | { ok: true; path: string }
  | DirectoryFailure
  | { ok: false; reason: 'symlink'; message: string }
  | { ok: false; reason: 'notSocket'; message: string }
  | { ok: false; reason: 'socketOwner'; message: string }
  | { ok: false; reason: 'socketUnreachable'; message: string }
  | { ok: false; reason: 'serverRunning'; message: string };

type PublishResult =
  | { ok: true }
  | { ok: false; reason: 'serverRunning'; message: string }
  | { ok: false; reason: 'publishFailed'; message: string };

type Probe = { kind: 'answers' } | { kind: 'stale' } | { kind: 'unreachable'; detail: string };

// Group and other read and write bits.
const sharedModeBits = 0o066;

// Group and other write bits.
const sharedWriteBits = 0o022;

const stickyBit = 0o1000;

// Connect errors that prove no server listens on the path.
const staleErrorCodes = new Set(['ECONNREFUSED', 'ENOENT']);

// Random characters in a listening path, kept short because socket paths have a small length limit.
const listeningNameLength = 8;

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
      message: `Other users can read or write the socket directory ${directory}. Set its mode to 0700.`,
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

const isSameFile = (current: Stats | undefined, probed: Stats): boolean =>
  current?.ino === probed.ino && current.dev === probed.dev;

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

const claimResolvedPath = async (path: string): Promise<ClaimResult> => {
  const directory = prepareSocketDirectory(dirname(path));

  if (!directory.ok) {
    return directory;
  }

  const existing = lstatSync(path, { throwIfNoEntry: false });

  if (existing === undefined) {
    return { ok: true, path };
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

  // Another server may have replaced the stale socket since the probe. Its socket stays.
  if (!isSameFile(lstatSync(path, { throwIfNoEntry: false }), existing)) {
    return claimResolvedPath(path);
  }

  rmSync(path, { force: true });

  return { ok: true, path };
};

// Leaves the path free for a listener, and returns it with its symlinks resolved. Use that path for
// everything after, so a later symlink swap cannot redirect the server. Removes only a socket that
// no server answers on.
export const claimSocketPath = async (requested: string): Promise<ClaimResult> => {
  const resolved = resolveSocketPath(requested);

  if (!resolved.ok) {
    return resolved;
  }

  return claimResolvedPath(resolved.path);
};

// A private path in the socket directory for the listener to bind before publishSocket.
export const listeningPathFor = (path: string): string =>
  join(dirname(path), `.phi-${randomUUID().slice(0, listeningNameLength)}`);

// A listener binds its path before it accepts connections, and a client that connects in between
// takes the socket for stale. Linking a listening socket into place leaves no such gap, and the
// link fails when another server took the path first.
export const publishSocket = (listeningPath: string, path: string): PublishResult => {
  try {
    // The listener creates the socket with the process umask.
    chmodSync(listeningPath, ownerOnlyMode);
    linkSync(listeningPath, path);

    return { ok: true };
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return { ok: false, reason: 'serverRunning', message: `A server already runs on ${path}.` };
    }

    return {
      ok: false,
      reason: 'publishFailed',
      message: `Cannot place the socket at ${path}: ${describeError(error)}`,
    };
  } finally {
    rmSync(listeningPath, { force: true });
  }
};
