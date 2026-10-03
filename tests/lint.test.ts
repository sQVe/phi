import { expect, it, onTestFinished } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Edge {
  name: string;
  source: string;
  refused: boolean;
}

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
  'keeps imports inside module boundaries through %s',
  async (script) => {
    const directory = await mkdtemp(join(tmpdir(), 'phi-boundaries-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    // The `src` segment above the project root must not count as the application source.
    const project = join(directory, 'src', 'project');

    const serverUrl = pathToFileURL(join(project, 'src', 'server', 'server.ts')).href;
    const privateBindingsUrl = pathToFileURL(join(project, 'src', 'vt', 'bindings.ts')).href;
    const protocolUrl = pathToFileURL(join(project, 'src', 'protocol', 'protocol.ts')).href;

    const fixtures: [string, string[], number][] = [
      ['src/ids.ts', ['export const ids = 1;', 'export interface PaneId { id: number }'], 0],
      ['src/invariant.ts', ['export const invariant = 1;'], 0],
      [
        'src/vt/vt.ts',
        [
          "import { dlopen } from 'bun:ffi';",
          "import { readFile } from 'node:fs/promises';",
          "import { invariant } from '../invariant.ts';",
          "import { bindings } from './bindings.ts';",
          "import { nested } from './nested/deep';",
          'export const vt = [dlopen, readFile, invariant, bindings, nested];',
        ],
        0,
      ],
      ['src/vt/bindings.ts', ["import { ptr } from 'bun:ffi';", 'export const bindings = ptr;'], 0],
      [
        'src/vt/nested/deep.ts',
        ["import { bindings } from '../bindings.ts';", 'export const nested = bindings;'],
        0,
      ],
      [
        'src/vt/vt.test.ts',
        [
          "import { expect, it } from 'bun:test';",
          "import { vt } from './vt.ts';",
          "it('loads', () => expect(vt).toHaveLength(5));",
        ],
        0,
      ],
      [
        'src/rows/rows.ts',
        [
          "import { ids } from '../ids';",
          "import { invariant } from '../invariant.js';",
          'export const rows = [ids, invariant];',
        ],
        0,
      ],
      [
        'src/layout.ts',
        [
          "import { ids } from './ids.ts';",
          "import { invariant } from './invariant.ts';",
          'export const layout = [ids, invariant];',
          'export interface Layout { width: number }',
        ],
        0,
      ],
      [
        'src/store/store.ts',
        [
          "import { ids } from '../ids.ts';",
          "import { invariant } from '../invariant.ts';",
          "import { layout } from '../layout.ts';",
          "import { reduce } from './reduce.ts';",
          'export const store = [ids, invariant, layout, reduce];',
          'export interface State { id: number }',
        ],
        0,
      ],
      ['src/store/reduce.ts', ['export const reduce = 1;'], 0],
      [
        'src/protocol/protocol.ts',
        [
          "import type { State } from '../store/store.ts';",
          "import { type State as Snapshot } from '../store/store.ts';",
          "import { ids } from '../ids.ts';",
          "import { invariant } from '../invariant.ts';",
          "import { rows } from '../rows/rows.ts';",
          "export type { State as Current } from '../store/store.ts';",
          "export type StateIdentifier = import('../store/store.ts').State['id'];",
          'const loaded = await import(`../rows/rows.ts`);',
          'export const protocol = [ids, invariant, rows, loaded];',
          'export type Sources = [State, Snapshot];',
        ],
        0,
      ],
      [
        'src/server/server.ts',
        [
          "import { spawn } from 'bun';",
          "import { createServer } from 'node:net';",
          "import { ids } from '../ids.ts';",
          "import { invariant } from '../invariant.ts';",
          "import { layout } from '../layout.ts';",
          "import { protocol } from '../protocol/protocol.ts';",
          "import { rows } from '../rows/rows.ts';",
          "import { store } from '../store/store.ts';",
          "import { vt } from '../vt/vt.ts';",
          'export const server = [spawn, createServer, ids, invariant, layout, protocol, rows, store, vt];',
        ],
        0,
      ],
      [
        'src/client/client.ts',
        [
          "import { connect } from 'node:net';",
          "import { ids } from '../ids.ts';",
          "import { invariant } from '../invariant.ts';",
          `import { protocol } from '${protocolUrl}';`,
          "import { rows } from '../rows/rows.ts';",
          'export const client = [connect, ids, invariant, protocol, rows];',
        ],
        0,
      ],
      [
        'src/ui/ui.tsx',
        [
          "import { createCliRenderer } from '@opentui/core';",
          "import { createRoot } from '@opentui/react';",
          "import { argv } from 'node:process';",
          "import { useState } from 'react';",
          "import { jsx } from 'react/jsx-runtime';",
          "import { client } from '../client/client.ts';",
          "import { ids } from '../ids.ts';",
          "import { invariant } from '../invariant.ts';",
          "import { view } from './view.tsx';",
          'export const ui = [createCliRenderer, createRoot, argv, useState, jsx, client, ids, invariant, view];',
        ],
        0,
      ],
      ['src/ui/view.tsx', ['export const view = 1;'], 0],
      [
        'src/index.ts',
        [
          "import { createCliRenderer } from '@opentui/core';",
          "import { useState } from 'react';",
          "import { client } from './client/client.ts';",
          "import { ids } from './ids.ts';",
          "import { invariant } from './invariant.ts';",
          "import { layout } from './layout.ts';",
          "import { protocol } from './protocol/protocol.ts';",
          "import { rows } from './rows/rows.ts';",
          "import { server } from './server/server.ts';",
          "import { store } from './store/store.ts';",
          "import { ui } from './ui/ui.tsx';",
          "import { vt } from './vt/vt.ts';",
          'export const index = [createCliRenderer, useState, client, ids, invariant, layout];',
          'export const modules = [protocol, rows, server, store, ui, vt];',
        ],
        0,
      ],
      [
        'scripts/tool.ts',
        [
          "import { readFile } from 'node:fs';",
          "import { bindings } from '../src/vt/bindings.ts';",
          'export const tool = [readFile, bindings];',
        ],
        0,
      ],
      ['src/utils.ts', ['export const utils = 1;'], 1],
      ['src/helpers/format.ts', ['export const format = 1;'], 1],
      ['src/store.ts', ['export const misplaced = 1;'], 1],
      ['src/layout/values.ts', ['export const values = 1;'], 1],
      [
        'src/server/unknownTargets.ts',
        [
          "import { utils } from '../utils.ts';",
          "import { format } from '../helpers/format.ts';",
          'export const unknown = [utils, format];',
        ],
        2,
      ],
      [
        'src/ids.test.ts',
        [
          "import { expect, it } from 'bun:test';",
          "import { readFile } from 'node:fs';",
          "import { ids } from './ids.ts';",
          "import { invariant } from './invariant.ts';",
          "it('names', () => expect([readFile, ids, invariant]).toHaveLength(3));",
        ],
        2,
      ],
      [
        'src/invariant.test.ts',
        [
          "import { expect, it } from 'bun:test';",
          "import { readFile } from 'node:fs/promises';",
          "import { ids } from './ids.ts';",
          "import { invariant } from './invariant.ts';",
          "it('holds', () => expect([readFile, ids, invariant]).toHaveLength(3));",
        ],
        2,
      ],
      [
        'src/layout.test.ts',
        [
          "import { expect, it } from 'bun:test';",
          "import { join } from 'node:path';",
          "import { layout } from './layout.ts';",
          "it('lays out', () => expect([join, layout]).toHaveLength(2));",
        ],
        1,
      ],
      [
        'src/vt/refusedModules.ts',
        [
          "import { ids } from '../ids.ts';",
          "import type { State } from '../store/store.ts';",
          "export * from '../rows/rows.ts';",
          "import { index } from '../index.ts';",
          'export const refused: [number, State?] = [ids, index];',
        ],
        4,
      ],
      [
        'src/rows/refusedModules.ts',
        [
          "import { layout } from '../layout.ts';",
          "import { store } from '../store/store.ts';",
          "import { vt } from '../vt/vt.ts';",
          'export const refused = [layout, store, vt];',
        ],
        3,
      ],
      [
        'src/store/refusedModules.ts',
        [
          "import { protocol } from '../protocol/protocol.ts';",
          "import { rows } from '../rows/rows.ts';",
          "import { server } from '../server/server.ts';",
          'export const refused = [protocol, rows, server];',
        ],
        3,
      ],
      [
        'src/protocol/refusedModules.ts',
        [
          "import type { Layout } from '../layout.ts';",
          "import { client } from '../client/client.ts';",
          "export type Server = import('../server/server.ts').Server;",
          'export const refused: [unknown, Layout?] = [client];',
        ],
        3,
      ],
      [
        'src/client/refusedModules.ts',
        [
          "import { layout } from '../layout.ts';",
          "import type { State } from '../store/store.ts';",
          "import { server } from '../server/server.ts';",
          "import { ui } from '../ui/ui.tsx';",
          "import { vt } from '../vt/vt.ts';",
          'export const refused: [unknown, State?] = [layout, server, ui, vt];',
        ],
        5,
      ],
      [
        'src/ui/refusedModules.tsx',
        [
          "import { protocol } from '../protocol/protocol.ts';",
          "import { rows } from '../rows/rows.ts';",
          "import { server } from '../server/server.ts';",
          "import { store } from '../store/store.ts';",
          'export const refused = [protocol, rows, server, store];',
        ],
        4,
      ],
      [
        'src/server/refusedModules.ts',
        [
          "import { client } from '../client/client.ts';",
          "import { index } from '../index.ts';",
          "import { ui } from '../ui/ui.tsx';",
          'export const refused = [client, index, ui];',
        ],
        3,
      ],
      [
        'src/protocol/valueImports.ts',
        [
          "import { store } from '../store/store.ts';",
          "import { type State, store as current } from '../store/store.ts';",
          "export { store as exported } from '../store/store.ts';",
          "const loaded = await import('../store/store.ts');",
          'export const values = [store, current, loaded];',
          'export type Value = State;',
        ],
        4,
      ],
      [
        'src/server/privateImports.ts',
        [
          "import { bindings } from '../vt/bindings.ts';",
          "import { vt } from '../vt';",
          "import { nested } from '../vt/nested/deep.ts';",
          "export * from '../protocol/valueImports.ts';",
          'export const imported = [bindings, vt, nested];',
        ],
        4,
      ],
      [
        'src/server/escape.ts',
        [
          "import { outside } from '../../outside.ts';",
          "import { vt } from '../../src/vt/vt.ts';",
          'export const escaped = [outside, vt];',
        ],
        1,
      ],
      [
        'src/store/runtime.ts',
        [
          "import { readFile } from 'node:fs';",
          "import path from 'path';",
          "import { $ } from 'bun';",
          "import { test } from 'bun:test';",
          "import { dlopen } from 'bun:ffi';",
          "import { useState } from 'react';",
          "import { jsx } from 'react/jsx-runtime';",
          "import { createCliRenderer } from '@opentui/core';",
          "import { z } from 'zod';",
          'export const runtime = [readFile, path, $, test, dlopen, useState, jsx, createCliRenderer, z];',
        ],
        8,
      ],
      [
        'src/rows/runtime.ts',
        ["import { readFileSync } from 'fs';", 'export const runtime = readFileSync;'],
        1,
      ],
      [
        'src/server/renderer.ts',
        [
          "import { readFile } from 'node:fs';",
          "import { useState } from 'react';",
          "import { createCliRenderer } from '@opentui/core';",
          'export const renderer = [readFile, useState, createCliRenderer];',
        ],
        2,
      ],
      [
        'src/client/renderer.ts',
        [
          "import { connect } from 'node:net';",
          "import { createRoot } from '@opentui/react';",
          'export const renderer = [connect, createRoot];',
        ],
        1,
      ],
      [
        'src/vt/renderer.ts',
        ["import { useState } from 'react';", 'export const renderer = useState;'],
        1,
      ],
      [
        'src/protocol/renderer.ts',
        ["import { jsx } from 'react/jsx-runtime';", 'export const renderer = jsx;'],
        1,
      ],
      [
        'src/client/dynamic.ts',
        [
          "const name = 'helper';",
          'export const computed = await import(name);',
          // eslint-disable-next-line eslint/no-template-curly-in-string -- Fixture source with an interpolated import.
          'export const interpolated = await import(`./${name}.ts`);',
          "export const refused = await import('../server/server.ts');",
          "export const allowed = await import('./client.ts');",
        ],
        3,
      ],
      [
        'src/client/required.ts',
        [
          "const name = 'helper';",
          "export const refused = require('../server/server.ts');",
          'export const computed = require(name);',
          "export const allowed = require('./client.ts');",
          "import server = require('../server/server.ts');",
          "import type Store = require('../store/store.ts');",
          "import client = require('./client.ts');",
          'export const imported = [server, client];',
          'export type Imported = Store;',
        ],
        4,
      ],
      ['src/client/directory.ts', ["export * from '.';"], 1],
      [
        'src/client/fileUrls.ts',
        [
          `export { server } from '${serverUrl}';`,
          `export const loaded = await import('${privateBindingsUrl}');`,
        ],
        2,
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

    const expected = fixtures.reduce((total, fixture) => total + fixture[2], 0);
    expect(diagnostics).toHaveLength(expected);
  },
  30_000,
);

const moduleEntries = {
  ids: 'src/ids.ts',
  invariant: 'src/invariant.ts',
  vt: 'src/vt/vt.ts',
  rows: 'src/rows/rows.ts',
  layout: 'src/layout.ts',
  store: 'src/store/store.ts',
  protocol: 'src/protocol/protocol.ts',
  server: 'src/server/server.ts',
  client: 'src/client/client.ts',
  ui: 'src/ui/ui.tsx',
  index: 'src/index.ts',
};

type ModuleName = keyof typeof moduleEntries;

const moduleNames = Object.keys(moduleEntries) as ModuleName[];

// Written out rather than read from the rule, so an extra edge in the rule fails the test.
const allowedEdges: Record<ModuleName, ModuleName[]> = {
  ids: [],
  invariant: [],
  vt: ['invariant'],
  rows: ['ids', 'invariant'],
  layout: ['ids', 'invariant'],
  store: ['ids', 'invariant', 'layout'],
  protocol: ['ids', 'invariant', 'rows'],
  server: ['ids', 'invariant', 'vt', 'rows', 'layout', 'store', 'protocol'],
  client: ['ids', 'invariant', 'rows', 'protocol'],
  ui: ['ids', 'invariant', 'client'],
  index: [
    'ids',
    'invariant',
    'vt',
    'rows',
    'layout',
    'store',
    'protocol',
    'server',
    'client',
    'ui',
  ],
};

const typeOnlyEdges: Partial<Record<ModuleName, ModuleName[]>> = { protocol: ['store'] };

const isRefused = (importer: ModuleName, target: ModuleName, typeOnly: boolean): boolean => {
  const allowed = allowedEdges[importer].includes(target);
  const typeOnlyAllowed = typeOnly && typeOnlyEdges[importer]?.includes(target) === true;

  return !allowed && !typeOnlyAllowed;
};

// One line per import, so a diagnostic's line number names the edge it refuses.
const edgesOf = (importer: ModuleName): Edge[] =>
  moduleNames
    .filter((target) => target !== importer)
    .flatMap((target) => {
      const path = relative(dirname(moduleEntries[importer]), moduleEntries[target]);
      const specifier = path.startsWith('.') ? path : `./${path}`;

      return [
        {
          name: `${importer} -> ${target}`,
          source: `import '${specifier}';`,
          refused: isRefused(importer, target, false),
        },
        {
          name: `${importer} -> type ${target}`,
          source: `import type {} from '${specifier}';`,
          refused: isRefused(importer, target, true),
        },
      ];
    });

it('refuses every module edge outside the import table', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-module-table-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, 'package.json'), '{}\n');

  for (const importer of moduleNames) {
    const path = join(directory, moduleEntries[importer]);
    const sources = edgesOf(importer).map((edge) => edge.source);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${[...sources, 'export {};'].join('\n')}\n`);
  }

  const result = spawnSync(process.execPath, ['run', 'lint', directory, ...unixFormat], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  // The linter prints a path relative to its working directory when the file sits below it.
  const edgeOf = (diagnostic: string): string => {
    const [, path = '', line = '0'] = diagnostic.match(/^(.+?):(\d+):\d+:/) ?? [];

    const importer = moduleNames.find(
      (name) => resolve(root, path) === join(directory, moduleEntries[name]),
    );

    return importer === undefined
      ? diagnostic
      : (edgesOf(importer)[Number(line) - 1]?.name ?? diagnostic);
  };

  const refused = result.stdout
    .split('\n')
    .filter((line) => line.includes('phi(module-boundaries)'))
    .map(edgeOf);

  const expected = moduleNames.flatMap((importer) =>
    edgesOf(importer)
      .filter((edge) => edge.refused)
      .map((edge) => edge.name),
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(refused.toSorted()).toEqual(expected.toSorted());
}, 30_000);
