import { dlopen, FFIType } from 'bun:ffi';
import { expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const library = fileURLToPath(new URL('../build/libphi-vt.so', import.meta.url));

it('builds a shim library that creates and frees a pane', () => {
  expect(existsSync(library)).toBe(true);

  const { symbols, close } = dlopen(library, {
    pane_new: { args: [FFIType.u16, FFIType.u16, FFIType.u64], returns: FFIType.ptr },
    pane_free: { args: [FFIType.ptr], returns: FFIType.void },
  });

  const pane = symbols.pane_new(80, 24, 0);

  expect(pane).not.toBeNull();

  symbols.pane_free(pane);
  close();
});
