# ADR 0007: Results for expected failures, exceptions for bugs, and checked boundaries

- Status: Accepted
- Date: 2026-10-02

## Context

- The server runs many panes and clients at once. One failure must never stop the others.
- Data enters from sockets, config files, the state file, and the output of other programs. None of
  it can be trusted until it is parsed.
- Most code transforms data, but a few hot paths parse and draw terminal output on every keystroke.
- Agents write much of the code, so the conventions must be explicit and easy to check in review.
- Some values own resources, such as a PTY or a libghostty-vt handle, that must be released exactly
  once. Everything else is data and functions over it.
- Phi ships one compiled binary, so every runtime dependency ships to every user. A version range
  would let a rebuild pick up new dependency code that nobody reviewed.

## Options considered

- Exceptions for every failure. Rejected: callers cannot see from a signature which failures to
  expect, and a missed catch can stop the server.
- Typed results for every failure, bugs included. Rejected: impossible states would spread checks
  through every caller, and a bug would read like an expected outcome.
- Assertions that run only in development builds. Rejected: a broken state in a release would go on
  silently and fail later, far from its cause.
- Add packages freely with version ranges. Rejected: each package adds size and supply-chain risk to
  the binary, and a range can change shipped code without review.
- Classes as the main unit of code, with inheritance for shared behavior. Rejected: state and
  behavior mix, so code is harder to test without real resources, and base classes couple unrelated
  modules.
- Typed results for expected failures, exceptions for bugs, always-on invariants, and parsing at
  every boundary. Chosen: expected failures are part of each signature, and bugs fail where they
  happen.

## Decision

Expected failures return typed results, and bugs throw. Phi parses untrusted data once, at the
boundary, with zod.

### Errors

- A function that can fail in an expected way returns a typed result with a reason.
- Throw only for bugs. The server catches per pane and per client, so one failure never stops other
  panes or clients.
- `invariant(condition, message)` checks states that must be impossible. It runs in every build.
  Never use it to check input.
- Lint refuses `throw` in `src/` outside `invariant.ts`. Test files are exempt.

### Boundaries

- Parse socket JSON, config, the state file, and the output of other programs with zod, once, where
  they enter. Pass trusted types inward.
- Ids are branded types: `PaneId`, `TabId`, `WorkspaceId`, and `ClientId`. Each has one constructor
  and is parsed at the boundary.

### State and classes

- Code is pure and immutable by default.
- Hot-path modules may reuse buffers and mutate typed arrays: the libghostty-vt bindings, row
  encoding, the row cache, and pane drawing.
- Use a class only for a resource Phi owns that needs a dispose step, such as a libghostty-vt
  handle, a PTY, a connection, or an OpenTUI renderable.
- Do not use inheritance, except where OpenTUI requires it.
- Lint refuses a class in `src/` without a dispose method. It also refuses `extends` unless the base
  class is imported from an `@opentui/` package. OpenTUI subclasses use OpenTUI's lifecycle and need
  no dispose method.

### Names

- Name files and folders in camelCase. A file named after the React component or class it exports
  may use PascalCase, such as `StatusBar.tsx`.

### Dependencies

- Prefer Bun built-ins to packages.
- Add a runtime dependency only with a stated reason. A core dependency needs an ADR.
- Pin every dependency to an exact version. A test refuses other versions in `package.json`, and
  `bunfig.toml` makes `bun add` write exact versions.

## Tradeoffs

- A caller sees each expected failure in the type and must handle it.
- A bug fails where it happens, in every build, and stops only its pane or client.
- Code inside the boundary trusts its types and needs no defensive checks.
- Cost: results add code at every call that can fail.
- Cost: always-on invariants run in release builds, so they must stay cheap.
- Cost: zod is a runtime dependency that every boundary relies on.
- Cost: the list of hot-path modules must be kept up to date, or mutation spreads beyond it.
- Cost: behavior that would sit on a class lives in module functions, so a reader finds a value's
  operations by its module, not its type.
