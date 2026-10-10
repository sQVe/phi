import { expect, it } from 'bun:test';

import { ModeFlag } from '../src/rows/rows.ts';
import { setupAttach } from './attachHarness.ts';

it('shows the input mode in the status bar as the keys change it', async () => {
  const { statusBar, type, until } = await setupAttach(0);

  await until(() => statusBar() === 'INSERT');

  type('\x02');

  await until(() => statusBar() === 'NORMAL');

  type('i');

  await until(() => statusBar() === 'INSERT');
});

it('sends a bracketed paste with markers when the pane asks for them', async () => {
  const { statusBar, type, receivedText, until } = await setupAttach(ModeFlag.bracketedPaste);

  await until(() => statusBar() === 'INSERT');

  type('\x1b[200~one\ntwo\x1b[201~');

  await until(() => receivedText().endsWith('\x1b[201~'));
  expect(receivedText()).toBe('\x1b[200~one\ntwo\x1b[201~');
});

it('sends a paste without markers when the pane does not ask for them', async () => {
  const { statusBar, type, receivedText, until } = await setupAttach(0);

  await until(() => statusBar() === 'INSERT');

  type('\x1b[200~one\ntwo\x1b[201~');

  await until(() => receivedText().length >= 'one\ntwo'.length);
  expect(receivedText()).toBe('one\ntwo');
});
