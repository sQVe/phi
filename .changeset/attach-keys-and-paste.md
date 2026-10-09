---
'phi': minor
---

Send keys and paste from `phi attach` to the pane. Insert mode sends every key, and Ctrl+B enters
normal mode, where `i` or Escape returns to insert and Ctrl+B sends a literal Ctrl+B. The status bar
shows `INSERT` or `NORMAL`. Cursor keys follow the pane's application cursor mode, and paste uses
bracketed paste markers when the pane asks for them.
