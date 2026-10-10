import { expect, it } from 'bun:test';

import { clientId, paneId } from '../ids.ts';
import type { Snapshot } from '../store/store.ts';
import { answerHello, encodeControl, parseControl } from './protocol.ts';
import type { ControlMessage } from './protocol.ts';

const build = { version: '1.2.3', ghostty: 'abc123' };

const text = (value: string) => new TextEncoder().encode(value);

const parseMessage = (bytes: Uint8Array): ControlMessage => {
  const result = parseControl(bytes);

  if (!result.ok) {
    throw new Error(`Expected a message, got ${result.reason}.`);
  }

  return result.message;
};

it('round-trips a hello with a version and a terminal size', () => {
  const hello: ControlMessage = { type: 'hello', version: build, size: { columns: 80, rows: 24 } };

  const bytes = encodeControl(hello);

  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(hello);
  expect(parseControl(bytes)).toEqual({ ok: true, message: hello });
});

const pane = {
  id: paneId(1),
  lifecycle: 'running' as const,
  size: { columns: 80, rows: 23 },
  generation: 1,
  exitCode: undefined,
};

const theme = {
  foreground: 0x11_22_33,
  background: 0xdd_ee_ff,
  palette: Array.from({ length: 16 }, (_, index) => index * 0x01_01_01),
};

const client = { id: clientId(2), size: { columns: 80, rows: 24 }, theme: undefined };

const themedClient = { ...client, theme };

const messages: ControlMessage[] = [
  { type: 'hello', version: build, size: undefined },
  { type: 'welcome' },
  { type: 'refused', client: build, server: { version: '1.2.4', ghostty: 'def456' } },
  { type: 'detach' },
  { type: 'stop' },
  { type: 'resize', size: { columns: 120, rows: 40 } },
  { type: 'theme', theme },
  { type: 'ack', sequence: 7 },
  { type: 'resync' },
  {
    type: 'snapshot',
    snapshot: { revision: 3, pane, attachedClientId: client.id, clients: [client] },
  },
  {
    type: 'snapshot',
    snapshot: { revision: 0, pane: undefined, attachedClientId: undefined, clients: [] },
  },
  { type: 'change', revision: 1, change: { type: 'paneAdded', pane } },
  {
    type: 'change',
    revision: 2,
    change: { type: 'paneStateChanged', paneId: pane.id, lifecycle: 'exited', exitCode: 1 },
  },
  {
    type: 'change',
    revision: 3,
    change: { type: 'paneResized', paneId: pane.id, size: { columns: 100, rows: 30 } },
  },
  { type: 'change', revision: 4, change: { type: 'clientAttached', client } },
  {
    type: 'change',
    revision: 5,
    change: { type: 'clientResized', clientId: client.id, size: { columns: 90, rows: 20 } },
  },
  {
    type: 'change',
    revision: 6,
    change: { type: 'clientDetached', clientId: client.id, reason: 'takenOver' },
  },
  { type: 'change', revision: 7, change: { type: 'serverStopping' } },
  { type: 'change', revision: 8, change: { type: 'clientAttached', client: themedClient } },
  {
    type: 'change',
    revision: 9,
    change: { type: 'clientThemeChanged', clientId: client.id, theme },
  },
  { type: 'takenOver' },
  { type: 'paneRead', paneId: pane.id },
  { type: 'paneRows', paneId: pane.id, rows: ['$ ls', ''] },
  { type: 'paneSend', paneId: pane.id, text: 'ls\r' },
  { type: 'paneSent', paneId: pane.id },
  { type: 'paneMissing', paneId: paneId(9) },
];

const nameOf = (message: ControlMessage): string => {
  if (message.type === 'change') {
    return `change ${message.change.type}`;
  }

  if (message.type === 'snapshot' && message.snapshot.pane === undefined) {
    return 'snapshot without a pane';
  }

  return message.type;
};

for (const message of messages) {
  it(`round-trips ${nameOf(message)}`, () => {
    expect(parseControl(encodeControl(message))).toStrictEqual({ ok: true, message });
  });
}

it.each([
  ['a resize to the largest size', { type: 'resize', size: { columns: 65_535, rows: 65_535 } }],
  ['an ack of the largest sequence', { type: 'ack', sequence: 0xff_ff_ff_ff }],
] as const)('round-trips %s', (_name, message) => {
  expect(parseControl(encodeControl(message))).toStrictEqual({ ok: true, message });
});

it.each([
  ['a missing field', '{"type":"resize"}'],
  [
    'a theme palette with 15 colors',
    JSON.stringify({ type: 'theme', theme: { ...theme, palette: theme.palette.slice(1) } }),
  ],
  [
    'a theme palette with 17 colors',
    JSON.stringify({ type: 'theme', theme: { ...theme, palette: [...theme.palette, 0] } }),
  ],
  [
    'a theme color past 0xffffff',
    JSON.stringify({ type: 'theme', theme: { ...theme, foreground: 0x1_00_00_00 } }),
  ],
  ['a wrong type', '{"type":"ack","sequence":"7"}'],
  ['a fractional number', '{"type":"ack","sequence":1.5}'],
  ['an unknown type', '{"type":"shout"}'],
  ['no type', '{"size":{"columns":80,"rows":24}}'],
  ['a size of zero', '{"type":"resize","size":{"columns":0,"rows":24}}'],
  ['more columns than 65535', '{"type":"resize","size":{"columns":65536,"rows":24}}'],
  ['more rows than 65535', '{"type":"resize","size":{"columns":80,"rows":65536}}'],
  [
    'a hello size past 65535',
    '{"type":"hello","version":{"version":"1.2.3","ghostty":"abc123"},"size":{"columns":65536,"rows":24}}',
  ],
  ['an ack sequence past 32 bits', '{"type":"ack","sequence":4294967296}'],
  ['a negative ack sequence', '{"type":"ack","sequence":-1}'],
  ['a malformed pane id', '{"type":"paneRead","paneId":"pane-01"}'],
  ['a pane id past the safe integers', '{"type":"paneRead","paneId":"pane-9007199254740993"}'],
  ['a client id as a pane id', '{"type":"paneRead","paneId":"client-1"}'],
  ['a JSON value that is not an object', '"hello"'],
])('refuses a message with %s', (_name, json) => {
  expect(parseControl(text(json))).toEqual({ ok: false, reason: 'invalidMessage' });
});

it.each([
  ['cut-off JSON', '{"type":'],
  ['no bytes', ''],
])('refuses %s', (_name, json) => {
  expect(parseControl(text(json))).toEqual({ ok: false, reason: 'invalidJson' });
});

it('refuses bytes that are not UTF-8', () => {
  expect(parseControl(Uint8Array.of(0x7b, 0xff, 0x7d))).toEqual({
    ok: false,
    reason: 'invalidText',
  });
});

it('welcomes a hello from the same build', () => {
  const hello = { type: 'hello' as const, version: { ...build }, size: undefined };

  expect(answerHello(build, hello)).toEqual({ type: 'welcome' });
});

it.each([
  ['version', { version: '1.2.4', ghostty: build.ghostty }],
  ['Ghostty commit', { version: build.version, ghostty: 'def456' }],
])('refuses a hello with another %s and names both versions', (_name, version) => {
  const hello = { type: 'hello' as const, version, size: { columns: 80, rows: 24 } };

  expect(answerHello(build, hello)).toEqual({ type: 'refused', client: version, server: build });
});

it('parses a snapshot into ids the store accepts', () => {
  const sent: Snapshot = {
    revision: 2,
    pane: { ...pane, id: paneId(4) },
    attachedClientId: clientId(5),
    clients: [{ id: clientId(5), size: { columns: 80, rows: 24 }, theme: undefined }],
  };

  const message = parseMessage(encodeControl({ type: 'snapshot', snapshot: sent }));

  if (message.type !== 'snapshot') {
    throw new Error(`Expected a snapshot, got ${message.type}.`);
  }

  const received: Snapshot = message.snapshot;

  expect(received.pane?.id).toBe(paneId(4));
  expect(received.attachedClientId).toBe(clientId(5));
  expect(received).toStrictEqual(sent);
});
