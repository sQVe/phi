# ADR 0006: One server store with pure transitions and a typed change feed

**Date**: 2026-10-02\
**Status**: Accepted

## Context

The server holds workspaces, tabs, panes, layout, focus, and later integration data such as pull
request state. Clients, the CLI, and agents read it and ask to change it.

Many changes start work that takes time and can fail, such as spawning a PTY or stopping a process.
Their results arrive later and may arrive after the pane they belong to is gone.

One pane or client failing must never stop the server.

PTYs, running processes, and parser grids cannot be saved or replayed. After a restart, only
structure, layout, and each pane's working directory can come back.

## Decision

Each server has one store. Pure transitions take the current state and an intent or fact, and return
the next state and typed changes. The server keeps no event log.

Every change goes through one place, transitions test without I/O, and clients follow the same
changes the store makes.

### Store

- One coordinator commits every change to shared state, in order.
- Transitions do no I/O.
- Each pane has an explicit lifecycle state, such as starting, running, exited, or closing.

### Effects

- Effects, such as spawning a PTY, run outside the store.
- An effect reports its result as a fact tagged with the generation it started from. The store
  ignores a fact whose generation is no longer current.
- When the store ignores a fact, the code that ran the effect disposes of any resource it created,
  such as a spawned process and its PTY.

### Runtime registry

- State holds no handles and no terminal cells.
- A runtime registry outside the store holds PTYs, parsers, and sockets, keyed by id.

### Clients

- A client gets a snapshot with a revision, then every change after it in order.
- A client that sees a gap in revisions asks for a new snapshot.
- Row updates are binary and carry pane and epoch identity, separate from the store's revisions.

## Consequences

### Positive

- Transitions are plain functions, so tests cover layout, focus, and lifecycle without processes.
- Clients, the CLI, and agents follow one ordered feed.
- A late result cannot change a pane that has moved on, because facts carry generations.

### Negative

- Every long-running action takes two steps, the intent and the fact that reports its result, with
  states in between.
- There is no history to replay. Debugging relies on tests and logs, and undo needs its own design.
- An audit trail added later would start empty.

## Alternatives considered

### Objects with methods

Objects with methods, such as pane and tab classes that own their PTYs and change themselves.
Rejected because state and handles mix, so a change is hard to test without real processes, and no
single place orders changes.

### An event log

Every change is an appended event, and state is folded from the log. Rejected because the log cannot
replay what matters most, the PTYs and processes, and terminal output already has its own row
protocol. A log adds schema versions, compaction, and replay rules for benefits that snapshots and a
change feed give at lower cost.
