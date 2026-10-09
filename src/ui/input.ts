import type { InputMode } from '../client/client.ts';
import { ModeFlag } from '../rows/rows.ts';

interface KeyRoute {
  bytes: Uint8Array;
  mode: InputMode;
}

const encoder = new TextEncoder();

const nothing = new Uint8Array();

const prefixKey = '\x02';

const escapeKey = '\x1b';

const cursorKeyTails = 'ABCDHF';

const pasteStart = encoder.encode('\x1b[200~');

const pasteEnd = encoder.encode('\x1b[201~');

const hasMode = (modes: number, flag: ModeFlag): boolean => (modes & flag) !== 0;

const encodeInsertKey = (raw: string, modes: number): Uint8Array => {
  const tail = raw.slice(2);
  const isCursorKey = raw.startsWith('\x1b[') && tail.length === 1 && cursorKeyTails.includes(tail);

  if (!isCursorKey || !hasMode(modes, ModeFlag.applicationCursorKeys)) {
    return encoder.encode(raw);
  }

  return encoder.encode(`\x1bO${tail}`);
};

const routeNormalKey = (raw: string): KeyRoute => {
  if (raw === prefixKey) {
    return { bytes: encoder.encode(prefixKey), mode: 'insert' };
  }

  const leavesNormal = raw === 'i' || raw === escapeKey;

  return { bytes: nothing, mode: leavesNormal ? 'insert' : 'normal' };
};

// raw is the key's legacy bytes, so the caller must not turn on Kitty key reporting.
export const routeKey = (raw: string, mode: InputMode, modes: number): KeyRoute => {
  if (mode === 'normal') {
    return routeNormalKey(raw);
  }

  if (raw === prefixKey) {
    return { bytes: nothing, mode: 'normal' };
  }

  return { bytes: encodeInsertKey(raw, modes), mode: 'insert' };
};

export const routePaste = (bytes: Uint8Array, modes: number): Uint8Array => {
  if (!hasMode(modes, ModeFlag.bracketedPaste)) {
    return bytes;
  }

  const wrapped = new Uint8Array(pasteStart.length + bytes.length + pasteEnd.length);

  wrapped.set(pasteStart);
  wrapped.set(bytes, pasteStart.length);
  wrapped.set(pasteEnd, pasteStart.length + bytes.length);

  return wrapped;
};
