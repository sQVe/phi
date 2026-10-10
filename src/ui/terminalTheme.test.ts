import { expect, it } from 'bun:test';

import { themeFromDetectedColors } from './terminalTheme.ts';

const hexPalette = Array.from({ length: 16 }, (_, index) => `#0000${index.toString(16)}0`);

it('converts detected hex colors to numbers', () => {
  const theme = themeFromDetectedColors({
    palette: hexPalette,
    defaultForeground: '#112233',
    defaultBackground: '#DDEEFF',
  });

  expect(theme).toEqual({
    foreground: 0x11_22_33,
    background: 0xdd_ee_ff,
    palette: Array.from({ length: 16 }, (_, index) => index * 0x10),
  });
});

it.each([
  ['a missing foreground', { defaultForeground: null }],
  ['a missing background', { defaultBackground: null }],
  ['a missing palette color', { palette: [...hexPalette.slice(0, 15), null] }],
  ['a short palette', { palette: hexPalette.slice(0, 15) }],
  ['a malformed color', { defaultBackground: 'blue' }],
])('gives no theme for %s', (_name, override) => {
  const colors = {
    palette: hexPalette,
    defaultForeground: '#112233',
    defaultBackground: '#ddeeff',
    ...override,
  };

  expect(themeFromDetectedColors(colors)).toBeUndefined();
});
