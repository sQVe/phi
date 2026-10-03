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

const effectRules = ['eslint(no-restricted-imports)', 'eslint(no-restricted-properties)'];

it.each(['lint', 'style:check'])(
  'refuses React effects through %s',
  async (script) => {
    const directory = await mkdtemp(join(tmpdir(), 'phi-effects-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    const fixtures: [string, string[], number][] = [
      [
        'named.ts',
        [
          "import { useEffect, useLayoutEffect as useLayout } from 'react';",
          "export { useEffect as useReexported } from 'react';",
          'export const hooks = [useEffect, useLayout];',
        ],
        3,
      ],
      ['member.ts', ['export const hooks = [React.useEffect, React.useLayoutEffect];'], 2],
      [
        'default.ts',
        ["import R from 'react';", 'export const hooks = [R.useEffect, R.useLayoutEffect];'],
        1,
      ],
      [
        'namespace.ts',
        [
          "import * as react from 'react';",
          'export const hooks = [react.useEffect, react.useLayoutEffect];',
        ],
        1,
      ],
      [
        'allowed.ts',
        [
          "import { useState, useSyncExternalStore } from 'react';",
          'const useEffect = (value: number) => value;',
          'export const useCount = () => {',
          '  const [count] = useState(0);',
          '  const snapshot = useSyncExternalStore(',
          '    () => () => undefined,',
          '    () => count,',
          '  );',
          '',
          '  return useEffect(snapshot);',
          '};',
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
      .filter((line) => effectRules.some((rule) => line.includes(rule)));

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
