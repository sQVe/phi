# phi

## 0.1.0

### Minor Changes

- [#15](https://github.com/sQVe/phi/pull/15)
  [`bd12508`](https://github.com/sQVe/phi/commit/bd12508763b3283c0604ed33435898844d194268) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi --version`, which prints the Phi version and the
  Ghostty commit of the terminal library. Add `--json` for a parseable form. The `phi` binary
  bundles the terminal library and runs without other files.

- [#29](https://github.com/sQVe/phi/pull/29)
  [`d997d30`](https://github.com/sQVe/phi/commit/d997d30443e4aad56f16e1a4147c4e2ad7980982) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi attach` to show the running pane and input mode in a
  terminal client. Resize the pane with the terminal and detach on SIGTERM, SIGINT, or SIGHUP
  without stopping the server.

- [#24](https://github.com/sQVe/phi/pull/24)
  [`be1f1b9`](https://github.com/sQVe/phi/commit/be1f1b9b6d448420af05e8aa4bc92e0045ba20b5) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi pane read` to print the pane's visible rows and
  `phi pane send <text>` to send text to its shell. Both commands support `--socket` and `--json`,
  and work without a terminal client attached. Agent reads leave pending row updates available to
  terminal clients.

  Send binary row updates to terminal clients after the welcome and store snapshot. Connections
  without a terminal size receive the state feed but no row updates.

  Refuse pane commands from another build with both Phi versions and Ghostty commits. The error
  explains that `phi server stop` followed by `phi` restarts the server and ends every pane.

- [#20](https://github.com/sQVe/phi/pull/20)
  [`a1a26be`](https://github.com/sQVe/phi/commit/a1a26be1f5a9c4afabe4c9c30567ad126b2fb5b4) Thanks
  [@sQVe](https://github.com/sQVe)! - Add the socket protocol. Rows and input use a binary codec,
  and control messages are checked JSON. Every connection starts with a version handshake, and a
  client and server from different builds refuse each other with an error that names both versions.

- [#21](https://github.com/sQVe/phi/pull/21)
  [`49d4cca`](https://github.com/sQVe/phi/commit/49d4ccac2a54dcd8ff87df9056849a2f8b609d1a) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi server start`, `phi server stop`, and
  `phi server run`. `phi server start` runs the server in the background with one shell, and
  `phi server stop` ends the shell and removes the socket. Each command takes `--socket` for another
  socket path and `--json` for a parseable form, and none prompts. The server refuses a symlink or
  another file at the socket path, a socket path under a directory other users can change, a socket
  directory other users can read, write, or enter, a socket path whose parent directories do not
  exist, and a socket another user owns. It replaces only a socket that refuses connections. The
  server locks a `.lock` file next to its socket, so only one server runs on a socket path.
  `phi server start` succeeds only when the server it started is ready, and it prints that server's
  error when the server cannot start its shell or write its log. `phi server stop` also stops a
  server from another Phi build, so a restart moves the server to the new build. `phi server run`
  exits with code 1 and a message when the server cannot clean up as it stops, such as when it
  cannot remove its socket. `phi server stop` then exits with code 1 at once and names the socket
  the server left.

- [#14](https://github.com/sQVe/phi/pull/14)
  [`e225fe0`](https://github.com/sQVe/phi/commit/e225fe0376430ac8601b47b5ba6b68d64e23b1aa) Thanks
  [@sQVe](https://github.com/sQVe)! - Add the server store. It holds one pane and the attached
  client, changes them only through pure transitions, and reports each change in a revisioned feed.

- [#24](https://github.com/sQVe/phi/pull/24)
  [`065f32f`](https://github.com/sQVe/phi/commit/065f32f41757b30921112f6d81ba29826ca2d2f3) Thanks
  [@sQVe](https://github.com/sQVe)! - Send a store snapshot after welcoming a connection, then
  publish each store change with its own revision. Connections can request a fresh snapshot with
  `resync` after a missed change.

- [#18](https://github.com/sQVe/phi/pull/18)
  [`564eeb4`](https://github.com/sQVe/phi/commit/564eeb4775af85ab755e42bbcfb109884b2fa41c) Thanks
  [@sQVe](https://github.com/sQVe)! - The terminal library reads the rows that changed, the cursor,
  and the terminal modes as one frame. Rows keep a stable number while output scrolls them into
  history, the history keeps to a memory limit, and a range of rows can be read again by number,
  also from history.

  New terminals turn on grapheme clustering (mode 2027), so an emoji sequence joined with zero-width
  joiners stays in one cell.

  While a program holds output with synchronized output (mode 2026), frames keep showing the last
  finished screen, so a redraw split across several writes never shows half drawn.

### Patch Changes

- [#30](https://github.com/sQVe/phi/pull/30)
  [`4c33782`](https://github.com/sQVe/phi/commit/4c3378270050c589abb5357984236f12e78063e7) Thanks
  [@sQVe](https://github.com/sQVe)! - Pace row updates to a slow `phi attach` client. The client
  acks each row update after it draws it, and the server stops sending to a client that falls too
  far behind instead of buffering without limit.

- [#18](https://github.com/sQVe/phi/pull/18)
  [`abd2870`](https://github.com/sQVe/phi/commit/abd287080ca18e643047042670bbebe3c71fdab5) Thanks
  [@sQVe](https://github.com/sQVe)! - A program's DECCOLM sequence no longer clears the pane unless
  the program turned on mode 40 first.

- [#32](https://github.com/sQVe/phi/pull/32)
  [`82052e8`](https://github.com/sQVe/phi/commit/82052e8cb4f3c875fd3c78070b0a736d01bcfd70) Thanks
  [@sQVe](https://github.com/sQVe)! - Show the palette and default colors a program sets with OSC 4,
  10, and 11 in `phi attach`.

- [#32](https://github.com/sQVe/phi/pull/32)
  [`82052e8`](https://github.com/sQVe/phi/commit/82052e8cb4f3c875fd3c78070b0a736d01bcfd70) Thanks
  [@sQVe](https://github.com/sQVe)! - Answer OSC 4, 10, and 11 color queries in the pane with the
  colors of the attached client's terminal. Panes keep white on black until a client reports its
  colors.
