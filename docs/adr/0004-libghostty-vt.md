# ADR 0004: libghostty-vt through bun:ffi and a thin C shim

**Date**: 2026-10-02\
**Status**: Accepted

## Context

Each pane needs a terminal parser that runs full-screen programs such as Neovim, answers terminal
queries, and keeps scrollback ([ADR 0003](./0003-session-server-and-client.md)).

Parsing must be synchronous, so a key's echo can be drawn in the next frame.

libghostty-vt is Ghostty's terminal parser as a C library. It has no stable release, so its API and
behavior can change between commits.

Phi needs some behavior that differs from Ghostty's. For example, only the layout sets a pane's
size, so DECCOLM must not resize a pane.

## Decision

Phi uses libghostty-vt through `bun:ffi` and a thin C shim. Phi builds it from one pinned Ghostty
commit, with local patches. This gives one FFI call per write and one per frame, with behavior Phi
controls.

### Shim

- The shim batches work so that TypeScript makes one FFI call per write and one per frame, not one
  per cell.
- The shim holds no Phi logic beyond batching and copying data.

### Pin and patches

- Phi pins one Ghostty commit and builds libghostty-vt from it.
- Local patches live in `patches/`. Each patch states why Phi needs it and links to the upstream
  issue, pull request, or discussion.
- The first patch makes DECCOLM never resize a pane.
- A pin bump is its own PR. It reapplies or drops each patch and runs the full test suite.

## Consequences

### Positive

- Phi gets Ghostty's terminal emulation with synchronous parsing.
- The pin keeps Ghostty's behavior fixed until Phi chooses to move.

### Negative

- Phi builds native code with Zig and links a C shim, which the release build must do for each
  platform.
- An unstable upstream API can break the shim on a pin bump.
- Each local patch is upkeep until upstream accepts or replaces it.
- A crash in native code stops the server and every pane.

## Alternatives considered

### `@xterm/headless`

Use `@xterm/headless` as the parser. Rejected because libghostty-vt replaced it so parsing is
synchronous and only changed rows are redrawn. In the spike, `@xterm/headless` parsed output and ran
Neovim.

### `ghostty-opentui`

Use `ghostty-opentui` as the parser. Rejected because in the spike it parsed output but could not
send query replies back to the PTY.

### Write a parser

Write Phi's own terminal parser. Rejected because terminal emulation is large, and libghostty-vt
already does it well.

### libghostty-vt from `bun:ffi` without a shim

Call libghostty-vt directly from `bun:ffi`. Rejected because reading a screen would take one FFI
call per cell.
