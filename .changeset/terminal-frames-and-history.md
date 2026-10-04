---
'phi': minor
---

The terminal library reads the rows that changed, the cursor, and the terminal modes as one frame.
Rows keep a stable number while output scrolls them into history, the history keeps to a memory
limit, and a range of rows can be read again by number, also from history.
