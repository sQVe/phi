# Phi

Terminal multiplexer with a session server and a terminal client. Read
[the development guide](docs/development.md) for local setup and verification.

- Run `bun run check` before finishing changes. It runs typechecking, lint with house style,
  formatting, Knip, and tests.
- Format with `bun run format`, and fix style with `bun run style:fix`. House style comes from
  `@sqve/seam`; Phi's own lint rules live in `scripts/phiPlugin.ts`.
- Follow the decisions in [docs/adr](docs/adr/README.md), and record new decisions there. Read that
  guide before adding an ADR. Do not write documents that explain how a feature works; see
  [ADR 0001](docs/adr/0001-documentation-scope.md).
- Name values in camelCase and types in PascalCase. Never SCREAMING_CASE, not even for module
  constants.
- Declare a helper before the code that uses it. Join at most three checks in one condition, and do
  not mix `&&` with `||`; name the inner group instead.
- Comment only what the code cannot say, such as a constraint or a workaround. Do not describe the
  code's history.
- Add a changeset with `bun run changeset` for user-facing changes.
- Before finishing a document, check its local links and verify the commands it gives against the
  repository.

## Architecture

- Spawn pane processes with `Bun.spawn` and its `terminal` option. Do not add node-pty or another
  PTY package. See [ADR 0002](docs/adr/0002-bun-runtime-and-pty.md).
- Only the server parses pane output. The client draws rows the server sends and never parses PTY
  bytes. Only the layout sets a pane's size. See
  [ADR 0003](docs/adr/0003-session-server-and-client.md).
- Keep the libghostty-vt shim thin. Put each Ghostty patch in `patches/` with its reason and an
  upstream link, and bump the Ghostty pin in its own PR. See
  [ADR 0004](docs/adr/0004-libghostty-vt.md).
- Draw panes with the custom pane renderable, never through React. React components read state with
  `useSyncExternalStore` and send intents. Lint refuses `useEffect`; an effect that connects to an
  outside system needs a disable comment with its reason. See
  [ADR 0005](docs/adr/0005-opentui-react-ui.md).
- Change server state only through the store's pure transitions. Run effects outside the store and
  report results as generation-tagged facts. Keep PTYs, parsers, sockets, and terminal cells out of
  state, in the runtime registry. See [ADR 0006](docs/adr/0006-server-state-store.md).
- Return a typed result with a reason for an expected failure. Throw only for bugs. Use
  `invariant(condition, message)` for states that must be impossible, never for input. See
  [ADR 0007](docs/adr/0007-coding-conventions.md).
- Parse untrusted data once with zod where it enters, and pass trusted types inward. Construct each
  branded id, such as `PaneId`, with its one constructor.
- Write pure, immutable code. Only the libghostty-vt bindings, row encoding, the row cache, and pane
  drawing may reuse buffers and mutate typed arrays.
- Use a class only for an owned resource with a dispose step. Do not use inheritance unless OpenTUI
  requires it.
- Name files and folders in camelCase.
- Prefer Bun built-ins. Add a runtime dependency only with a stated reason and an exact version; a
  core dependency needs an ADR.

## Tests

Keep tests fast so the full suite stays practical as coverage grows.

- Test behavior a caller can observe. Do not test wording, constants, types, removed features, or
  internal calls. Assert exact bytes only where another program parses them.
- Keep unit tests next to source. Cross-module, PTY, and tooling checks go in `tests/`.
- Use real PTYs, libghostty-vt, sockets, and the filesystem where those boundaries matter. Otherwise
  avoid subprocesses and test the pure modules directly.
- Fake timers, `Date`, and `performance` together, and use explicit signals for async work. Use real
  time only when elapsed time is the behavior.
- Use temporary directories for fixtures and remove them when the test finishes. Keep mutable
  fixtures isolated.
- Never drop assertions or failure cases to save time.
