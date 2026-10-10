export type InputToken =
  | { kind: 'key'; raw: string; escapeSent: boolean }
  | { kind: 'paste'; bytes: Uint8Array; escapeSent: boolean }
  | { kind: 'response'; bytes: Uint8Array };

export interface InputTokenizer {
  push: (bytes: Uint8Array, nowMs: number) => InputToken[];
  // Releases input held longer than the hold window as keys.
  expire: (nowMs: number) => InputToken[];
  holding: () => boolean;
}

interface Paste {
  bytes: Uint8Array;
  escapeSent: boolean;
}

type Scanned =
  | { kind: 'key'; end: number }
  | { kind: 'response'; end: number }
  | { kind: 'pasteStart'; end: number }
  | { kind: 'skip'; end: number };

const byteOf = (character: string): number => character.codePointAt(0) ?? 0;

const escape = byteOf('\x1b');
const bell = byteOf('\x07');
const backslash = byteOf('\\');
const leftBracket = byteOf('[');
const upperO = byteOf('O');
const linuxFunctionLength = 3;

const bytesOf = (text: string): number[] =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));

const linuxFunctionFinals = new Set(bytesOf('ABCDE'));

const holdWindowMs = 50;

// Input is a key unless it has the exact shape of a reply to a query OpenTUI 0.5.17 writes at
// startup (see the writes in the renderer's setup). Only these shapes go to OpenTUI; every other
// complete sequence goes to the pane as a key.
//   OSC 10 and 11: foreground and background color replies (`ESC]10;?` and `ESC]11;?`).
//   OSC 99: the notification capability reply. OSC 1337: the iTerm2 capabilities reply.
//   DCS 1+r and 0+r: XTGETTCAP replies. DCS >|: the XTVERSION reply.
//   APC G: the Kitty graphics query reply.
const stringReplyPrefixes = new Map<number, string[]>([
  [byteOf(']'), ['10;', '11;', '99;', '1337;']],
  [byteOf('P'), ['1+r', '0+r', '>|']],
  [byteOf('_'), ['G']],
]);

//   CSI ? Ps ; Pm $ y: DECRQM replies. CSI ? flags u: the Kitty keyboard flags reply.
//   CSI ? ... c: the device attributes reply. CSI 4 ; h ; w t: the pixel size reply.
//   CSI row ; col R: the cursor position report. It looks like Shift+F3 (ESC[1;2R) when the row
//   is 1, and OpenTUI asks for the position at startup, so modified F3 is lost.
//   CSI I and CSI O: focus reports, which OpenTUI turns on with mode 1004.
//   CSI ? 997 ; 1 n and 2 n: color scheme reports, which OpenTUI turns on with mode 2031.
const csiReplyShapes = [
  /^\?[0-9;:]*\$y$/,
  /^\?[0-9]*u$/,
  /^\?[0-9;]*c$/,
  /^4;[0-9]+;[0-9]+t$/,
  /^[0-9]+;[0-9]+R$/,
  /^[IO]$/,
  /^\?997;[12]n$/,
];

// The longest reply body worth waiting for. Kitty and iTerm2 capability replies stay far below it.
const maxReplyBodyBytes = 512;

// A paste with no end marker is emitted after this long without a new byte. It is long enough for
// a large paste over a slow link.
const pasteWindowMs = 1000;

const pasteStartParams = '200';
const pasteEnd = Uint8Array.from(bytesOf('\x1b[201~'));

// OpenTUI waits this long before it reports a lone Escape. A sequence that continues inside the
// window is still one key.
const escapeWindowMs = 20;

const maxCsiBytes = 64;

const isBetween = (value: number, low: string, high: string): boolean =>
  value >= byteOf(low) && value <= byteOf(high);

const continuationMin = 0x80;
const continuationMax = 0xbf;

const isContinuation = (value: number): boolean =>
  value >= continuationMin && value <= continuationMax;

const threeByteLead = 0xe0;
const fourByteLead = 0xf0;
const maxLead = 0xf4;
const minLead = 0xc2;
const threeBytes = 3;
const ss3Length = 3;
const fourBytes = 4;

const characterLength = (lead: number): number => {
  if (lead < minLead || lead > maxLead) {
    return 0;
  }

  if (lead < threeByteLead) {
    return 2;
  }

  return lead < fourByteLead ? threeBytes : fourBytes;
};

const concat = (first: Uint8Array, second: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(first.length + second.length);

  joined.set(first);
  joined.set(second, first.length);

  return joined;
};

const indexOfPasteEnd = (bytes: Uint8Array, from: number): number => {
  for (let index = from; index + pasteEnd.length <= bytes.length; index += 1) {
    if (pasteEnd.every((expected, offset) => bytes[index + offset] === expected)) {
      return index;
    }
  }

  return -1;
};

// Length of the UTF-8 character at start, 0 when the bytes are not UTF-8, or undefined when the
// character is cut off at the end of the input.
const scanCharacter = (input: Uint8Array, start: number): number | undefined => {
  const length = characterLength(input[start] ?? 0);

  if (length === 0) {
    return 0;
  }

  for (let offset = 1; offset < length; offset += 1) {
    const next = input[start + offset];

    if (next === undefined) {
      return undefined;
    }

    if (!isContinuation(next)) {
      return 0;
    }
  }

  return length;
};

// Whether the body so far can still become a reply: it is a prefix of a known reply start, or it
// starts with one.
const matchesReplyPrefix = (introducer: number, body: string): boolean =>
  (stringReplyPrefixes.get(introducer) ?? []).some(
    (prefix) => prefix.startsWith(body) || body.startsWith(prefix),
  );

const scanStringSequence = (input: Uint8Array, start: number): Scanned | undefined => {
  const introducer = input[start + 1] ?? 0;
  const notReply: Scanned = { kind: 'key', end: start + 2 };

  for (let index = start + 2; index < input.length; index += 1) {
    const byte = input[index];
    const body = new TextDecoder().decode(input.subarray(start + 2, index));
    const stillReply = matchesReplyPrefix(introducer, body);
    const tooLong = index - start - 2 > maxReplyBodyBytes;

    if (!stillReply || tooLong) {
      return notReply;
    }

    if (byte === bell) {
      return { kind: 'response', end: index + 1 };
    }

    if (byte === escape && index + 1 >= input.length) {
      return undefined;
    }

    if (byte === escape) {
      return input[index + 1] === backslash ? { kind: 'response', end: index + 2 } : notReply;
    }
  }

  const unfinished = new TextDecoder().decode(input.subarray(start + 2));

  return matchesReplyPrefix(introducer, unfinished) ? undefined : notReply;
};

const classifyCsi = (
  input: Uint8Array,
  start: number,
  final: number,
): 'key' | 'response' | 'pasteStart' => {
  const body = new TextDecoder().decode(input.subarray(start + 2, final + 1));

  if (body === `${pasteStartParams}~`) {
    return 'pasteStart';
  }

  return csiReplyShapes.some((shape) => shape.test(body)) ? 'response' : 'key';
};

const scanCsi = (input: Uint8Array, start: number, from = start + 2): Scanned | undefined => {
  for (let index = from; index < input.length; index += 1) {
    const byte = input[index] ?? 0;

    if (isBetween(byte, '@', '~')) {
      return { kind: classifyCsi(input, start, index), end: index + 1 };
    }

    if (!isBetween(byte, ' ', '?') || index - from > maxCsiBytes) {
      return { kind: 'key', end: start + 2 };
    }
  }

  return undefined;
};

// The Linux console sends F1 to F5 as ESC[[A to ESC[[E, and ESC[[5~ is a key with a second bracket
// as a prefix. The second bracket would read as a CSI final.
const scanBracket = (input: Uint8Array, start: number): Scanned | undefined => {
  if (input[start + 2] !== leftBracket) {
    return scanCsi(input, start);
  }

  const final = input[start + linuxFunctionLength];

  if (final === undefined) {
    return undefined;
  }

  return linuxFunctionFinals.has(final)
    ? { kind: 'key', end: start + linuxFunctionLength + 1 }
    : scanCsi(input, start, start + linuxFunctionLength);
};

// The first token of input that cannot finish, cut short: an Escape pair as an Alt key, a cut
// character dropped.
const releaseFirst = (input: Uint8Array, start: number): Scanned => {
  if (input[start] !== escape) {
    return { kind: 'skip', end: input.length };
  }

  const startsCharacter = characterLength(input[start + 1] ?? 0) > 0;

  return { kind: 'key', end: start + (startsCharacter ? 1 : 2) };
};

const scanSs3 = (input: Uint8Array, start: number): Scanned | undefined => {
  const next = input[start + 2];

  if (next === undefined) {
    return undefined;
  }

  return { kind: 'key', end: isBetween(next, '@', '~') ? start + ss3Length : start + 2 };
};

const scanAlt = (input: Uint8Array, start: number): Scanned | undefined => {
  const next = input[start + 1] ?? 0;
  const length = characterLength(next);

  if (length === 0) {
    return { kind: 'key', end: start + 2 };
  }

  const character = scanCharacter(input, start + 1);

  if (character === undefined) {
    return undefined;
  }

  return { kind: 'key', end: character === 0 ? start + 1 : start + 1 + character };
};

const scanEscape = (input: Uint8Array, start: number): Scanned | undefined => {
  const next = input[start + 1];

  if (next === undefined || next === escape) {
    return { kind: 'key', end: start + 1 };
  }

  if (next === leftBracket) {
    return scanBracket(input, start);
  }

  if (next === upperO) {
    return scanSs3(input, start);
  }

  return stringReplyPrefixes.has(next) ? scanStringSequence(input, start) : scanAlt(input, start);
};

const scanToken = (input: Uint8Array, start: number): Scanned | undefined => {
  if (input[start] === escape) {
    return scanEscape(input, start);
  }

  const length = scanCharacter(input, start);

  if (length === undefined) {
    return undefined;
  }

  return length === 0 && (input[start] ?? 0) >= byteOf('\x80')
    ? { kind: 'skip', end: start + 1 }
    : { kind: 'key', end: start + Math.max(length, 1) };
};

export const createInputTokenizer = (): InputTokenizer => {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let held = new Uint8Array();
  let heldEscapeSent = false;
  let heldAt = 0;
  let escapeSentAt: number | undefined;
  let paste: Paste | undefined;
  let pasteAt = 0;

  const continuesSentEscape = (bytes: Uint8Array, nowMs: number): boolean => {
    const first = bytes[0];

    const startsSequence =
      first === leftBracket || first === upperO || stringReplyPrefixes.has(first ?? 0);

    const inWindow = escapeSentAt !== undefined && nowMs - escapeSentAt < escapeWindowMs;

    return held.length === 0 && startsSequence && inWindow;
  };

  // Adds the input to the open paste. Returns what follows the end marker, or undefined while the
  // paste is still open.
  const feedPaste = (
    open: Paste,
    input: Uint8Array,
    tokens: InputToken[],
    nowMs: number,
  ): Uint8Array | undefined => {
    pasteAt = nowMs;
    const searchFrom = Math.max(0, open.bytes.length - pasteEnd.length + 1);

    open.bytes = concat(open.bytes, input);

    const end = indexOfPasteEnd(open.bytes, searchFrom);

    if (end === -1) {
      return undefined;
    }

    tokens.push({ kind: 'paste', bytes: open.bytes.slice(0, end), escapeSent: open.escapeSent });
    paste = undefined;

    return open.bytes.slice(end + pasteEnd.length);
  };

  const emit = (
    tokens: InputToken[],
    scanned: Scanned,
    text: Uint8Array,
    escapeSent: boolean,
    atEnd: boolean,
    nowMs: number,
  ): void => {
    if (scanned.kind === 'key') {
      tokens.push({ kind: 'key', raw: decoder.decode(text), escapeSent });

      if (text.length === 1 && text[0] === escape && atEnd) {
        escapeSentAt = nowMs;
      }
    }

    if (scanned.kind === 'response') {
      tokens.push({ kind: 'response', bytes: text.slice() });
    }

    if (scanned.kind === 'pasteStart') {
      paste = { bytes: new Uint8Array(), escapeSent };
      pasteAt = nowMs;
    }
  };

  // release makes the first token leave even when it is cut off.
  const run = (
    start: Uint8Array,
    startEscapeSent: boolean,
    nowMs: number,
    release: boolean,
    tokens: InputToken[],
  ): void => {
    let input = start;
    let escapeSent = startEscapeSent;
    let index = 0;

    held = new Uint8Array();
    heldEscapeSent = false;
    escapeSentAt = undefined;

    while (index < input.length) {
      if (paste !== undefined) {
        const rest = feedPaste(paste, input.subarray(index), tokens, nowMs);

        if (rest === undefined) {
          break;
        }

        input = rest;
        index = 0;

        continue;
      }

      const scanned = scanToken(input, index);
      const mustRelease = release && index === 0;

      if (scanned === undefined && !mustRelease) {
        held = input.slice(index);
        heldEscapeSent = escapeSent && index === 0;
        heldAt = nowMs;

        break;
      }

      const token =
        scanned ??
        (mustRelease
          ? releaseFirst(input, index)
          : { kind: 'response' as const, end: input.length });

      emit(
        tokens,
        token,
        input.subarray(index, token.end),
        escapeSent,
        token.end === input.length,
        nowMs,
      );

      escapeSent = false;
      index = token.end;
    }
  };

  const heldTooLong = (nowMs: number): boolean => held.length > 0 && nowMs - heldAt >= holdWindowMs;

  const expire = (nowMs: number): InputToken[] => {
    const tokens: InputToken[] = [];

    if (paste !== undefined && nowMs - pasteAt >= pasteWindowMs) {
      tokens.push({ kind: 'paste', bytes: paste.bytes, escapeSent: paste.escapeSent });
      paste = undefined;
    }

    if (!heldTooLong(nowMs)) {
      return tokens;
    }

    const stamp = heldAt;

    run(held, heldEscapeSent, nowMs, true, tokens);

    if (held.length > 0) {
      heldAt = stamp === heldAt ? nowMs : heldAt;
    }

    return tokens;
  };

  const push = (bytes: Uint8Array, nowMs: number): InputToken[] => {
    const tokens = expire(nowMs);
    const continues = continuesSentEscape(bytes, nowMs);
    const resumes = held.length > 0 && heldEscapeSent;
    const previousHeldAt = heldAt;
    const wasHolding = held.length > 0;
    const input = continues ? concat(Uint8Array.of(escape), bytes) : concat(held, bytes);

    run(input, continues || resumes, nowMs, false, tokens);

    if (wasHolding && held.length === input.length) {
      heldAt = previousHeldAt;
    }

    return tokens;
  };

  return { push, expire, holding: () => held.length > 0 || paste !== undefined };
};
