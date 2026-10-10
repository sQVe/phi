import type { InputMode } from '../client/client.ts';
import { ModeFlag } from '../rows/rows.ts';

interface TokenRouterHost {
  mode: () => InputMode;
  setMode: (mode: InputMode) => void;
  modes: () => number;
  send: (bytes: Uint8Array) => void;
}

type RoutedToken =
  | { kind: 'key'; raw: string; escapeSent: boolean }
  | { kind: 'paste'; bytes: Uint8Array; escapeSent: boolean };

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

// A token with escapeSent continues an Escape that the tokenizer already sent on. Its first routed
// byte is that Escape, so it is dropped, but only when the Escape really reached the pane: normal
// mode consumes an Escape. When the pane does not ask for bracketed paste, the pane keeps the stray
// Escape and gets the bare paste. A terminal reply that arrives split after a lone Escape cannot
// take that Escape back either.
export const createInputRouter = (host: TokenRouterHost): ((token: RoutedToken) => void) => {
  let escapeInPane = false;

  const withoutSentEscape = (bytes: Uint8Array, escapeSent: boolean): Uint8Array =>
    escapeSent && escapeInPane ? bytes.subarray(1) : bytes;

  return (token) => {
    if (token.kind === 'paste') {
      const routed = routePaste(token.bytes, host.modes());
      const wrapped = routed.length > token.bytes.length;

      host.send(wrapped ? withoutSentEscape(routed, token.escapeSent) : routed);
      escapeInPane = false;

      return;
    }

    const routed = routeKey(token.raw, host.mode(), host.modes());

    host.send(withoutSentEscape(routed.bytes, token.escapeSent));
    host.setMode(routed.mode);
    escapeInPane = token.raw === escapeKey && routed.bytes.length > 0;
  };
};
