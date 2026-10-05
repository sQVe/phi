---
'phi': minor
---

Add `phi server start`, `phi server stop`, and `phi server run`. `phi server start` runs the server
in the background with one shell, and `phi server stop` ends the shell and removes the socket. Each
command takes `--socket` for another socket path and `--json` for a parseable form, and none
prompts. The server refuses a symlink or another file at the socket path, a socket path under a
directory other users can change, a socket directory other users can read, write, or enter, a socket
path whose parent directories do not exist, and a socket another user owns. It replaces only a
socket that refuses connections. The server locks a `.lock` file next to its socket, so only one
server runs on a socket path. `phi server start` succeeds only when the server it started is ready,
and it prints that server's error when the server cannot start its shell or write its log.
`phi server stop` also stops a server from another Phi build, so a restart moves the server to the
new build.
