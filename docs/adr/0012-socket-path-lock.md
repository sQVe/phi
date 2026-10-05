# ADR 0012: One server per socket path through a flock lock file

- Status: Accepted
- Date: 2026-10-05

## Context

- A server must replace a stale socket that no server answers on, but never a live one.
- Two servers that start at once on a stale socket can each check it and remove it. A check and a
  removal on the path are two steps, so another server can bind the path between them.
- A listener's socket refuses connections between its bind and its listen, so for that moment it
  looks stale to a probe.
- Phi runs on Linux with glibc first, and Bun has no binding for `flock`.

## Options considered

- Bind a private path, then hard-link it onto the socket path. Rejected: the stale check and the
  removal still race, and the private path is longer than the socket path, so it can pass the
  AF_UNIX path limit when the socket path does not.
- A pid file. Rejected: a pid can be reused, and a crash leaves the file behind.
- Hold `flock` on a lock file next to the socket, called from libc through `bun:ffi`. Chosen: the
  kernel allows one holder and drops the lock when the holder exits, even after a crash.

## Decision

A server takes an exclusive, non-blocking `flock` on `<socket path>.lock` before it touches the
socket path, and holds it until its last shutdown step.

### Rules

- The lock file lives in the private socket directory. The server opens it with `O_NOFOLLOW` and
  refuses a symlink there.
- A server that cannot take the lock refuses to start, as a running server.
- Under the lock, the server probes the socket path, removes a stale socket, and binds the path
  itself.
- The server releases the lock last, even when it could not remove its socket. The next start finds
  that socket refusing connections and removes it as stale.
- The lock file stays after the server stops. Removing it would let one server lock the removed file
  and another lock a new file.
- The `flock` binding is a thin file in the server module, and loads `libc.so.6`.

## Tradeoffs

- No second server can remove a live socket, whatever the timing.
- A crashed server leaves its lock free, so the next start needs no cleanup.
- Cost: an empty lock file stays next to each socket path that a server used.
- Cost: the binding loads glibc by name, so musl and macOS need another library name.

## See also

- [ADR 0002: Bun as runtime, package manager, test runner, and PTY](./0002-bun-runtime-and-pty.md)
