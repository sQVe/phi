# ADR 0005: OpenTUI with React for the UI, panes outside React

**Date**: 2026-10-02\
**Status**: Accepted\
**Related**: [ADR 0002 (Bun as runtime, package manager, test runner, and PTY)](./0002-bun-runtime-and-pty.md)

## Context

The client draws pane rows from the server ([ADR 0003](./0003-session-server-and-client.md)) and the
UI around them: a fuzzy picker, a status bar, a `:` command line, and a space list. That UI changes
often and benefits from components and declarative layout.

Pane drawing is the hot path. Every keystroke echo and every line of output redraws pane rows, so it
must not wait for React to reconcile.

The spike drew panes with OpenTUI and redrew only changed rows.

## Decision

The client uses OpenTUI with its React bindings for the UI. Panes are a custom OpenTUI renderable
that React does not render. This gives components for the UI that changes often, and direct drawing
for the hot path.

### Panes

- A pane renderable draws rows from the client's row cache directly, without React.
- React places the pane renderables in the layout but does not pass pane content through props or
  state.

### React

- React is a view only. Components read client state with `useSyncExternalStore` and send intents
  out.
- Lint refuses `useEffect` and `useLayoutEffect`. An effect that connects to an outside system needs
  a lint disable comment that gives its reason.

## Consequences

### Positive

- UI changes stay in components, while pane drawing stays fast.
- React state cannot drift from client state, because components only read it.

### Negative

- Panes and React components follow two drawing models.
- A pane renderable must subclass OpenTUI's renderable class, so it follows OpenTUI's lifecycle.
- OpenTUI is young, and its API can change between versions.

## Alternatives considered

### OpenTUI core only

Use OpenTUI core only, with imperative renderables for everything. Rejected because the picker,
status bar, and command line are easier to write and change as components.

### React for everything, panes included

Use OpenTUI with React for everything, panes included. Rejected because each pane update would go
through React, which adds work to the hot path.
