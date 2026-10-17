# phi

## 0.1.0

### Minor Changes

- [#33](https://github.com/sQVe/phi/pull/33)
  [`dfacc27`](https://github.com/sQVe/phi/commit/dfacc2765a1674a598b07ebaf6732008827635c1) Thanks
  [@sQVe](https://github.com/sQVe)! - Run `phi` with no command to attach to the server, and start
  the server first when none runs. When two `phi` runs start at once, the one that loses the socket
  lock attaches to the server that won. Press Ctrl+B then `d`, or run `phi detach`, to detach and
  leave the shell running. A new `phi` reattaches and shows the same screen. A second client that
  attaches takes over from the first, and the first exits with a message. Exiting the shell stops
  the server and the client.

- [#42](https://github.com/sQVe/phi/pull/42)
  [`8f9be3e`](https://github.com/sQVe/phi/commit/8f9be3efe51dca03f9020beb41004fa71584a3a3) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi pane process-info <id>`. It shows the pane's shell
  process id, its foreground process group, and each process in that group with its arguments and
  folder. `phi pane list` now shows each pane's `cwd` and `foreground_cwd`. A folder that cannot be
  read prints as `null` in `--json`. Both support `--socket` and `--json`, and the key names match
  herdr.

- [#40](https://github.com/sQVe/phi/pull/40)
  [`16da8dc`](https://github.com/sQVe/phi/commit/16da8dc79b762a5e64815ea123c8ba9ca17126f7) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi pane zoom <id>` and
  `phi pane resize <id> --direction left|right|up|down --cells <n>`. Zoom shows one pane over the
  whole tab, and a second zoom restores the split. Resize moves the nearest split edge in that
  direction. Both support `--socket` and `--json`. `phi pane list` now shows which pane is zoomed,
  as `zoomed` in `--json`.

  In Phi mode, `z` zooms the focused pane, and `<`, `>`, `-`, and `+` move the nearest split edge
  one cell left, right, up, or down.

- [#56](https://github.com/sQVe/phi/pull/56)
  [`f56b4e2`](https://github.com/sQVe/phi/commit/f56b4e29fd6a78b272f2c8255922b64a80875e0a) Thanks
  [@sQVe](https://github.com/sQVe)! - Take the pane id of `phi pane read` as an argument:
  `phi pane read <id>`. The command no longer reads the focused pane when it has no id, and it
  refuses `--pane`. `phi pane send` keeps `--pane`.

- [#36](https://github.com/sQVe/phi/pull/36)
  [`a2a6420`](https://github.com/sQVe/phi/commit/a2a642011f3ae7065ae9670ca47f8b8757791e20) Thanks
  [@sQVe](https://github.com/sQVe)! - Run several workspaces from the CLI. The server now starts
  with no workspace. `phi workspace list|create|focus|rename|close` and `phi pane list` manage
  workspaces and panes, and every command has a `--json` form. `phi pane read` and `phi pane send`
  take `--pane <id>` to reach a pane in a workspace that is not focused. A pane that exits closes
  its tab and workspace, and the server keeps running with none. A terminal client gets rows only
  from the focused workspace's pane. The terminal client draws the focused workspace's pane,
  switches to another pane's current screen when focus changes, and shows an empty screen with a
  `phi workspace create <dir>` hint when no workspace is open.

- [#39](https://github.com/sQVe/phi/pull/39)
  [`1784dd4`](https://github.com/sQVe/phi/commit/1784dd415afc63c36d4940e12faf60333fff4fb0) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi pane split <id> --direction below|right`,
  `phi pane focus <id>`, and `phi pane close <id>` to split a pane, move focus, and close a pane
  with its process. Each command supports `--socket` and `--json`, and fails with a message and exit
  code 1 for an unknown pane. `phi pane list` now shows each pane's `columns` and `rows`.

- [#15](https://github.com/sQVe/phi/pull/15)
  [`bd12508`](https://github.com/sQVe/phi/commit/bd12508763b3283c0604ed33435898844d194268) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi --version`, which prints the Phi version and the
  Ghostty commit of the terminal library. Add `--json` for a parseable form. The `phi` binary
  bundles the terminal library and runs without other files.

- [#45](https://github.com/sQVe/phi/pull/45)
  [`7c2f7c5`](https://github.com/sQVe/phi/commit/7c2f7c5839a78d22c20ce2e75924f9d60acdc934) Thanks
  [@sQVe](https://github.com/sQVe)! - `phi pane read` reads pane history. Choose rows with
  `--source visible|recent|recent-unwrapped` and `--lines <n>`, or read a stable row range with
  `--from <row> --to <row>`. The default source is `recent`, the last 80 rows, where it was the
  visible screen. `recent-unwrapped` joins lines that the terminal wrapped. A read comes from one
  snapshot of the pane, sent in parts, so it stays whole while the pane writes. A selection over 16
  MiB of encoded rows is read in several snapshots, and fails if the pane switches between its
  primary and alternate screens between them. A range below the oldest kept row fails with that row
  number. `--json` now prints `pane`, `source`, `epoch`, `oldest`, `from`, `to`, and `lines`, where
  it printed `pane` and `rows`.

- [#46](https://github.com/sQVe/phi/pull/46)
  [`cbcbe4c`](https://github.com/sQVe/phi/commit/cbcbe4c67f345804c033c5ebbfdeb6fa088ca806) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep a restored pane in the layout when its saved folder is
  gone or its shell fails to start. The pane shows its error where the terminal would be, and
  `phi pane list` shows the lifecycle `failed` and a `restore_error`. Close it with
  `phi pane close`. Restore the folder and restart the server to start it again.

- [#34](https://github.com/sQVe/phi/pull/34)
  [`7f3c695`](https://github.com/sQVe/phi/commit/7f3c695d961d49fcd5f1b9c06ced98267ca5fe01) Thanks
  [@sQVe](https://github.com/sQVe)! - `phi server stop` now ends every process a pane started, even
  one that called `setsid`. Phi starts each pane's shell in its own systemd user scope and ends the
  scope when the server stops. Without a systemd user manager, stop ends the shell's session as
  before, and a process that called `setsid` can survive. The server log says which of the two it
  uses. A process you detach in a pane now ends when the server stops. To keep one, start it outside
  the pane, such as with `systemd-run --user`.

- [#62](https://github.com/sQVe/phi/pull/62)
  [`acbfad2`](https://github.com/sQVe/phi/commit/acbfad23c69f4078465fd0a83bad09671be1f3c5) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi pane copy <id> --from <row>:<col> --to <row>:<col>`
  to copy a range of pane history to the foreground client's clipboard. Rows are stable row numbers
  and columns start at 0. With `--print`, the command writes the text to stdout and needs no client.

- [#41](https://github.com/sQVe/phi/pull/41)
  [`1636cde`](https://github.com/sQVe/phi/commit/1636cdea3dc2a78d2a354dc1d1865892860de018) Thanks
  [@sQVe](https://github.com/sQVe)! - The server saves its workspaces, tabs, splits, zoom, and focus
  after every change and on stop, and restores them on its next start on the same socket path. Each
  pane starts a new shell in its workspace root. A save file that is broken or from a newer version
  is logged, and the server starts with no workspace.

- [#53](https://github.com/sQVe/phi/pull/53)
  [`6df463d`](https://github.com/sQVe/phi/commit/6df463d24ea1d78e210044e69a9aac7bf2a07ab7) Thanks
  [@sQVe](https://github.com/sQVe)! - Pass the kitty keyboard protocol to panes. `phi attach` asks
  the outer terminal for kitty keys and sends each key to the focused pane in the encoding that pane
  asked for. A pane that does not ask for kitty flags still gets legacy keys. Releases reach only
  panes that ask for event types. Ctrl+B enters normal mode under any pane flags. A terminal without
  kitty support keeps working as before.

- [#61](https://github.com/sQVe/phi/pull/61)
  [`e4401f8`](https://github.com/sQVe/phi/commit/e4401f8a976d6fa9112be58dae81cdf8b5cf960c) Thanks
  [@sQVe](https://github.com/sQVe)! - Add scroll mode. `[` in normal mode enters it on the focused
  pane, and `q` or Escape leaves it. The status bar shows `SCROLL`, and a cursor marks the position
  in the pane's history. The cursor moves as in herdr's copy mode: `h j k l` and the arrow keys,
  `w b e`, `W B E`, `0 ^ $`, `{ }`, Home and End, PageUp and PageDown, Ctrl+U, Ctrl+D, Ctrl+F, and
  `g` and `G`. The view scrolls when the cursor leaves it, and `G` returns it to the bottom. `q`,
  Escape, and Ctrl+B restore the view from when scroll mode started. Ctrl+B still leaves scroll mode
  for normal mode. A motion that needs history rows the client has not fetched yet waits for them.
  Moving focus to another pane leaves scroll mode.

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

- [#52](https://github.com/sQVe/phi/pull/52)
  [`aada21b`](https://github.com/sQVe/phi/commit/aada21b19c08ad0b8ea59af98a7398be62c278a1) Thanks
  [@sQVe](https://github.com/sQVe)! - Start each pane's shell with `PHI_SOCKET_PATH`, `PHI_PANE_ID`,
  `PHI_TAB_ID`, `PHI_WORKSPACE_ID`, and related variables. Inside a pane, `phi` commands reach that
  pane's server without `--socket`. `--socket` still wins. `phi` takes no default pane or workspace
  from the pane it runs in.

- [#58](https://github.com/sQVe/phi/pull/58)
  [`119eae8`](https://github.com/sQVe/phi/commit/119eae85bd654d1f6959edf9697a6d554af22f21) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi pane move <id>` with one of `--tab <id>`,
  `--new-tab`, or `--new-workspace`. The pane keeps its process and its id, and takes the focus at
  its destination. `--new-workspace` roots the workspace at the pane's current folder. In Phi mode,
  `!` moves the focused pane to a new tab in its workspace.

- [#46](https://github.com/sQVe/phi/pull/46)
  [`cbcbe4c`](https://github.com/sQVe/phi/commit/cbcbe4c67f345804c033c5ebbfdeb6fa088ca806) Thanks
  [@sQVe](https://github.com/sQVe)! - Save the folder of each pane's shell with the session. After a
  restart, each restored shell starts in its last folder, or in its workspace root when no folder
  was saved.

- [#20](https://github.com/sQVe/phi/pull/20)
  [`a1a26be`](https://github.com/sQVe/phi/commit/a1a26be1f5a9c4afabe4c9c30567ad126b2fb5b4) Thanks
  [@sQVe](https://github.com/sQVe)! - Add the socket protocol. Rows and input use a binary codec,
  and control messages are checked JSON. Every connection starts with a version handshake, and a
  client and server from different builds refuse each other with an error that names both versions.

- [#57](https://github.com/sQVe/phi/pull/57)
  [`fa6fa3d`](https://github.com/sQVe/phi/commit/fa6fa3d53f8d4dfb8c8ce3175b3e5856dfdee647) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi tab rename <id> <label>`. A tab label shows in
  `phi tab list` as `label`, and in the status bar of `phi attach` as `<number>:<label>`, such as
  `[2:build]`. The label survives a server restart.

- [#59](https://github.com/sQVe/phi/pull/59)
  [`5d99475`](https://github.com/sQVe/phi/commit/5d99475ce29ac7b1fa97694804bdeebf252cd4af) Thanks
  [@sQVe](https://github.com/sQVe)! - Forward the mouse from `phi attach` to the pane under the
  pointer. The client turns on mouse reporting in the outer terminal and turns it off on detach. A
  pane gets clicks, drags, motion, and the wheel at its own coordinates when it asked for them. A
  drag and the release go to the pane where the press started. A left click focuses the pane,
  workspace, or tab under the pointer. A click on an unfocused pane that asked for the mouse also
  reaches that pane. Keys typed after a click on a pane or workspace wait until the focus changes.

- [#61](https://github.com/sQVe/phi/pull/61)
  [`e4401f8`](https://github.com/sQVe/phi/commit/e4401f8a976d6fa9112be58dae81cdf8b5cf960c) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi pane scroll <id> --to top|bottom|<row>` to scroll a
  client's view of a pane's history. It moves the foreground client, or the client named by
  `--client`. `phi client list` shows each client's scrolled panes.

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

- [#38](https://github.com/sQVe/phi/pull/38)
  [`f48654c`](https://github.com/sQVe/phi/commit/f48654ca3559ca9a2fcfba1edb5e8e4016220215) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi tab list`, `phi tab create [--workspace <id>]`,
  `phi tab focus <id>`, and `phi tab close <id>`. A new tab starts one pane in the workspace root
  and becomes the active tab. Closing the active tab activates its neighbor, and closing the last
  tab closes the workspace. All commands support `--socket` and `--json`.

- [#44](https://github.com/sQVe/phi/pull/44)
  [`6effe17`](https://github.com/sQVe/phi/commit/6effe179e81e0f7e317bb182b1bad7c1c7e13d9a) Thanks
  [@sQVe](https://github.com/sQVe)! - Start a new split pane or tab in the folder of the pane it
  comes from. The folder is the running command's folder, else the shell's folder. When that folder
  is deleted or cannot be entered, the pane starts in the workspace root. This applies to the `s`,
  `v`, and `t` keys, `phi pane split`, and `phi tab create`.

  Add `--cwd <dir>` to `phi pane split` and `phi tab create` to start the new pane in a chosen
  folder. A relative path resolves against the folder the command runs in. A path that is not a
  directory is refused, and nothing is created.

- [#14](https://github.com/sQVe/phi/pull/14)
  [`e225fe0`](https://github.com/sQVe/phi/commit/e225fe0376430ac8601b47b5ba6b68d64e23b1aa) Thanks
  [@sQVe](https://github.com/sQVe)! - Add the server store. It holds one pane and the attached
  client, changes them only through pure transitions, and reports each change in a revisioned feed.

- [#31](https://github.com/sQVe/phi/pull/31)
  [`d0a4d9c`](https://github.com/sQVe/phi/commit/d0a4d9cfd45a0705cb40a7f0df164a4cf1758278) Thanks
  [@sQVe](https://github.com/sQVe)! - Send keys and paste from `phi attach` to the pane. Insert mode
  sends every key, and Ctrl+B enters normal mode, where `i` or Escape returns to insert and Ctrl+B
  sends a literal Ctrl+B. The status bar shows `INSERT` or `NORMAL`. Escape reaches the pane at
  once, and Alt plus a non-ASCII key arrives intact. Cursor keys follow the pane's application
  cursor mode, and paste uses bracketed paste markers when the pane asks for them.

- [#38](https://github.com/sQVe/phi/pull/38)
  [`f48654c`](https://github.com/sQVe/phi/commit/f48654ca3559ca9a2fcfba1edb5e8e4016220215) Thanks
  [@sQVe](https://github.com/sQVe)! - Add tab keys to `phi attach`. In normal mode, `t` creates a
  tab, `H` and `L` focus the previous and next tab, and `1` to `9` focus a tab by number. Each of
  these keys stays in normal mode. The status bar lists the focused workspace's tabs by number and
  marks the active one, such as `1 [2] 3`.

- [#57](https://github.com/sQVe/phi/pull/57)
  [`fa6fa3d`](https://github.com/sQVe/phi/commit/fa6fa3d53f8d4dfb8c8ce3175b3e5856dfdee647) Thanks
  [@sQVe](https://github.com/sQVe)! - Print JSON by default for
  `phi workspace list|create|focus|rename|close`, `phi tab list|create|focus|close`, and
  `phi pane list|split|focus|zoom|resize|close|process-info`. `--json` is still accepted and prints
  the same JSON. `phi pane read` and `phi pane send` keep text output by default.

- [#37](https://github.com/sQVe/phi/pull/37)
  [`1bafad4`](https://github.com/sQVe/phi/commit/1bafad4fa611fa0436d691f549a7406d4c4087a8) Thanks
  [@sQVe](https://github.com/sQVe)! - `phi workspace create` no longer focuses the new workspace,
  unless no workspace is focused. Add `--focus` to focus it. `--no-focus` keeps the default, and the
  last of the two flags wins. Without `--label`, the server names the workspace after the base name
  of its directory.

- [#24](https://github.com/sQVe/phi/pull/24)
  [`065f32f`](https://github.com/sQVe/phi/commit/065f32f41757b30921112f6d81ba29826ca2d2f3) Thanks
  [@sQVe](https://github.com/sQVe)! - Send a store snapshot after welcoming a connection, then
  publish each store change with its own revision. Connections can request a fresh snapshot with
  `resync` after a missed change.

- [#61](https://github.com/sQVe/phi/pull/61)
  [`e4401f8`](https://github.com/sQVe/phi/commit/e4401f8a976d6fa9112be58dae81cdf8b5cf960c) Thanks
  [@sQVe](https://github.com/sQVe)! - Draw a pane from its scroll position. The client fetches
  history rows it lacks from the server, keeps the rows on screen in its cache, and holds the view
  in place while new output arrives.

- [#37](https://github.com/sQVe/phi/pull/37)
  [`1bafad4`](https://github.com/sQVe/phi/commit/1bafad4fa611fa0436d691f549a7406d4c4087a8) Thanks
  [@sQVe](https://github.com/sQVe)! - Show a side list of workspaces in the attached client, with
  the focused one marked. Panes are now 20 columns narrower. In normal mode, `j` and `k` focus the
  next and previous workspace and wrap at the ends, `c` creates a workspace in the directory `phi`
  started in, and `X` closes the focused workspace.

- [#39](https://github.com/sQVe/phi/pull/39)
  [`1784dd4`](https://github.com/sQVe/phi/commit/1784dd415afc63c36d4940e12faf60333fff4fb0) Thanks
  [@sQVe](https://github.com/sQVe)! - Add Phi mode keys for panes. After `Ctrl-b`, `s` splits the
  focused pane below, `v` splits it to the right, `h` and `l` focus the previous and next pane in
  the tab, and `x` closes the focused pane.

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

- [#43](https://github.com/sQVe/phi/pull/43)
  [`59376c8`](https://github.com/sQVe/phi/commit/59376c86b710c42499db33d3311408541e656cd1) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `phi client list`, which lists the attached clients, their
  views, and the foreground client. Add `phi detach --client <id>` to detach one client. Without
  `--client`, `phi detach` detaches the foreground client, and an unknown id fails with
  `unknownClient`. Both commands support `--socket` and `--json`.

- [#39](https://github.com/sQVe/phi/pull/39)
  [`1784dd4`](https://github.com/sQVe/phi/commit/1784dd415afc63c36d4940e12faf60333fff4fb0) Thanks
  [@sQVe](https://github.com/sQVe)! - Draw every pane of the focused tab in the terminal client at
  its layout rectangle. When a tab has two or more panes, each pane gets its own thin frame with one
  blank column between side-by-side frames, and the focused pane's frame is drawn in an accent
  color. A tab with one pane has no frame and fills the whole area. Resizing the terminal redraws
  each pane at its new size.

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

- [#50](https://github.com/sQVe/phi/pull/50)
  [`96730f7`](https://github.com/sQVe/phi/commit/96730f706bd91285e99afea7e326c90d4714f2d2) Thanks
  [@sQVe](https://github.com/sQVe)! - A restored shell no longer starts in a folder that only shares
  the name of its deleted folder.

- [#40](https://github.com/sQVe/phi/pull/40)
  [`16da8dc`](https://github.com/sQVe/phi/commit/16da8dc79b762a5e64815ea123c8ba9ca17126f7) Thanks
  [@sQVe](https://github.com/sQVe)! - Fix a black box that showed below a pane for a moment after it
  grew, such as on zoom or when a sibling pane closed. New rows now use the default background until
  the server sends their content.

- [#63](https://github.com/sQVe/phi/pull/63)
  [`cf2c278`](https://github.com/sQVe/phi/commit/cf2c27898e914609935b9d3c9390e31ebce4e8fc) Thanks
  [@sQVe](https://github.com/sQVe)! - The focused pane shows its cursor with the terminal's own
  cursor, in the shape and blink the program set with DECSCUSR. It hides when the program hides its
  cursor or the pane is scrolled. Unfocused panes still draw their cursor as an inverse cell.

- [#60](https://github.com/sQVe/phi/pull/60)
  [`f7a9779`](https://github.com/sQVe/phi/commit/f7a977932d7669e3cad287687c52841729da370b) Thanks
  [@sQVe](https://github.com/sQVe)! - Pass a pane's bell to the terminal of the foreground client,
  and pass a pane's clipboard write (OSC 52) to its clipboard. Phi copies with wl-copy, xclip, or
  xsel when it can, and writes OSC 52 over SSH or when no tool works.

- [#32](https://github.com/sQVe/phi/pull/32)
  [`82052e8`](https://github.com/sQVe/phi/commit/82052e8cb4f3c875fd3c78070b0a736d01bcfd70) Thanks
  [@sQVe](https://github.com/sQVe)! - Show the palette and default colors a program sets with OSC 4,
  10, and 11 in `phi attach`.

- [#55](https://github.com/sQVe/phi/pull/55)
  [`4ce5547`](https://github.com/sQVe/phi/commit/4ce55476834d67fb0bf072605e5bcee428d5a36f) Thanks
  [@sQVe](https://github.com/sQVe)! - `phi tab create` now adds the tab without moving focus, as
  herdr does. Pass `--focus` to show the new tab. `--no-focus` is accepted and keeps the default.
  The new-tab key in `phi attach` still shows the new tab.

- [#32](https://github.com/sQVe/phi/pull/32)
  [`82052e8`](https://github.com/sQVe/phi/commit/82052e8cb4f3c875fd3c78070b0a736d01bcfd70) Thanks
  [@sQVe](https://github.com/sQVe)! - Answer OSC 4, 10, and 11 color queries in the pane with the
  colors of the attached client's terminal. Panes keep white on black until a client reports its
  colors.

- [#63](https://github.com/sQVe/phi/pull/63)
  [`cf2c278`](https://github.com/sQVe/phi/commit/cf2c27898e914609935b9d3c9390e31ebce4e8fc) Thanks
  [@sQVe](https://github.com/sQVe)! - Panes now draw strikethrough, blink, and invisible text.

- [#43](https://github.com/sQVe/phi/pull/43)
  [`59376c8`](https://github.com/sQVe/phi/commit/59376c86b710c42499db33d3311408541e656cd1) Thanks
  [@sQVe](https://github.com/sQVe)! - Closing the focused tab now shows the previous tab, or the
  next one when the first tab closed, as herdr does. Client views on the closed tab follow the new
  tab of the default view.
