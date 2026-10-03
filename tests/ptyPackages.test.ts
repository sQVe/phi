import { expect, it, onTestFinished } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// The linter picks its default output format from the environment. One line per diagnostic keeps
// the paths readable.
const unixFormat = ['--format', 'unix'];

it.each(['lint', 'style:check'])(
  'refuses node-pty and its forks through %s',
  async (script) => {
    const directory = await mkdtemp(join(tmpdir(), 'phi-pty-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    const fixtures: [string, string[], number][] = [
      [
        'refused.ts',
        [
          "import { spawn } from 'node-pty';",
          "export { spawn as forkSpawn } from '@lydell/node-pty';",
          "export * from '@homebridge/node-pty-prebuilt-multiarch';",
          "export * from 'node-pty-prebuilt';",
          "export const loaded = await import('node-pty/lib/unixTerminal');",
          'export const spawned = spawn;',
        ],
        5,
      ],
      [
        'allowed.ts',
        [
          "import { spawn } from 'bun';",
          "export * from 'empty-node';",
          "export * from 'node-ptyx';",
          "export * from 'snode-pty';",
          "export const loaded = await import('@scope/pty');",
          'export const spawned = spawn;',
        ],
        0,
      ],
      [
        'local.ts',
        [
          "export * from './node-pty-utils';",
          "export * from '../node-pty/adapter';",
          "export * from '/vendor/node-pty';",
          "export const loaded = await import('./lib/node-pty/spawn');",
        ],
        0,
      ],
    ];

    await writeFile(join(directory, 'package.json'), '{}\n');

    for (const [file, lines] of fixtures) {
      await writeFile(join(directory, file), `${lines.join('\n')}\n`);
    }

    const result = spawnSync(process.execPath, ['run', script, directory, ...unixFormat], {
      cwd: root,
      env: { ...process.env, SEAM_STYLE: '0' },
      encoding: 'utf8',
      timeout: 20_000,
    });

    const diagnostics = result.stdout
      .split('\n')
      .filter((line) => line.includes('eslint(no-restricted-imports)'));

    // The linter prints a path relative to its working directory when the file sits below it.
    const reportedPath = (diagnostic: string) => {
      const [, path = ''] = diagnostic.match(/^(.+?):\d+:\d+:/) ?? [];

      return resolve(root, path);
    };

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);

    for (const [file, , count] of fixtures) {
      const fileDiagnostics = diagnostics.filter(
        (line) => reportedPath(line) === join(directory, file),
      );

      expect({ file, diagnostics: fileDiagnostics.length }).toEqual({ file, diagnostics: count });
    }
  },
  30_000,
);
