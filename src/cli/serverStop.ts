import { lstatSync } from 'node:fs';

import { sendStop } from '../client/client.ts';
import { print } from './output.ts';
import type { Outcome } from './output.ts';
import { poll, pollIntervalMs, seconds } from './serverContext.ts';
import type { ServerContext } from './serverContext.ts';

type SocketRelease = 'removed' | 'leftSocket';

// Covers the server's wait for pane processes that ignore SIGHUP.
const serverStopTimeoutMs = 10_000;

const socketInode = (socketPath: string): bigint | undefined =>
  lstatSync(socketPath, { bigint: true, throwIfNoEntry: false })?.ino;

// Only a refused connection proves that no server listens any more. The probe sends nothing and
// closes at once, so a server that is still stopping drops it with its other connections.
const connectionRefused = async (socketPath: string): Promise<boolean> => {
  try {
    const socket = await Bun.connect({ unix: socketPath, socket: { data: () => undefined } });

    socket.end();

    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED';
  }
};

// Works for a server of any build. A server closes its listener just before it removes its
// socket, so a refused socket gets one more interval to disappear. A new server may claim the path
// meanwhile, so only the same socket counts as left behind.
const releasedPath = async (socketPath: string): Promise<SocketRelease | undefined> => {
  const probed = socketInode(socketPath);

  if (probed === undefined) {
    return 'removed';
  }

  if (!(await connectionRefused(socketPath))) {
    return undefined;
  }

  await Bun.sleep(pollIntervalMs);

  return socketInode(socketPath) === probed ? 'leftSocket' : 'removed';
};

export const stopServer = async (context: ServerContext): Promise<Outcome> => {
  const { socketPath } = context;
  const sent = await sendStop(socketPath);

  if (!sent.ok) {
    return { ok: false, message: `No server runs on ${socketPath}.` };
  }

  const released = await poll(() => releasedPath(socketPath), serverStopTimeoutMs);

  sent.close();

  if (released === undefined) {
    return {
      ok: false,
      message: `The server on ${socketPath} did not stop within ${seconds(serverStopTimeoutMs)} seconds.`,
    };
  }

  if (released === 'leftSocket') {
    return {
      ok: false,
      message: `The server stopped, but left its socket at ${socketPath}. The next start removes it.`,
    };
  }

  print(context.json, {
    json: { stopped: true },
    text: `Stopped the server on ${socketPath}.`,
  });

  return { ok: true };
};
