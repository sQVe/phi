import { encodeControl, encodeFrame, FrameKind } from '../protocol/protocol.ts';

type StopResult = { ok: true; close: () => void } | { ok: false; reason: 'noServer' };

// Sends stop without a handshake, so it reaches a server of any build.
export const sendStop = async (socketPath: string): Promise<StopResult> => {
  let socket: Bun.Socket;

  try {
    socket = await Bun.connect({ unix: socketPath, socket: { data: () => undefined } });
  } catch {
    return { ok: false, reason: 'noServer' };
  }

  socket.write(encodeFrame(FrameKind.control, encodeControl({ type: 'stop' })));

  return {
    ok: true,
    close: () => {
      socket.end();
    },
  };
};
