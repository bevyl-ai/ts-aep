/**
 * Ink bounds of a text layer, for `AVLayer.sourceRectAtTime`.
 *
 * After Effects measures a text layer's content as the tight box around its
 * glyphs' outlines. Rules measured on After Effects 2026 (point and box text
 * at sizes 8-500, several fonts, justifications, leading, tracking, stroke):
 *
 * - Glyphs sit where the composer places them (see `text_composition`):
 *   point text keeps one line per paragraph, its first baseline on the layer
 *   origin, the next ones a line's leading below; box text breaks and
 *   baselines exactly as the box composer does, below the box's top inset.
 *   A left-justified line starts at its origin, a centered or right-justified
 *   one is shifted back by half or all of its advance width, without the
 *   tracking after its last character.
 * - A glyph's ink is its outline's bounds at the character's font size, a
 *   PostScript (CFF) outline scaled by a further `1031.25 / 1024` about the
 *   glyph origin (every CFF font measured, whatever its units per em;
 *   TrueType outlines are exact).
 * - A stroked character grows the box by the whole stroke width on every
 *   side, with or without `extents`.
 * - A layer without ink measures `0, 0, 0, 0`.
 *
 * Anything the measurements did not cover raises `NotImplementedError`
 * rather than guess: text animators, text on a path, per-character 3D, faux
 * bold / italic, small or all caps, horizontal / vertical scale, trailing
 * spaces on a centered or right-justified line, and everything the box
 * composer itself refuses.
 */

// NOTE(port): text is indexed in UTF-16 units here; Python indexes code points.
// `_check_envelope` refuses astral characters before any of this runs, so the
// two agree on every text that reaches these helpers.

import * as fontkit from "fontkit";
import * as host from "../../pyrt/host.ts";
import {
  NotImplementedError,
  at,
  max,
  py_bool,
  py_or,
  repr,
  rstrip,
  split,
  str,
  tkey,
  zip,
} from "../../pyrt/index.ts";
import type { TextDocument } from "../models/text/text_document.ts";
import { cos_get, run_spans } from "../cos/index.ts";
import type { CosDict } from "../cos/cos.ts";
import { enum_from_cos } from "../cos/descriptors.ts";
import { cos_float, cos_get_or, cos_int } from "../cos/kinds.ts";
import { ParagraphJustification } from "../enums/index.ts";
import * as tc from "./text_composition.ts";
import { BoxAccumulator } from "./shape_bounds.ts";

// A glyph's outline bounds in font units, `null` for an empty glyph.
// NOTE(port): keyed by glyph id (HarfBuzz codepoint); Python's glyph name is order[gid], a 1:1 map, so the cache is equivalent.
export type _GlyphBounds = Map<number, [number, number, number, number] | null>;

export type _CharStyle = ReturnType<typeof tc._char_styles>[number];

export const _CFF_INK_SCALE = 1031.25 / 1024;

export const _glyph_cache = new Map<string, [fontkit.Font, boolean, _GlyphBounds]>();

export function _is_os_error(exc: Error | null): boolean {
  // Python catches OSError (a missing or unreadable file). Node reports those
  // as errors carrying a string `code`.
  return exc instanceof Error && "code" in exc && typeof exc.code === "string";
}

export function _open_face(path: string, face_index: number): fontkit.Font {
  // NOTE(port): fontTools `TTFont(fontNumber=...)` picks a face of a .ttc;
  // fontkit exposes collection faces through `.fonts`; a plain font is its own face.
  const opened = fontkit.create(host.fs.readFileSync(path));
  return opened.fonts ? at(opened.fonts, face_index) : opened;
}

/** `(font, is_cff, outline bounds by glyph id)` for a PostScript name, cached; the bounds fill in as glyphs are measured. */
export function _font_outlines(ps_name: string): [fontkit.Font, boolean, _GlyphBounds] {
  const [path, face_index] = tc._resolve_face(ps_name);
  const key = tkey(path.toString(), face_index);
  let cached = _glyph_cache.get(key);
  if (cached === undefined) {
    let font: fontkit.Font;
    try {
      font = _open_face(path.toString(), face_index);
    } catch (exc) {
      if (!(exc instanceof Error) || !_is_os_error(exc)) throw exc;
      throw Object.assign(
        new NotImplementedError(`font file for ${repr(ps_name)} is unreadable: ${path.toString()}`),
        { cause: exc },
      );
    }
    const tables = font.directory.tables;
    cached = [font, "CFF " in tables || "CFF2" in tables, new Map()];
    _glyph_cache.set(key, cached);
  }
  return cached;
}

/** fontTools `BoundsPen` for one glyph: `null` when it draws nothing. */
export function _pen_bounds(font: fontkit.Font, gid: number): [number, number, number, number] | null {
  // TODO(port): fontkit vs fontTools outline decoding. fontkit's Path.bbox is
  // exact (curve extrema) like BoundsPen, but fontkit builds the path itself
  // (TrueType implied on-curve points, CFF/CFF2 charstring interpretation), so
  // a glyph whose outline fontkit decodes differently from fontTools gets
  // different bounds; not checkable without a second decoder.
  const glyph = font.getGlyph(gid);
  if (glyph.path.commands.length === 0) return null;
  const b = glyph.path.bbox;
  return [b.minX, b.minY, b.maxX, b.maxY];
}

export function _refuse(reason: string): NotImplementedError {
  return new NotImplementedError(`source_rect_at_time does not model text with ${reason}`);
}

export function _check_styles(doc: TextDocument): void {
  for (const [_start, _end, style] of run_spans(doc._doc, "6", "6")) {
    if (py_bool(style.get("2") ?? null)) throw _refuse("faux bold");
    if (py_bool(style.get("3") ?? null)) throw _refuse("faux italic");
    if (cos_int(cos_get_or(style, "12", 0)) !== 0) throw _refuse("small or all caps");
    if (cos_float(cos_get_or(style, "6", 1.0)) !== 1.0 || cos_float(cos_get_or(style, "7", 1.0)) !== 1.0) {
      throw _refuse("horizontal or vertical scale");
    }
  }
}

/**
 * The stroke a character's run draws, 0 when it has none (the width
 * defaults to 1, as `TextDocument.strokeWidth` reads it).
 */
export function _stroke_width(style: CosDict): number {
  if (!py_bool(cos_get_or(style, "57", false))) return 0.0;
  return cos_float(cos_get_or(style, "63", 1.0));
}

/**
 * Grow `box` by the ink of one line whose pen starts at `origin_x`.
 *
 * Glyphs are placed by the composer's own shaping and advances
 * (`text_composition`), the ones that break and justify the lines.
 */
export function _line_ink(
  text: string,
  styles: _CharStyle[],
  strokes: number[],
  offset: number,
  origin_x: number,
  baseline: number,
  box: BoxAccumulator,
): void {
  let x = origin_x;
  let i = 0;
  while (i < text.length) {
    const style = styles[offset + i];
    const key = style.stretch_key();
    let j = i;
    while (j < text.length && styles[offset + j].stretch_key() === key) {
      j += 1;
    }
    const stretch = text.slice(i, j);
    const [buf, scale] = tc._shape_glyphs(stretch, style);
    const pens: number[] = [];
    for (const advance of tc._glyph_advances(stretch, style, buf, scale)) {
      pens.push(x);
      x += advance;
    }
    const [font, is_cff, glyph_bounds] = _font_outlines(style.font);
    const ink_scale = scale * (is_cff ? _CFF_INK_SCALE : 1.0);
    for (const [info, pos] of zip<[{ codepoint: number; cluster: number }[], { x_advance: number; y_advance: number; x_offset: number; y_offset: number }[]]>(buf.glyph_infos, buf.glyph_positions)) {
      // fontkit addresses glyphs by id, which HarfBuzz reports as the codepoint.
      const name = info.codepoint;
      if (!glyph_bounds.has(name)) {
        glyph_bounds.set(name, _pen_bounds(font, name));
      }
      const bounds = glyph_bounds.get(name);
      if (bounds == null) continue;
      const [x_min, y_min, x_max, y_max] = bounds;
      const gx = pens[info.cluster] + pos.x_offset * scale;
      const gy = baseline - pos.y_offset * scale;
      const grow = strokes[offset + i + info.cluster];
      box.add(
        gx + x_min * ink_scale - grow,
        gy - y_max * ink_scale - grow,
        gx + x_max * ink_scale + grow,
        gy - y_min * ink_scale + grow,
      );
    }
    i = j;
  }
}

/** Where a point-text line that is not left-justified starts its pen, from its advance width. */
export function _justified_origin(
  justification: ParagraphJustification,
  width: number,
  text: string,
): number {
  if (text !== rstrip(text, " ")) {
    throw _refuse("trailing spaces on a centered or right-justified line");
  }
  if (justification === ParagraphJustification.CENTER_JUSTIFY) {
    return -width / 2;
  }
  if (justification === ParagraphJustification.RIGHT_JUSTIFY) {
    return -width;
  }
  throw _refuse(`${ParagraphJustification.name_of(justification)} paragraphs`);
}

/**
 * `sourceRectAtTime` of a text layer's document (see module rules).
 *
 * @throws NotImplementedError Outside the measured envelope (module
 *   docstring), or when a font is not installed.
 */
export function text_ink_rect(doc: TextDocument): { top: number; left: number; width: number; height: number } {
  const raw = str(py_or(cos_get(doc._doc, "0", "0"), ""));
  _check_styles(doc);
  let styles: _CharStyle[];
  try {
    tc._check_envelope(doc, raw);
    styles = tc._char_styles(doc, raw);
  } catch (exc) {
    if (!(exc instanceof tc.CompositionUnsupported)) throw exc;
    throw Object.assign(_refuse(exc.message), { cause: exc });
  }
  const strokes: number[] = [];
  for (const [start, end, style] of run_spans(doc._doc, "6", "6")) {
    const width = _stroke_width(style);
    for (let k = 0; k < end - start; k++) strokes.push(width);
  }
  const paragraph_styles = run_spans(doc._doc, "5", "5").map(([_s, _e, style]) => style);
  const box = new BoxAccumulator();
  try {
    if (doc.boxTextSize != null) {
      _box_text_ink(doc, raw, styles, strokes, paragraph_styles, box);
    } else {
      _point_text_ink(raw, styles, strokes, paragraph_styles, box);
    }
  } catch (exc) {
    if (!(exc instanceof tc.CompositionUnsupported)) throw exc;
    throw Object.assign(_refuse(exc.message), { cause: exc });
  }
  return box.rect();
}

export function _justification(paragraph_style: CosDict): ParagraphJustification {
  return enum_from_cos(ParagraphJustification, cos_int(cos_get_or(paragraph_style, "0", 0)));
}

export function _point_text_ink(
  raw: string,
  styles: _CharStyle[],
  strokes: number[],
  paragraph_styles: CosDict[],
  box: BoxAccumulator,
): void {
  const body = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const paragraphs = split(body, "\r");
  if (paragraph_styles.length !== paragraphs.length) {
    throw _refuse("paragraph runs that do not cover the paragraphs");
  }
  let offset = 0;
  let baseline = 0.0;
  for (const [index, paragraph] of paragraphs.entries()) {
    let line_styles = styles.slice(offset, offset + paragraph.length + 1);
    if (line_styles.length === 0) line_styles = [at(styles, -1)];
    if (index > 0) {
      baseline += max(line_styles.map((s) => s.leading));
    }
    if (paragraph) {
      const style = paragraph_styles[index];
      const justification = _justification(style);
      let origin = 0.0;
      if (justification !== ParagraphJustification.LEFT_JUSTIFY) {
        // AE justifies the line without the tracking after its last
        // character (measured on AE 2026: a centered line shifts by
        // half of `tracking * size / 1000`, a right-justified one by
        // all of it). A left-justified line needs no width, so its
        // glyphs are shaped once, by `_line_ink`.
        const last = styles[offset + paragraph.length - 1];
        const width =
          tc._width(paragraph, styles, offset) - (last.tracking / 1000.0) * last.size;
        origin = _justified_origin(justification, width, paragraph);
      }
      // A point-text paragraph is one line, its first: AE 2026 moves it
      // by the first-line indent whatever the justification, plus the
      // start indent when left-justified or minus the end indent when
      // right-justified (a centered line ignores both).
      origin += cos_float(cos_get_or(style, "1", 0.0));
      if (justification === ParagraphJustification.LEFT_JUSTIFY) {
        origin += cos_float(cos_get_or(style, "2", 0.0));
      } else if (justification === ParagraphJustification.RIGHT_JUSTIFY) {
        origin -= cos_float(cos_get_or(style, "3", 0.0));
      }
      _line_ink(paragraph, styles, strokes, offset, origin, baseline, box);
    }
    offset += paragraph.length + 1;
  }
}

export function _box_text_ink(
  doc: TextDocument,
  raw: string,
  styles: _CharStyle[],
  strokes: number[],
  paragraph_styles: CosDict[],
  box: BoxAccumulator,
): void {
  const composed = tc.compose_lines(doc);
  const position = doc.boxTextPos;
  if (position == null) {
    throw _refuse("a text box without a position");
  }
  const left = cos_float(position[0]);
  const top = cos_float(position[1]);
  const inset = doc.boxInsetSpacing;
  // Map each character to its paragraph for the justification and indents.
  const paragraph_of: number[] = [];
  for (const [index, [start, end]] of run_spans(doc._doc, "5", "5").entries()) {
    for (let k = 0; k < end - start; k++) paragraph_of.push(index);
  }
  for (const [[start, end], baseline] of zip(composed.spans, composed.baselines)) {
    const text = rstrip(raw.slice(start, end), "\r");
    if (!text) continue;
    const style = paragraph_styles[paragraph_of[start]];
    if (_justification(style) !== ParagraphJustification.LEFT_JUSTIFY) {
      throw _refuse("non-left-justified box text");
    }
    const first_line = start === 0 || raw[start - 1] === "\r";
    let origin = left + inset + cos_float(cos_get_or(style, "2", 0.0));
    if (first_line) {
      origin += cos_float(cos_get_or(style, "1", 0.0));
    }
    // The inset pads the box on every side, the top included (AE 2026:
    // an inset of 8 or 20 lowers the ink by exactly that much).
    _line_ink(text, styles, strokes, start, origin, top + inset + baseline, box);
  }
}
