import { FrameBufferRenderable, RGBA, TextAttributes } from '@opentui/core';
import type { OptimizedBuffer, RenderContext } from '@opentui/core';

import type { RowCache } from '../client/client.ts';
import { CellFlag, CellWidth, cellWidthMask, cellWords } from '../rows/rows.ts';

interface PaneRenderableOptions {
  cache: RowCache;
  width: number;
  height: number;
}

interface Cursor {
  x: number;
  y: number;
  visible: boolean;
}

const rgbColorBase = 0x1_00_00_00;

const paletteLimit = 256;

const byteMask = 0xff;

const redShift = 16;

const greenShift = 8;

const blankCodePoint = 0x20;

const spacerWidths = new Set<number>([CellWidth.spacerTail, CellWidth.spacerHead]);

const flagAttributes: [CellFlag, number][] = [
  [CellFlag.bold, TextAttributes.BOLD],
  [CellFlag.faint, TextAttributes.DIM],
  [CellFlag.italic, TextAttributes.ITALIC],
  [CellFlag.underline, TextAttributes.UNDERLINE],
  [CellFlag.inverse, TextAttributes.INVERSE],
];

const colorOf = (word: number, fallback: RGBA): RGBA => {
  if (word === 0) {
    return fallback;
  }

  if (word > paletteLimit) {
    const rgb = word - rgbColorBase;

    return RGBA.fromInts(
      (rgb >> redShift) & byteMask,
      (rgb >> greenShift) & byteMask,
      rgb & byteMask,
    );
  }

  return RGBA.fromIndex(word - 1);
};

const attributesOf = (flags: number): number => {
  let attributes: number = TextAttributes.NONE;

  for (const [flag, attribute] of flagAttributes) {
    if ((flags & flag) !== 0) {
      attributes += attribute;
    }
  }

  return attributes;
};

const isSpacer = (flags: number): boolean => spacerWidths.has(flags & cellWidthMask);

const sameCursor = (left: Cursor | undefined, right: Cursor | undefined): boolean =>
  left?.x === right?.x && left?.y === right?.y && left?.visible === right?.visible;

// Draws the rows of one pane from its row cache. The frame buffer keeps the rows that did not
// change, so each frame draws only the rows named by draw.
export class PaneRenderable extends FrameBufferRenderable {
  private readonly cache: RowCache;
  private readonly pending = new Set<number>();
  private drawnCursor: Cursor | undefined;

  public constructor(context: RenderContext, { cache, width, height }: PaneRenderableOptions) {
    super(context, { width, height });
    this.cache = cache;
  }

  // Marks cache rows, counted from the active screen's top, for drawing on the next frame.
  public draw(rows: readonly number[]): void {
    for (const row of rows) {
      this.pending.add(row);
    }

    this.requestRender();
  }

  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    this.drawPending();
    super.renderSelf(buffer);
  }

  private drawPending(): void {
    const cursor = this.cache.cursor();

    if (!sameCursor(cursor, this.drawnCursor)) {
      this.pending.add(this.drawnCursor?.y ?? -1);
      this.pending.add(cursor?.y ?? -1);
      this.drawnCursor = cursor === undefined ? undefined : { ...cursor };
    }

    for (const index of this.pending) {
      this.drawRow(index);
    }

    this.pending.clear();
  }

  private drawRow(index: number): void {
    const row = this.cache.row(index);

    if (row === undefined || index >= this.frameBuffer.height) {
      return;
    }

    const cursor = this.cache.cursor();
    const cursorColumn = cursor?.visible === true && cursor.y === index ? cursor.x : undefined;
    const columns = Math.min(row.cells.length / cellWords, this.frameBuffer.width);

    this.frameBuffer.fillRect(0, index, this.frameBuffer.width, 1, RGBA.defaultBackground());

    for (let column = 0; column < columns; column++) {
      this.drawCell(row, column, index, column === cursorColumn);
    }
  }

  private drawCell(
    row: NonNullable<ReturnType<RowCache['row']>>,
    column: number,
    y: number,
    atCursor: boolean,
  ): void {
    const start = column * cellWords;
    const flags = row.cells[start + cellWords - 1] ?? 0;

    if (isSpacer(flags)) {
      return;
    }

    const codePoint = row.cells[start] ?? 0;

    const text =
      row.clusters.get(column) ??
      String.fromCodePoint(codePoint === 0 ? blankCodePoint : codePoint);

    const foreground = colorOf(row.cells[start + 1] ?? 0, RGBA.defaultForeground());
    const background = colorOf(row.cells[start + 2] ?? 0, RGBA.defaultBackground());
    const shownFlags = atCursor ? flags ^ CellFlag.inverse : flags;

    this.frameBuffer.drawText(text, column, y, foreground, background, attributesOf(shownFlags));
  }
}
