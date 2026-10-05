// The part of a socket the queue writes to. It returns how many bytes the socket took, which can be
// fewer than it was given, or negative when the socket is closed.
interface ByteSink {
  write: (bytes: Uint8Array) => number;
}

type SendResult = { ok: true } | { ok: false; reason: 'queueFull' };

export interface WriteQueue {
  send: (bytes: Uint8Array) => SendResult;
  // Writes queued bytes until the socket takes only part of them. Call when the socket drains.
  drain: () => void;
  isEmpty: () => boolean;
}

// Keeps the bytes a socket did not take and writes them in order when it drains. A send that would
// leave more than limitBytes queued is refused, so a reader that falls behind cannot grow the
// server. The stream may then end mid-frame, so the caller must close the socket.
export const createWriteQueue = (sink: ByteSink, limitBytes: number): WriteQueue => {
  const pending: Uint8Array[] = [];
  let queuedBytes = 0;

  // Returns whether the socket took all of bytes. Queues the rest.
  const write = (bytes: Uint8Array): boolean => {
    const written = Math.max(0, sink.write(bytes));

    if (written >= bytes.length) {
      return true;
    }

    pending.unshift(bytes.subarray(written));
    queuedBytes += bytes.length - written;

    return false;
  };

  const drain = (): void => {
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      queuedBytes -= next.length;

      if (!write(next)) {
        return;
      }
    }
  };

  const send = (bytes: Uint8Array): SendResult => {
    if (pending.length === 0) {
      write(bytes);
    } else {
      pending.push(bytes);
      queuedBytes += bytes.length;
    }

    return queuedBytes > limitBytes ? { ok: false, reason: 'queueFull' } : { ok: true };
  };

  return { send, drain, isEmpty: () => pending.length === 0 };
};
