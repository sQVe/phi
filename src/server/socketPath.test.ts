import { expect, it, onTestFinished } from 'bun:test';
import { lstatSync, statSync } from 'node:fs';
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimSocketPath, restrictSocket, socketPathFor } from './socketPath.ts';

const userId = process.getuid?.() ?? -1;

const isRoot = userId === 0;

// Without root a test cannot create a directory for another user, so it uses `/` when another user
// owns it.
const canUseForeignDirectory = isRoot || statSync('/').uid !== userId;

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-socket-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return directory;
};

const foreignDirectory = async (): Promise<string> => {
  if (!isRoot) {
    return '/';
  }

  const directory = await temporaryDirectory();
  const nobody = 65_534;
  await chown(directory, nobody, nobody);

  return directory;
};

const listen = (path: string) => {
  const listener = Bun.listen({ unix: path, socket: { data: () => undefined } });

  onTestFinished(() => {
    listener.stop(true);
  });

  return listener;
};

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

it('places the default socket in the runtime directory', () => {
  expect(socketPathFor(undefined, '/run/user/1000', 1000)).toBe('/run/user/1000/phi/phi.sock');
});

it('places the default socket in a per-user tmp directory without a runtime directory', () => {
  expect(socketPathFor(undefined, undefined, 1000)).toBe('/tmp/phi-1000/phi.sock');
  expect(socketPathFor(undefined, 'relative', 1000)).toBe('/tmp/phi-1000/phi.sock');
});

it('uses the requested socket path over the default', () => {
  expect(socketPathFor('/srv/phi.sock', '/run/user/1000', 1000)).toBe('/srv/phi.sock');
});

it('creates a missing socket directory with mode 0700', async () => {
  const directory = join(await temporaryDirectory(), 'phi');

  const result = await claimSocketPath(join(directory, 'phi.sock'));

  expect(result).toEqual({ ok: true });
  expect(await modeOf(directory)).toBe(0o700);
});

it('refuses a socket directory that is a symlink', async () => {
  const base = await temporaryDirectory();
  const directory = join(base, 'link');
  await mkdir(join(base, 'real'), { mode: 0o700 });
  await symlink(join(base, 'real'), directory);

  const result = await claimSocketPath(join(directory, 'phi.sock'));

  expect(result).toMatchObject({ ok: false, reason: 'directorySymlink' });
});

it.skipIf(!canUseForeignDirectory)(
  'refuses a socket directory that another user owns',
  async () => {
    const directory = await foreignDirectory();

    const result = await claimSocketPath(join(directory, 'phi.sock'));

    expect(result).toMatchObject({ ok: false, reason: 'directoryOwner' });
  },
);

it('refuses a group-writable socket directory and leaves its mode', async () => {
  const directory = join(await temporaryDirectory(), 'phi');
  await mkdir(directory);
  await chmod(directory, 0o720);

  const result = await claimSocketPath(join(directory, 'phi.sock'));

  expect(result).toMatchObject({ ok: false, reason: 'directoryMode' });
  expect(await modeOf(directory)).toBe(0o720);
});

it('refuses a regular file at the socket path and leaves it in place', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'phi.sock');
  await writeFile(path, 'keep');

  const result = await claimSocketPath(path);

  expect(result).toMatchObject({ ok: false, reason: 'notSocket' });
  expect(await readFile(path, 'utf8')).toBe('keep');
});

it('refuses a symlink at the socket path and leaves it in place', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'phi.sock');
  const target = join(directory, 'target');
  await writeFile(target, 'keep');
  await symlink(target, path);

  const result = await claimSocketPath(path);

  expect(result).toMatchObject({ ok: false, reason: 'symlink' });
  expect(await readlink(path)).toBe(target);
  expect(await readFile(target, 'utf8')).toBe('keep');
});

it('removes a stale socket and claims its path', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'phi.sock');
  const listening = join(directory, 'listening.sock');
  const listener = listen(listening);
  // The listener removes its own path on stop, so a second link keeps the socket file stale.
  await link(listening, path);
  listener.stop(true);

  const result = await claimSocketPath(path);

  expect(result).toEqual({ ok: true });
  expect(lstatSync(path, { throwIfNoEntry: false })).toBeUndefined();
});

it('refuses a socket that a server answers on and leaves it in place', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'phi.sock');
  listen(path);

  const result = await claimSocketPath(path);

  expect(result).toMatchObject({ ok: false, reason: 'serverRunning' });
  expect((await lstat(path)).isSocket()).toBe(true);
});

it('restricts a listening socket to its owner', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'phi.sock');
  listen(path);

  restrictSocket(path);

  expect(await modeOf(path)).toBe(0o600);
});
