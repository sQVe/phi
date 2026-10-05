---
'phi': minor
---

Add the socket protocol. Rows and input use a binary codec, and control messages are checked JSON.
Every connection starts with a version handshake, and a client and server from different builds
refuse each other with an error that names both versions.
