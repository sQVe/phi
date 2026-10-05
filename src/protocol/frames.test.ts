import { expect, it } from 'bun:test';

import { createFrameDecoder, encodeFrame, FrameKind, maxFramePayloadBytes } from './protocol.ts';

const join = (parts: Uint8Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  return bytes;
};

it('decodes two frames joined into one buffer', () => {
  const control = new TextEncoder().encode('{"type":"hello"}');
  const input = Uint8Array.of(1, 0, 0, 0, 0x61);
  const decoder = createFrameDecoder();

  const result = decoder.push(
    join([encodeFrame(FrameKind.control, control), encodeFrame(FrameKind.input, input)]),
  );

  expect(result).toEqual({
    ok: true,
    frames: [
      { kind: FrameKind.control, payload: control },
      { kind: FrameKind.input, payload: input },
    ],
  });
});

const threeFrames = () => [
  { kind: FrameKind.control, payload: new TextEncoder().encode('{"type":"resize"}') },
  { kind: FrameKind.rowUpdate, payload: Uint8Array.from({ length: 40 }, (_, index) => index) },
  { kind: FrameKind.input, payload: new Uint8Array(0) },
];

const encodeAll = (frames: { kind: FrameKind; payload: Uint8Array }[]) =>
  join(frames.map((frame) => encodeFrame(frame.kind, frame.payload)));

const header = (kind: number, length: number) => {
  const bytes = new Uint8Array(5);

  bytes[0] = kind;
  new DataView(bytes.buffer).setUint32(1, length, true);

  return bytes;
};

it('decodes three frames split at every byte boundary', () => {
  const frames = threeFrames();
  const stream = encodeAll(frames);

  for (let split = 0; split <= stream.length; split++) {
    const decoder = createFrameDecoder();
    const first = decoder.push(stream.subarray(0, split));
    const second = decoder.push(stream.subarray(split));
    const decoded = [first, second].flatMap((result) => (result.ok ? result.frames : []));

    expect(first.ok && second.ok).toBe(true);
    expect(decoded).toEqual(frames);
    expect(decoder.finish()).toEqual({ ok: true });
  }
});

it('decodes three frames pushed one byte at a time', () => {
  const frames = threeFrames();
  const stream = encodeAll(frames);
  const decoder = createFrameDecoder();
  const decoded = [];

  for (const byte of stream) {
    const result = decoder.push(Uint8Array.of(byte));

    expect(result.ok).toBe(true);
    decoded.push(...(result.ok ? result.frames : []));
  }

  expect(decoded).toEqual(frames);
});

it('keeps a payload intact after its input buffer changes', () => {
  const stream = encodeAll(threeFrames());
  const decoder = createFrameDecoder();
  const result = decoder.push(stream);

  stream.fill(0);

  expect(result).toEqual({ ok: true, frames: threeFrames() });
});

it('returns truncated when the stream ends in the middle of a frame', () => {
  const stream = encodeAll(threeFrames());
  const half = Math.floor(stream.length / 2);

  for (const end of [1, 4, 5, half]) {
    const decoder = createFrameDecoder();

    decoder.push(stream.subarray(0, end));

    expect(decoder.finish()).toEqual({ ok: false, reason: 'truncated' });
  }
});

it('finishes without an error after whole frames', () => {
  const decoder = createFrameDecoder();

  decoder.push(encodeAll(threeFrames()));

  expect(decoder.finish()).toEqual({ ok: true });
});

it('finishes without an error when no bytes arrived', () => {
  expect(createFrameDecoder().finish()).toEqual({ ok: true });
});

it('refuses a length above the limit and stops', () => {
  const decoder = createFrameDecoder();
  const tooLarge = { ok: false, reason: 'tooLarge' } as const;

  expect(decoder.push(header(FrameKind.rowUpdate, maxFramePayloadBytes + 1))).toEqual(tooLarge);
  expect(decoder.push(encodeAll(threeFrames()))).toEqual(tooLarge);
  expect(decoder.finish()).toEqual(tooLarge);
});

it('accepts a length at the limit', () => {
  const decoder = createFrameDecoder();

  expect(decoder.push(header(FrameKind.rowUpdate, maxFramePayloadBytes))).toEqual({
    ok: true,
    frames: [],
  });

  expect(decoder.finish()).toEqual({ ok: false, reason: 'truncated' });
});

it('refuses the largest u32 length', () => {
  const decoder = createFrameDecoder();

  expect(decoder.push(header(FrameKind.control, 0xff_ff_ff_ff))).toEqual({
    ok: false,
    reason: 'tooLarge',
  });
});

it('refuses an unknown kind from its first byte and stops', () => {
  const decoder = createFrameDecoder();
  const unknownKind = { ok: false, reason: 'unknownKind' } as const;

  expect(decoder.push(Uint8Array.of(0))).toEqual(unknownKind);
  expect(decoder.push(encodeAll(threeFrames()))).toEqual(unknownKind);
  expect(decoder.finish()).toEqual(unknownKind);
});

it('refuses an unknown kind after valid frames', () => {
  const decoder = createFrameDecoder();
  const stream = join([encodeAll(threeFrames()), header(99, 0)]);

  expect(decoder.push(stream)).toEqual({ ok: false, reason: 'unknownKind' });
});
