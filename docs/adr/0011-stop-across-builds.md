# ADR 0011: Any build can stop the server with a stop message

**Date**: 2026-10-05\
**Status**: Accepted\
**Related**: [ADR 0003 (One parser per pane in the server, drawing in the client)](./0003-session-server-and-client.md)

## Context

A detached server outlives the binary that started it. So after an upgrade, the server and the CLI
can come from different builds.

The server refuses a hello from another build, because the two builds may not share the row
protocol.

The only way to restart onto the new build is to stop the old server first. If stop needs a matching
build, the user has to end the server by hand.

## Decision

The server accepts `stop` as the first frame of a connection, from a client of any build, and stops.
`phi server stop` sends it without a handshake. The CLI reaches the server it names by socket, and
only a small part of the protocol must stay stable.

### Stable admin surface

- The frame format and the `hello`, `refused`, and `stop` messages keep their encoding in every
  build. A change to any of them is a breaking change across builds.
- `stop` carries no fields, so later builds can still decode it.
- Every other message needs a welcome from a matching build first.

## Consequences

### Positive

- After an upgrade, `phi server stop` and then `phi server start` move the user to the new build.

### Negative

- The frame format and three messages can no longer change freely.
- Any process that can open the socket can stop the server without a handshake. The socket is
  private to its owner, so this does not reach other users.

## Alternatives considered

### Stop behind the version handshake

Keep stop behind the version handshake. Rejected because the new CLI cannot stop the old server,
which is the one case where a restart is needed.

### Signal to a pid

Stop the server with a signal to a pid from a pid file or the socket peer. Rejected because a pid
can be reused, and a signal skips the socket that names which server to stop.
