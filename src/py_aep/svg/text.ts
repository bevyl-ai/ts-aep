/**
 * Outline SVG text into After Effects vector subpaths.
 *
 * After Effects' own SVG importer drops `<text>`; py_aep renders it by outlining
 * each glyph with `fontTools` and converting the contours to the same cubic
 * {@link Subpath | Subpath}s the shape importer uses, so they flow
 * through the existing shape-layer builder unchanged.
 *
 * A `<text>` is split into {@link TextRun | TextRun}s (the parent text
 * plus each `<tspan>`), laid out left-to-right by glyph advance width. Kerning,
 * bidirectional text, and complex-script shaping are out of scope.
 */

// TODO(port): fontTools TTFont → fontkit 2.0.4: fontkit exposes glyphs by numeric id, not glyph name, so the glyph set is keyed by id (same 1:1 mapping); fonts whose glyph metrics/outlines fontkit parses differently from fontTools (e.g. malformed hmtx/glyf tables) may give different advances or outlines.
import * as fontkit from "fontkit";
import * as host from "../../pyrt/host.ts";
import { type CubicSeg, RawSubpath } from "./path_data.ts";
import { cubics_to_subpath } from "./shapes.ts";
import { Affine } from "./transform.ts";
import type { Subpath } from "./types.ts";
import {
  type Path,
  fspath,
  py_eq,
  sum,
  zip,
  hypot,
} from "../../pyrt/index.ts";

/** The subset of a fontkit glyph this module reads. */
export interface FontkitGlyph {
  advanceWidth: number;
  path: { commands: { command: string; args: number[] }[] };
}

/** The subset of a fontkit font this module reads. */
export interface FontkitFont {
  unitsPerEm: number;
  numGlyphs: number;
  getGlyph(id: number): FontkitGlyph;
  _cmapProcessor: FontkitCmap;
}

/** fontkit's internal cmap processor. */
export interface FontkitCmap {
  lookup(codePoint: number): number;
}

/** `(names, advances, units_per_em, glyph_set)` for one run's text. */
export type TextGlyphs = [(number | null)[], number[], number, FontkitFont];

/** Parsed-font cache keyed by file path (one parse per font per process). */
export const _font_cache = new Map<string, FontkitFont>();

/**
 * One styled run of text within a `<text>` (the parent text or a `<tspan>`).
 *
 * Positioning follows SVG: `abs_x` / `abs_y` (when not `null`) reset the
 * cursor; otherwise `dx` / `dy` offset it from the previous run's end.
 */
export class TextRun {
  declare text: string;
  declare font_path: Path;
  declare font_size: number;
  declare letter_spacing: number;
  declare abs_x: number | null;
  declare abs_y: number | null;
  declare dx: number;
  declare dy: number;
  /** CSS `text-anchor` for this run's chunk (`null` = inherit the caller's). */
  declare anchor: string | null;
  /** Face index within a `.ttc` collection (0 for a single-face file). */
  declare font_number: number;

  constructor(
    text: string,
    font_path: Path,
    font_size: number,
    letter_spacing = 0.0,
    abs_x: number | null = null,
    abs_y: number | null = null,
    dx = 0.0,
    dy = 0.0,
    anchor: string | null = null,
    font_number = 0,
  ) {
    this.text = text;
    this.font_path = font_path;
    this.font_size = font_size;
    this.letter_spacing = letter_spacing;
    this.abs_x = abs_x;
    this.abs_y = abs_y;
    this.dx = dx;
    this.dy = dy;
    this.anchor = anchor;
    this.font_number = font_number;
  }
}

export function _load_font(path: Path, font_number = 0): FontkitFont {
  const key = `${fspath(path)}#${font_number}`;
  let font: FontkitFont | null = _font_cache.get(key) ?? null;
  if (font == null) {
    // NOTE(port): lazy=True only defers table parsing (no result difference); a .ttc resolves its face through `.fonts`.
    const opened = fontkit.create(host.fs.readFileSync(fspath(path)));
    font = opened.fonts ? opened.fonts[font_number] : opened;
    _font_cache.set(key, font);
  }
  return font;
}

/**
 * Collect glyph contours as closed cubic `RawSubpath`s.
 *
 * `BasePen` converts TrueType quadratics (and any implied on-curve points)
 * to cubics for us and decomposes composite glyphs, so only straight and
 * cubic segments reach `_lineTo` / `_curveToOne`.
 */
export class _CubicContourPen {
  // NOTE(port): fontTools BasePen base class dropped. `_draw_glyph` drives these
  // methods from fontkit path commands; fontkit already emits implied on-curve
  // points and decomposes composite glyphs.
  declare contours: RawSubpath[];
  declare _segs: CubicSeg[];
  declare _cur: [number, number];
  declare _start: [number, number];

  constructor(glyph_set: FontkitFont) {
    // `super().__init__(glyph_set)` is the BasePen call dropped above.
    this.contours = [];
    this._segs = [];
    this._cur = [0.0, 0.0];
    this._start = [0.0, 0.0];
  }

  _moveTo(pt: [number, number]): void {
    this._segs = [];
    this._cur = pt;
    this._start = pt;
  }

  _lineTo(pt: [number, number]): void {
    const [x0, y0] = this._cur;
    const [x1, y1] = pt;
    this._segs.push([x0, y0, x0, y0, x1, y1, x1, y1]);
    this._cur = pt;
  }

  /** BasePen's quadratic-to-cubic step for TrueType off-curve points. */
  _qCurveToOne(pt1: [number, number], pt2: [number, number]): void {
    const [x0, y0] = this._cur;
    const [x1, y1] = pt1;
    const [x2, y2] = pt2;
    // fontTools BasePen._qCurveToOne uses the literal 0.66666666666666667 weight.
    this._curveToOne(
      [x0 + 0.66666666666666667 * (x1 - x0), y0 + 0.66666666666666667 * (y1 - y0)],
      [x2 + 0.66666666666666667 * (x1 - x2), y2 + 0.66666666666666667 * (y1 - y2)],
      pt2,
    );
  }

  _curveToOne(c1: [number, number], c2: [number, number], pt: [number, number]): void {
    const [x0, y0] = this._cur;
    this._segs.push([x0, y0, c1[0], c1[1], c2[0], c2[1], pt[0], pt[1]]);
    this._cur = pt;
  }

  _closePath(): void {
    if (!py_eq(this._cur, this._start)) {
      const [x0, y0] = this._cur;
      const [x1, y1] = this._start;
      this._segs.push([x0, y0, x0, y0, x1, y1, x1, y1]);
    }
    if (this._segs?.length > 0) {
      this.contours.push(new RawSubpath(this._segs, true));
    }
    this._segs = [];
  }

  _endPath(): void {
    // NOTE(port): fontkit never emits an end-path (glyf and CFF contours always close), so this is unreachable, as in fontTools for glyf/CFF.
    if (this._segs?.length > 0) {
      this.contours.push(new RawSubpath(this._segs, false));
    }
    this._segs = [];
  }
}

/** fontTools `glyph.draw(pen)` over fontkit's path commands. */
export function _draw_glyph(glyph: FontkitGlyph, pen: _CubicContourPen): void {
  for (const { command, args } of glyph.path.commands) {
    if (command === "moveTo") {
      pen._moveTo([args[0], args[1]]);
    } else if (command === "lineTo") {
      pen._lineTo([args[0], args[1]]);
    } else if (command === "quadraticCurveTo") {
      pen._qCurveToOne([args[0], args[1]], [args[2], args[3]]);
    } else if (command === "bezierCurveTo") {
      pen._curveToOne([args[0], args[1]], [args[2], args[3]], [args[4], args[5]]);
    } else if (command === "closePath") {
      pen._closePath();
    }
  }
}

export function _glyph_contours(glyph_set: FontkitFont, glyph_name: number): RawSubpath[] {
  const pen = new _CubicContourPen(glyph_set);
  _draw_glyph(glyph_set.getGlyph(glyph_name), pen);
  return pen.contours;
}

/** `gname in glyph_set`: a mapped glyph id that exists in the font. */
export function _in_glyph_set(glyph_set: FontkitFont, gname: number | null): gname is number {
  return gname != null && gname < glyph_set.numGlyphs;
}

export function _glyphs(font: FontkitFont, text: string): TextGlyphs {
  // `getBestCmap()` is None for a font with no Unicode cmap subtable (the
  // Windows symbol faces Wingdings/Webdings/Symbol/Marlett, and similar). Treat
  // it as empty so every char maps to no glyph and the run is dropped, matching
  // the "unresolved font is skipped" behaviour rather than crashing read_svg.
  // TODO(port): fontkit has no getBestCmap(); its internal cmap processor may pick a different subtable than fontTools' priority order for fonts carrying several Unicode cmaps (e.g. both format 4 and format 12, or differing platform 0/3 subtables), changing which code points map to glyphs.
  // Its lookup returns 0 for unmapped code points, which is reported as null here.
  let cmap: FontkitCmap | null = null;
  try {
    cmap = font._cmapProcessor;
  } catch {
    // fontkit throws when no supported cmap subtable exists (fontTools: getBestCmap() is None).
    cmap = null;
  }
  // NOTE(port): getGlyphSet() → the fontkit font itself; glyphs are addressed by id, not name (ids are unique, same mapping as names).
  const glyph_set = font;
  const units_per_em = font.unitsPerEm;
  const names: (number | null)[] = [];
  const advances: number[] = [];
  for (const ch of text) {
    const gid: number = cmap == null ? 0 : cmap.lookup(ch.codePointAt(0) ?? 0);
    const gname = gid !== 0 ? gid : null;
    names.push(gname);
    advances.push(_in_glyph_set(glyph_set, gname) ? glyph_set.getGlyph(gname).advanceWidth : 0.0);
  }
  return [names, advances, units_per_em, glyph_set];
}

/** Advance width of a run's text in user units (incl. letter-spacing). */
export function _advance_width(
  run: TextRun,
  glyphs: TextGlyphs,
): number {
  const [, advances, units_per_em] = glyphs;
  const scale = run.font_size / units_per_em;
  return sum(advances) * scale + run.letter_spacing * Array.from(run.text).length;
}

/** Outline one run starting at `(pen_x, pen_y)`; return (subpaths, end_x). */
export function _outline_run(
  run: TextRun,
  pen_x: number,
  pen_y: number,
  ctm: Affine,
  glyphs: TextGlyphs,
): [Subpath[], number] {
  const [names, advances, units_per_em, glyph_set] = glyphs;
  const scale = run.font_size / units_per_em;
  const subpaths: Subpath[] = [];
  for (const [gname, advance] of zip(names, advances)) {
    if (gname != null && _in_glyph_set(glyph_set, gname)) {
      // Scale + y-flip (font units are y-up) into user space at the pen
      // position, then apply the element transform.
      const glyph_tf = ctm.multiply(new Affine(scale, undefined, undefined, -scale, pen_x, pen_y));
      for (const raw of _glyph_contours(glyph_set, gname)) {
        const sub = cubics_to_subpath(raw, glyph_tf);
        if (sub != null) subpaths.push(sub);
      }
    }
    pen_x += advance * scale + run.letter_spacing;
  }
  return [subpaths, pen_x];
}

/**
 * Outline `runs` into per-run subpath lists (parallel to `runs`).
 *
 * `origin_x` / `origin_y` are the `<text>` baseline anchor. Runs are grouped
 * into SVG text chunks - a run carrying an absolute `x` starts a new chunk -
 * and `text-anchor` (`start` / `middle` / `end`) is applied per chunk, taken
 * from the run that starts the chunk (falling back to `anchor`). Each run's
 * glyphs are measured once and reused for both the anchor width and the
 * outline.
 */
export function outline_runs(
  runs: TextRun[],
  origin_x: number,
  origin_y: number,
  ctm: Affine,
  anchor = "start",
): Subpath[][] {
  const glyph_data = runs.map((run) =>
    _glyphs(_load_font(run.font_path, run.font_number), run.text),
  );
  const widths = runs.map((run, k) => _advance_width(run, glyph_data[k]));
  const result: Subpath[][] = runs.map(() => []);
  let pen_x = origin_x;
  let pen_y = origin_y;
  const n = runs.length;
  let i = 0;
  while (i < n) {
    // The chunk runs from `i` up to (not including) the next absolute-x run.
    let j = i + 1;
    while (j < n && runs[j].abs_x == null) j += 1;
    const first = runs[i];
    const chunk_advance = sum(Array.from({ length: j - i }, (_, k) => widths[i + k] + runs[i + k].dx));
    const chunk_anchor = first.anchor || anchor;
    const shift =
      chunk_anchor === "middle"
        ? chunk_advance / 2.0
        : chunk_anchor === "end"
          ? chunk_advance
          : 0.0;
    // An absolute x resets the cursor; otherwise the (first) chunk continues
    // from the running pen. The anchor shifts the whole chunk left.
    const base_x = first.abs_x != null ? first.abs_x : pen_x;
    pen_x = base_x - shift;
    for (let k = i; k < j; k++) {
      const run = runs[k];
      pen_x = pen_x + run.dx;
      pen_y = run.abs_y != null ? run.abs_y : pen_y + run.dy;
      const [subpaths, end_x] = _outline_run(run, pen_x, pen_y, ctm, glyph_data[k]);
      pen_x = end_x;
      result[k] = subpaths;
    }
    i = j;
  }
  return result;
}

/** Sample a cubic bezier into points (excluding the start point). */
export function _flatten_cubic(seg: CubicSeg, steps = 16): [number, number][] {
  const [x0, y0, c1x, c1y, c2x, c2y, x3, y3] = seg;
  const pts: [number, number][] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1.0 - t;
    const [a, b, c, d] = [mt * mt * mt, 3 * mt * mt * t, 3 * mt * t * t, t * t * t];
    pts.push([
      a * x0 + b * c1x + c * c2x + d * x3,
      a * y0 + b * c1y + c * c2y + d * y3,
    ]);
  }
  return pts;
}

/** Flatten a raw subpath's cubics into a polyline (path-local coords). */
export function _polyline(raw: RawSubpath): [number, number][] {
  const segs = raw.segments;
  if (!segs?.length) return [];
  const pts: [number, number][] = [[segs[0][0], segs[0][1]]];
  for (const seg of segs) {
    pts.push(..._flatten_cubic(seg));
  }
  return pts;
}

export function _arc_lengths(pts: [number, number][]): number[] {
  const cum = [0.0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(
      cum[cum.length - 1] + hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
    );
  }
  return cum;
}

/** Point and tangent angle at arc-length `dist` along the polyline. */
export function _point_at(
  pts: [number, number][],
  cum: number[],
  dist: number,
): [number, number, number] {
  dist = Math.max(0.0, Math.min(dist, cum[cum.length - 1]));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < dist) i += 1;
  const [x0, y0] = pts[i - 1];
  const [x1, y1] = pts[i];
  const span = cum[i] - cum[i - 1];
  const f = span > 1e-9 ? (dist - cum[i - 1]) / span : 0.0;
  // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
  return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, Math.atan2(y1 - y0, x1 - x0)];
}

/**
 * Outline `text` laid along `path` (a `<textPath>`'s referenced geometry).
 *
 * Each glyph is placed with its advance midpoint at the corresponding
 * arc-length along the (first subpath of the) path and rotated to the local
 * tangent. Glyphs past the path end are dropped. `start_offset` is in user
 * units; `start_offset_frac` (0-1) is the percentage form. The path's own
 * transform is not applied (it is taken in the text's coordinate space).
 */
export function outline_text_path(
  text: string,
  path: RawSubpath[],
  font_path: Path,
  font_size: number,
  ctm: Affine,
  kw: {
    font_number?: number;
    start_offset?: number;
    start_offset_frac?: number | null;
    letter_spacing?: number;
  } = {},
): Subpath[] {
  const {
    font_number = 0,
    start_offset = 0.0,
    start_offset_frac = null,
    letter_spacing = 0.0,
  } = kw;
  if (!path?.length) return [];
  const pts = _polyline(path[0]);
  if (pts.length < 2) return [];
  const cum = _arc_lengths(pts);
  const total = cum[cum.length - 1];
  const [names, advances, units_per_em, glyph_set] = _glyphs(
    _load_font(font_path, font_number),
    text,
  );
  const scale = font_size / units_per_em;

  let dist = start_offset_frac != null ? start_offset_frac * total : start_offset;
  const subpaths: Subpath[] = [];
  for (const [k, gname] of names.entries()) {
    const advance = advances[k];
    const advance_user = advance * scale + letter_spacing;
    const mid = dist + advance_user / 2.0;
    if (gname != null && _in_glyph_set(glyph_set, gname) && 0.0 <= mid && mid <= total) {
      const [px, py, angle] = _point_at(pts, cum, mid);
      // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // place at path point, rotate to tangent, scale+y-flip, then shift
      // the glyph left by half its advance (font units) so its advance
      // midpoint sits on the path.
      const glyph_tf = ctm
        .multiply(new Affine(undefined, undefined, undefined, undefined, px, py))
        .multiply(new Affine(cos, sin, -sin, cos))
        .multiply(new Affine(scale, undefined, undefined, -scale))
        .multiply(new Affine(undefined, undefined, undefined, undefined, -advance / 2.0));
      for (const raw of _glyph_contours(glyph_set, gname)) {
        const sub = cubics_to_subpath(raw, glyph_tf);
        if (sub != null) subpaths.push(sub);
      }
    }
    dist += advance_user;
  }
  return subpaths;
}
