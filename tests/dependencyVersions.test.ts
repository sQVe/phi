import { expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const exactVersion = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// An `npm:` alias names another package, and its own version must be exact too.
const isExact = (version: unknown): boolean => {
  if (typeof version !== 'string') {
    return false;
  }

  const alias = /^npm:(?:@[^/@]+\/)?[^@]+@(.+)$/.exec(version);

  return exactVersion.test(alias?.[1] ?? version);
};

const dependenciesOf = (manifest: unknown): [string, unknown][] => {
  if (!isRecord(manifest)) {
    return [];
  }

  return dependencyFields.flatMap((field) => {
    const dependencies = manifest[field];

    return isRecord(dependencies) ? Object.entries(dependencies) : [];
  });
};

it('pins every dependency in package.json to an exact version', async () => {
  const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const dependencies = dependenciesOf(manifest);
  const loose = dependencies.filter(([, version]) => !isExact(version));

  expect(dependencies.length).toBeGreaterThan(0);
  expect(loose).toEqual([]);
});
