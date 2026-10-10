---
'phi': patch
---

Pace row updates to a slow `phi attach` client. The client acks each row update after it draws it,
and the server stops sending to a client that falls too far behind instead of buffering without
limit.
