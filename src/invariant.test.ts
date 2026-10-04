import { expect, it } from 'bun:test';

import { invariant } from './invariant.ts';

it('throws the message when the condition is false', () => {
  expect(() => {
    invariant(false, 'pane is missing');
  }).toThrow(new Error('pane is missing'));
});

it('returns when the condition is true', () => {
  expect(() => {
    invariant(true, 'pane is missing');
  }).not.toThrow();
});
