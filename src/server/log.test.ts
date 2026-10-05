import { expect, it, onTestFinished } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { createLog, logPathFor } from './log.ts';

const messageSchema = z.object({ message: z.string() });

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-log-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return directory;
};

const readLines = async (path: string): Promise<unknown[]> => {
  const text = await readFile(path, 'utf8');

  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
};

const readMessages = async (path: string): Promise<string[]> => {
  const lines = await readLines(path);

  return lines.map((line) => messageSchema.parse(line).message);
};

it('places the log in the XDG state directory', () => {
  expect(logPathFor('/home/user/state', '/home/user')).toBe('/home/user/state/phi/server.log');
});

it('places the log in ~/.local/state without an XDG state directory', () => {
  expect(logPathFor(undefined, '/home/user')).toBe('/home/user/.local/state/phi/server.log');
  expect(logPathFor('relative', '/home/user')).toBe('/home/user/.local/state/phi/server.log');
});

it('writes each entry as a JSON line with its time, level, message, and fields', async () => {
  const path = join(await temporaryDirectory(), 'phi', 'server.log');
  const log = createLog(path, () => Date.UTC(2026, 9, 5, 8, 0, 0));

  log.info('server started', { socket: '/run/phi.sock' });
  log.error('pane failed', { pane: 'pane-1', code: 2 });

  expect(await readLines(path)).toEqual([
    {
      time: '2026-10-05T08:00:00.000Z',
      level: 'info',
      message: 'server started',
      fields: { socket: '/run/phi.sock' },
    },
    {
      time: '2026-10-05T08:00:00.000Z',
      level: 'error',
      message: 'pane failed',
      fields: { pane: 'pane-1', code: 2 },
    },
  ]);
});

it('rotates at the size limit and keeps exactly one old file', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'server.log');
  // Each line is 82 bytes, so two lines fit under the limit and a third rotates the log.
  const limitBytes = 200;
  const log = createLog(path, () => 0, limitBytes);

  for (const message of ['line 1', 'line 2', 'line 3', 'line 4', 'line 5']) {
    log.info(message);
  }

  expect((await readdir(directory)).toSorted()).toEqual(['server.log', 'server.log.1']);
  expect(await readMessages(`${path}.1`)).toEqual(['line 3', 'line 4']);
  expect(await readMessages(path)).toEqual(['line 5']);
  expect((await stat(`${path}.1`)).size).toBeLessThanOrEqual(limitBytes);
});
