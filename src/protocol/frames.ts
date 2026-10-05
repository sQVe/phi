import { invariant } from '../invariant.ts';

interface Frame {
  kind: FrameKind;
  payload: Uint8Array;
}

type FrameError = { ok: false; reason: 'unknownKind' } | { ok: false; reason: 'tooLarge' };

type PushResult = { ok: true; frames: Frame[] } | FrameError;

type FinishResult = { ok: true } | FrameError | { ok: false; reason: 'truncated' };

interface FrameDecoder {
  push: (bytes: Uint8Array) => PushResult;
  finish: () => FinishResult;
}

export enum FrameKind {
  control = 1,
  rowUpdate = 2,
  input = 3,
}

// 16 MiB. The decoder refuses a longer payload before it allocates one, so a peer cannot make it
// reserve memory for a length it never sends.
export const maxFramePayloadBytes = 0x1_00_00_00;

// A kind byte, then the payload length as a little-endian u32.
const headerBytes = 5;

const frameKinds = new Set<number>([FrameKind.control, FrameKind.rowUpdate, FrameKind.input]);

const isFrameKind = (value: number): value is FrameKind => frameKinds.has(value);

export const encodeFrame = (kind: FrameKind, payload: Uint8Array): Uint8Array => {
  invariant(payload.length <= maxFramePayloadBytes, 'The frame payload is over the limit.');

  const frame = new Uint8Array(headerBytes + payload.length);

  frame[0] = kind;
  new DataView(frame.buffer).setUint32(1, payload.length, true);
  frame.set(payload, headerBytes);

  return frame;
};

// Splits a byte stream into frames. Each payload is a copy, so it stays valid after later pushes.
// After an error the decoder is stopped and returns that error for every later call.
export const createFrameDecoder = (): FrameDecoder => {
  const header = new Uint8Array(headerBytes);
  let headerFilled = 0;
  let kind = FrameKind.control;
  let payload: Uint8Array | undefined;
  let payloadFilled = 0;
  let error: FrameError | undefined;

  // Copies header bytes from the start of bytes and returns how many it took.
  const readHeader = (bytes: Uint8Array): number => {
    const taken = Math.min(headerBytes - headerFilled, bytes.length);

    header.set(bytes.subarray(0, taken), headerFilled);
    headerFilled += taken;

    const headerKind = header[0] ?? 0;

    if (!isFrameKind(headerKind)) {
      error = { ok: false, reason: 'unknownKind' };

      return taken;
    }

    if (headerFilled < headerBytes) {
      return taken;
    }

    const length = new DataView(header.buffer).getUint32(1, true);

    if (length > maxFramePayloadBytes) {
      error = { ok: false, reason: 'tooLarge' };

      return taken;
    }

    kind = headerKind;
    payload = new Uint8Array(length);
    payloadFilled = 0;

    return taken;
  };

  // Copies payload bytes from the start of bytes and returns how many it took.
  const readPayload = (target: Uint8Array, bytes: Uint8Array): number => {
    const taken = Math.min(target.length - payloadFilled, bytes.length);

    target.set(bytes.subarray(0, taken), payloadFilled);
    payloadFilled += taken;

    return taken;
  };

  // Returns the current frame once its payload is full and starts the next one.
  const takeFrame = (): Frame | undefined => {
    if (payload === undefined || payloadFilled < payload.length) {
      return undefined;
    }

    const frame = { kind, payload };

    payload = undefined;
    headerFilled = 0;

    return frame;
  };

  const push = (bytes: Uint8Array): PushResult => {
    const frames: Frame[] = [];
    let offset = 0;

    while (offset < bytes.length) {
      const rest = bytes.subarray(offset);

      offset += payload === undefined ? readHeader(rest) : readPayload(payload, rest);

      if (error !== undefined) {
        break;
      }

      const frame = takeFrame();

      if (frame !== undefined) {
        frames.push(frame);
      }
    }

    return error ?? { ok: true, frames };
  };

  const finish = (): FinishResult => {
    if (error !== undefined) {
      return error;
    }

    const midFrame = headerFilled > 0 || payload !== undefined;

    return midFrame ? { ok: false, reason: 'truncated' } : { ok: true };
  };

  return { push, finish };
};
