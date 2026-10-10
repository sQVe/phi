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

// The reads of an open paste stay separate until it ends, so a long paste is copied once.
interface Paste {
  parts: Uint8Array[];
  length: number;
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

// Input is a key unless it has the exact shape of a reply to a query OpenTUI 0.5.17 writes, from
// its native setup or its palette detection. Only these shapes go to OpenTUI; every other complete
// sequence goes to the pane as a key.
//   OSC 4: palette color replies (`ESC]4;n;?`). OSC 10 to 19: special color replies.
//   OSC 99: the notification capability reply. OSC 1337: the iTerm2 capabilities reply.
//   DCS 1+r and 0+r: XTGETTCAP replies. DCS >|: the XTVERSION reply.
//   APC G: the Kitty graphics query reply.
const stringReplyPrefixes = new Map<number, string[]>([
  [
    byteOf(']'),
    ['4;', '10;', '11;', '12;', '13;', '14;', '15;', '16;', '17;', '18;', '19;', '99;', '1337;'],
  ],
  [byteOf('P'), ['1+r', '0+r', '>|']],
  [byteOf('_'), ['G']],
]);

// A complete body, without the introducer and the terminator:
//   OSC 4 and OSC 10 to 19: a color value, `rgb:` and three hex groups of one to four digits, or
//   `#` and six hex digits. OSC 4 has the palette index before it.
//   OSC 99: `99;` and printable text. OSC 1337: `Capabilities=` and printable text.
//   DCS 1+r and 0+r: hex-encoded names, with an optional `=` and hex-encoded value.
//   DCS >|: the terminal name and version as printable text.
//   APC G: `Gi=` an image id, `;` and printable text.
const stringReplyBodies = new Map<number, RegExp[]>([
  [
    byteOf(']'),
    [
      /^(?:4;[0-9]{1,3}|1[0-9]);(?:rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}|#[0-9a-f]{6})$/i,
      /^99;[\x20-\x7e]+$/,
      /^1337;Capabilities=[\x20-\x7e]*$/,
    ],
  ],
  [byteOf('P'), [/^[01]\+r(?:[0-9a-f]*(?:=[0-9a-f]*)?)$/i, /^>\|[\x20-\x7e]+$/]],
  [byteOf('_'), [/^Gi=[0-9]+;[\x20-\x7e]+$/]],
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

const joinParts = (parts: Uint8Array[], length: number): Uint8Array => {
  const joined = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    joined.set(part.subarray(0, length - offset), offset);
    offset += Math.min(part.length, length - offset);
  }

  return joined;
};

// The last bytes of the open paste that could start an end marker the next read finishes.
const pasteTail = (open: Paste): Uint8Array => {
  const tailLength = Math.min(open.length, pasteEnd.length - 1);
  const tail = new Uint8Array(tailLength);
  let filled = 0;

  for (let index = open.parts.length - 1; filled < tailLength; index -= 1) {
    const part = open.parts[index] ?? new Uint8Array();
    const taken = Math.min(part.length, tailLength - filled);

    tail.set(part.subarray(part.length - taken), tailLength - filled - taken);
    filled += taken;
  }

  return tail;
};

const onlyReplies = (tokens: InputToken[]): boolean =>
  tokens.length > 0 && tokens.every((token) => token.kind === 'response');

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

const isCompleteReply = (introducer: number, body: string): boolean =>
  (stringReplyBodies.get(introducer) ?? []).some((shape) => shape.test(body));

// The end of the string terminator at index, or undefined when there is none.
const terminatorEnd = (input: Uint8Array, index: number): number | undefined => {
  if (input[index] === bell) {
    return index + 1;
  }

  return input[index] === escape && input[index + 1] === backslash ? index + 2 : undefined;
};

const scanStringSequence = (input: Uint8Array, start: number): Scanned | undefined => {
  const introducer = input[start + 1] ?? 0;
  const notReply: Scanned = { kind: 'key', end: start + 2 };
  const decoder = new TextDecoder();

  for (let index = start + 2; index < input.length; index += 1) {
    const body = decoder.decode(input.subarray(start + 2, index));

    const keepsWaiting =
      matchesReplyPrefix(introducer, body) && index - start - 2 <= maxReplyBodyBytes;

    if (!keepsWaiting) {
      return notReply;
    }

    const end = terminatorEnd(input, index);

    if (end !== undefined) {
      return isCompleteReply(introducer, body) ? { kind: 'response', end } : notReply;
    }

    if (input[index] === escape) {
      return index + 1 >= input.length ? undefined : notReply;
    }
  }

  const unfinished = decoder.decode(input.subarray(start + 2));
  const fits = input.length - start - 2 <= maxReplyBodyBytes;

  return fits && matchesReplyPrefix(introducer, unfinished) ? undefined : notReply;
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
    const tail = pasteTail(open);
    const window = concat(tail, input);
    const end = indexOfPasteEnd(window, 0);

    if (end === -1) {
      open.parts.push(input.slice());
      open.length += input.length;

      return undefined;
    }

    const bodyLength = open.length - tail.length + end;
    const bytes = joinParts([...open.parts, input], bodyLength);

    tokens.push({ kind: 'paste', bytes, escapeSent: open.escapeSent });
    paste = undefined;

    return window.slice(end + pasteEnd.length);
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
      paste = { parts: [], length: 0, escapeSent };
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
      const bytes = joinParts(paste.parts, paste.length);

      tokens.push({ kind: 'paste', bytes, escapeSent: paste.escapeSent });
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
    const sentEscapeAt = escapeSentAt;
    const before = tokens.length;

    run(input, continues || resumes, nowMs, false, tokens);

    if (wasHolding && held.length === input.length) {
      heldAt = previousHeldAt;
    }

    // A terminal reply can arrive between a lone Escape and the rest of its key.
    if (onlyReplies(tokens.slice(before)) && held.length === 0) {
      escapeSentAt = sentEscapeAt;
    }

    return tokens;
  };

  return { push, expire, holding: () => held.length > 0 || paste !== undefined };
};
