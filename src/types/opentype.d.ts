// Minimal type declarations for the parts of opentype.js (MIT) that we use.
// The library does not ship its own TypeScript types.
declare module "opentype.js" {
  export type PathCommand =
    | { type: "M"; x: number; y: number }
    | { type: "L"; x: number; y: number }
    | { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: "Q"; x1: number; y1: number; x: number; y: number }
    | { type: "Z" };

  export interface Path {
    commands: PathCommand[];
  }
  export interface BoundingBox {
    x1: number; y1: number; x2: number; y2: number;
  }
  export interface Glyph {
    index: number;
    advanceWidth?: number;
    path: Path;
    getBoundingBox(): BoundingBox;
  }
  export interface Font {
    unitsPerEm: number;
    names: Record<string, Record<string, string> | undefined>;
    tables: { os2?: { sCapHeight?: number } };
    charToGlyph(c: string): Glyph;
    stringToGlyphs(s: string): Glyph[];
    getKerningValue(left: Glyph, right: Glyph): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
  const opentype: { parse: typeof parse };
  export default opentype;
}
