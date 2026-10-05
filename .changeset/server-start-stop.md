---
'phi': minor
---

Add `phi server start`, `phi server stop`, and `phi server run`. `phi server start` runs the server
in the background with one shell, and `phi server stop` ends the shell and removes the socket. Each
command takes `--socket` for another socket path and `--json` for a parseable form, and none
prompts. The server refuses a symlink or another file at the socket path, and replaces only a stale
socket.
