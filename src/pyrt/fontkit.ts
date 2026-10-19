// fontkit 2.0.4 ships no type declarations, and @types/fontkit disagrees with
// its runtime (it misses `directory` and the lazily decoded table properties,
// requires getName's language, and only accepts a Node Buffer). These type
// the API the port uses, checked against node_modules/fontkit/dist/module.mjs.
interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  readonly width: number;
  readonly height: number;
}

interface PathCommand {
  command: "moveTo" | "lineTo" | "quadraticCurveTo" | "bezierCurveTo" | "closePath";
  args: number[];
}

interface Path {
  commands: PathCommand[];
  readonly bbox: BBox;
  readonly cbox: BBox;
  toSVG(): string;
}

interface Glyph {
  id: number;
  codePoints: number[];
  readonly path: Path;
  readonly bbox: BBox;
  readonly cbox: BBox;
  readonly advanceWidth: number;
  readonly name: string;
}

interface TableEntry {
  tag: string;
  checkSum: number;
  offset: number;
  length: number;
}

interface VariationAxis {
  name: string;
  min: number;
  default: number;
  max: number;
}

export interface Font {
  readonly postscriptName: string | null;
  readonly familyName: string | null;
  readonly subfamilyName: string | null;
  readonly fullName: string | null;
  readonly unitsPerEm: number;
  readonly numGlyphs: number;
  readonly directory: { tag: string; numTables: number; tables: Record<string, TableEntry> };
  readonly variationAxes: Record<string, VariationAxis>;
  /**
   * Faces of a collection (`.ttc`). Absent on a single-face font. `create`
   * returns one object for both, and callers pick `fonts[i]` for a collection.
   */
  readonly fonts?: Font[];
  /**
   * Internal Unicode cmap. Reading it throws when the font has no supported
   * cmap subtable (symbol faces such as Wingdings).
   */
  readonly _cmapProcessor: { lookup(codePoint: number): number };
  /** Tables decode lazily into properties named by tag; absent when the font has no such table. */
  readonly name?: { records: Record<string, Record<string, string>> };
  readonly hhea?: { ascent: number; descent: number; lineGap: number };
  /** `lang` defaults to the font's (or fontkit's) default language, `"en"`. */
  getName(key: string, lang?: string): string | null;
  glyphForCodePoint(codePoint: number): Glyph;
  getGlyph(id: number, codePoints?: number[]): Glyph;
  hasGlyphForCodePoint(codePoint: number): boolean;
}

/** A `.ttc` / `.dfont` collection: `create` returns this for collection files. */
interface FontCollection extends Font {
  readonly fonts: Font[];
  getFont(postscriptName: string): Font | null;
}

/** The fontkit module. */
export interface Fontkit {
  create(buffer: Uint8Array, postscriptName?: string): Font | FontCollection;
}
