import { expect, it } from 'bun:test';

import { clientId, paneId } from './ids.ts';

it('gives different pane ids for different numbers', () => {
  expect(paneId(1)).not.toBe(paneId(2));
});

it('gives equal pane ids for the same number', () => {
  expect(paneId(1)).toBe(paneId(1));
});

it('gives different client ids for different numbers', () => {
  expect(clientId(1)).not.toBe(clientId(2));
});

it('gives equal client ids for the same number', () => {
  expect(clientId(1)).toBe(clientId(1));
});
