# ADR 0013: A terminal multiplexer built around pi

**Date**: 2026-10-07\
**Status**: Accepted\
**Related**: [ADR 0003 (One parser per pane in the server, drawing in the client)](./0003-session-server-and-client.md),
[ADR 0010 (Every UI feature has a CLI equal)](./0010-cli-parity.md)

## Context

The user works in pi all day, inside herdr. herdr's workflow and UI cannot be shaped to fit that
work. Its plugin API allows sidebar rows, keys, themes, and plugin panes, but no native UI, so the
agents side panel and the navigation stay as herdr designs them.

pi's own TUI carries the user's setup. Tau's extensions draw custom dialogs and editor hooks in it,
and the pi-claude-bridge package routes model calls through the user's Claude subscription. Both
must keep working unchanged. pi's RPC mode and its SDK drop the TUI, and in RPC mode extension UI
such as custom components and editor hooks does nothing.

An attention view needs to know what each pi is doing and to send it messages. A pi that keeps its
TUI in a pane has no protocol on its stdin, because the PTY carries keystrokes.

## Decision

Phi is a terminal multiplexer built around pi: any command can run in a pane, and pi panes are a
first-class pane type. Phi owns the layout, navigation, and the views around the panes. pi owns the
chat inside its pane.

### pi in a pane

- pi runs with its normal TUI in a PTY, as any other command does. Phi does not draw a chat UI and
  does not run pi in RPC mode.
- Tau and pi-claude-bridge work in a Phi pane exactly as they do in a plain terminal. A change that
  breaks either one is a regression.
- Other agent types may become first-class pane types later, in the same way.

### Channel to pi

- A small pi extension connects to the Phi server over a socket. It reports pi's state (idle,
  working, waiting for user input, finished) and its session file, and it delivers messages from Phi
  as steer or follow-up messages.
- The channel is a side channel. The server still parses pane output only from the PTY.
- pi refuses a message during compaction and gives the extension no error for it. So the extension
  holds messages while compaction runs and delivers them after it ends.

A probe against pi's real TUI and pi-claude-bridge showed that this channel works, except during
compaction, which the rule above covers.

### First usable version

The first usable version replaces herdr for daily work. It has a spaces side panel synced with pull
request state and similar status, and no agents side panel. It has fast navigation between
workspaces and panes, and fuzzy finding of earlier pi sessions, workspaces, and more. Panes can be
visible or run in the background as equals. An attention view lists what needs the user's action or
input.

### Earlier decisions

This ADR adds a pane type and a scope on top of the earlier ADRs and changes none of them. The
server, row protocol, store, and CLI parity in ADRs 0003 to 0012 stay the path to the first pane.
The extension channel respects [ADR 0003](./0003-session-server-and-client.md), because it reads no
pane output. The attention view and the pi pane actions need CLI equals under
[ADR 0010](./0010-cli-parity.md).

## Consequences

### Positive

- The user's pi setup, Tau, and the Claude subscription work in Phi without porting.
- Phi controls the views the user cannot change in herdr.
- pi panes stay ordinary panes, so detach, attach, scrollback, and selection work for them as for a
  shell.

### Negative

- Phi depends on pi's extension API and events. A pi release can change them.
- pi's events carry no request ID, so the extension matches a delivered message by its content.
- A message in flight when pi dies is reported as uncertain and never sent again. Delivery is not
  exactly once across a crash.
- Phi cannot restyle the chat itself, because pi draws it.

## Alternatives considered

### Stay on herdr with plugins

Keep herdr and build the missing views as plugins. Rejected because its plugin API gives rows, keys,
themes, and plugin panes, but no native UI, so the side panel and navigation stay as herdr designs
them.

### Fork herdr

Fork herdr and change its UI. Rejected because it is a large, fast-moving Rust codebase, and its UI
design is what the user wants to replace.

### pi in RPC mode with a chat UI in Phi

Run pi in RPC mode, or embed it with the SDK, and draw the chat in Phi. RPC gives request IDs and
error responses that the extension channel lacks. Rejected because pi then has no TUI: Tau's custom
dialogs and editor hooks stop working, and Phi takes on a chat UI it does not need.

### Pi Durable as the host

Run pi under Pi Durable for crash recovery. Rejected because pi-claude-bridge cannot work under it.
Durable aborts a model call's signal at each tool handoff, and the bridge holds that signal while it
waits for the tool result, so its Claude Code subprocess is killed. pi's direct Anthropic
subscription login may be billed as extra usage. Without the bridge, the recovery gain does not pay
for porting Tau.
