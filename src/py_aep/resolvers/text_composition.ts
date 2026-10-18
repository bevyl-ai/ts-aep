/**
 * Recompose box-text lines the way AE's single-line Latin composer does.
 *
 * Every rule here is fixture-verified against AE 26.3's own persisted
 * layout caches (37/37 matrix layers reproduce AE's exact breaks; see
 * `.claude/plans/text-recomposition.md` and
 * `samples/models/text/box_matrix.aep`):
 *
 * * Measurement: HarfBuzz shaping per maximal same-style stretch with
 *   `liga`/`clig` disabled (AE's ligature default), advances accumulated
 *   per source cluster at `size / unitsPerEm`; tracking adds
 *   `tracking / 1000 x size` per character; horizontal scale multiplies
 *   advances; faux bold adds `0.027 x size` per glyph; small caps are
 *   synthesized (uppercase shaped, originally-lowercase advances x 0.7).
 * * Breaks: greedy word-fit at space groups only - hyphens are not break
 *   opportunities; a token wider than the line wraps at the character
 *   level. Trailing spaces ride along, excluded from the fit.
 * * Geometry: usable width = box width - 2 x inset - start/end indents;
 *   each paragraph's first line additionally subtracts the first-line
 *   indent.
 * * Vertical clip: keep lines while `baseline <= box height`, with the
 *   first baseline at `inset + ascender x size` (ascender = the lowercase
 *   'd' glyph height, CoolType's notion of ascent) and subsequent
 *   baselines adding the line leading (auto leading = 1.2 x size).
 *
 * Anything outside the verified envelope raises
 * {@link CompositionUnsupported} - the resolver refuses rather than guesses.
 * Besides the module-header features, that covers non-default box
 * vertical alignment / auto-fit / first-baseline alignment, paragraph
 * space before/after, disabled auto kerning, and case maps that change
 * the text length (all dirty-marked by the write engine but not modeled
 * here). Requires `uharfbuzz` for OpenType shaping; it is unavailable on
 * Python 3.7 (no wheels), where the resolver reports unsupported.
 */

import * as host from "../../pyrt/host.ts";
import * as unicodedata from "../../pyrt/unicodedata.ts";
import * as fontkit from "fontkit";
import type { Path } from "../../pyrt/index.ts";
import {
  at,
  KeyError,
  islower,
  max,
  OSError,
  py_bool,
  py_eq,
  py_or,
  repr,
  rstrip,
  split,
  str,
  sum,
  tkey,
  ValueError,
  zip,
} from "../../pyrt/index.ts";
import { cos_get, run_spans } from "../cos/index.ts";
import type { CosDict } from "../cos/cos.ts";
import { cos_contains, cos_float, cos_get_or, cos_int } from "../cos/kinds.ts";
import { char_style, read } from "../cos/schema.ts";
import { BoxAutoFitPolicy, BoxFirstBaselineAlignment, BoxVerticalAlignment } from "../enums/index.ts";
import { resolve_postscript } from "../svg/fonts.ts";
import type { TextDocument } from "../models/text/text_document.ts";

// uharfbuzz -> harfbuzzjs. The wasm module initializes asynchronously, so it is
// awaited once at module load and wrapped in a uharfbuzz-shaped binding
// (`hb.Blob.from_file_path`, `hb.Face`, `hb.Font`, `hb.Buffer`, `hb.shape`).
// NOTE(port): harfbuzzjs indexes clusters in UTF-16 units; uharfbuzz in code
// points. Composition refuses astral text first (`_check_envelope`), so the
// two agree on every text that is shaped.
// Off Node/Bun the wasm is fetched from `hb.wasm` next to the bundle. Where
// it cannot load (not served there; Cloudflare Workers, which refuse to
// compile wasm from bytes) the module still loads and shaping raises instead.
/** The subset of harfbuzzjs's `hbjs()` API this module calls; handles are opaque. */
export interface HbJs {
  createBlob(data: Uint8Array): object;
  createFace(blob: object, index: number): HbJsFace;
  createFont(face: HbJsFace): object;
  createBuffer(): HbJsBuffer;
  shape(font: object, buffer: HbJsBuffer, features: string): void;
}
export interface HbJsFace {
  upem: number;
}
export interface HbJsBuffer {
  addText(text: string): void;
  guessSegmentProperties(): void;
  json(): _HbJsGlyph[];
}

/** The loaded harfbuzzjs API, or how to report that it failed to load. */
type HbLoad = { hb: HbJs; fail: null } | { hb: null; fail: () => never };

const _hbjs: HbLoad = await (async (): Promise<HbLoad> => {
  try {
    if (host.platform !== "browser") return { hb: await (await import("harfbuzzjs")).default, fail: null };
    const [{ default: hb_wasm }, { default: hbjs }] = await Promise.all([
      import("harfbuzzjs/hb.js"),
      import("harfbuzzjs/hbjs.js"),
    ]);
    return { hb: hbjs(await hb_wasm({ locateFile: (file: string) => new URL(file, import.meta.url).href })), fail: null };
  } catch (e) {
    return {
      hb: null,
      fail: () => {
        throw Object.assign(new Error(`harfbuzzjs is unavailable on this host: ${e}`), { cause: e });
      },
    };
  }
})();

function _hb(): HbJs {
  if (_hbjs.hb == null) return _hbjs.fail();
  return _hbjs.hb;
}

/** One glyph of harfbuzzjs's `buffer.json()` output. */
export interface _HbJsGlyph {
  g: number;
  cl: number;
  ax: number;
  ay: number;
  dx: number;
  dy: number;
}

class _HbBlob {
  declare data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  static from_file_path(path: string): _HbBlob {
    return new _HbBlob(new Uint8Array(host.fs.readFileSync(path)));
  }
}

class _HbFace {
  declare _face: HbJsFace;
  declare upem: number;
  constructor(blob: _HbBlob, index: number = 0) {
    const b = _hb().createBlob(blob.data);
    this._face = _hb().createFace(b, index);
    this.upem = this._face.upem;
  }
}

class _HbFont {
  declare _font: object;
  constructor(face: _HbFace) {
    this._font = _hb().createFont(face._face);
  }
}

class _HbBuffer {
  declare _buf: HbJsBuffer;
  constructor() {
    this._buf = _hb().createBuffer();
  }
  add_str(text: string): void {
    this._buf.addText(text);
  }
  guess_segment_properties(): void {
    this._buf.guessSegmentProperties();
  }
  get glyph_infos(): { codepoint: number; cluster: number }[] {
    return this._buf.json().map((g) => ({ codepoint: g.g, cluster: g.cl }));
  }
  get glyph_positions(): { x_advance: number; y_advance: number; x_offset: number; y_offset: number }[] {
    return this._buf
      .json()
      .map((g) => ({ x_advance: g.ax, y_advance: g.ay, x_offset: g.dx, y_offset: g.dy }));
  }
}

/** The uharfbuzz-shaped binding built over harfbuzzjs. */
interface HbBinding {
  Blob: typeof _HbBlob;
  Face: typeof _HbFace;
  Font: typeof _HbFont;
  Buffer: typeof _HbBuffer;
  shape(font: _HbFont, buf: _HbBuffer, features: Record<string, boolean>): void;
  HarfBuzzError?: abstract new (...args: never[]) => object;
}

export let hb: HbBinding = {
  Blob: _HbBlob,
  Face: _HbFace,
  Font: _HbFont,
  Buffer: _HbBuffer,
  shape(font: _HbFont, buf: _HbBuffer, features: Record<string, boolean>): void {
    const spec = Object.entries(features)
      .map(([tag, on]) => `${on ? "" : "-"}${tag}`)
      .join(",");
    _hb().shape(font._font, buf._buf, spec);
  },
};

export const _AUTO_LEADING_FACTOR = 1.2;
export const _FAUX_BOLD_ADVANCE = 0.027;
export const _SMALL_CAPS_SCALE = 0.7;

// The font index is process-lifetime, so an indexed file can vanish
// (CoreSync eviction, uninstall) before its first shaping; those opens
// must refuse, not leak OS/HarfBuzz errors into innocuous reads.
export const _FONT_OPEN_ERRORS: (abstract new (...args: never[]) => object)[] = [OSError];
const _harfbuzz_error = hb.HarfBuzzError;
if (_harfbuzz_error != null) {
  _FONT_OPEN_ERRORS.push(_harfbuzz_error);
}

/**
 * The `except _FONT_OPEN_ERRORS` clause: Python's `OSError`, plus HarfBuzz's own
 * error when the binding exposes one.
 * NOTE(port): Node's fs failures are plain `Error`s carrying a `code`, not
 * `OSError` instances; the `code` check stands in for Python's OSError. Parse
 * failures (fontTools TTLibError / fontkit Error without `code`) propagate in both.
 */
export function _is_font_open_error(exc: object): boolean {
  if (_FONT_OPEN_ERRORS.some((cls) => exc instanceof cls)) return true;
  return exc instanceof Error && "code" in exc;
}

export class CompositionUnsupported extends ValueError {}

/** Result of a recomposition: clipped line spans + overflow state. */
export class ComposedLines {
  declare spans: [number, number][];
  declare baselines: number[];
  declare overflow: boolean;

  constructor(spans: [number, number][], baselines: number[], overflow: boolean) {
    this.spans = spans;
    this.baselines = baselines;
    this.overflow = overflow;
  }
}

export const _hb_cache = new Map<string, [_HbFont, number]>();
export const _ascender_cache = new Map<string, number>();

export function _resolve_face(ps_name: string): [Path, number] {
  const resolved = resolve_postscript(ps_name);
  if (resolved == null) {
    throw new CompositionUnsupported(`font ${repr(ps_name)} is not installed`);
  }
  return resolved;
}

export function _hb_font(ps_name: string): [_HbFont, number] {
  const [path, face_index] = _resolve_face(ps_name);
  const key = tkey(path.toString(), face_index);
  let cached = _hb_cache.get(key);
  if (cached === undefined) {
    let face: _HbFace;
    try {
      const blob = hb.Blob.from_file_path(path.toString());
      face = new hb.Face(blob, face_index);
    } catch (exc) {
      if (!(exc instanceof Object) || !_is_font_open_error(exc)) throw exc;
      throw Object.assign(
        new CompositionUnsupported(`font file for ${repr(ps_name)} is unreadable: ${path.toString()}`),
        { cause: exc },
      );
    }
    cached = [new hb.Font(face), face.upem];
    _hb_cache.set(key, cached);
  }
  return cached;
}

/**
 * CoolType's ascent as a fraction of the em: the lowercase 'd'
 * glyph height (fixture-matched: Myriad 710/1000 while every table
 * ascent says 750), falling back to `hhea` when 'd' is missing.
 */
export function _ascender_ratio(ps_name: string): number {
  const [path, face_index] = _resolve_face(ps_name);
  const key = tkey(path.toString(), face_index);
  let ratio = _ascender_cache.get(key);
  if (ratio === undefined) {
    let font: fontkit.Font;
    try {
      // NOTE(port): fontTools TTFont(path, fontNumber=face_index, lazy=True) ->
      // fontkit. fontkit's create returns a FontCollection for .ttc files, so the
      // face is picked with `.fonts[face_index]`.
      const opened = fontkit.create(host.fs.readFileSync(path.toString()));
      font = opened.fonts ? at(opened.fonts, face_index) : opened;
    } catch (exc) {
      if (!(exc instanceof Object) || !_is_font_open_error(exc)) throw exc;
      throw Object.assign(
        new CompositionUnsupported(`font file for ${repr(ps_name)} is unreadable: ${path.toString()}`),
        { cause: exc },
      );
    }
    // fontkit reads the file into memory and holds no OS handle, so there is
    // nothing to close where Python calls `font.close()` in its `finally`.
    const upem = font.unitsPerEm;
    // fontTools `font["hhea"]`: a font without the table raises KeyError.
    const hhea = font.hhea;
    if (hhea == null) throw new KeyError("'hhea' table not found");
    ratio = hhea.ascent / upem;
    // TODO(port): getBestCmap() vs fontkit's cmap subtable choice may differ on
    // fonts with several cmaps; 'd' absent is detected as .notdef (id 0), so a
    // font mapping 'd' explicitly to glyph 0 would be skipped here but measured
    // by Python. Also glyph.bbox (fontkit) vs BoundsPen tight bounds can differ
    // for TrueType glyphs whose glyf header yMax is not the true extremum.
    const glyph = font.glyphForCodePoint(0x64);
    if (glyph.id !== 0) {
      // BoundsPen reports bounds None for an empty outline: keep the hhea ratio.
      if (glyph.path.commands.length > 0) {
        ratio = glyph.bbox.maxY / upem;
      }
    }
    _ascender_cache.set(key, ratio);
  }
  return ratio;
}

/** Per-character composition inputs decoded from one style run. */
export class _CharStyle {
  declare font: string;
  declare size: number;
  declare tracking: number;
  declare hscale: number;
  declare fauxbold: boolean;
  declare caps: number;
  declare leading: number;

  constructor(ps_name: string, style: CosDict) {
    this.font = ps_name;
    this.size = cos_float(cos_get_or(style, "1", 36.0));
    this.tracking = cos_float(cos_get_or(style, "8", 0.0));
    this.hscale = cos_float(cos_get_or(style, "6", 1.0));
    this.fauxbold = py_bool(cos_get_or(style, "2", false));
    this.caps = cos_int(cos_get_or(style, "12", 0)); // 0 normal, 1 small, 2 all
    if (py_bool(cos_get_or(style, "4", true))) {
      this.leading = _AUTO_LEADING_FACTOR * this.size;
    } else {
      this.leading = cos_float(cos_get_or(style, "5", _AUTO_LEADING_FACTOR * this.size));
    }
  }

  stretch_key(): string {
    return tkey(this.font, this.size, this.tracking, this.hscale, this.fauxbold, this.caps);
  }
}

export function _check_envelope(doc: TextDocument, raw: string): void {
  /** Raise {@link CompositionUnsupported} outside the verified envelope. */
  if (hb == null) {
    throw new CompositionUnsupported(
      "composition requires uharfbuzz, which is unavailable on Python 3.7",
    );
  }
  const orientation = cos_get(doc._cos_data, "0", "8", "0", 0, "0", "2", "1");
  if (!(orientation == null || py_eq(orientation, 0))) {
    throw new CompositionUnsupported("vertical text");
  }
  const text_dict = cos_get(doc._doc, "0");
  if (cos_contains(py_bool(text_dict) ? text_dict : new Map(), "8")) {
    throw new CompositionUnsupported("manual kerning");
  }
  // Box-frame inputs the composer does not model: the matrix fixture
  // never swept them, so non-default values must refuse rather than
  // silently compose with top-aligned, ascender-based geometry.
  if (doc.box_vertical_alignment !== BoxVerticalAlignment.TOP) {
    throw new CompositionUnsupported("box vertical alignment");
  }
  if (doc.box_auto_fit_policy !== BoxAutoFitPolicy.NONE) {
    throw new CompositionUnsupported("box auto-fit policy");
  }
  if (doc.box_first_baseline_alignment !== BoxFirstBaselineAlignment.ASCENT) {
    throw new CompositionUnsupported("box first-baseline alignment");
  }
  if (doc.box_first_baseline_alignment_minimum !== 0.0) {
    throw new CompositionUnsupported("box first-baseline minimum");
  }
  for (const char of Array.from(raw)) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\t") {
      throw new CompositionUnsupported("tab characters");
    }
    if (char === "\u00a0") {
      throw new CompositionUnsupported("no-break spaces");
    }
    if (code > 0xffff) {
      throw new CompositionUnsupported("non-BMP characters");
    }
    if (char !== "\r" && ["R", "AL", "AN"].includes(unicodedata.bidirectional(char))) {
      throw new CompositionUnsupported("right-to-left text");
    }
    if (unicodedata.combining(char) !== 0) {
      throw new CompositionUnsupported("combining marks");
    }
  }
  for (const [_start, _end, style] of run_spans(doc._doc, "6", "6")) {
    if (py_bool(style.get("18") ?? null)) {
      throw new CompositionUnsupported("ligatures enabled");
    }
    if (cos_float(cos_get_or(style, "36", 0.0)) !== 0.0) {
      throw new CompositionUnsupported("tsume");
    }
    const kern_type = cos_int(cos_get_or(style, "11", 1));
    if (kern_type === 2) {
      throw new CompositionUnsupported("optical kerning");
    }
    if (kern_type !== 1) {
      // HarfBuzz keeps pair kerning on (matching AE's metric
      // default); a no-auto-kern run would measure kerned widths
      // for text AE lays out unkerned.
      throw new CompositionUnsupported("auto kerning disabled");
    }
    if (py_bool(style.get("52") ?? null)) {
      throw new CompositionUnsupported("no-break attribute");
    }
    if (cos_float(cos_get_or(style, "9", 0.0)) !== 0.0) {
      throw new CompositionUnsupported("baseline shift");
    }
    if (cos_int(cos_get_or(style, "13", 0)) !== 0) {
      throw new CompositionUnsupported("super/subscript");
    }
  }
  for (const [_start, _end, style] of run_spans(doc._doc, "5", "5")) {
    if (py_bool(style.get("29") ?? null)) {
      throw new CompositionUnsupported("every-line composer");
    }
    // NOTE auto-hyphenate (para key "9") is AE's DEFAULT and is inert
    // for the single-line composer: the explicit M_HYPHENATE matrix
    // layer still breaks greedily (long words char-wrap rather than
    // hyphenate), so it is deliberately NOT refused.
    if (cos_int(cos_get_or(style, "33", 0)) !== 0) {
      throw new CompositionUnsupported("right-to-left paragraphs");
    }
    if (cos_int(cos_get_or(style, "8", 0)) !== 0) {
      throw new CompositionUnsupported("non-Roman leading type");
    }
    if (cos_float(cos_get_or(style, "4", 0.0)) !== 0.0 || cos_float(cos_get_or(style, "5", 0.0)) !== 0.0) {
      // space_before/space_after shift baselines; the matrix never
      // swept them, so the composer does not model them.
      throw new CompositionUnsupported("paragraph spacing");
    }
  }
}

export function _char_styles(doc: TextDocument, raw: string): _CharStyle[] {
  const fonts = doc._fonts.map((f) => f.post_script_name);
  const out: _CharStyle[] = [];
  for (const [start, end, style] of run_spans(doc._doc, "6", "6")) {
    const font_idx = read(char_style, style, "0");
    const index = font_idx == null ? -1 : Number(font_idx);
    if (!(0 <= index && index < fonts.length)) {
      throw new CompositionUnsupported("unresolvable font reference");
    }
    const run_style = new _CharStyle(fonts[index], style);
    for (let k = 0; k < end - start; k++) {
      out.push(run_style);
    }
  }
  if (out.length !== raw.length) {
    throw new CompositionUnsupported("style runs do not cover the text");
  }
  return out;
}

/**
 * Shape one same-style stretch: the HarfBuzz buffer (one cluster per
 * character) and the font-unit-to-pixel scale.
 */
export function _shape_glyphs(text: string, style: _CharStyle): [_HbBuffer, number] {
  const [font, upem] = _hb_font(style.font);
  const shaped_text = style.caps === 1 || style.caps === 2 ? text.toUpperCase() : text;
  if (shaped_text.length !== text.length) {
    // e.g. eszett -> "SS": clusters no longer map 1:1 onto the
    // source characters, so per-character advances are undefined.
    throw new CompositionUnsupported("case mapping changes the text length");
  }
  const buf = new hb.Buffer();
  buf.add_str(shaped_text);
  buf.guess_segment_properties();
  hb.shape(font, buf, { liga: false, clig: false });
  for (const info of buf.glyph_infos) {
    if (info.codepoint === 0) {
      throw new CompositionUnsupported(
        `glyph missing from ${repr(style.font)} for a character in ${repr(text)}`,
      );
    }
  }
  return [buf, style.size / upem];
}

/** Per-character advances for one same-style stretch. */
export function _shape_stretch(text: string, style: _CharStyle): number[] {
  const [buf, scale] = _shape_glyphs(text, style);
  return _glyph_advances(text, style, buf, scale);
}

/** Per-character advances of a stretch shaped by `_shape_glyphs`. */
export function _glyph_advances(text: string, style: _CharStyle, buf: _HbBuffer, scale: number): number[] {
  // Text here is BMP-only (`_check_envelope` refuses astral characters
  // first), so UTF-16 indexing matches Python's code-point indexing.
  const per_cluster: number[] = new Array<number>(text.length).fill(0.0);
  for (const [info, pos] of zip<[_HbBuffer["glyph_infos"], _HbBuffer["glyph_positions"]]>(buf.glyph_infos, buf.glyph_positions)) {
    per_cluster[info.cluster] += pos.x_advance * scale;
  }
  const advances: number[] = [];
  for (let [i, advance] of per_cluster.entries()) {
    if (style.fauxbold) {
      advance += _FAUX_BOLD_ADVANCE * style.size;
    }
    if (style.caps === 1 && islower(text[i])) {
      advance *= _SMALL_CAPS_SCALE;
    }
    advances.push(advance * style.hscale + (style.tracking / 1000.0) * style.size);
  }
  return advances;
}

/** Per-character advances for `text` at `offset` in the document. */
export function _advances(text: string, styles: _CharStyle[], offset: number): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    const key = styles[offset + i].stretch_key();
    let j = i;
    while (j < text.length && styles[offset + j].stretch_key() === key) {
      j += 1;
    }
    for (const advance of _shape_stretch(text.slice(i, j), styles[offset + i])) {
      out.push(advance);
    }
    i = j;
  }
  return out;
}

export function _width(text: string, styles: _CharStyle[], offset: number): number {
  return sum(_advances(text, styles, offset));
}

/**
 * Greedy word-fit; returns the length of each produced line.
 *
 * Each candidate prefix is re-shaped from scratch (quadratic in line
 * width). Deliberate: prefix sums over one full-paragraph shape
 * diverge from shaped-substring widths by up to ~1 px at the cut
 * boundary (cross-boundary kern/contextual positioning, measured on
 * M_HYPHENS), and only per-candidate shaping is fixture-proven
 * against AE's breaks. Do not swap in prefix sums without re-running
 * the box_matrix parity suite on width-critical fixtures.
 */
export function _break_paragraph(
  paragraph: string,
  styles: _CharStyle[],
  offset: number,
  limit: number,
  first_limit: number,
): number[] {
  if (!paragraph) {
    // An empty paragraph still composes to one (empty) line; the
    // caller extends it over the paragraph's `\r`.
    return [0];
  }
  const lengths: number[] = [];
  let rest = paragraph;
  let rest_offset = offset;
  let current_limit = first_limit;
  while (rest) {
    let take = 0;
    while (take < rest.length) {
      const next_space = rest.indexOf(" ", take);
      let candidate_end = next_space === -1 ? rest.length : next_space;
      const candidate = rstrip(rest.slice(0, candidate_end), " ");
      if (_width(candidate, styles, rest_offset) > current_limit) {
        break;
      }
      while (candidate_end < rest.length && rest[candidate_end] === " ") {
        candidate_end += 1;
      }
      take = candidate_end;
      if (next_space === -1) {
        break;
      }
    }
    if (take === 0) {
      // Token wider than the line: wrap at the character level.
      take = 1;
      while (
        take < rest.length &&
        rest[take] !== " " &&
        _width(rest.slice(0, take + 1), styles, rest_offset) <= current_limit
      ) {
        take += 1;
      }
    }
    lengths.push(take);
    rest = rest.slice(take);
    rest_offset += take;
    current_limit = limit;
  }
  return lengths;
}

/**
 * Recompose a box-text document's lines exactly as AE would.
 *
 * Returns the clipped line spans (UTF-16 == code-point indices inside
 * the envelope; the final span covers the raw terminator like AE's
 * cache), their baselines, and whether the text overflows the box.
 *
 * Throws CompositionUnsupported: When the document uses any feature
 * outside the verified envelope, a font is not installed, or
 * `uharfbuzz` is unavailable (Python 3.7).
 */
export function compose_lines(doc: TextDocument): ComposedLines {
  const raw = str(py_or(cos_get(doc._doc, "0", "0"), ""));
  const box_size = doc.box_text_size;
  if (box_size == null) {
    throw new CompositionUnsupported("not a box-text document");
  }
  _check_envelope(doc, raw);
  const styles = _char_styles(doc, raw);
  const inset = doc.box_inset_spacing;
  const width = box_size[0];
  const height = box_size[1];

  const para_geo: [number, number][] = [];
  for (const [_start, _end, style] of run_spans(doc._doc, "5", "5")) {
    const base = width - 2 * inset - cos_float(cos_get_or(style, "2", 0.0)) - cos_float(cos_get_or(style, "3", 0.0));
    para_geo.push([base, base - cos_float(cos_get_or(style, "1", 0.0))]);
  }

  const body = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const paragraphs = split(body, "\r");
  if (para_geo.length !== paragraphs.length) {
    // AE stores exactly one paragraph run per paragraph (and
    // _splice_text preserves that); a mismatch means a malformed
    // document whose geometry we must not guess.
    throw new CompositionUnsupported("paragraph runs do not cover the paragraphs");
  }

  const spans: [number, number][] = [];
  let offset = 0;
  for (const [index, paragraph] of paragraphs.entries()) {
    const [limit, first_limit] = para_geo[index];
    const lengths = _break_paragraph(paragraph, styles, offset, limit, first_limit);
    for (const [line_no, length] of lengths.entries()) {
      let end = offset + length;
      if (line_no === lengths.length - 1) {
        end += 1; // the paragraph's \r (or the raw terminator)
      }
      spans.push([offset, end]);
      offset = end;
    }
  }

  // The inset shrinks the usable width but does NOT shift the first
  // baseline (probed M_INSET8); faux bold raises the ascent by half
  // its advance bump (probed M_FAUXB).
  const baselines: number[] = [];
  let y = 0.0;
  for (const [line_no, [start, end]] of spans.entries()) {
    const line_styles = py_or(styles.slice(start, Math.min(end, styles.length)), [at(styles, -1)]);
    if (line_no === 0) {
      y += max(
        line_styles.map(
          (s) => (_ascender_ratio(s.font) + (s.fauxbold ? _FAUX_BOLD_ADVANCE / 2 : 0.0)) * s.size,
        ),
      );
    } else {
      y += max(line_styles.map((s) => s.leading));
    }
    baselines.push(y);
  }

  const kept = sum(baselines.map((b) => (b <= height ? 1 : 0)));
  return new ComposedLines(spans.slice(0, kept), baselines.slice(0, kept), kept < spans.length);
}

/**
 * Verify the composer against the document's own persisted cache.
 *
 * Composes the CURRENT (still clean) text and compares line spans and
 * baselines with what AE saved. Success proves the installed fonts
 * and every composition rule match AE's composer for this document,
 * making post-mutation recomposition trustworthy; any mismatch (or an
 * envelope refusal) means the composer must not be used for it.
 */
export function calibrate(
  doc: TextDocument,
  cached_spans: [number, number][],
  cached_baselines: (number | null)[],
): boolean {
  let composed: ComposedLines;
  try {
    composed = compose_lines(doc);
  } catch (e) {
    if (!(e instanceof CompositionUnsupported)) throw e;
    return false;
  }
  if (!py_eq(composed.spans, [...cached_spans])) {
    return false;
  }
  for (const [computed, cached] of zip(composed.baselines, cached_baselines)) {
    if (cached == null) {
      continue;
    }
    // TrueType ascenders reproduce AE within ~1.4 font units
    // (<= 0.03 px at 36 pt); breaks are unaffected, only a box
    // height landing inside that sliver could mis-clip.
    if (Math.abs(computed - cached) > 0.05) {
      return false;
    }
  }
  return true;
}
