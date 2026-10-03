import { expect, it, onTestFinished } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// The linter picks its default output format from the environment, such as GitHub Actions or an AI
// agent. Tests that read paths from diagnostics need one line per diagnostic.
const unixFormat = ['--format', 'unix'];

it('rejects lint warnings in project checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-lint-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixture = join(directory, 'warning.js');
  await writeFile(fixture, 'console.log("warning fixture");\n');

  const result = spawnSync(process.execPath, ['run', 'lint', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('eslint(no-console)');
}, 30_000);

it('runs house style through the style command but not plain lint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-style-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const fixture = join(directory, 'style.ts');
  await writeFile(fixture, 'export const MAX_RETRIES = 3;\n');

  const run = (script: string) =>
    spawnSync(process.execPath, ['run', script, fixture], {
      cwd: root,
      env: { ...process.env, SEAM_STYLE: '0' },
      encoding: 'utf8',
      timeout: 20_000,
    });

  const ordinary = run('lint');
  const style = run('style:check');

  expect(ordinary.error).toBeUndefined();
  expect(ordinary.status).toBe(0);
  expect(ordinary.stdout).not.toContain('naming-convention');
  expect(style.error).toBeUndefined();
  expect(style.status).toBe(1);
  expect(style.stdout).toContain('naming-convention');
}, 60_000);

it.each(['lint', 'style:check'])(
  'refuses files outside a known module through %s',
  async (script) => {
    const directory = await mkdtemp(join(tmpdir(), 'phi-boundaries-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    // The `src` segment above the project root must not count as the application source.
    const project = join(directory, 'src', 'project');

    const fixtures: [string, string[], number][] = [
      [
        'src/main.ts',
        ["import { helper } from './helper/helper.ts';", 'export const main = helper;'],
        1,
      ],
      ['src/helper/helper.ts', ['export const helper = 1;'], 1],
      [
        'src/main.test.ts',
        [
          "import { expect, it } from 'bun:test';",
          "import { main } from './main.ts';",
          "it('runs', () => expect(main).toBe(1));",
        ],
        1,
      ],
      [
        'scripts/tool.ts',
        [
          "import { readFile } from 'node:fs';",
          "import { helper } from '../src/helper/helper.ts';",
          'export const tool = [readFile, helper];',
        ],
        0,
      ],
      [
        'tests/tool.test.ts',
        ["import { tool } from '../scripts/tool.ts';", 'export const tested = tool;'],
        0,
      ],
    ];

    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'package.json'), '{}\n');

    for (const [file, lines] of fixtures) {
      const path = join(project, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${lines.join('\n')}\n`);
    }

    const result = spawnSync(process.execPath, ['run', script, project, ...unixFormat], {
      cwd: root,
      env: { ...process.env, SEAM_STYLE: '0' },
      encoding: 'utf8',
      timeout: 20_000,
    });

    const diagnostics = result.stdout
      .split('\n')
      .filter((line) => line.includes('phi(module-boundaries)'));

    // The linter prints a path relative to its working directory when the file sits below it.
    const reportedPath = (diagnostic: string) => {
      const [, path = ''] = diagnostic.match(/^(.+?):\d+:\d+:/) ?? [];

      return resolve(root, path);
    };

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);

    for (const [file, , count] of fixtures) {
      const fileDiagnostics = diagnostics.filter(
        (line) => reportedPath(line) === join(project, file),
      );

      expect({ file, diagnostics: fileDiagnostics.length }).toEqual({ file, diagnostics: count });
    }

    expect(diagnostics).toHaveLength(3);
  },
  30_000,
);
