// Thin C layer over libghostty-vt so Bun makes one FFI call per write and one per frame, not one per cell.
#include <ghostty/vt.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  GhosttyTerminal terminal;
  uint8_t *reply;
  size_t reply_len;
  size_t reply_capacity;
  bool reply_lost;
} Pane;

// The terminal sends replies during a write and cannot be asked to pause, so the buffer grows
// to hold every reply until the binding reads it.
static void write_pty(GhosttyTerminal terminal, void *userdata, const uint8_t *data, size_t len) {
  (void)terminal;
  Pane *pane = userdata;
  size_t needed = pane->reply_len + len;
  if (needed > pane->reply_capacity) {
    size_t capacity = pane->reply_capacity * 2;
    if (capacity < needed) capacity = needed;
    uint8_t *reply = realloc(pane->reply, capacity);
    if (!reply) {
      pane->reply_lost = true;
      return;
    }
    pane->reply = reply;
    pane->reply_capacity = capacity;
  }
  memcpy(pane->reply + pane->reply_len, data, len);
  pane->reply_len = needed;
}

// Answer DA like xterm: VT220 with ANSI color.
static bool device_attributes(GhosttyTerminal terminal, void *userdata, GhosttyDeviceAttributes *out) {
  (void)terminal;
  (void)userdata;
  out->primary.conformance_level = 62;
  out->primary.features[0] = 22;
  out->primary.num_features = 1;
  out->secondary.device_type = 1;
  out->secondary.firmware_version = 10;
  out->secondary.rom_cartridge = 0;
  out->tertiary.unit_id = 0;
  return true;
}

Pane *pane_new(uint16_t cols, uint16_t rows) {
  GhosttyTerminal terminal = NULL;
  if (ghostty_terminal_new(NULL, &terminal, cols, rows) != GHOSTTY_SUCCESS) return NULL;
  Pane *pane = calloc(1, sizeof(Pane));
  if (!pane) {
    ghostty_terminal_free(terminal);
    return NULL;
  }
  pane->terminal = terminal;
  // Without a write_pty callback the terminal drops its replies.
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_USERDATA, pane);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY, (const void *)write_pty);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES, (const void *)device_attributes);
  // OSC 10 and 11 queries only get a reply when default colors are set.
  GhosttyColorRgb foreground = {255, 255, 255};
  GhosttyColorRgb background = {0, 0, 0};
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &foreground);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &background);
  return pane;
}

void pane_free(Pane *pane) {
  ghostty_terminal_free(pane->terminal);
  free(pane->reply);
  free(pane);
}

// Returns how many reply bytes wait in pane_reply, or -1 when a reply did not fit in memory.
static int64_t waiting_reply_len(Pane *pane) {
  if (pane->reply_lost) return -1;
  return (int64_t)pane->reply_len;
}

// Parses PTY output and returns waiting_reply_len. Program output never changes the terminal's
// size: a patch makes DECCOLM erase without resizing.
int64_t pane_write(Pane *pane, const uint8_t *data, size_t len) {
  ghostty_terminal_vt_write(pane->terminal, data, len);
  return waiting_reply_len(pane);
}

const uint8_t *pane_reply(Pane *pane) { return pane->reply; }

void pane_clear_reply(Pane *pane) {
  pane->reply_len = 0;
  pane->reply_lost = false;
}

// Returns waiting_reply_len, since a resize can send an in-band size report, or -2 when
// libghostty-vt refuses the resize.
int64_t pane_resize(Pane *pane, uint16_t cols, uint16_t rows) {
  if (ghostty_terminal_resize(pane->terminal, cols, rows, 1, 1) != GHOSTTY_SUCCESS) return -2;
  return waiting_reply_len(pane);
}

// Copies the active screen as plain text into buffer. Returns the text's length, or -1 when the
// formatter fails. When the length is more than len, the caller reads again with a larger buffer.
int64_t pane_text(Pane *pane, uint8_t *buffer, size_t len) {
  GhosttyFormatterTerminalOptions options = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  options.extra = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalExtra);
  options.extra.screen = GHOSTTY_INIT_SIZED(GhosttyFormatterScreenExtra);
  options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
  options.trim = true;
  GhosttyFormatter formatter = NULL;
  if (ghostty_formatter_terminal_new(NULL, &formatter, pane->terminal, options) != GHOSTTY_SUCCESS) return -1;
  size_t written = 0;
  GhosttyResult result = ghostty_formatter_format_buf(formatter, buffer, len, &written);
  ghostty_formatter_free(formatter);
  if (result != GHOSTTY_SUCCESS && result != GHOSTTY_OUT_OF_SPACE) return -1;
  return (int64_t)written;
}

// buildVt.sh defines PHI_GHOSTTY_COMMIT from its pin, so the library reports the Ghostty it links.
const char *shim_ghostty_commit(void) { return PHI_GHOSTTY_COMMIT; }
