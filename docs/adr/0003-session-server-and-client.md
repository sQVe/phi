# ADR 0003: One parser per pane in the server, drawing in the client

**Date**: 2026-10-02\
**Status**: Accepted

## Context

Shells and coding agents run in panes all day. They must keep running when the UI closes, detaches,
or crashes, so a long-lived server owns the PTYs.

The server needs a terminal parser per pane anyway, because it answers terminal queries, serves pane
content to agents, and restores the screen when a client attaches.

The UI changes often. A UI change or UI crash must not restart the server or stop the panes.

Scrolling and selection need the same rows the server holds, scrollback included.

## Decision

A long-lived server owns each pane's PTY and its only terminal parser, a libghostty-vt terminal. The
server sends the client changed rows. The client draws them with OpenTUI and fetches scrollback rows
on demand.

The server is the only source of pane content. In the spike, the rows design kept keystroke echo
close to raw forwarding while sending far fewer bytes for bulk output. WezTerm's multiplexer uses
the same shape.

### Server

- The server parses every byte a pane writes. No other process parses pane output.
- Per pane, the server sends changed rows, the cursor, the input modes the client needs to encode
  keys, and a sequence number.
- Rows have stable row numbers with an epoch. The epoch changes when reflow or pruning makes earlier
  row numbers invalid.
- A row that leaves the screen is sent again if it changed, so rows a client has cached match the
  server.
- Only the layout sets a pane's size. A program in the pane cannot resize it.
- Each pane has an explicit scrollback limit.
- The server keeps running, and keeps every pane running, when no client is attached.

### Client

- The client keeps a row cache per pane and draws from it.
- Scrolling and selection read rows from the cache and fetch missing rows from the server.
- The client acknowledges the updates it has drawn, and the server limits how far it runs ahead of
  those acknowledgements.

## Consequences

### Positive

- Pane content cannot drift between server and client, because only the server parses it.
- UI code, including OpenTUI's native renderer, runs only in the client. A UI crash or update does
  not stop the panes.
- Agents, attach, scrolling, and selection read the same rows.

### Negative

- Phi owns a row protocol with stable row numbers, epochs, and flow control.
- Each keystroke echo adds one row encode and decode, so echo is a little slower than raw
  forwarding.
- The client must receive input modes from the server to encode keys and mouse events.

## Alternatives considered

### Raw bytes parsed again in the client

Forward raw PTY bytes and parse them again in the client, with a snapshot on attach. Rejected
because in the spike, the client's copy pruned scrollback at different times than the server's, so
the two copies drifted silently after attach.

### Client parser for the visible screen

Parse in the client for the visible screen only, and fetch scrollback from the server. Rejected
because it keeps two parsers that must agree on everything that depends on history, such as reflow,
scroll regions, and the alternate screen. It also needs three paths: snapshot, raw bytes, and row
fetch.

### Finished frames from the server

Draw in the server and send finished frames, as tmux, Zellij, and herdr do. Rejected because herdr's
server-side renderer crashed the server and every pane with it. In the spike's benchmark, its
keystroke echo was also slower than the spike's client and server.

### Thin client without a parser

A thin client that passes raw bytes to the terminal without parsing, as dtach and abduco do.
Rejected because it keeps no screen state, so it cannot draw several panes, restore a screen on
attach, or serve rows for scrolling and selection.
