// Font registry: every font the app can draw text with.
//  - bundled: Alfa Slab One and Roboto Slab, shipped with the app
//  - upload:  any .ttf / .otf / .woff file the user picks
//  - google:  downloaded on request from the Fontsource catalogue (the open
//             Google Fonts collection; no API key or account needed)
// Fonts are parsed with opentype.js so text can be turned into real outlines.

import { useSyncExternalStore } from "react";
import { parse, type Font } from "opentype.js";

export interface FontEntry {
  id: string;
  name: string;
  source: "bundled" | "upload" | "google";
  font: Font;
  /** The original file, kept so it can be saved inside a project. */
  bytes: ArrayBuffer;
  /** Height of a capital H, in the font's own units. */
  capHeight: number;
}

const BUNDLED = [
  { id: "alfa-slab-one", name: "Alfa Slab One", file: "fonts/AlfaSlabOne-Regular.woff" },
  { id: "roboto-slab-bold", name: "Roboto Slab Bold", file: "fonts/RobotoSlab-Bold.woff" },
  { id: "roboto-slab-black", name: "Roboto Slab Black", file: "fonts/RobotoSlab-Black.woff" },
];
export const DEFAULT_FONT = BUNDLED[0].id;

// ---------------------------------------------------------------- store
let fonts: FontEntry[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

export const getFont = (id: string) => fonts.find((f) => f.id === id);

/** Parse font bytes and add them to the registry. Throws a readable error if unusable. */
export function addFont(id: string, name: string, source: FontEntry["source"], bytes: ArrayBuffer): FontEntry {
  let font: Font;
  try {
    font = parse(bytes);
  } catch {
    throw new Error(`"${name}" could not be read as a font. Use a .ttf, .otf or .woff file (not .woff2).`);
  }
  // Cap height = top of the letter H (same measure as textify.py).
  let capHeight = 0;
  try {
    capHeight = font.charToGlyph("H").getBoundingBox().y2;
  } catch {
    // fall through to the defaults below
  }
  if (!(capHeight > 0)) capHeight = font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7;
  const entry: FontEntry = { id, name, source, font, bytes, capHeight };
  fonts = [...fonts.filter((f) => f.id !== id), entry];
  changed();
  return entry;
}

let bundledStarted = false;
/** Fetch and register the fonts that ship with the app (once). */
export function loadBundledFonts() {
  if (bundledStarted) return;
  bundledStarted = true;
  for (const b of BUNDLED) {
    fetch(b.file)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.arrayBuffer();
      })
      .then((bytes) => addFont(b.id, b.name, "bundled", bytes))
      .catch((e) => console.error("Could not load bundled font " + b.name, e));
  }
}

/** Register a font file chosen by the user. */
export async function addUploadedFont(file: File): Promise<FontEntry> {
  const name = file.name.replace(/\.[^.]+$/, "");
  return addFont("upload-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, "upload", await file.arrayBuffer());
}

/** React hook: the current list of fonts (re-renders when one is added). */
export function useFonts(): FontEntry[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => fonts,
  );
}

// ---------------------------------------------------------------- Google Fonts (via Fontsource)
export interface CatalogFont {
  id: string;
  family: string;
  weights: number[];
  styles: string[];
  subsets: string[];
  defSubset: string;
  category: string;
  license: string;
}

let catalog: Promise<CatalogFont[]> | null = null;
/** The list of available Google fonts (downloaded once, about 500 KB). */
export function loadCatalog(): Promise<CatalogFont[]> {
  catalog ??= fetch("https://api.fontsource.org/v1/fonts?type=google")
    .then((r) => {
      if (!r.ok) throw new Error("The font catalogue did not respond (" + r.status + ").");
      return r.json() as Promise<CatalogFont[]>;
    })
    .catch((e) => {
      catalog = null; // allow a retry
      throw e;
    });
  return catalog;
}

/** Download one weight of a catalogue font and register it. */
export async function addGoogleFont(f: CatalogFont, weight: number): Promise<FontEntry> {
  const subset = f.subsets.includes("latin") ? "latin" : f.defSubset;
  const style = f.styles.includes("normal") ? "normal" : f.styles[0];
  const url = `https://cdn.jsdelivr.net/fontsource/fonts/${f.id}@latest/${subset}-${weight}-${style}.woff`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not download ${f.family} (${r.status}).`);
  const label = f.weights.length > 1 ? `${f.family} ${weight}` : f.family;
  return addFont(`google-${f.id}-${weight}`, label, "google", await r.arrayBuffer());
}
