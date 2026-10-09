import { afterEach, expect, it } from 'bun:test';

import { createTestRenderer } from '@opentui/core/testing';
import type { TestRendererSetup } from '@opentui/core/testing';

import { createRowCache } from '../src/client/client.ts';
import { createRowPublisher } from '../src/server/rowPublisher.ts';
import { PaneRenderable } from '../src/ui/paneRenderable.ts';
import { createTerminal } from '../src/vt/vt.ts';

let setup: TestRendererSetup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

it('redraws the rows that scroll when the publisher omits rows it already sent', async () => {
  const created = await createTestRenderer({ width: 5, height: 3 });
  const cache = createRowCache({ rowLimit: 10 });
  const pane = new PaneRenderable(created.renderer, { cache, width: 5, height: 3 });
  const result = createTerminal(5, 3, 1_000_000);

  if (!result.ok) {
    throw new Error(result.reason);
  }

  using terminal = result.terminal;
  using publisher = createRowPublisher(
    terminal,
    1,
    { columns: 5, rows: 3 },
    {
      requestPublication: () => undefined,
    },
  );
  const encoder = new TextEncoder();

  setup = created;
  created.renderer.root.add(pane);

  publisher.subscribe((update) => {
    pane.draw(cache.apply(update));
  });

  terminal.write(encoder.encode('one\r\ntwo\r\nthree'));
  terminal.stableRows();
  publisher.publish();
  await created.renderOnce();
  terminal.write(encoder.encode('\r\nfour'));
  terminal.stableRows();
  publisher.publish();
  await created.renderOnce();

  expect(
    created
      .captureCharFrame()
      .split('\n')
      .map((line) => line.trimEnd()),
  ).toEqual(['two', 'three', 'four', '']);
});
