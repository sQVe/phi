# ADR 0004: libghostty-vt through bun:ffi and a thin C shim

- Status: Accepted
- Date: 2026-10-02

## Context

- Each pane needs a terminal parser that runs full-screen programs such as Neovim, answers terminal
  queries, and keeps scrollback ([ADR 0003](./0003-session-server-and-client.md)).
- Parsing must be synchronous, so a key's echo can be drawn in the next frame.
- libghostty-vt is Ghostty's terminal parser as a C library. It has no stable release, so its API
  and behavior can change between commits.
- Phi needs some behavior that differs from Ghostty's. For example, only the layout sets a pane's
  size, so DECCOLM must not resize a pane.

## Options considered

- `@xterm/headless`. Rejected: it parsed output and ran Neovim in the spike, but libghostty-vt
  replaced it so parsing is synchronous and only changed rows are redrawn.
- `ghostty-opentui`. Rejected: in the spike it parsed output but could not send query replies back
  to the PTY.
- Write a parser. Rejected: terminal emulation is large, and libghostty-vt already does it well.
- Call libghostty-vt directly from `bun:ffi`. Rejected: reading a screen would take one FFI call per
  cell.
- libghostty-vt through `bun:ffi` and a thin C shim, built from a pinned Ghostty commit with local
  patches. Chosen: one FFI call per write and one per frame, with behavior Phi controls.

## Decision

Phi uses libghostty-vt through `bun:ffi` and a thin C shim. Phi builds it from one pinned Ghostty
commit.

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

## Tradeoffs

- Phi gets Ghostty's terminal emulation with synchronous parsing.
- The pin keeps Ghostty's behavior fixed until Phi chooses to move.
- Cost: Phi builds native code with Zig and links a C shim, which the release build must do for each
  platform.
- Cost: an unstable upstream API can break the shim on a pin bump.
- Cost: each local patch is upkeep until upstream accepts or replaces it.
- Cost: a crash in native code stops the server and every pane.
