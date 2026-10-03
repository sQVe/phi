# ADR 0010: Every UI feature has a CLI equal

- Status: Accepted
- Date: 2026-10-03

## Context

- Coding agents run in Phi's panes, and they should be able to drive the whole Phi experience, not
  only the shell inside one pane.
- An agent works through commands and text output. It cannot press keys in the client or read what
  the client draws.
- The server already accepts intents from clients, the CLI, and agents, and sends one ordered change
  feed ([ADR 0006](./0006-server-state-store.md)). One binary runs the server, the client, and the
  CLI ([ADR 0008](./0008-capability-modules.md)).
- A feature that only the UI can reach is easy to ship and hard to cover later, because each gap is
  small and nothing reports it.

## Options considered

- Build features for the UI first, and add CLI commands when someone needs them. Rejected: the CLI
  falls behind, and an agent finds the gap only when it gets stuck.
- Let agents drive the client by sending keys and reading the screen. Rejected: it depends on key
  bindings and layout, which change often, and breaks without a clear error.
- Give every UI feature a CLI equal that sends the same intent, in the same change. Chosen: the UI
  and the CLI stay equal by rule, and an agent can use any feature from a shell.

## Decision

Every feature a user can reach in the UI has a CLI equal. A change that adds or changes a UI feature
adds or changes its CLI command in the same change.

### Shared intents

- A UI action and its CLI command send the same intent to the server. Neither has behavior the other
  lacks.
- What the UI shows, the CLI can read: structure, focus, layout, pane content, and scrollback.
- A gesture that exists only to choose or point, such as the fuzzy picker or mouse selection, needs
  no CLI equal of its own. The action it leads to, such as focusing a pane or copying its text,
  does.

### Commands for agents

- Commands never wait for input. Every value a prompt would ask for is an argument.
- Output has a structured form that a program can parse, and an expected failure exits with a
  nonzero code and an error message.

## Tradeoffs

- An agent can do anything a user can do in the UI, from any shell.
- The CLI gives scripts and tests a way to drive Phi without a client.
- Keeping behavior in server intents keeps it out of the UI, which supports
  [ADR 0005](./0005-opentui-react-ui.md).
- Cost: every UI feature takes more work, because it needs a command, its arguments, and its output.
- Cost: the CLI's commands and output form are a public surface that agents and scripts depend on,
  so changing them breaks callers.

## See also

- [ADR 0003: One parser per pane in the server, drawing in the client](./0003-session-server-and-client.md)
