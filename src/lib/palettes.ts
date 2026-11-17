// Colour palettes ("brand colours"). Milestone 3 adds a full palette manager;
// for now this just ships the Happy Caveman preset.
import paletteTxt from "../../reference/palette.txt?raw";

export interface Palette {
  name: string;
  colors: string[];
}

/** Read "#RRGGBB optional name" lines; anything else (comments, blanks) is skipped. */
export function parsePaletteText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(#[0-9a-fA-F]{6})\b/.exec(line);
    if (m) out.push(m[1].toUpperCase());
  }
  return out;
}

export const HAPPY_CAVEMAN: Palette = { name: "Happy Caveman", colors: parsePaletteText(paletteTxt) };
