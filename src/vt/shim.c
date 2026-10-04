// Thin C layer over libghostty-vt so Bun makes one FFI call per write and one per frame, not one per cell.
#include <ghostty/vt.h>
#include <stdlib.h>

typedef struct {
  GhosttyTerminal terminal;
} Pane;

Pane *pane_new(uint16_t cols, uint16_t rows) {
  GhosttyTerminal terminal = NULL;
  if (ghostty_terminal_new(NULL, &terminal, cols, rows) != GHOSTTY_SUCCESS) return NULL;
  Pane *pane = calloc(1, sizeof(Pane));
  if (!pane) {
    ghostty_terminal_free(terminal);
    return NULL;
  }
  pane->terminal = terminal;
  return pane;
}

void pane_free(Pane *pane) {
  ghostty_terminal_free(pane->terminal);
  free(pane);
}
