import { expect, it } from 'bun:test';

import { createInputTokenizer } from './inputTokens.ts';
import type { InputToken } from './inputTokens.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const describeToken = (token: InputToken): string => {
  if (token.kind === 'key') {
    return `key:${token.raw}${token.escapeSent ? ':sent' : ''}`;
  }

  const text = decoder.decode(token.bytes);

  return token.kind === 'paste'
    ? `paste:${text}${token.escapeSent ? ':sent' : ''}`
    : `response:${text}`;
};

const setup = () => {
  const tokenizer = createInputTokenizer();
  let now = 0;

  const read = (input: string | number[], at = now): string[] => {
    now = at;
    const bytes = typeof input === 'string' ? encoder.encode(input) : Uint8Array.from(input);

    return tokenizer.push(bytes, now).map(describeToken);
  };

  const expire = (at: number): string[] => {
    now = at;

    return tokenizer.expire(now).map(describeToken);
  };

  return { read, expire, holding: () => tokenizer.holding() };
};

it('emits a lone Escape at once', () => {
  const { read } = setup();

  expect(read('\x1b')).toEqual(['key:\x1b']);
});

it('emits a cursor key tail after a lone Escape inside the window as a continuation', () => {
  const { read } = setup();

  read('\x1b', 0);

  expect(read('[Ax', 19)).toEqual(['key:\x1b[A:sent', 'key:x']);
});

it('reads a cursor key tail after a lone Escape outside the window as plain keys', () => {
  const { read } = setup();

  read('\x1b', 0);

  expect(read('[A', 20)).toEqual(['key:[', 'key:A']);
});

it('completes an arrow delivered in three reads as a continuation of the sent Escape', () => {
  const { read } = setup();

  expect(read('\x1b', 0)).toEqual(['key:\x1b']);
  expect(read('[', 1)).toEqual([]);
  expect(read('A', 2)).toEqual(['key:\x1b[A:sent']);
});

it('completes an arrow whose Escape bracket arrive together', () => {
  const { read } = setup();

  expect(read('\x1b[')).toEqual([]);
  expect(read('A')).toEqual(['key:\x1b[A']);
});

it('keeps a paste whose start Escape arrives alone', () => {
  const { read } = setup();

  read('\x1b', 0);

  expect(read('[200~hi\x1b[201~z', 1)).toEqual(['paste:hi:sent', 'key:z']);
});

it('keeps a paste across three reads and an end marker split in two', () => {
  const { read } = setup();

  expect(read('\x1b[200~one')).toEqual([]);
  expect(read('two\x1b')).toEqual([]);
  expect(read('[201')).toEqual([]);
  expect(read('~')).toEqual(['paste:onetwo']);
});

it('keeps Escape and multibyte characters inside a paste', () => {
  const { read } = setup();

  expect(read('\x1b[200~a\x1bé\x1b[Ab\x1b[201~')).toEqual(['paste:a\x1bé\x1b[Ab']);
});

it('keeps Alt plus a multibyte character after a plain key', () => {
  const { read } = setup();

  expect(read('x\x1béz')).toEqual(['key:x', 'key:\x1bé', 'key:z']);
});

it('keeps two Alt keys in one read', () => {
  const { read } = setup();

  expect(read('\x1bé\x1bü')).toEqual(['key:\x1bé', 'key:\x1bü']);
});

it('waits for the rest of a multibyte character', () => {
  const { read } = setup();

  expect(read([0x1b, 0xc3])).toEqual([]);
  expect(read([0xa9])).toEqual(['key:\x1bé']);
  expect(read([0xe2, 0x82])).toEqual([]);
  expect(read([0xac])).toEqual(['key:€']);
});

it('emits Escape plus an ASCII byte as one Alt key', () => {
  const { read } = setup();

  expect(read('\x1bx')).toEqual(['key:\x1bx']);
});

it('emits Escape then a plain key inside the window without joining them', () => {
  const { read } = setup();

  read('\x1b', 0);

  expect(read('x', 1)).toEqual(['key:x']);
});

it('emits modified keys, function keys and Shift+Tab as keys', () => {
  const { read } = setup();

  expect(read('\x1b[1;5A\x1b[3~\x1b[Z\x1bOP\x1b[1;2P')).toEqual([
    'key:\x1b[1;5A',
    'key:\x1b[3~',
    'key:\x1b[Z',
    'key:\x1bOP',
    'key:\x1b[1;2P',
  ]);
});

it('passes terminal replies through as responses', () => {
  const { read } = setup();

  expect(read('\x1b[?62;4c\x1b]11;rgb:0000/0000/0000\x07\x1b[?2004;2$y\x1b[?1u')).toEqual([
    'response:\x1b[?62;4c',
    'response:\x1b]11;rgb:0000/0000/0000\x07',
    'response:\x1b[?2004;2$y',
    'response:\x1b[?1u',
  ]);
});

it('passes a string reply that ends with Escape backslash and waits for a split one', () => {
  const { read } = setup();

  expect(read('\x1bP>|term\x1b')).toEqual([]);
  expect(read('\\a')).toEqual(['response:\x1bP>|term\x1b\\', 'key:a']);
});

it('treats a cursor position report as a response, even when its row is 1', () => {
  const { read } = setup();

  expect(read('\x1b[1;5R\x1b[12;40R')).toEqual(['response:\x1b[1;5R', 'response:\x1b[12;40R']);
});

it('splits Ctrl+B from the keys around it', () => {
  const { read } = setup();

  expect(read('a\x02b')).toEqual(['key:a', 'key:\x02', 'key:b']);
});

it('drops a stray continuation byte', () => {
  const { read } = setup();

  expect(read([0x80, 0x61])).toEqual(['key:a']);
});

it('emits Alt plus a string introducer key that OpenTUI never answers as a key', () => {
  const { read, holding } = setup();

  expect(read('\x1bX')).toEqual(['key:\x1bX']);
  expect(read('\x1b^')).toEqual(['key:\x1b^']);

  expect(read('\x1bXabc\x07z')).toEqual([
    'key:\x1bX',
    'key:a',
    'key:b',
    'key:c',
    'key:\x07',
    'key:z',
  ]);

  expect(holding()).toBe(false);
});

it('holds an introducer that may start a reply only for the hold window, then emits keys', () => {
  const { read, expire, holding } = setup();

  expect(read('\x1b]1', 0)).toEqual([]);
  expect(holding()).toBe(true);
  expect(expire(49)).toEqual([]);
  expect(expire(50)).toEqual(['key:\x1b]', 'key:1']);
  expect(holding()).toBe(false);
});

it('releases a held introducer when the next read arrives after the window', () => {
  const { read } = setup();

  read('\x1bP', 0);

  expect(read('z', 60)).toEqual(['key:\x1bP', 'key:z']);
});

it('releases a held partial sequence and ends a held partial character after the window', () => {
  const { read, expire } = setup();

  expect(read('\x1b[1;', 0)).toEqual([]);
  expect(expire(50)).toEqual(['key:\x1b[', 'key:1', 'key:;']);
  expect(read([0xc3], 100)).toEqual([]);
  expect(expire(150)).toEqual([]);
  expect(read('a', 151)).toEqual(['key:a']);
});

it('sends a split OSC reply whole to OpenTUI after a lone Escape', () => {
  const { read } = setup();

  read('\x1b', 0);

  expect(read(']11;rgb:0000/0000/0000\x07', 1)).toEqual([
    'response:\x1b]11;rgb:0000/0000/0000\x07',
  ]);
});

it('sends split DCS and APC replies whole to OpenTUI after a lone Escape', () => {
  const { read } = setup();

  read('\x1b', 0);

  expect(read('P>|term\x1b\\', 1)).toEqual(['response:\x1bP>|term\x1b\\']);

  read('\x1b', 2);

  expect(read('_Gi=1;OK\x1b\\', 3)).toEqual(['response:\x1b_Gi=1;OK\x1b\\']);
});

it('emits a held Escape introducer after a lone Escape as a continuation key', () => {
  const { read, expire } = setup();

  read('\x1b', 0);
  read(']1', 1);

  expect(expire(60)).toEqual(['key:\x1b]:sent', 'key:1']);
});

it('reads Linux console function keys as keys, also when split', () => {
  const { read } = setup();

  expect(read('\x1b[[A\x1b[[E')).toEqual(['key:\x1b[[A', 'key:\x1b[[E']);
  expect(read('\x1b[[')).toEqual([]);
  expect(read('C')).toEqual(['key:\x1b[[C']);
});

it('keeps a byte order mark character as a key', () => {
  const { read } = setup();

  expect(read('\ufeff')).toEqual(['key:\ufeff']);
  expect(read([0xef, 0xbb])).toEqual([]);
  expect(read([0xbf])).toEqual(['key:\ufeff']);
  expect(read('\x1b\ufeff')).toEqual(['key:\x1b\ufeff']);
});

it('reads unknown complete sequences as keys, complete and split', () => {
  const { read } = setup();

  expect(read('\x1b[a\x1b[d\x1b[2^\x1b[[5~\x1b[0n')).toEqual([
    'key:\x1b[a',
    'key:\x1b[d',
    'key:\x1b[2^',
    'key:\x1b[[5~',
    'key:\x1b[0n',
  ]);

  expect(read('\x1b[')).toEqual([]);
  expect(read('2')).toEqual([]);
  expect(read('^')).toEqual(['key:\x1b[2^']);
  expect(read('\x1b[[')).toEqual([]);
  expect(read('5~')).toEqual(['key:\x1b[[5~']);
});

it('passes every reply OpenTUI asks for as a response', () => {
  const { read } = setup();

  const replies = [
    '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
    '\x1b]99;i=opentui-notifications:p=?;a=focus\x1b\\',
    '\x1b]1337;Capabilities=Tc\x1b\\',
    '\x1bP1+r4d73=1b5d\x1b\\',
    '\x1bP0+r\x1b\\',
    '\x1bP>|kitty(0.30)\x1b\\',
    '\x1b_Gi=31337;OK\x1b\\',
    '\x1b[?1016;2$y',
    '\x1b[?0u',
    '\x1b[?62;c',
    '\x1b[4;600;800t',
    '\x1b[I',
    '\x1b[O',
    '\x1b[?997;1n',
    '\x1b[?997;2n',
  ];

  expect(read(replies.join(''))).toEqual(replies.map((reply) => `response:${reply}`));
});

it('passes a color scheme report split across reads as a response', () => {
  const { read } = setup();

  expect(read('\x1b[?99')).toEqual([]);
  expect(read('7;2nz')).toEqual(['response:\x1b[?997;2n', 'key:z']);
});

it('reads Escape bracket text that is not a reply as an Alt key and its rest', () => {
  const { read, holding } = setup();

  expect(read('\x1b]abc\x07z')).toEqual([
    'key:\x1b]',
    'key:a',
    'key:b',
    'key:c',
    'key:\x07',
    'key:z',
  ]);

  expect(holding()).toBe(false);
  expect(read('\x1b]')).toEqual([]);
  expect(read('a')).toEqual(['key:\x1b]', 'key:a']);
});

it('releases a reply body that is too long or stops matching, without waiting', () => {
  const { read, holding } = setup();
  const long = `\x1b]11;${'a'.repeat(600)}`;

  expect(read(long).slice(0, 2)).toEqual(['key:\x1b]', 'key:1']);
  expect(holding()).toBe(false);
  expect(read('\x1bP>|x')).toEqual([]);
  expect(read('\x1bz')).toEqual(['key:\x1bP', 'key:>', 'key:|', 'key:x', 'key:\x1bz']);
});

it('emits an unfinished paste after the paste window since its last byte', () => {
  const { read, expire, holding } = setup();

  expect(read('\x1b[200~one', 0)).toEqual([]);
  expect(holding()).toBe(true);
  expect(read('two', 900)).toEqual([]);
  expect(expire(1899)).toEqual([]);
  expect(expire(1900)).toEqual(['paste:onetwo']);
  expect(holding()).toBe(false);
  expect(read('x', 1901)).toEqual(['key:x']);
});

it('emits an unfinished paste when a read arrives after the window', () => {
  const { read } = setup();

  read('\x1b[200~hi', 0);

  expect(read('x', 2000)).toEqual(['paste:hi', 'key:x']);
});
