# ADR 0008: Capability modules with an enforced import table

**Date**: 2026-10-02\
**Status**: Accepted

## Context

One binary runs the server, the client, and the CLI. Each part needs code the others must not reach:
the server owns PTYs and parsers, and only the client draws.

The pure parts, such as the store, the layout, and the row codec, must stay free of I/O so tests run
them without processes ([ADR 0006](./0006-server-state-store.md)).

Renderer code must stay out of the server, so a UI change cannot stop the panes
([ADR 0003](./0003-session-server-and-client.md)).

Written import rules drift unless a check enforces them. Zeta enforces its table in lint.

## Decision

`src/` holds capability modules. A lint rule, `phi/module-boundaries`, enforces which module may
import which. Modules name their owner, and lint refuses imports that cross the table.

### Modules

- Folder modules: `vt/`, `rows/`, `store/`, `protocol/`, `server/`, `client/`, `ui/`, `cli/`. Each
  has one public entry file named after the folder, such as `store/store.ts`. Other files in the
  folder are private to the module.
- Flat modules: `ids.ts`, `invariant.ts`, `layout.ts`, `index.ts`.
- The import table and file privacy apply only to files in `src/`. Tests and scripts outside `src/`
  may import any module file.
- A file outside these modules is an error. A new module starts as a flat file. It becomes a folder
  when it needs a second source file.

### Import direction

| Module      | May import                                                                  |
| ----------- | --------------------------------------------------------------------------- |
| `ids`       | nothing                                                                     |
| `invariant` | nothing                                                                     |
| `vt`        | `invariant`, `rows`                                                         |
| `rows`      | `ids`, `invariant`                                                          |
| `layout`    | `ids`, `invariant`                                                          |
| `store`     | `ids`, `invariant`, `layout`                                                |
| `protocol`  | `ids`, `invariant`, `rows`, and types from `store`                          |
| `server`    | `ids`, `invariant`, `vt`, `rows`, `layout`, `store`, `protocol`             |
| `client`    | `ids`, `invariant`, `rows`, `protocol`                                      |
| `ui`        | `ids`, `invariant`, `rows`, `client`                                        |
| `cli`       | `ids`, `invariant`, `protocol`, `server`, `client`, `vt`, `ui`              |
| `index`     | any module. It is the binary's entry and calls `cli`. No module imports it. |

- `ids`, `invariant`, `rows`, `layout`, and `store` import no Node or Bun built-ins.
- Only `ui` and `index` import React or OpenTUI packages.
- Type imports count as dependencies. Dynamic imports must use a literal path.
- A module may import a file outside `src/` only when the binary embeds it and the rule lists it:
  `vt` imports `build/libphi-vt.so`, and `cli` imports `package.json`.

The rule holds the exact table. A change that keeps these directions updates the rule. A new module,
such as the command catalog or config, joins the table with the ADR that introduces it. A change
that reverses a direction needs a new ADR.

### Code placement

- Types live in the module that owns them. Do not add a shared `types.ts`, `utils/`, or barrel file.
- Extract shared code only when two existing consumers need it.

## Consequences

### Positive

- An agent or reviewer can read ownership from the path, and lint refuses imports that cross it.
- The server cannot reach renderer code, and the client cannot reach PTYs or parsers.
- Pure modules stay free of I/O, so tests run them without fakes.

### Negative

- Every new module or edge needs a rule change, which adds friction to small additions.
- The rule checks import paths only. It does not detect I/O reached through globals such as
  `Date.now` or `process`.

## Alternatives considered

### Folders by process

Folders by process, such as `server/`, `client/`, and `shared/`. Rejected because `shared/` becomes
a place for everything, and it says nothing about which code is pure.

### Layer folders

Layer folders such as `domain/`, `application/`, and `adapters/`. Rejected because the names say
little about who owns a job, and they invite empty scaffolding.

### Import rules written only in `AGENTS.md`

Capability modules with import rules written only in `AGENTS.md`. Rejected because the rules would
drift without a check.
