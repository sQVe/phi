import { expect, it } from 'bun:test';

import type { InputMode } from '../client/client.ts';
import { ModeFlag } from '../rows/rows.ts';
import { routeKey, routePaste } from './input.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const key = (raw: string, mode: InputMode, modes = 0) => {
  const routed = routeKey(raw, mode, modes);

  return { text: decoder.decode(routed.bytes), mode: routed.mode };
};

const paste = (text: string, modes = 0) => decoder.decode(routePaste(encoder.encode(text), modes));

it('sends a cursor key as an application key in insert mode when the pane asks for it', () => {
  expect(key('\x1b[A', 'insert', ModeFlag.applicationCursorKeys)).toEqual({
    text: '\x1bOA',
    mode: 'insert',
  });
});

it('keeps a cursor key as it is when the pane does not ask for application keys', () => {
  for (const tail of ['A', 'B', 'C', 'D', 'H', 'F']) {
    expect(key(`\x1b[${tail}`, 'insert')).toEqual({ text: `\x1b[${tail}`, mode: 'insert' });
  }
});

it('changes every cursor key in application cursor mode', () => {
  for (const tail of ['A', 'B', 'C', 'D', 'H', 'F']) {
    expect(key(`\x1b[${tail}`, 'insert', ModeFlag.applicationCursorKeys).text).toBe(`\x1bO${tail}`);
  }
});

it('keeps a key with a modifier as it is in application cursor mode', () => {
  expect(key('\x1b[1;5A', 'insert', ModeFlag.applicationCursorKeys).text).toBe('\x1b[1;5A');
});

it('sends keys, Ctrl+C, and Escape raw in insert mode', () => {
  expect(key('a', 'insert')).toEqual({ text: 'a', mode: 'insert' });
  expect(key('\x03', 'insert')).toEqual({ text: '\x03', mode: 'insert' });
  expect(key('\x1b', 'insert')).toEqual({ text: '\x1b', mode: 'insert' });
});

it('enters normal mode on Ctrl+B and sends nothing', () => {
  expect(key('\x02', 'insert')).toEqual({ text: '', mode: 'normal' });
});

it('sends one literal Ctrl+B when it is pressed twice from insert mode', () => {
  const first = key('\x02', 'insert');
  const second = key('\x02', first.mode);

  expect(first.text + second.text).toBe('\x02');
  expect(second.mode).toBe('insert');
});

it('returns to insert mode on i or Escape without sending anything', () => {
  expect(key('i', 'normal')).toEqual({ text: '', mode: 'insert' });
  expect(key('\x1b', 'normal')).toEqual({ text: '', mode: 'insert' });
});

it('sends nothing for other keys in normal mode', () => {
  expect(key('a', 'normal')).toEqual({ text: '', mode: 'normal' });

  expect(key('\x1b[A', 'normal', ModeFlag.applicationCursorKeys)).toEqual({
    text: '',
    mode: 'normal',
  });
});

it('sends pasted bytes unchanged when the pane has no bracketed paste', () => {
  expect(paste('a\r\n\x1b[200~b')).toBe('a\r\n\x1b[200~b');
});

it('wraps pasted bytes in markers when the pane has bracketed paste', () => {
  expect(paste('one\ntwo', ModeFlag.bracketedPaste)).toBe('\x1b[200~one\ntwo\x1b[201~');
});

it('sends a paste in normal mode and keeps the mode', () => {
  const normal = routeKey('\x02', 'insert', 0).mode;

  expect(normal).toBe('normal');
  expect(paste('abc', ModeFlag.bracketedPaste)).toBe('\x1b[200~abc\x1b[201~');
  expect(paste('abc')).toBe('abc');
  expect(key('a', normal).mode).toBe('normal');
});
