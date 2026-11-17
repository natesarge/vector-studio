// Colour palettes ("brand colours"): the built-in Happy Caveman preset plus
// any the user creates. They are remembered in the browser's localStorage.
import { useCallback, useEffect, useState } from "react";
import paletteTxt from "../../reference/palette.txt?raw";

export interface Palette {
  id: string;
  name: string;
  colors: string[];
}

/** Read "#RRGGBB optional name" lines; anything else (comments, blanks) is skipped. */
export function parsePaletteText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(#[0-9a-fA-F]{6})\b/.exec(line);
    if (m && !out.includes(m[1].toUpperCase())) out.push(m[1].toUpperCase());
  }
  return out;
}

const makeId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const HAPPY_CAVEMAN: Palette = {
  id: "happy-caveman",
  name: "Happy Caveman",
  colors: parsePaletteText(paletteTxt),
};

export const newPalette = (name: string, colors: string[] = []): Palette => ({ id: makeId(), name, colors });

/** Palette file contents -> palettes. Accepts our JSON or a plain text list of hex codes. */
export function importPalettes(text: string, fallbackName: string): Palette[] {
  try {
    const data: unknown = JSON.parse(text);
    const list = Array.isArray(data) ? data : [data];
    const out: Palette[] = [];
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const { name, colors } = p as { name?: unknown; colors?: unknown };
      if (!Array.isArray(colors)) continue;
      const clean = parsePaletteText(colors.filter((c) => typeof c === "string").join("\n"));
      if (clean.length) out.push(newPalette(typeof name === "string" && name ? name : fallbackName, clean));
    }
    if (out.length) return out;
  } catch {
    // not JSON: fall through and read it as text
  }
  const colors = parsePaletteText(text);
  return colors.length ? [newPalette(fallbackName, colors)] : [];
}

export const paletteToJson = (p: Palette) => JSON.stringify({ name: p.name, colors: p.colors }, null, 2) + "\n";
export const paletteToText = (p: Palette) =>
  `# ${p.name} - one hex code per line (text after the code is ignored)\n` + p.colors.join("\n") + "\n";

// ---------------------------------------------------------------- storage
const KEY = "cvs.palettes.v1";
interface Stored {
  palettes: Palette[];
  activeId: string;
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Stored;
      if (Array.isArray(s.palettes) && s.palettes.length) return s;
    }
  } catch {
    // unreadable or blocked storage: use the default
  }
  return { palettes: [HAPPY_CAVEMAN], activeId: HAPPY_CAVEMAN.id };
}

/** The palette list, which one is active, and functions to change them. */
export function usePalettes() {
  const [state, setState] = useState<Stored>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // storage full or blocked: palettes still work for this session
    }
  }, [state]);

  const active = state.palettes.find((p) => p.id === state.activeId) ?? state.palettes[0];
  const setActive = useCallback((id: string) => setState((s) => ({ ...s, activeId: id })), []);
  const update = useCallback((p: Palette) =>
    setState((s) => ({ ...s, palettes: s.palettes.map((q) => (q.id === p.id ? p : q)) })), []);
  const add = useCallback((list: Palette[]) =>
    setState((s) => (list.length ? { palettes: [...s.palettes, ...list], activeId: list[0].id } : s)), []);
  const remove = useCallback((id: string) =>
    setState((s) => {
      const palettes = s.palettes.filter((p) => p.id !== id);
      if (!palettes.length) palettes.push(HAPPY_CAVEMAN); // always keep at least one
      return { palettes, activeId: s.activeId === id ? palettes[0].id : s.activeId };
    }), []);

  return { palettes: state.palettes, active, setActive, update, add, remove };
}
export type Palettes = ReturnType<typeof usePalettes>;
