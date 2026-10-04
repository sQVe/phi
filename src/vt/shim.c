// Thin C layer over libghostty-vt so Bun makes one FFI call per write and one per frame, not one per cell.
#include <ghostty/vt.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  GhosttyTerminal terminal;
  GhosttyRenderState state;
  GhosttyRenderStateRowIterator rows;
  GhosttyRenderStateRowCells cells;
  uint8_t *reply;
  size_t reply_len;
  size_t reply_capacity;
  bool reply_lost;
  // Stable row numbers, see pane_stable_rows.
  GhosttyTrackedGridRef anchor;
  uint64_t anchor_number;
  uint64_t active_top;
  uint64_t epoch;
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

void pane_free(Pane *pane) {
  ghostty_tracked_grid_ref_free(pane->anchor);
  ghostty_render_state_row_cells_free(pane->cells);
  ghostty_render_state_row_iterator_free(pane->rows);
  ghostty_render_state_free(pane->state);
  ghostty_terminal_free(pane->terminal);
  free(pane->reply);
  free(pane);
}

Pane *pane_new(uint16_t cols, uint16_t rows, uint64_t scrollback_bytes) {
  Pane *pane = calloc(1, sizeof(Pane));
  if (!pane) return NULL;
  bool created = ghostty_terminal_new(NULL, &pane->terminal, cols, rows) == GHOSTTY_SUCCESS &&
                 ghostty_render_state_new(NULL, &pane->state) == GHOSTTY_SUCCESS &&
                 ghostty_render_state_row_iterator_new(NULL, &pane->rows) == GHOSTTY_SUCCESS &&
                 ghostty_render_state_row_cells_new(NULL, &pane->cells) == GHOSTTY_SUCCESS;
  if (!created) {
    pane_free(pane);
    return NULL;
  }
  GhosttyTerminal terminal = pane->terminal;
  size_t max_bytes = scrollback_bytes;
  if (ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &max_bytes) != GHOSTTY_SUCCESS) {
    pane_free(pane);
    return NULL;
  }
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
  // Reflow rewraps rows, so rows read before the resize no longer match their numbers.
  pane->epoch++;
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

// Color keys: 0 is the default color, 1-256 a palette index plus 1, so the client's theme
// applies, and 0x1000000 plus the value an RGB color.
static uint32_t rgb_key(GhosttyColorRgb rgb) {
  return 0x1000000u | ((uint32_t)rgb.r << 16) | ((uint32_t)rgb.g << 8) | rgb.b;
}

static uint32_t color_key(GhosttyStyleColor color) {
  if (color.tag == GHOSTTY_STYLE_COLOR_PALETTE) return (uint32_t)color.value.palette + 1;
  if (color.tag == GHOSTTY_STYLE_COLOR_RGB) return rgb_key(color.value.rgb);
  return 0;
}

// Cells erased with a background set carry that color in the cell itself, without a style.
static uint32_t content_background_key(GhosttyCell raw) {
  GhosttyCellContentTag tag = GHOSTTY_CELL_CONTENT_CODEPOINT;
  ghostty_cell_get(raw, GHOSTTY_CELL_DATA_CONTENT_TAG, &tag);
  if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE) {
    GhosttyColorPaletteIndex index = 0;
    ghostty_cell_get(raw, GHOSTTY_CELL_DATA_COLOR_PALETTE, &index);
    return (uint32_t)index + 1;
  }
  if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_RGB) {
    GhosttyColorRgb rgb = {0, 0, 0};
    ghostty_cell_get(raw, GHOSTTY_CELL_DATA_COLOR_RGB, &rgb);
    return rgb_key(rgb);
  }
  return 0;
}

// Fills the fg and bg keys and returns the cell's flags without the grapheme bit. style is NULL
// for an unstyled cell.
static uint32_t style_flags(GhosttyCell raw, const GhosttyStyle *style, uint32_t *fg, uint32_t *bg) {
  uint32_t flags = 0;
  *fg = 0;
  *bg = content_background_key(raw);
  if (style) {
    *fg = color_key(style->fg_color);
    if (*bg == 0) *bg = color_key(style->bg_color);
    if (style->bold) flags |= 1;
    if (style->faint) flags |= 2;
    if (style->italic) flags |= 4;
    if (style->underline) flags |= 8;
    if (style->inverse) flags |= 16;
  }
  GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
  ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
  return flags | ((uint32_t)wide << 8);
}

static uint32_t cell_style(GhosttyRenderStateRowCells cells, GhosttyCell raw, uint32_t *fg, uint32_t *bg) {
  bool styled = false;
  ghostty_render_state_row_cells_get(cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_HAS_STYLING, &styled);
  if (!styled) return style_flags(raw, NULL, fg, bg);
  GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  ghostty_render_state_row_cells_get(cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
  return style_flags(raw, &style, fg, bg);
}

// The caller's buffers for one frame. A word past the end of a buffer is counted but not
// written, so the counts tell the caller how large the buffers must be. The counts are 64-bit
// because a 65535x65535 screen needs more than 2^32 words, and a wrapped count would pass the
// bounds checks.
typedef struct {
  uint32_t *cells;
  uint64_t cells_len;
  uint64_t cells_used;
  uint32_t *graphemes;
  uint64_t graphemes_len;
  uint64_t graphemes_used;
} FrameOutput;

static void put_cell_word(FrameOutput *out, uint32_t value) {
  if (out->cells_used < out->cells_len) out->cells[out->cells_used] = value;
  out->cells_used++;
}

static void put_grapheme(GhosttyRenderStateRowCells cells, FrameOutput *out, uint32_t length) {
  uint64_t needed = 2 + (uint64_t)length;
  if (out->graphemes_used + needed <= out->graphemes_len) {
    uint32_t *grapheme = out->graphemes + out->graphemes_used;
    // The binding never passes a cells buffer past 2^32 words, so a returned index fits.
    grapheme[0] = (uint32_t)out->cells_used;
    grapheme[1] = length;
    ghostty_render_state_row_cells_get(cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, grapheme + 2);
  }
  out->graphemes_used += needed;
}

static void read_cell(GhosttyRenderStateRowCells cells, FrameOutput *out) {
  GhosttyCell raw = 0;
  ghostty_render_state_row_cells_get(cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
  uint32_t base = 0;
  ghostty_cell_get(raw, GHOSTTY_CELL_DATA_CODEPOINT, &base);
  uint32_t fg = 0;
  uint32_t bg = 0;
  uint32_t flags = cell_style(cells, raw, &fg, &bg);
  uint32_t length = 0;
  ghostty_render_state_row_cells_get(cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &length);
  if (length > 1) {
    flags |= 1u << 16;
    put_grapheme(cells, out, length);
  }
  put_cell_word(out, base);
  put_cell_word(out, fg);
  put_cell_word(out, bg);
  put_cell_word(out, flags);
}

static void read_row(Pane *pane, uint16_t y, uint16_t cols, FrameOutput *out) {
  put_cell_word(out, y);
  ghostty_render_state_row_get(pane->rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &pane->cells);
  for (uint16_t x = 0; x < cols; x++) {
    if (ghostty_render_state_row_cells_next(pane->cells)) {
      read_cell(pane->cells, out);
      continue;
    }
    for (int word = 0; word < 4; word++) put_cell_word(out, 0);
  }
}

static bool private_mode(Pane *pane, uint16_t value) {
  GhosttyTerminalModeConfig config = {.mode = ghostty_mode_new(value, false), .value = false};
  ghostty_terminal_get(pane->terminal, GHOSTTY_TERMINAL_DATA_MODE, &config);
  return config.value;
}

// Bit i is DEC private mode private_modes[i]. Bit 7 is set while the alternate screen is active,
// whichever of modes 47, 1047, and 1049 switched to it.
static uint32_t mode_bits(Pane *pane) {
  static const uint16_t private_modes[] = {1, 2004, 9, 1000, 1002, 1003, 1006};
  uint32_t bits = 0;
  for (size_t i = 0; i < sizeof private_modes / sizeof private_modes[0]; i++) {
    if (private_mode(pane, private_modes[i])) bits |= 1u << i;
  }
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  ghostty_terminal_get(pane->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen);
  if (screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE) bits |= 1u << 7;
  return bits;
}

static void read_cursor(Pane *pane, uint64_t *x, uint64_t *y, uint64_t *visible) {
  GhosttyRenderStateCursor cursor = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  ghostty_render_state_get(pane->state, GHOSTTY_RENDER_STATE_DATA_CURSOR, &cursor);
  *x = cursor.viewport_x;
  *y = cursor.viewport_y;
  *visible = cursor.visible && cursor.viewport_has_value;
}

// Reads the rows that changed since the last frame. Each row goes to cells as its viewport y,
// then 4 words per cell: code point, fg key, bg key, and flags, with keys as at color_key. Flags
// bits 0-4 are bold, faint, italic, underline, and inverse, bits 8-9 the GhosttyCellWide value,
// and bit 16 means the cell's cluster is in graphemes as: the index in cells of the cell's code
// point, the cluster length, then its code points.
// info receives the cell words and grapheme words the frame needs, the cursor x, y, and
// visibility, and the bits of mode_bits. Returns the number of rows, -1 when a buffer is too
// small, or -2 when libghostty-vt cannot update. Rows stay dirty unless the whole frame fits.
int32_t pane_frame(Pane *pane, uint32_t *cells, uint64_t cells_len, uint32_t *graphemes, uint64_t graphemes_len,
                   uint64_t *info) {
  if (ghostty_render_state_update(pane->state, pane->terminal) != GHOSTTY_SUCCESS) return -2;
  uint16_t cols = 0;
  ghostty_render_state_get(pane->state, GHOSTTY_RENDER_STATE_DATA_COLS, &cols);
  ghostty_render_state_get(pane->state, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &pane->rows);
  FrameOutput out = {.cells = cells, .cells_len = cells_len, .graphemes = graphemes, .graphemes_len = graphemes_len};
  int32_t rows = 0;
  uint16_t y = 0;
  while (ghostty_render_state_row_iterator_next_dirty(pane->rows, &y)) {
    read_row(pane, y, cols, &out);
    rows++;
  }
  info[0] = out.cells_used;
  info[1] = out.graphemes_used;
  read_cursor(pane, &info[2], &info[3], &info[4]);
  info[5] = mode_bits(pane);
  if (out.cells_used > cells_len || out.graphemes_used > graphemes_len) return -1;
  ghostty_render_state_clean(pane->state);
  return rows;
}

// The next pane_frame returns every row, such as for a client that just attached.
void pane_mark_all_dirty(Pane *pane) {
  GhosttyRenderStateDirty full = GHOSTTY_RENDER_STATE_DIRTY_FULL;
  ghostty_render_state_set(pane->state, GHOSTTY_RENDER_STATE_OPTION_DIRTY, &full);
}

// Fills info with the scrollback rows the active screen retains, the byte limit, and the bytes
// of memory the primary screen's pages use.
void pane_scrollback(Pane *pane, uint64_t *info) {
  size_t rows = 0;
  size_t max_bytes = 0;
  GhosttyTerminalMemoryUsage memory = GHOSTTY_INIT_SIZED(GhosttyTerminalMemoryUsage);
  ghostty_terminal_get(pane->terminal, GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, &rows);
  ghostty_terminal_get(pane->terminal, GHOSTTY_TERMINAL_DATA_SCROLLBACK_MAX_BYTES, &max_bytes);
  ghostty_terminal_get(pane->terminal, GHOSTTY_TERMINAL_DATA_MEMORY_USAGE, &memory);
  info[0] = rows;
  info[1] = max_bytes;
  info[2] = memory.primary_resident_bytes;
}

static GhosttyPoint active_top_point(void) {
  return (GhosttyPoint){.tag = GHOSTTY_POINT_TAG_ACTIVE, .value = {.coordinate = {.x = 0, .y = 0}}};
}

// Returns whether the anchor still marks its row, and puts that row's screen y in anchor_y.
// Reflow on a narrower resize can put more rows above the anchor than its number, so the rows
// above it would get negative numbers. Such an anchor counts as lost.
static bool anchor_row(Pane *pane, uint64_t *anchor_y) {
  if (!pane->anchor) return false;
  GhosttyPointCoordinate anchor = {0, 0};
  if (ghostty_tracked_grid_ref_point(pane->anchor, GHOSTTY_POINT_TAG_SCREEN, &anchor) != GHOSTTY_SUCCESS) return false;
  *anchor_y = anchor.y;
  return anchor.y <= pane->anchor_number;
}

static bool track_active_top(Pane *pane) {
  GhosttyPoint top = active_top_point();
  if (pane->anchor) return ghostty_tracked_grid_ref_set(pane->anchor, pane->terminal, top) == GHOSTTY_SUCCESS;
  return ghostty_terminal_grid_ref_track(pane->terminal, top, &pane->anchor) == GHOSTTY_SUCCESS;
}

// Gives each row of the primary screen a number that stays with the row while output scrolls it
// into history and the oldest history is pruned, like WezTerm's StableRowIndex. libghostty-vt has
// no such number, so a tracked grid ref marks the active area's top row with its number; the next
// call reads where that row moved to in screen coordinates. Each call moves the ref back to the
// active top. When the marked row is gone (reset, or more output than the history holds between
// two calls), when reflow put more rows above it than its number, or after a resize, the epoch
// grows and numbers restart above every number used before.
// info receives the number of screen row 0 (the oldest history row), the number of the active
// area's top row, the epoch, and 1 when the alternate screen is active. The alternate screen has
// no history, so both numbers stay at the primary screen's active top. Returns false when
// libghostty-vt cannot track the active top.
static bool update_stable_rows(Pane *pane, uint64_t *info) {
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  ghostty_terminal_get(pane->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen);
  if (screen != GHOSTTY_TERMINAL_SCREEN_PRIMARY) {
    info[0] = pane->active_top;
    info[1] = pane->active_top;
    info[2] = pane->epoch;
    info[3] = 1;
    return true;
  }
  size_t scrollback = 0;
  ghostty_terminal_get(pane->terminal, GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, &scrollback);
  uint64_t anchor_y = 0;
  if (anchor_row(pane, &anchor_y)) {
    pane->active_top = pane->anchor_number - anchor_y + scrollback;
  } else if (pane->anchor) {
    pane->epoch++;
    uint16_t rows = 0;
    ghostty_terminal_get(pane->terminal, GHOSTTY_TERMINAL_DATA_ROWS, &rows);
    pane->active_top += rows + scrollback;
  } else {
    pane->active_top = scrollback;
  }
  if (!track_active_top(pane)) return false;
  pane->anchor_number = pane->active_top;
  info[0] = pane->active_top - scrollback;
  info[1] = pane->active_top;
  info[2] = pane->epoch;
  info[3] = 0;
  return true;
}

bool pane_stable_rows(Pane *pane, uint64_t *info) { return update_stable_rows(pane, info); }

// Returns the cluster length and writes the cluster to graphemes when it fits.
static uint32_t read_ref_grapheme(const GhosttyGridRef *ref, FrameOutput *out) {
  uint64_t start = out->graphemes_used + 2;
  bool room = start < out->graphemes_len;
  uint32_t *buffer = room ? out->graphemes + start : NULL;
  size_t buffer_len = room ? out->graphemes_len - start : 0;
  size_t length = 0;
  ghostty_grid_ref_graphemes(ref, buffer, buffer_len, &length);
  if (length <= 1) return (uint32_t)length;
  if (start + length <= out->graphemes_len) {
    out->graphemes[out->graphemes_used] = (uint32_t)out->cells_used;
    out->graphemes[out->graphemes_used + 1] = (uint32_t)length;
  }
  out->graphemes_used = start + length;
  return (uint32_t)length;
}

static void read_ref_cell(const GhosttyGridRef *ref, FrameOutput *out) {
  GhosttyCell raw = 0;
  ghostty_grid_ref_cell(ref, &raw);
  uint32_t base = 0;
  ghostty_cell_get(raw, GHOSTTY_CELL_DATA_CODEPOINT, &base);
  bool styled = false;
  ghostty_cell_get(raw, GHOSTTY_CELL_DATA_HAS_STYLING, &styled);
  GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  if (styled) ghostty_grid_ref_style(ref, &style);
  uint32_t fg = 0;
  uint32_t bg = 0;
  uint32_t flags = style_flags(raw, styled ? &style : NULL, &fg, &bg);
  GhosttyCellContentTag tag = GHOSTTY_CELL_CONTENT_CODEPOINT;
  ghostty_cell_get(raw, GHOSTTY_CELL_DATA_CONTENT_TAG, &tag);
  if (tag == GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME && read_ref_grapheme(ref, out) > 1) flags |= 1u << 16;
  put_cell_word(out, base);
  put_cell_word(out, fg);
  put_cell_word(out, bg);
  put_cell_word(out, flags);
}

// Resolving a screen point walks the page list, so the row is resolved once. A grid ref names a
// page node and a cell in it, and the row's other cells share the node and the y.
static bool read_screen_row(Pane *pane, uint64_t y, uint32_t offset, uint16_t cols, FrameOutput *out) {
  GhosttyPoint point = {.tag = GHOSTTY_POINT_TAG_SCREEN, .value = {.coordinate = {.x = 0, .y = (uint32_t)y}}};
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  if (ghostty_terminal_grid_ref(pane->terminal, point, &ref) != GHOSTTY_SUCCESS) return false;
  put_cell_word(out, offset);
  for (uint16_t x = 0; x < cols; x++) {
    ref.x = x;
    read_ref_cell(&ref, out);
  }
  return true;
}

// Reads up to count rows of the active screen from the row numbered first, as pane_stable_rows
// numbers them, in the pane_frame layout except that each row's first word is its offset from
// first. It stops at the last row. The rows stay as dirty as they were.
// info receives the cell words and grapheme words the rows need. Returns the number of rows, -1
// when a buffer is too small, -2 when epoch is not the current epoch, -3 when the row numbered
// first is gone, or -4 when libghostty-vt cannot track the active top or resolve a row.
int64_t pane_read_rows(Pane *pane, uint64_t epoch, uint64_t first, uint32_t count, uint32_t *cells,
                       uint64_t cells_len, uint32_t *graphemes, uint64_t graphemes_len, uint64_t *info) {
  uint64_t stable[4] = {0, 0, 0, 0};
  if (!update_stable_rows(pane, stable)) return -4;
  if (stable[2] != epoch) return -2;
  if (first < stable[0]) return -3;
  size_t total = 0;
  uint16_t cols = 0;
  ghostty_terminal_get(pane->terminal, GHOSTTY_TERMINAL_DATA_TOTAL_ROWS, &total);
  ghostty_terminal_get(pane->terminal, GHOSTTY_TERMINAL_DATA_COLS, &cols);
  uint64_t y = first - stable[0];
  uint64_t available = y < total ? total - y : 0;
  uint32_t rows = available < count ? (uint32_t)available : count;
  FrameOutput out = {.cells = cells, .cells_len = cells_len, .graphemes = graphemes, .graphemes_len = graphemes_len};
  for (uint32_t row = 0; row < rows; row++) {
    if (!read_screen_row(pane, y + row, row, cols, &out)) return -4;
  }
  info[0] = out.cells_used;
  info[1] = out.graphemes_used;
  if (out.cells_used > cells_len || out.graphemes_used > graphemes_len) return -1;
  return rows;
}

// buildVt.sh defines PHI_GHOSTTY_COMMIT from its pin, so the library reports the Ghostty it links.
const char *shim_ghostty_commit(void) { return PHI_GHOSTTY_COMMIT; }
