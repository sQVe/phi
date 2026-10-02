# ADR 0002: Bun as runtime, package manager, test runner, and PTY

- Status: Accepted
- Date: 2026-10-02

## Context

- Phi runs shells in pseudo-terminals (PTYs) and draws its UI with OpenTUI. OpenTUI's native
  renderer needs Bun; on Node it needs an experimental FFI flag.
- The spike tested PTYs under Bun. `Bun.spawn` with the `terminal` option spawned, read, wrote, and
  resized a PTY. node-pty got no output under Bun, and its resize failed with `EBADF`.
- Phi ships as one program that users download, not as a package on npm.
- Phi is for Linux first. macOS may follow, so Linux-only calls are worth avoiding where that is
  cheap.

## Options considered

- Node with node-pty and Vitest. Rejected: OpenTUI needs an experimental flag on Node, and the app
  would need a second runtime next to the Bun tooling.
- Bun with node-pty. Rejected: node-pty did not work under Bun in the spike.
- Bun with a PTY helper written in another language. Rejected: it adds a second build and a process
  boundary that `Bun.spawn` already covers.
- Bun as runtime, package manager, test runner, and PTY, built into one binary. Chosen: one runtime
  covers the tooling, the app, the PTYs, and every test.

## Decision

Phi uses Bun as its runtime, package manager, test runner, and PTY layer, and ships as one binary
built with `bun build --compile`.

### Toolchain

- `bun.lock` is the only lockfile. `packageManager` in `package.json` pins the Bun version, and CI
  installs that version.
- Tests use `bun test` and import from `bun:test`.
- Vite+ stays for lint, formatting, and staged checks. TypeScript, Knip, and Changesets also stay.
- Scripts and hooks run installed command-line tools with `bunx --bun`, so tools with a Node shebang
  run on Bun.

### PTYs

- Phi spawns each pane's process with `Bun.spawn` and its `terminal` option. Do not add node-pty or
  another PTY package.

### Platforms and releases

- Linux on x64 is the first target, and arm64 follows when it costs little.
- Prefer calls that also exist on macOS when the choice is cheap.
- Releases are binaries attached to GitHub releases.

## Tradeoffs

- The tooling, the app, the PTYs, and all tests share one runtime and one test runner.
- Users install one file and need no runtime of their own.
- Cost: Phi depends on Bun's PTY support. A bug there has no Node fallback.
- Cost: GitHub's dependency graph does not read `bun.lock`, so dependency review does not cover
  locked package versions. A scheduled `bun audit` covers them instead.
- Cost: tools that assume Node need `bunx --bun`.
- Cost: Oxlint's test rules do not recognize `bun:test`, so test files get no test-specific lint.
- Cost: a compiled binary contains the whole runtime, so it is large.

## See also

- [OpenTUI runtime support](https://opentui.com/docs/getting-started/runtime-support/)
