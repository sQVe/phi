# Architecture decision records

Record lasting decisions and the reasons behind them, not how a feature works.

## Before writing

Follow [ADR 0001](./0001-documentation-scope.md) for documentation scope. Before opening the
[template](./TEMPLATE.md), answer:

- What choice are we making, and what lasting reason stands behind it?
- What credible alternative did we consider, and why did we reject it?

If the answers only restate what the code does, do not write an ADR. Code and tests hold behavior. A
feature change does not require a new document.

Use a title that names the choice, and state that choice at the start of the Decision section. An
ADR is not a feature summary, implementation plan, or acceptance checklist.

A new ADR is Accepted. Merging its PR is the approval, so there is no Proposed stage. When a later
decision replaces it, change its status to Superseded with a link to the replacement.

## Index

- [0001: Documentation scope](./0001-documentation-scope.md)
- [0002: Bun as runtime, package manager, test runner, and PTY](./0002-bun-runtime-and-pty.md)
- [0003: One parser per pane in the server, drawing in the client](./0003-session-server-and-client.md)
- [0004: libghostty-vt through bun:ffi and a thin C shim](./0004-libghostty-vt.md)
- [0005: OpenTUI with React for the UI, panes outside React](./0005-opentui-react-ui.md)
- [0006: One server store with pure transitions and a typed change feed](./0006-server-state-store.md)
- [0007: Results for expected failures, exceptions for bugs, and checked boundaries](./0007-coding-conventions.md)
- [0008: Capability modules with an enforced import table](./0008-capability-modules.md)
