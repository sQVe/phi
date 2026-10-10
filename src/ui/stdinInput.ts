import type { CliRenderer } from '@opentui/core';

import { invariant } from '../invariant.ts';
import { createInputTokenizer } from './inputTokens.ts';
import type { InputToken } from './inputTokens.ts';

type StdinListener = (chunk: string | Buffer) => void;

// The renderer's stdinListener is private in @opentui/core 0.5.17. Phi reads stdin itself so that
// OpenTUI's parser never sees a key or a paste: it splits Escape, Alt plus a multibyte character,
// and keys cut across reads wrongly. OpenTUI's listener stays for terminal replies only.
interface OpenTuiInternals {
  stdinListener?: StdinListener;
}

const releaseCheckMs = 25;

// Replaces OpenTUI's stdin listener, hands keys and pastes to onInput, and returns a function that
// puts OpenTUI's listener back.
export const takeStdin = (
  renderer: CliRenderer,
  onInput: (token: Exclude<InputToken, { kind: 'response' }>) => void,
): (() => void) => {
  // SAFETY: the renderer's private field is read as optional and checked before use.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the field is private in OpenTUI's types.
  const openTuiListener = (renderer as unknown as OpenTuiInternals).stdinListener;

  invariant(openTuiListener !== undefined, '@opentui/core no longer has a stdinListener.');

  invariant(
    process.stdin.listeners('data').includes(openTuiListener),
    'OpenTUI has not attached its stdin listener.',
  );

  const tokenizer = createInputTokenizer();

  let timer: ReturnType<typeof setTimeout> | undefined;

  const deliver = (tokens: InputToken[]): void => {
    for (const token of tokens) {
      if (token.kind === 'response') {
        openTuiListener(Buffer.from(token.bytes));
      } else {
        onInput(token);
      }
    }
  };

  // The tokenizer holds a cut-off sequence for a short window. Nothing else reads stdin then, so a
  // timer releases it.
  const scheduleRelease = (): void => {
    clearTimeout(timer);

    if (!tokenizer.holding()) {
      return;
    }

    timer = setTimeout(() => {
      deliver(tokenizer.expire(performance.now()));
      scheduleRelease();
    }, releaseCheckMs);
  };

  const readStdin: StdinListener = (input) => {
    const chunk = typeof input === 'string' ? Buffer.from(input) : input;

    deliver(tokenizer.push(chunk, performance.now()));
    scheduleRelease();
  };

  process.stdin.removeListener('data', openTuiListener);
  process.stdin.on('data', readStdin);

  return () => {
    clearTimeout(timer);
    process.stdin.removeListener('data', readStdin);
    process.stdin.on('data', openTuiListener);
  };
};
