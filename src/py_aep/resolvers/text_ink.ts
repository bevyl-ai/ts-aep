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
// `_checkEnvelope` refuses astral characters before any of this runs, so the
// two agree on every text that reaches these helpers.

import type * as fontkit from "fontkit";
import { dep } from "../../pyrt/deps.ts";
import * as host from "../../pyrt/host.ts";
import {
  NotImplementedError,
  max,
  truthy,
  truthyOr,
  literal,
  compositeKey,
  zip,
} from "../../pyrt/index.ts";
import type { TextDocument } from "../models/text/text_document.ts";
import { cosGet, runSpans } from "../cos/index.ts";
import type { CosDict } from "../cos/cos.ts";
import { enumFromCos } from "../cos/descriptors.ts";
import { cosFloat, cosGetOr, cosInt } from "../cos/kinds.ts";
import { ParagraphJustification } from "../enums/index.ts";
import * as tc from "./text_composition.ts";
import { BoxAccumulator } from "./shape_bounds.ts";

// A glyph's outline bounds in font units, `null` for an empty glyph.
// NOTE(port): keyed by glyph id (HarfBuzz codepoint); Python's glyph name is order[gid], a 1:1 map, so the cache is equivalent.
export type _GlyphBounds = Map<number, [number, number, number, number] | null>;

export type _CharStyle = ReturnType<typeof tc._charStyles>[number];

export const _CFF_INK_SCALE = 1031.25 / 1024;

export const _glyphCache = new Map<string, [fontkit.Font, boolean, _GlyphBounds]>();

export function _isOsError(exc: Error | null): boolean {
  // Python catches OSError (a missing or unreadable file). Node reports those
  // as errors carrying a string `code`.
  return exc instanceof Error && "code" in exc && typeof exc.code === "string";
}

export function _openFace(path: string, faceIndex: number): fontkit.Font {
  // NOTE(port): fontTools `TTFont(fontNumber=...)` picks a face of a .ttc;
  // fontkit exposes collection faces through `.fonts`; a plain font is its own face.
  const opened = dep("fontkit").create(host.fs.readFileSync(path));
  return opened.fonts ? opened.fonts.at(faceIndex)! : opened;
}

/** `(font, is_cff, outline bounds by glyph id)` for a PostScript name, cached; the bounds fill in as glyphs are measured. */
export function _fontOutlines(psName: string): [fontkit.Font, boolean, _GlyphBounds] {
  const [path, faceIndex] = tc._resolveFace(psName);
  const key = compositeKey(path.toString(), faceIndex);
  let cached = _glyphCache.get(key);
  if (cached === undefined) {
    let font: fontkit.Font;
    try {
      font = _openFace(path.toString(), faceIndex);
    } catch (exc) {
      if (!(exc instanceof Error) || !_isOsError(exc)) throw exc;
      throw Object.assign(
        new NotImplementedError(`font file for ${literal(psName)} is unreadable: ${path.toString()}`),
        { cause: exc },
      );
    }
    const tables = font.directory.tables;
    cached = [font, "CFF " in tables || "CFF2" in tables, new Map()];
    _glyphCache.set(key, cached);
  }
  return cached;
}

/** fontTools `BoundsPen` for one glyph: `null` when it draws nothing. */
export function _penBounds(font: fontkit.Font, gid: number): [number, number, number, number] | null {
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
  return new NotImplementedError(`sourceRectAtTime does not model text with ${reason}`);
}

export function _checkStyles(doc: TextDocument): void {
  for (const [_start, _end, style] of runSpans(doc._doc, "6", "6")) {
    if (truthy(style.get("2") ?? null)) throw _refuse("faux bold");
    if (truthy(style.get("3") ?? null)) throw _refuse("faux italic");
    if (cosInt(cosGetOr(style, "12", 0)) !== 0) throw _refuse("small or all caps");
    if (cosFloat(cosGetOr(style, "6", 1.0)) !== 1.0 || cosFloat(cosGetOr(style, "7", 1.0)) !== 1.0) {
      throw _refuse("horizontal or vertical scale");
    }
  }
}

/**
 * The stroke a character's run draws, 0 when it has none (the width
 * defaults to 1, as `TextDocument.strokeWidth` reads it).
 */
export function _strokeWidth(style: CosDict): number {
  if (!truthy(cosGetOr(style, "57", false))) return 0.0;
  return cosFloat(cosGetOr(style, "63", 1.0));
}

/**
 * Grow `box` by the ink of one line whose pen starts at `originX`.
 *
 * Glyphs are placed by the composer's own shaping and advances
 * (`text_composition`), the ones that break and justify the lines.
 */
export function _lineInk(
  text: string,
  styles: _CharStyle[],
  strokes: number[],
  offset: number,
  originX: number,
  baseline: number,
  box: BoxAccumulator,
): void {
  let x = originX;
  let i = 0;
  while (i < text.length) {
    const style = styles[offset + i];
    const key = style.stretchKey();
    let j = i;
    while (j < text.length && styles[offset + j].stretchKey() === key) {
      j += 1;
    }
    const stretch = text.slice(i, j);
    const [buf, scale] = tc._shapeGlyphs(stretch, style);
    const pens: number[] = [];
    for (const advance of tc._glyphAdvances(stretch, style, buf, scale)) {
      pens.push(x);
      x += advance;
    }
    const [font, isCff, glyphBounds] = _fontOutlines(style.font);
    const inkScale = scale * (isCff ? _CFF_INK_SCALE : 1.0);
    for (const [info, pos] of zip<[{ codepoint: number; cluster: number }[], { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }[]]>(buf.glyphInfos, buf.glyphPositions)) {
      // fontkit addresses glyphs by id, which HarfBuzz reports as the codepoint.
      const name = info.codepoint;
      if (!glyphBounds.has(name)) {
        glyphBounds.set(name, _penBounds(font, name));
      }
      const bounds = glyphBounds.get(name);
      if (bounds == null) continue;
      const [xMin, yMin, xMax, yMax] = bounds;
      const gx = pens[info.cluster] + pos.xOffset * scale;
      const gy = baseline - pos.yOffset * scale;
      const grow = strokes[offset + i + info.cluster];
      box.add(
        gx + xMin * inkScale - grow,
        gy - yMax * inkScale - grow,
        gx + xMax * inkScale + grow,
        gy - yMin * inkScale + grow,
      );
    }
    i = j;
  }
}

/** Where a point-text line that is not left-justified starts its pen, from its advance width. */
export function _justifiedOrigin(
  justification: ParagraphJustification,
  width: number,
  text: string,
): number {
  if (text !== text.replace(/ +$/, "")) {
    throw _refuse("trailing spaces on a centered or right-justified line");
  }
  if (justification === ParagraphJustification.CENTER_JUSTIFY) {
    return -width / 2;
  }
  if (justification === ParagraphJustification.RIGHT_JUSTIFY) {
    return -width;
  }
  throw _refuse(`${ParagraphJustification.nameOf(justification)} paragraphs`);
}

/**
 * `sourceRectAtTime` of a text layer's document (see module rules).
 *
 * @throws NotImplementedError Outside the measured envelope (module
 *   docstring), or when a font is not installed.
 */
export function textInkRect(doc: TextDocument): { top: number; left: number; width: number; height: number } {
  const raw = String(truthyOr(cosGet(doc._doc, "0", "0"), ""));
  _checkStyles(doc);
  let styles: _CharStyle[];
  try {
    tc._checkEnvelope(doc, raw);
    styles = tc._charStyles(doc, raw);
  } catch (exc) {
    if (!(exc instanceof tc.CompositionUnsupported)) throw exc;
    throw Object.assign(_refuse(exc.message), { cause: exc });
  }
  const strokes: number[] = [];
  for (const [start, end, style] of runSpans(doc._doc, "6", "6")) {
    const width = _strokeWidth(style);
    for (let k = 0; k < end - start; k++) strokes.push(width);
  }
  const paragraphStyles = runSpans(doc._doc, "5", "5").map(([_s, _e, style]) => style);
  const box = new BoxAccumulator();
  try {
    if (doc.boxTextSize != null) {
      _boxTextInk(doc, raw, styles, strokes, paragraphStyles, box);
    } else {
      _pointTextInk(raw, styles, strokes, paragraphStyles, box);
    }
  } catch (exc) {
    if (!(exc instanceof tc.CompositionUnsupported)) throw exc;
    throw Object.assign(_refuse(exc.message), { cause: exc });
  }
  return box.rect();
}

export function _justification(paragraphStyle: CosDict): ParagraphJustification {
  return enumFromCos(ParagraphJustification, cosInt(cosGetOr(paragraphStyle, "0", 0)));
}

export function _pointTextInk(
  raw: string,
  styles: _CharStyle[],
  strokes: number[],
  paragraphStyles: CosDict[],
  box: BoxAccumulator,
): void {
  const body = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const paragraphs = body.split("\r");
  if (paragraphStyles.length !== paragraphs.length) {
    throw _refuse("paragraph runs that do not cover the paragraphs");
  }
  let offset = 0;
  let baseline = 0.0;
  for (const [index, paragraph] of paragraphs.entries()) {
    let lineStyles = styles.slice(offset, offset + paragraph.length + 1);
    if (lineStyles.length === 0) lineStyles = [styles.at(-1)!];
    if (index > 0) {
      baseline += max(lineStyles.map((s) => s.leading));
    }
    if (paragraph) {
      const style = paragraphStyles[index];
      const justification = _justification(style);
      let origin = 0.0;
      if (justification !== ParagraphJustification.LEFT_JUSTIFY) {
        // AE justifies the line without the tracking after its last
        // character (measured on AE 2026: a centered line shifts by
        // half of `tracking * size / 1000`, a right-justified one by
        // all of it). A left-justified line needs no width, so its
        // glyphs are shaped once, by `_lineInk`.
        const last = styles[offset + paragraph.length - 1];
        const width =
          tc._width(paragraph, styles, offset) - (last.tracking / 1000.0) * last.size;
        origin = _justifiedOrigin(justification, width, paragraph);
      }
      // A point-text paragraph is one line, its first: AE 2026 moves it
      // by the first-line indent whatever the justification, plus the
      // start indent when left-justified or minus the end indent when
      // right-justified (a centered line ignores both).
      origin += cosFloat(cosGetOr(style, "1", 0.0));
      if (justification === ParagraphJustification.LEFT_JUSTIFY) {
        origin += cosFloat(cosGetOr(style, "2", 0.0));
      } else if (justification === ParagraphJustification.RIGHT_JUSTIFY) {
        origin -= cosFloat(cosGetOr(style, "3", 0.0));
      }
      _lineInk(paragraph, styles, strokes, offset, origin, baseline, box);
    }
    offset += paragraph.length + 1;
  }
}

export function _boxTextInk(
  doc: TextDocument,
  raw: string,
  styles: _CharStyle[],
  strokes: number[],
  paragraphStyles: CosDict[],
  box: BoxAccumulator,
): void {
  const composed = tc.composeLines(doc);
  const position = doc.boxTextPos;
  if (position == null) {
    throw _refuse("a text box without a position");
  }
  const left = cosFloat(position[0]);
  const top = cosFloat(position[1]);
  const inset = doc.boxInsetSpacing;
  // Map each character to its paragraph for the justification and indents.
  const paragraphOf: number[] = [];
  for (const [index, [start, end]] of runSpans(doc._doc, "5", "5").entries()) {
    for (let k = 0; k < end - start; k++) paragraphOf.push(index);
  }
  for (const [[start, end], baseline] of zip(composed.spans, composed.baselines)) {
    const text = raw.slice(start, end).replace(/\r+$/, "");
    if (!text) continue;
    const style = paragraphStyles[paragraphOf[start]];
    if (_justification(style) !== ParagraphJustification.LEFT_JUSTIFY) {
      throw _refuse("non-left-justified box text");
    }
    const firstLine = start === 0 || raw[start - 1] === "\r";
    let origin = left + inset + cosFloat(cosGetOr(style, "2", 0.0));
    if (firstLine) {
      origin += cosFloat(cosGetOr(style, "1", 0.0));
    }
    // The inset pads the box on every side, the top included (AE 2026:
    // an inset of 8 or 20 lowers the ink by exactly that much).
    _lineInk(text, styles, strokes, start, origin, top + inset + baseline, box);
  }
}
