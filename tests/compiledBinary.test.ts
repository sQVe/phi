import { afterAll, beforeAll, expect, it, onTestFinished } from 'bun:test';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import packageJson from '../package.json' with { type: 'json' };
import { endServersIn, isRunning, serverProcessesIn, waitFor } from './serverProcesses.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

let source: string;
let directory: string;

const pinnedGhosttyCommit = async () => {
  const script = await readFile(join(root, 'scripts/buildVt.sh'), 'utf8');
  const commit = /^ghostty_commit=([0-9a-f]{40})$/m.exec(script)?.[1];

  if (commit === undefined) {
    throw new Error('scripts/buildVt.sh has no Ghostty pin.');
  }

  return commit;
};

// Compiles from a copy of the sources and deletes the copy, so the library path the compiler saw no
// longer exists and the binary can only load its embedded library.
const compileFromCopy = async () => {
  await cp(join(root, 'src'), join(source, 'src'), { recursive: true });
  await cp(join(root, 'package.json'), join(source, 'package.json'));
  await symlink(join(root, 'node_modules'), join(source, 'node_modules'));
  await mkdir(join(source, 'build'));
  await cp(join(root, 'build/libphi-vt.so'), join(source, 'build/libphi-vt.so'));

  const build = Bun.spawnSync(
    ['bun', 'build', '--compile', 'src/index.ts', '--outfile', join(directory, 'phi')],
    { cwd: source, stdout: 'pipe', stderr: 'pipe' },
  );

  if (build.exitCode !== 0) {
    throw new Error(build.stderr.toString());
  }

  await rm(source, { recursive: true, force: true });
};

beforeAll(async () => {
  source = await mkdtemp(join(tmpdir(), 'phi-binary-source-'));
  directory = await mkdtemp(join(tmpdir(), 'phi-binary-'));

  await compileFromCopy();
});

afterAll(async () => {
  await rm(source, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
});

it('prints the version and the pinned Ghostty commit without the library it was compiled from', async () => {
  const run = Bun.spawnSync([join(directory, 'phi'), '--version', '--json'], {
    cwd: directory,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: '',
  });

  const output: unknown = JSON.parse(run.stdout.toString());

  expect(output).toEqual({ version: packageJson.version, ghostty: await pinnedGhosttyCommit() });
  expect(packageJson.version).not.toBe('');
});

it('prints the version and the pinned Ghostty commit when run from source', async () => {
  const run = Bun.spawnSync(['bun', 'src/index.ts', '--version'], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: '',
  });

  expect(run.stdout.toString()).toMatch(
    new RegExp(`^phi \\S+ \\(ghostty ${await pinnedGhosttyCommit()}\\)\\n$`),
  );
});

const startOutputSchema = z.object({ socket: z.string(), pid: z.number().int().positive() });

it('starts and stops a server', async () => {
  const state = await mkdtemp(join(tmpdir(), 'phi-binary-server-'));
  const socketPath = join(state, 'run', 'phi.sock');

  const runBinary = (commandArguments: string[]) =>
    Bun.spawnSync([join(directory, 'phi'), 'server', ...commandArguments, '--socket', socketPath], {
      cwd: state,
      env: { ...process.env, XDG_STATE_HOME: join(state, 'state') },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

  onTestFinished(async () => {
    await endServersIn(state);
    await rm(state, { recursive: true, force: true });
  });

  const started = runBinary(['start', '--json']);

  expect({ exitCode: started.exitCode, stderr: started.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: '',
  });

  const output = startOutputSchema.parse(JSON.parse(started.stdout.toString()));

  expect(output.socket).toBe(socketPath);
  expect(serverProcessesIn(state)).toEqual([output.pid]);

  const stopped = runBinary(['stop', '--json']);

  expect({ exitCode: stopped.exitCode, stdout: stopped.stdout.toString() }).toEqual({
    exitCode: 0,
    stdout: '{"stopped":true}\n',
  });

  expect(existsSync(socketPath)).toBe(false);
  expect(await waitFor(() => !isRunning(output.pid))).toBe(true);
}, 30_000);
