import { expect, it } from 'bun:test';

import { ModeFlag } from '../src/rows/rows.ts';
import { setupAttach } from './attachHarness.ts';
import type { AttachHarness } from './attachHarness.ts';

const escape = '\x1b';

// The few milliseconds that make each PTY write a separate stdin read.
const separateRead = async () => {
  await Bun.sleep(5);
};

const startInInsert = async (modes: number) => {
  const attached = await setupAttach(modes);

  await attached.until(() => attached.statusBar() === 'INSERT');

  return attached;
};

// Sends Escape alone and waits until the pane has it, so the next write is a separate stdin read.
const sendEscape = async (attached: AttachHarness) => {
  attached.type(escape);

  await attached.until(() => attached.receivedText() === escape);
};

it('sends a lone Escape to the pane as its own input frame', async () => {
  const attached = await startInInsert(0);

  attached.type(escape);

  await attached.until(() => attached.receivedBytes().length > 0);
  expect(attached.receivedText()).toBe(escape);
});

it('sends Escape then a split cursor key in application cursor mode', async () => {
  const attached = await startInInsert(ModeFlag.applicationCursorKeys);

  await sendEscape(attached);
  attached.type('[A');

  await attached.until(() => attached.receivedText().length >= 3);
  expect(attached.receivedText()).toBe('\x1bOA');
});

it('sends Escape then a split cursor key in normal cursor mode', async () => {
  const attached = await startInInsert(0);

  await sendEscape(attached);
  attached.type('[A');

  await attached.until(() => attached.receivedText().length >= 3);
  expect(attached.receivedText()).toBe('\x1b[A');
});

it('sends the rest of a read after a split cursor key', async () => {
  const attached = await startInInsert(ModeFlag.applicationCursorKeys);

  await sendEscape(attached);
  attached.type('[Ax');

  await attached.until(() => attached.receivedText().length >= 4);
  expect(attached.receivedText()).toBe('\x1bOAx');
});

it('sends Escape then a plain key', async () => {
  const attached = await startInInsert(0);

  await sendEscape(attached);
  attached.type('x');

  await attached.until(() => attached.receivedText().length >= 2);
  expect(attached.receivedText()).toBe('\x1bx');
});

it('sends only Escape when Ctrl+B follows and goes to normal mode', async () => {
  const attached = await startInInsert(0);

  await sendEscape(attached);
  attached.type('\x02');

  await attached.until(() => attached.statusBar() === 'NORMAL');
  expect(attached.receivedText()).toBe(escape);
});

it('sends Escape then a bracketed paste', async () => {
  const attached = await startInInsert(ModeFlag.bracketedPaste);

  await sendEscape(attached);
  attached.type('\x1b[200~hi\x1b[201~');

  await attached.until(() => attached.receivedText().endsWith('\x1b[201~'));
  expect(attached.receivedText()).toBe('\x1b\x1b[200~hi\x1b[201~');
});

it('sends one Ctrl+B to the pane when it is typed twice', async () => {
  const attached = await startInInsert(0);

  attached.type('\x02');

  await attached.until(() => attached.statusBar() === 'NORMAL');
  attached.type('\x02');

  await attached.until(() => attached.statusBar() === 'INSERT');
  await attached.until(() => attached.receivedText() === '\x02');
});

it('sends Alt plus a multibyte character unchanged', async () => {
  const attached = await startInInsert(0);

  attached.type(Uint8Array.from([0x1b, 0xc3, 0xa9]));

  await attached.until(() => attached.receivedBytes().length >= 3);
  expect([...attached.receivedBytes()]).toEqual([0x1b, 0xc3, 0xa9]);
});

it('sends Alt plus a multibyte character and the key after it unchanged', async () => {
  const attached = await startInInsert(0);

  attached.type(Uint8Array.from([0x1b, 0xc3, 0xa9, 0x78]));

  await attached.until(() => attached.receivedBytes().length >= 4);
  expect([...attached.receivedBytes()]).toEqual([0x1b, 0xc3, 0xa9, 0x78]);
});

it('sends a cursor key when the bracket and letter arrive in two reads', async () => {
  const attached = await startInInsert(ModeFlag.applicationCursorKeys);

  attached.type('\x1b[');
  await separateRead();
  attached.type('A');

  await attached.until(() => attached.receivedText().length >= 3);
  expect(attached.receivedText()).toBe('\x1bOA');
});

it('ends a bracketed paste whose end marker Escape arrives as its own read', async () => {
  const attached = await startInInsert(ModeFlag.bracketedPaste);

  attached.type('\x1b[200~hi');
  await separateRead();
  attached.type(escape);
  await separateRead();
  attached.type('[201~');

  await attached.until(() => attached.receivedText().endsWith('\x1b[201~'));
  expect(attached.receivedText()).toBe('\x1b[200~hi\x1b[201~');
});

it('keeps a bracketed paste whose start Escape arrives alone', async () => {
  const attached = await startInInsert(ModeFlag.bracketedPaste);

  await sendEscape(attached);
  attached.type('[200~hi\x1b[201~z');

  await attached.until(() => attached.receivedText().endsWith('z'));
  expect(attached.receivedText()).toBe('\x1b[200~hi\x1b[201~z');
});

it('keeps Alt plus a multibyte character after a plain key in one read', async () => {
  const attached = await startInInsert(0);

  attached.type('x\x1béz');

  await attached.until(() => attached.receivedText().endsWith('z'));
  expect(attached.receivedText()).toBe('x\x1béz');
});

it('sends an application arrow delivered in three reads as one key', async () => {
  const attached = await startInInsert(ModeFlag.applicationCursorKeys);

  await sendEscape(attached);
  attached.type('[');
  await separateRead();
  attached.type('A');

  await attached.until(() => attached.receivedText().length >= 3);
  expect(attached.receivedText()).toBe('\x1bOA');
});

it('keeps palette color replies out of the pane when the terminal has no truecolor', async () => {
  const attached = await setupAttach(0, { truecolor: false });

  await attached.until(() => attached.statusBar() === 'INSERT');
  await attached.until(() => attached.repliesText().includes('\x1b]4;15;'));
  attached.type('x');
  await attached.until(() => attached.receivedText().endsWith('x'));

  expect(attached.receivedText()).toBe('x');
});
