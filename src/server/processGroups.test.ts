import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { parseStat, sessionGroups } from './processGroups.ts';

it('reads the process group and session after the command name', () => {
  expect(parseStat('4242 (sleep) S 4200 4242 4200 34817 4242 4194304 99 0')).toEqual({
    group: 4242,
    session: 4200,
  });
});

it('reads a command name that holds spaces and parentheses', () => {
  expect(parseStat('17 (a) b (c)) R 1 23 19 0 -1 0')).toEqual({ group: 23, session: 19 });
});

it('refuses a line without a command name', () => {
  expect(parseStat('17 R 1 23 19')).toBeUndefined();
});

it('refuses a line cut off before the session', () => {
  expect(parseStat('17 (sh) R 1 23')).toBeUndefined();
});

it('finds the process group of this process in its session', () => {
  const own = parseStat(readFileSync('/proc/self/stat', 'utf8'));

  if (own === undefined) {
    throw new Error('Cannot read this process.');
  }

  expect(sessionGroups(own.session)).toContain(own.group);
});

it('finds no process group in a session that has no processes', () => {
  expect(sessionGroups(0x7f_ff_ff_ff)).toEqual([]);
});
