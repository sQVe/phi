import { expect, it, onTestFinished } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// The linter picks its default output format from the environment. One line per diagnostic keeps
// the paths readable.
const unixFormat = ['--format', 'unix'];

const conventionRules = ['phi(throw-only-in-invariant)', 'phi(class-owns-resource)'];

const fixtures: [string, string[], number][] = [
  [
    'src/invariant.ts',
    [
      'export const invariant = (condition: boolean, message: string) => {',
      '  if (!condition) {',
      '    throw new Error(message);',
      '  }',
      '};',
    ],
    0,
  ],
  ['src/parse.ts', ["export const parse = () => {\n  throw new Error('bad input');\n};"], 1],
  ['src/parse.test.ts', ["export const parseTest = () => {\n  throw new Error('test');\n};"], 0],
  [
    'scripts/tool.ts',
    ["export const tool = () => {\n  throw new Error('tool');\n};", 'export class Tool {}'],
    0,
  ],
  ['src/handle.ts', ['export class Handle {\n  dispose() {\n    return 0;\n  }\n}'], 0],
  [
    'src/terminal.ts',
    ['export class Terminal {\n  [Symbol.dispose]() {\n    return 0;\n  }\n}'],
    0,
  ],
  ['src/plain.ts', ['export class Plain {\n  read() {\n    return 0;\n  }\n}'], 1],
  [
    'src/expression.ts',
    ['export const Expression = class {\n  read() {\n    return 0;\n  }\n};'],
    1,
  ],
  [
    'src/paneRenderable.ts',
    [
      "import { Renderable } from '@opentui/core';",
      'export class PaneRenderable extends Renderable {\n  draw() {\n    return 0;\n  }\n}',
    ],
    0,
  ],
  [
    'src/failure.ts',
    ['export class Failure extends Error {\n  dispose() {\n    return 0;\n  }\n}'],
    1,
  ],
  [
    'src/child.ts',
    [
      'class Base {\n  dispose() {\n    return 0;\n  }\n}',
      'export class Child extends Base {\n  dispose() {\n    return 1;\n  }\n}',
    ],
    1,
  ],
];

it.each(['lint', 'style:check'])(
  'refuses throws outside invariant and classes without a resource through %s',
  async (script) => {
    const directory = await mkdtemp(join(tmpdir(), 'phi-conventions-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    await writeFile(join(directory, 'package.json'), '{}\n');

    for (const [file, lines] of fixtures) {
      const path = join(directory, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${lines.join('\n')}\n`);
    }

    const result = spawnSync(process.execPath, ['run', script, directory, ...unixFormat], {
      cwd: root,
      env: { ...process.env, SEAM_STYLE: '0' },
      encoding: 'utf8',
      timeout: 20_000,
    });

    const diagnostics = result.stdout
      .split('\n')
      .filter((line) => conventionRules.some((rule) => line.includes(rule)));

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
