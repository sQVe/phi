import type { TerminalTheme } from '../client/client.ts';

interface DetectedColors {
  palette: readonly (string | null)[];
  defaultForeground: string | null;
  defaultBackground: string | null;
}

const paletteSize = 16;

const hexColor = /^#[0-9a-f]{6}$/i;

const parseHex = (hex: string | null): number | undefined =>
  hex !== null && hexColor.test(hex) ? Number.parseInt(hex.slice(1), 16) : undefined;

// Returns undefined unless the terminal answered every color a theme needs.
export const themeFromDetectedColors = (colors: DetectedColors): TerminalTheme | undefined => {
  const foreground = parseHex(colors.defaultForeground);
  const background = parseHex(colors.defaultBackground);
  const palette: number[] = [];

  for (const hex of colors.palette.slice(0, paletteSize)) {
    const color = parseHex(hex);

    if (color !== undefined) {
      palette.push(color);
    }
  }

  if (foreground === undefined || background === undefined || palette.length !== paletteSize) {
    return undefined;
  }

  return { foreground, background, palette };
};
