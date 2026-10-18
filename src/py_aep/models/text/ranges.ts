/**
 * Text range models mirroring the AE 24.3+ ExtendScript range API.
 *
 * `CharacterRange`, `ParagraphRange` and `ComposedLineRange` are computed,
 * read-only views over a {@link TextDocument | TextDocument}'s
 * parsed COS data. They are created via the `TextDocument` factory methods
 * (`characterRange`, `paragraphRange`, `composedLineRange`), never
 * constructed directly - matching ExtendScript, where `new CharacterRange()`
 * does not exist.
 *
 * Index semantics (probed against AE 26.3, see
 * `samples/models/text/text_ranges_probe.json`):
 *
 * * All indices are UTF-16 code units, exactly as in ExtendScript. Astral
 *   characters (e.g. emoji) count as two units, and AE allows ranges that
 *   split a surrogate pair - `text` then contains a lone surrogate.
 * * Style-run, kerning-run and composed-line counts stored in the COS data
 *   cover the raw text, which carries one terminator `\r` beyond the
 *   user-visible text. Boundaries are clamped to the visible length.
 * * Ranges resolve dynamically: they hold their creation parameters and
 *   re-evaluate bounds on every access, so a range can become invalid (or
 *   valid again) as the backing document changes.
 * * Composed lines are a layout cache written by AE at save time. py_aep
 *   cannot recompose text; after py-side edits the cache goes stale with
 *   the same observable behavior as AE's own un-reapplied TextDocument
 *   values: counts stay cached, line boundaries clamp to the current text,
 *   and lines that fall wholly outside raise.
 */

import { INSPECT } from "../../../pyrt/index.ts";
import {
  AttributeError,
  NotImplementedError,
  ValueError,
  deepcopy,
  float,
  getitem,
  max,
  pyAssert,
  pyBool,
  pyEq,
  repr,
  round,
  sorted,
  split,
  str,
  descriptor,
  pyfloat,
} from "../../../pyrt/index.ts";
import { CosField, CosName, cosGet, runSpans } from "../../cos/index.ts";
import type { CosDict, CosNode } from "../../cos/cos.ts";
import { _extract, boolField, enumField, floatField, intField, enumFromCos, type CosEnum, type CosFieldExtras, type InstanceValue } from "../../cos/descriptors.ts";
import { cosDict, cosFloat, cosGetOr, cosIn, cosInsert, cosInt, cosIter, cosNum, cosPop, cosSetdefault, cosSetitem, is, pyAdd, pyInt, pyNum, pyNumber, pySub, type PyNum } from "../../cos/kinds.ts";
import { cacheLine, charStyle, fontRef, read } from "../../cos/schema.ts";
import { AutoKernType, BaselineDirection, DigitSet, FontBaselineOption, FontCapsOption, LeadingType, LineJoinType, ParagraphDirection, ParagraphJustification } from "../../enums/index.ts";
import type { ComposerEngine } from "../../enums/index.ts";
import { CompositionUnsupported, composeLines } from "../../resolvers/text_composition.ts";
import { fontVersionString } from "../../svg/fonts.ts";
import { validateBool, validateEnum, validateFontName, validateNormalizedFloat, validateNumber, validatePositiveNonzeroNumber, validatePositiveNumber, validateRgbColor, validateS4, validateText, type InstanceValidator } from "../validators.ts";
import { FontObject } from "./font_object.ts";
import type { TextDocument } from "./text_document.ts";

export const bool = (x: CosNode): boolean => pyBool(x);

// AE's exact error strings (AE 26.3, English locale); py_aep raises these
// from ValueError so behavior parity does not depend on hosting AE.
export const CHARACTER_RANGE_OOB = "Character index range is outside of TextDocument bounds.";
export const PARAGRAPH_RANGE_OOB = "Paragraph index range is outside of TextDocument bounds.";
export const COMPOSED_LINE_OOB = "ComposedLine index range is outside of TextDocument composed lines.";
export const NOT_ASSOCIATED = "Unable to set value as it is not associated with a layer.";

// ---------------------------------------------------------------------------
// UTF-16 code-unit helpers (AE index semantics)
// ---------------------------------------------------------------------------

/**
 * Length of `s` in UTF-16 code units (AE / ExtendScript indexing).
 *
 * JS strings already index UTF-16 code units, so this is `s.length`; the
 * Python version counts astral characters twice on top of `len(s)`.
 */
export function u16Len(s: string): number {
  return s.length;
}

/**
 * Slice `s` by UTF-16 code-unit offsets.
 *
 * A slice that splits a surrogate pair yields a lone surrogate, exactly
 * as AE does (JS keeps lone surrogates in a string, as `surrogatepass` does).
 */
export function u16Slice(s: string, start: number, end: number): string {
  return s.slice(start, end);
}

// ---------------------------------------------------------------------------
// COS accessors shared with TextDocument
// ---------------------------------------------------------------------------

/** The stored text, including the terminator `\r`. */
export function _rawText(doc: TextDocument): string {
  const val = cosGet(doc._doc, "0", "0");
  return val != null ? str(val) : "";
}

/**
 * Length in UTF-16 units of the user-visible text.
 *
 * The stored run counts cover one trailing terminator `\r` that
 * ExtendScript's indices never expose; everything user-facing is
 * clamped to this length.
 */
export function _visibleLength(doc: TextDocument): number {
  const raw = _rawText(doc);
  const n = u16Len(raw);
  if (raw.endsWith("\r")) return n - 1;
  return n;
}

/** Character style-run spans. */
export function _charRunSpans(doc: TextDocument): [number, number, CosDict][] {
  return runSpans(doc._doc, "6", "6");
}

/** Paragraph style-run spans (one run per paragraph). */
export function _paraRunSpans(doc: TextDocument): [number, number, CosDict][] {
  return runSpans(doc._doc, "5", "5");
}

/** Manual-kerning run spans; payload key `"0"` holds the value. */
export function _kernRunSpans(doc: TextDocument): [number, number, CosDict][] {
  return runSpans(doc._doc, "8", null);
}

/**
 * The persisted `/L` line records of the layout cache, in order.
 *
 * The cache lives at `doc["1"]["2"]` as a `/PC` node; `/L` records are
 * collected depth-first through the nested `"6"` arrays. Empty when the
 * document has no cache.
 */
export function _cachedLineNodes(doc: TextDocument): CosDict[] {
  const entries = cosGet(doc._doc, "1", "2");
  if (!Array.isArray(entries)) return [];
  const lines: CosDict[] = [];

  const collect = (node: CosNode): void => {
    if (!(node instanceof Map)) return;
    if (str(node.get("99") ?? null) === "L") {
      lines.push(node);
      return;
    }
    const children = node.get("6") ?? null;
    if (Array.isArray(children)) {
      for (const child of children) collect(child);
    }
  };

  for (const entry of entries) collect(entry);
  return lines;
}

/**
 * Line `(start, end)` spans + baselines from the persisted cache.
 *
 * Returns `null` when the document has no cache. Callers that also need
 * the `/L` nodes should fetch them once with `_cachedLineNodes` and
 * use `_lineDataFromNodes` to avoid a second cache walk.
 */
export function _cachedLineData(doc: TextDocument): [[number, number][], (number | null)[]] | null {
  return _lineDataFromNodes(_cachedLineNodes(doc));
}

/**
 * Line `(start, end)` spans + baselines from `/L` cache nodes.
 *
 * Each line's length is the sum of its `/S` segment counts
 * (`seg["15"]["0"]`) and its baseline is the `/L` `"10"` value. Returns
 * `null` for an empty node list (no cache).
 */
export function _lineDataFromNodes(nodes: CosDict[]): [[number, number][], (number | null)[]] | null {
  const lengths: number[] = [];
  const baselines: (number | null)[] = [];
  for (const node of nodes) {
    let total = 0;
    const children = node.get("6") ?? null;
    if (Array.isArray(children)) {
      for (const seg of children) {
        const count = cosGet(seg, "15", "0");
        if (is(pyInt, count)) total += Number(count);
      }
    }
    lengths.push(total);
    const baseline = read(cacheLine, node, "10");
    baselines.push(baseline != null ? float(baseline) : null);
  }
  if (!lengths.length) return null;
  const spans: [number, number][] = [];
  let pos = 0;
  for (const length of lengths) {
    spans.push([pos, pos + length]);
    pos += length;
  }
  return [spans, baselines];
}

/**
 * A `/L` record's pen origin `(x, y)` in composition-cache space.
 *
 * Stored at `/L "0" "0"`; AE omits it on the first line (origin `(0, 0)`),
 * where the baseline key `"10"` is absent too.
 */
export function _lineOrigin(node: CosDict): [number, number] {
  const origin = cosGet(node, "0", "0");
  if (Array.isArray(origin) && origin.length >= 2) return [cosFloat(origin[0]), cosFloat(origin[1])];
  const baseline = read(cacheLine, node, "10");
  const y = baseline != null ? float(baseline) : 0.0;
  return [0.0, y];
}

/**
 * Per-code-unit cumulative pen advances across a `/L` record's
 * `/S` segments (`seg["15"]["7"]["7"]`).
 *
 * AE does not split segments on style or font changes - every observed
 * line (including mixed-font ones) carries a single segment whose
 * advances are cumulative from the line start. Multiple segments are
 * chained by carrying the running total forward.
 */
export function _lineAdvances(node: CosDict): number[] {
  const out: number[] = [];
  let base = 0.0;
  const children = node.get("6") ?? null;
  if (!Array.isArray(children)) return out;
  for (const seg of children) {
    const advances = cosGet(seg, "15", "7", "7");
    if (!Array.isArray(advances)) continue;
    for (const advance of advances) {
      if (is(pyNumber, advance)) out.push(base + float(advance));
    }
    if (out.length) base = out[out.length - 1];
  }
  return out;
}

const isSpans = (v: InstanceValue): v is [number, number][] =>
  Array.isArray(v) && v.every((span) => Array.isArray(span) && span.length === 2);

/**
 * Recompose the document when its calibration proved the composer.
 *
 * Returns `null` when the composer never calibrated against this
 * document's own AE cache or now refuses it (envelope change) - the
 * caller falls back to the stale-clamp semantics. The result (spans
 * or the refusal) is cached on the document; every layout-affecting
 * write invalidates it via `TextDocument._mark_layout_dirty`.
 */
export function _freshComposedSpans(doc: TextDocument): [number, number][] | null {
  if (doc._compositionCalibrated !== true) return null;
  if (doc._overrides.has("_composed_cache")) {
    const memo = doc._overrides.get("_composed_cache") ?? null;
    return memo != null && isSpans(memo) ? memo : null;
  }
  let spans: [number, number][] | null;
  try {
    spans = composeLines(doc).spans;
  } catch (e) {
    if (!(e instanceof CompositionUnsupported)) throw e;
    spans = null;
  }
  doc._overrides.set("_composed_cache", spans);
  return spans;
}

/**
 * Composed-line `(start, end)` spans for the document's CURRENT state.
 *
 * Point text never wraps, so its composed lines ARE the paragraphs
 * (fixture-proven) - always fresh, no cache involved. Box text reads
 * the persisted AE cache while the document is untouched; after a
 * layout-affecting py-side write it recomposes via
 * `resolvers.text_composition` when the per-document calibration
 * succeeded, otherwise the stale cache (with
 * the AE-parity clamp semantics) remains.
 */
export function _composedLineSpans(doc: TextDocument): [number, number][] | null {
  if (!doc.boxText) {
    const para = _paraRunSpans(doc);
    if (!para.length) return null;
    return para.map(([start, end]): [number, number] => [start, end]);
  }
  if (doc._layoutDirty) {
    const fresh = _freshComposedSpans(doc);
    if (fresh != null) return fresh;
  }
  const cached = _cachedLineData(doc);
  return cached != null ? cached[0] : null;
}

/** Extract `[R, G, B]` from a COS SimplePaint structure. */
export function _parseColor(paint: CosNode): number[] | null {
  const argb = cosGet(paint, "0", "1");
  if (Array.isArray(argb) && argb.length >= 4) {
    return [cosFloat(argb[1]), cosFloat(argb[2]), cosFloat(argb[3])];
  }
  return null;
}

/**
 * Build a COS SimplePaint dict from `[R, G, B]`.
 *
 * The 4-float array is `[alpha, R, G, B]`; AE stores a fully opaque
 * alpha of `1.0`.
 */
export function _buildColorPaint(rgb: number[]): CosDict {
  return new Map<string, CosNode>([
    ["99", new CosName("SimplePaint")],
    [
      "0",
      new Map<string, CosNode>([
        ["0", 1],
        ["1", [pyfloat(1.0), pyfloat(rgb[0]), pyfloat(rgb[1]), pyfloat(rgb[2])]],
      ]),
    ],
  ]);
}

/** Build a COS CoolTypeFont entry for a font PostScript name. */
export function _buildFontEntry(postScriptName: string): CosDict {
  return new Map<string, CosNode>([
    [
      "0",
      new Map<string, CosNode>([
        ["99", new CosName("CoolTypeFont")],
        ["0", new Map<string, CosNode>([["0", postScriptName], ["2", 1]])],
      ]),
    ],
  ]);
}

/**
 * Insert a font entry at `index` and reindex the existing references.
 *
 * Every reference at or after `index` is bumped by one. Font indices live
 * in the char-run styles of every keyframe document sharing this
 * `_cosData`, the document-default character style at `cos["1"]["2"]`,
 * the typography settings at `cos["1"]["0"]`, the used-font records at
 * `cos["1"]["5"][*]["4"]` (which also gain a record for the new font) and
 * the header style presets at `cos["0"]["5"]["0"]`; the layout cache holds
 * none. The host font's version string (name ID 5) is stamped on the entry
 * and the used-font record like AE does, when the font is installed.
 *
 * `index` 0 is AE's insertion point for a new font on a style write
 * (probed: `W_FONT`, `W_PASTE_XDOC`); `Project.replaceFont` inserts
 * directly after the font being replaced instead, and passes
 * `used_record=False` because a replacement repoints the used-font
 * record of the font it replaces rather than adding one. Returns `index`.
 */
export function _registerFontAt(
  doc: TextDocument,
  postScriptName: string,
  index = 0,
  kw: { usedRecord?: boolean } = {},
): number {
  const { usedRecord = true } = kw;
  const cos = doc._cosData;
  const fontArray = cosSetdefault(cosSetdefault(cosSetdefault(cos, "0", new Map()), "1", new Map()), "0", []);
  const entry = _buildFontEntry(postScriptName);
  const fontEntry = entry.get("0");
  const fontData = fontEntry instanceof Map ? fontEntry.get("0") : null;
  pyAssert(fontEntry instanceof Map && fontData instanceof Map);
  const version = fontVersionString(postScriptName);
  if (version != null) fontData.set("5", version);
  cosInsert(fontArray, index, entry);

  const bump = (holder: CosDict): void => {
    const current = read(fontRef, holder, "0");
    if (current != null && Number(current) >= index) {
      holder.set("0", Number(current) + 1);
    }
  };

  const state = cosGetOr(cos, "1", new Map());
  const entryDocs = cosGetOr(state, "1", []);
  for (const entryDoc of cosIter(pyBool(entryDocs) ? entryDocs : [])) {
    const runs = cosGet(entryDoc, "0", "6", "0");
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      const style = cosGet(run, "0", "0", "6");
      if (style instanceof Map) bump(style);
    }
  }
  const defaultChar = cosGet(cos, "1", "2");
  if (defaultChar instanceof Map) bump(defaultChar);
  const typography = cosGet(cos, "1", "0", "0");
  if (typography instanceof Map) bump(typography);
  const presets = cosGet(cos, "0", "5", "0");
  if (Array.isArray(presets)) {
    for (const preset of presets) {
      const style = cosGet(preset, "0", "6");
      if (style instanceof Map) bump(style);
    }
  }
  const sessions = cosGet(cos, "1", "5");
  const newRecord: CosDict = new Map([["0", index]]);
  if (version != null) newRecord.set("1", version);
  if (Array.isArray(sessions)) {
    let appended = false;
    for (const session of sessions) {
      const records = session instanceof Map ? session.get("4") ?? null : null;
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (record instanceof Map) bump(record);
      }
      if (usedRecord && !appended) {
        records.push(newRecord);
        appended = true;
      }
    }
  }
  doc._fonts.splice(index, 0, new FontObject({ _fontData: fontData, _fontEntry: fontEntry }));
  return index;
}

/**
 * Repoint one text layer's `fromName` character runs at `toName`.
 *
 * All of a layer's keyframe documents share one font table and one COS
 * tree, so the font is registered once per layer. After Effects inserts
 * the replacement directly AFTER the font it replaces and leaves the old
 * entry in place (probed AE 2026: `Verdana`\@0 -\> `Georgia`\@1), which is
 * what `_registerFontAt` reproduces.
 *
 * A font table can hold SEVERAL entries with one PostScript name (AE
 * writes a second `MyriadPro-Regular` when a style reset re-applies the
 * panel font), and the runs may reference any of them, so every entry
 * carrying `fromName` is matched - taking only the first would silently
 * skip layers whose runs point at a later duplicate.
 */
export function _replaceLayerFont(docs: TextDocument[], fromName: string, toName: string): boolean {
  const first = docs[0];
  const fromIndices = new Set<number>();
  for (const [i, font] of first._fonts.entries()) {
    if (font.postScriptName === fromName) fromIndices.add(i);
  }
  if (!fromIndices.size) return false;
  const referenced = docs.some((doc) =>
    _charRunSpans(doc).some(([, , style]) => cosIn(style.get("0"), fromIndices)),
  );
  if (!referenced) return false;

  let toIndex: number | null = null;
  for (const [i, font] of first._fonts.entries()) {
    if (font.postScriptName === toName) {
      toIndex = i;
      break;
    }
  }
  if (toIndex == null) {
    // Inserting past the LAST matching entry leaves every from-index
    // unshifted (`_registerFontAt` only bumps references at or after
    // the insertion point).
    toIndex = _registerFontAt(first, toName, max(fromIndices) + 1, { usedRecord: false });
  }

  for (const doc of docs) {
    for (const [, , style] of _charRunSpans(doc)) {
      if (cosIn(style.get("0"), fromIndices)) style.set("0", toIndex);
    }
  }
  _repointUsedFontRecord(first, fromIndices, toIndex, toName);
  first._propagateCos();
  return true;
}

/**
 * Point the replaced font's used-font records at its replacement.
 *
 * After Effects rewrites the existing record in place - index and name-ID-5
 * version - rather than appending one and leaving the now-unused font
 * behind (probed AE 2026: Verdana's record becomes Georgia's).
 */
export function _repointUsedFontRecord(
  doc: TextDocument,
  fromIndices: Set<number>,
  toIndex: number,
  toName: string,
): void {
  const version = fontVersionString(toName);
  const sessions = cosGet(doc._cosData, "1", "5");
  if (!Array.isArray(sessions)) return;
  for (const session of sessions) {
    const records = session instanceof Map ? session.get("4") ?? null : null;
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!(record instanceof Map) || !cosIn(record.get("0"), fromIndices)) continue;
      record.set("0", toIndex);
      if (version == null) record.delete("1");
      else record.set("1", version);
    }
  }
}

// ---------------------------------------------------------------------------
// Write engine (run splitting / merging)
//
// All rules below are AE-probed via samples/models/text/text_writes.aep;
// see .claude/plans/text-range-writes.md for the fixture-to-rule mapping.
// ---------------------------------------------------------------------------

/**
 * Char-style keys that cannot change line composition (paints, their
 * gates, stroke geometry); every other style write marks the layout
 * dirty so the composed-line APIs know the cache no longer applies.
 */
export const _NON_LAYOUT_CHAR_KEYS: ReadonlySet<string> = new Set(["53", "54", "56", "57", "58", "62", "63"]);

/**
 * Flag a layout-affecting write on documents that track it.
 *
 * Must run BEFORE the mutation lands: the first call calibrates the
 * composer against the still-clean cache (see
 * `TextDocument._mark_layout_dirty`). Duck-typed test documents
 * without the hook are skipped.
 */
export function _markLayoutDirty(doc: TextDocument): void {
  // Python `getattr(doc, "_markLayoutDirty", None)`: duck-typed test
  // documents may lack the hook.
  if (typeof doc._markLayoutDirty === "function") doc._markLayoutDirty();
}

/**
 * Re-point `_charStyle` / `_paraStyle` at the current first runs.
 *
 * TextDocument's document-level accessors alias the first run's style
 * dict by object identity; merges can replace that object, so every
 * structural op must end here.
 */
export function _refreshStyleAliases(doc: TextDocument): void {
  const char = cosGet(doc._doc, "0", "6", "0", 0, "0", "0", "6");
  if (char instanceof Map) doc._charStyle = char;
  const para = cosGet(doc._doc, "0", "5", "0", 0, "0", "0", "5");
  if (para instanceof Map) doc._paraStyle = para;
}

/**
 * Expand u16 boundaries outward so they never split a surrogate pair.
 *
 * AE expands a mid-pair style write to cover the whole pair
 * (`W_SURROGATE_STYLE`). A zero-span caret cannot expand - it moves
 * past the pair instead, so caret writes stay zero-span no-ops
 * (`W_ZERO_STYLE`) rather than covering (or deleting) the glyph.
 */
export function _snapToPairs(raw: string, start: number, end: number): [number, number] {
  // No surrogate code units -> no pairs to split, so snapping is a no-op.
  // Skips the repeated scans below on the common (BMP) path.
  if (!/[\uD800-\uDFFF]/.test(raw)) return [start, end];

  const midPair = (index: number): boolean => {
    if (index <= 0 || index >= u16Len(raw)) return false;
    const before = u16Slice(raw, index - 1, index).charCodeAt(0);
    const after = u16Slice(raw, index, index + 1).charCodeAt(0);
    return 0xd800 <= before && before <= 0xdbff && 0xdc00 <= after && after <= 0xdfff;
  };

  if (start === end) {
    if (midPair(start)) return [start + 1, end + 1];
    return [start, end];
  }
  if (midPair(start)) start -= 1;
  if (midPair(end)) end += 1;
  return [start, end];
}

/** A run entry's count, `run.get("1", 0)`, as a Python number (`TypeError` for other kinds). */
function _runCount(run: CosNode): PyNum {
  return pyNum(cosGetOr(run, "1", 0));
}

/**
 * Split `{"0": payload, "1": count}` entries in place at u16 offsets.
 *
 * The original entry keeps its identity as the LEFT fragment, so run
 * 0's payload object only ever narrows (never detaches) and the
 * `_charStyle` alias stays inside the serialized tree.
 */
export function _splitRunArray(runs: CosNode[], offsets: Set<number>): void {
  const cuts = sorted(offsets);
  let pos: PyNum = 0;
  let i = 0;
  while (i < runs.length) {
    const runEnd = pyAdd(pos, _runCount(runs[i]));
    let cut: number | null = null;
    for (const offset of cuts) {
      if (float(pos) < offset && offset < float(runEnd)) {
        cut = offset;
        break;
      }
    }
    if (cut == null) {
      pos = runEnd;
      i += 1;
      continue;
    }
    const clone = deepcopy(runs[i]);
    cosSetitem(runs[i], "1", pySub(cut, pos));
    cosSetitem(clone, "1", pySub(runEnd, cut));
    runs.splice(i + 1, 0, clone);
    pos = cut;
    i += 1;
  }
}

/**
 * Coalesce adjacent runs whose full payloads compare equal.
 *
 * AE merges after every write (`W_MERGE_SAME`, `W_PARTIAL_EQ`) and a
 * no-op set leaves a uniform document at one run (`W_NOOP`). The first
 * run of each merged group keeps its object (aliasing, key order).
 */
export function _mergeAdjacentRuns(runs: CosNode[]): void {
  let i = 0;
  while (i + 1 < runs.length) {
    const here = cosDict(runs[i], "get").get("0") ?? null;
    if (pyEq(here, cosDict(runs[i + 1], "get").get("0") ?? null)) {
      cosSetitem(runs[i], "1", pyAdd(_runCount(runs[i]), _runCount(runs[i + 1])));
      runs.splice(i + 1, 1);
    } else {
      i += 1;
    }
  }
}

/**
 * Write one char-style key over `[start, end)` with AE's rules.
 *
 * Zero-span writes are silent no-ops (`W_ZERO_STYLE`); a write ending
 * at the visible length extends through the raw terminator
 * (`W_MERGE_SAME`); `value=None` clears the key.
 */
export function _applyCharKey(doc: TextDocument, start: number, end: number, key: string, value: CosNode): void {
  const raw = _rawText(doc);
  [start, end] = _snapToPairs(raw, start, end);
  if (start === end) return;
  if (!_NON_LAYOUT_CHAR_KEYS.has(key)) _markLayoutDirty(doc);
  if (end === _visibleLength(doc)) end = u16Len(raw);
  const runs = cosGet(doc._doc, "0", "6", "0");
  if (!Array.isArray(runs) || !runs.length) return;
  _splitRunArray(runs, new Set([start, end]));
  let pos: PyNum = 0;
  for (const run of runs) {
    const runEnd = pyAdd(pos, _runCount(run));
    if (float(pos) >= start && float(runEnd) <= end) {
      const style = cosGet(run, "0", "0", "6");
      if (style instanceof Map) {
        if (value == null) style.delete(key);
        else style.set(key, value);
      }
    }
    pos = runEnd;
  }
  _mergeAdjacentRuns(runs);
  _refreshStyleAliases(doc);
}

/** Per-character manual-kern values decoded from the kern runs (the stored values; `null` where none). */
export function _kernValues(doc: TextDocument): CosNode[] {
  const total = u16Len(_rawText(doc));
  const values: CosNode[] = new Array<CosNode>(total).fill(null);
  for (const [start, end, payload] of _kernRunSpans(doc)) {
    const value = payload.get("0") ?? null;
    if (value != null) {
      for (let i = start; i < Math.min(end, total); i++) values[i] = value;
    }
  }
  return values;
}

/**
 * Re-emit the kern-run array from a per-character value map.
 *
 * AE stores kerned characters as individual length-1 runs and merges
 * only the empty gaps (probed `W_KERN_MID` / `W_KERN_START`); the
 * array covers the raw text contiguously. The `doc["0"]["8"]` holder
 * dict is kept in place when it exists so `doc["0"]`'s key order is
 * preserved; a fresh key is appended, like AE's creation order.
 */
export function _rebuildKernRuns(doc: TextDocument, values: CosNode[]): void {
  const inner = cosSetdefault(doc._doc, "0", new Map());
  const hasValue = values.some((v) => v != null);
  if (!hasValue) {
    // AE drops the array entirely once no manual values remain
    // (probed `X_AKT_SET`); the leading-edge value at "7" only
    // exists alongside the array, so it goes too.
    cosPop(inner, "8");
    cosPop(inner, "7");
    return;
  }
  const runs: CosNode[] = [];
  let i = 0;
  const total = values.length;
  while (i < total) {
    if (values[i] == null) {
      let j = i;
      while (j < total && values[j] == null) j += 1;
      runs.push(new Map<string, CosNode>([["0", new Map()], ["1", j - i]]));
      i = j;
    } else {
      runs.push(new Map<string, CosNode>([["0", new Map([["0", values[i]]])], ["1", 1]]));
      i += 1;
    }
  }
  const holder = cosDict(inner, "get").get("8");
  if (holder instanceof Map) {
    holder.set("0", runs);
  } else {
    cosSetitem(inner, "8", new Map([["0", runs]]));
  }
}

/**
 * Replace `[start, end)` of the raw text, splicing every run array.
 *
 * AE's probed rules: the replacement takes the style of the first
 * replaced character (the caret's containing run for zero-span
 * inserts), a `\r` in the replacement splits paragraphs (the donor
 * paragraph's run is cloned), kern values survive for untouched
 * characters only, and the trailing terminator is preserved
 * (`W_TEXT_*`, `X_TEXT_KERN`, `X_TEXT_END`). `insertRuns` /
 * `insertKern` override the donor styling for paste transplants.
 */
export function _spliceText(
  doc: TextDocument,
  start: number,
  end: number,
  newText: string,
  insertRuns: CosNode[] | null = null,
  insertKern: CosNode[] | null = null,
): void {
  const raw = _rawText(doc);
  const total = u16Len(raw);
  const insertLen = u16Len(newText);
  if (start === end && insertLen === 0 && insertRuns == null) return;
  _markLayoutDirty(doc);
  const kernValues = _kernValues(doc);
  const newRaw = u16Slice(raw, 0, start) + newText + u16Slice(raw, end, total);
  let parts = split(newRaw, "\r");
  if (parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  const inner = cosSetdefault(doc._doc, "0", new Map());

  const runs = cosGet(inner, "6", "0");
  if (Array.isArray(runs) && runs.length) {
    let insertEntries: CosNode[];
    if (insertRuns == null) {
      let donor: CosNode | undefined;
      let pos: PyNum = 0;
      for (const run of runs) {
        const runEnd = pyAdd(pos, _runCount(run));
        if (float(pos) <= start && start < float(runEnd)) {
          donor = deepcopy(run);
          break;
        }
        pos = runEnd;
      }
      if (donor === undefined) donor = deepcopy(runs[runs.length - 1]);
      cosSetitem(donor, "1", insertLen);
      insertEntries = insertLen ? [donor] : [];
    } else {
      insertEntries = insertRuns;
    }
    _splitRunArray(runs, new Set([start, end]));
    const rebuilt: CosNode[] = [];
    let pos: PyNum = 0;
    let inserted = false;
    for (const run of runs) {
      const runEnd = pyAdd(pos, _runCount(run));
      if (float(runEnd) <= start) {
        rebuilt.push(run);
      } else if (float(pos) >= end) {
        if (!inserted) {
          rebuilt.push(...insertEntries);
          inserted = true;
        }
        rebuilt.push(run);
      }
      pos = runEnd;
    }
    if (!inserted) rebuilt.push(...insertEntries);
    runs.splice(0, runs.length, ...rebuilt);
    _mergeAdjacentRuns(runs);
  }

  const paraRuns = cosGet(inner, "5", "0");
  if (Array.isArray(paraRuns) && paraRuns.length) {
    const oldSpans: [number, number, CosNode][] = [];
    let pos: PyNum = 0;
    for (const entry of paraRuns) {
      const length = _runCount(entry);
      oldSpans.push([float(pos), float(pyAdd(pos, length)), entry]);
      pos = pyAdd(pos, length);
    }

    const donorEntry = (newPos: number): CosNode => {
      let oldPos: number;
      if (newPos < start) oldPos = newPos;
      else if (newPos >= start + insertLen) oldPos = newPos - insertLen + (end - start);
      else oldPos = start;
      oldPos = total ? Math.min(oldPos, total - 1) : 0;
      for (const [spanStart, spanEnd, entry] of oldSpans) {
        if (spanStart <= oldPos && oldPos < spanEnd) return entry;
      }
      return oldSpans[oldSpans.length - 1][2];
    };

    const newParaRuns: CosNode[] = [];
    let pos2 = 0;
    for (const [i, part] of parts.entries()) {
      const entry = donorEntry(pos2);
      // Keep the first run's object identity when it stays first
      // (aliased by `_paraStyle`); clone everything else.
      const clone = i === 0 && entry === paraRuns[0] ? entry : deepcopy(entry);
      const partLen = u16Len(part) + 1;
      cosSetitem(clone, "1", partLen);
      newParaRuns.push(clone);
      pos2 += partLen;
    }
    paraRuns.splice(0, paraRuns.length, ...newParaRuns);
  }

  if (insertKern == null) insertKern = new Array<CosNode>(insertLen).fill(null);
  _rebuildKernRuns(doc, [...kernValues.slice(0, start), ...insertKern, ...kernValues.slice(end)]);
  if (start === 0) {
    // Replacing the leading edge invalidates the pair-0 kern value
    // (AE-unprobed; dropping it mirrors the auto_kern_type setter).
    cosPop(inner, "7");
  }

  cosSetitem(inner, "0", newRaw);
  // Python `getattr(doc, "_rebuildLineCountRuns", None)`: duck-typed test documents may lack it.
  if (typeof doc._rebuildLineCountRuns === "function") doc._rebuildLineCountRuns(parts);
  _refreshStyleAliases(doc);
}

/**
 * Write one paragraph-style key to every paragraph overlapping the
 * range (paragraph runs are structural: never split, never merged -
 * `W_PARA_PARTIAL` styles the whole containing paragraph).
 */
export function _applyParaKey(doc: TextDocument, start: number, end: number, key: string, value: CosNode): void {
  if (start === end) return;
  _markLayoutDirty(doc);
  const runs = cosGet(doc._doc, "0", "5", "0");
  if (!Array.isArray(runs)) return;
  let pos: PyNum = 0;
  for (const run of runs) {
    const runEnd = pyAdd(pos, _runCount(run));
    if (float(pos) < end && float(runEnd) > start) {
      const style = cosGet(run, "0", "0", "5");
      if (style instanceof Map) {
        if (value == null) style.delete(key);
        else style.set(key, value);
      }
    }
    pos = runEnd;
  }
}

// ---------------------------------------------------------------------------
// RangeField descriptor
// ---------------------------------------------------------------------------

/** Which run array a {@link RangeField} resolves over. */
export type RangeKind = "char" | "para" | "kern";

/** Constructor options of {@link RangeField | RangeField}. */
export interface RangeFieldOptions<T extends InstanceValue> {
  transform: (raw: CosNode) => T;
  default?: T | null;
  gate?: string | null;
  reverse?: ((value: NonNullable<T>) => CosNode) | null;
  validate?: InstanceValidator<TextDocument> | null;
  readOnly?: boolean;
}

/** The options a `RangeField` factory leaves to its caller. */
type RangeFieldExtras<T extends InstanceValue> = Partial<Omit<RangeFieldOptions<T>, "transform">>;

/**
 * Read-only descriptor resolving one COS style key over a range.
 *
 * Evaluates the key across every style run overlapping the owning
 * {@link CharacterRange} with AE's mixed-value semantics: a uniform value
 * is returned, disagreement reads as `null` (ExtendScript
 * `undefined`). `gate` names a boolean style key that must be truthy
 * for a run to participate at all (AE gates `strokeColor` on
 * `applyStroke` and `fillColor` on `applyFill`); when no overlapping
 * run passes the gate the field reads `null`.
 *
 * Writable fields split the style runs at the range boundaries, write
 * the key into the covered runs and re-merge adjacent identical runs,
 * mirroring AE's probed behavior.
 * Fields whose writes need coupled side effects (kerning runs,
 * leading/auto-leading) stay `readOnly` until their phase lands.
 *
 * @param kind - `"char"` or `"para"` - which run array to resolve over.
 * @param key - String key into each run's style dict.
 * @param transform - Callable applied to each stored value.
 * @param default - Per-run value when the key is absent from the run.
 * @param gate - Optional boolean style key gating run participation.
 * @param reverse - 1-arg callable applied when setting (user-facing -\> COS value), mirroring
 *   `CosField.reverse`.
 * @param validate - Optional callable `(value, instance)` run before any `reverse`, mirroring the
 *   TextDocument CosField validators.
 * @param read_only - When `true`, the field cannot be set.
 */
export class RangeField<T extends InstanceValue> {
  declare kind: RangeKind;
  declare key: string;
  declare transform: (raw: CosNode) => T;
  declare default_: T | null;
  declare gate: string | null;
  declare reverse: ((value: NonNullable<T>) => CosNode) | null;
  declare validate: InstanceValidator<TextDocument> | null;
  declare readOnly: boolean;
  declare publicName: string;

  constructor(kind: RangeKind, key: string, kw: RangeFieldOptions<T>) {
    const { transform, default: default_ = null, gate = null, reverse = null, validate = null, readOnly = false } = kw;
    this.kind = kind;
    this.key = key;
    this.transform = transform;
    this.default_ = default_;
    this.gate = gate;
    this.reverse = reverse;
    this.validate = validate;
    this.readOnly = readOnly;
  }

  __set_name__(owner: Function, name: string): void {
    this.publicName = name;
  }

  __get__(obj: CharacterRange | null, objtype?: Function | null): T | null | this {
    if (obj == null) return this;
    return obj._resolveMixed(this.kind, this.key, this.transform, this.default_, this.gate);
  }

  __set__(obj: CharacterRange, value: T | null): void {
    if (this.readOnly) throw new AttributeError(`${repr(this.publicName)} is read-only.`);
    let raw: CosNode = null;
    if (value != null) {
      if (this.validate != null) this.validate(value, obj._docRef);
      // Every writable field declares its reverse; only read-only ones omit it.
      if (this.reverse == null) throw new AttributeError(`${repr(this.publicName)} is read-only.`);
      raw = this.reverse(value);
    }
    const [start, end] = obj._bounds();
    if (this.kind === "char") _applyCharKey(obj._docRef, start, end, this.key, raw);
    else _applyParaKey(obj._docRef, start, end, this.key, raw);
    obj._propagate();
  }

  /** Create a RangeField for boolean style flags. */
  static bool(kind: RangeKind, key: string, kwargs: RangeFieldExtras<boolean> = {}): RangeField<boolean> {
    return new RangeField<boolean>(kind, key, { transform: bool, reverse: bool, ...kwargs });
  }

  /** Create a RangeField that coerces to float. */
  static float(kind: RangeKind, key: string, kwargs: RangeFieldExtras<number> = {}): RangeField<number> {
    // The stored value is a Python float, so box it to keep `1.0` from serializing as `1`.
    return new RangeField<number>(kind, key, { transform: cosFloat, reverse: (x: number) => pyfloat(x), ...kwargs });
  }

  /**
   * Create a RangeField for integer-stored style keys.
   *
   * Coerces to `int` on read and rounds to the nearest integer on
   * write. AE stores these keys as integers; a real-typed value is
   * misread at 16.16 scale (stored `50.0` read back as `3276800`,
   * probed AE 2026).
   */
  static int(kind: RangeKind, key: string, kwargs: RangeFieldExtras<number> = {}): RangeField<number> {
    return new RangeField<number>(kind, key, { transform: cosInt, reverse: (x: number) => round(x), ...kwargs });
  }

  /**
   * Create a RangeField for IntEnum-backed style keys. Writes reject
   * out-of-enum ints (ExtendScript parity); reads stay tolerant via
   * `fromBinary`. Without the check a stray int serializes a value
   * that reads back as `None`/undefined.
   */
  static enum<V extends number>(enumCls: CosEnum<V>, kind: RangeKind, key: string, kwargs: RangeFieldExtras<V> = {}): RangeField<V> {
    return new RangeField<V>(kind, key, {
      transform: (raw: CosNode) => enumFromCos(enumCls, raw),
      reverse: (value: V) => enumCls.toBinary(value),
      validate: validateEnum(enumCls),
      ...kwargs,
    });
  }
}

/** A `TextDocument` style dict attribute. */
type StyleAttr = "_charStyle" | "_paraStyle";

/**
 * A {@link CosField | CosField} whose writes style the whole
 * document.
 *
 * AE document-level setters apply to every character or paragraph and
 * re-merge the style runs (probed `W_DOCLEVEL`, `X_DOC_FILL`,
 * `X_DOC_JUST`); a plain CosField write only touches the first run's
 * style dict, which is correct only for single-run documents. Reads
 * keep the first-run semantics of the base descriptor. Documents
 * without run backing (parser fallbacks) fall back to the base
 * override behavior.
 */
export class DocumentWideCosField<T extends InstanceValue> extends CosField<T, StyleAttr, TextDocument> {
  __set__(obj: TextDocument, value: T | null): void {
    const isChar = this.dictAttr === "_charStyle";
    const backing = obj[this.dictAttr];
    let runs: CosNode = null;
    if (backing != null) {
      runs = cosGet(obj._doc, "0", isChar ? "6" : "5", "0");
    }
    if (!Array.isArray(runs) || !runs.length) {
      // Single style dict (or a parser fallback with no runs): the
      // base descriptor's first-run write is already document-wide.
      super.__set__(obj, value);
      return;
    }
    this._checkWritable(obj);
    obj._overrides.delete(this.publicName);
    const rawValue = value == null ? null : this._coerce(obj, value);
    const total = u16Len(_rawText(obj));
    if (isChar) _applyCharKey(obj, 0, total, this.key, rawValue);
    else _applyParaKey(obj, 0, total, this.key, rawValue);
    if (typeof obj._propagateCos === "function") obj._propagateCos();
  }

  /** `CosField.bool`: a boolean flag on the document's first char / para style. */
  static bool<D extends boolean | null>(dictAttr: StyleAttr, key: string, kw: CosFieldExtras<D, TextDocument>): DocumentWideCosField<boolean | D> {
    return new DocumentWideCosField(dictAttr, key, boolField(kw));
  }

  /** `CosField.float`: a float style key, coerced to float in both directions. */
  static float<D extends number | null>(dictAttr: StyleAttr, key: string, kw: CosFieldExtras<D, TextDocument>): DocumentWideCosField<number | D> {
    return new DocumentWideCosField(dictAttr, key, floatField(kw));
  }

  /** `CosField.int`: an integer-stored style key. */
  static int<D extends number | null>(dictAttr: StyleAttr, key: string, kw: CosFieldExtras<D, TextDocument>): DocumentWideCosField<number | D> {
    return new DocumentWideCosField(dictAttr, key, intField(kw));
  }

  /**
   * `CosField.enum`, rejecting out-of-enum ints on write (ExtendScript
   * parity). Mirrors `RangeField.enum`; the base `CosField.enum` does
   * not validate, so a stray int would serialize a value that reads back
   * as `null`/undefined. Reads stay tolerant via `fromBinary`.
   */
  static enum<V extends number, D extends V | null>(enumCls: CosEnum<V>, dictAttr: StyleAttr, key: string, kw: CosFieldExtras<D, TextDocument>): DocumentWideCosField<V | D> {
    return new DocumentWideCosField(dictAttr, key, enumField(enumCls, { validate: validateEnum(enumCls), ...kw }));
  }
}

// ---------------------------------------------------------------------------
// Range base classes
// ---------------------------------------------------------------------------

/**
 * Shared boundary/validity/repr behavior for the text range views.
 *
 * Subclasses store `_docRef`, `_start` and `_signedEnd`, and
 * implement `_bounds()` (returning the current
 * `(character_start, character_end)` and raising `ValueError` when the
 * range is out of bounds). The public accessors and string forms below
 * are shared across all three range types.
 */
export class _TextRange {
  declare _docRef: TextDocument;
  declare _start: number;
  declare _signedEnd: number;

  constructor(doc: TextDocument, start: number, signedEnd: number) {
    this._docRef = doc;
    this._start = start;
    this._signedEnd = signedEnd;
    // AE validates at creation time and raises immediately.
    this._bounds();
  }

  _bounds(): [number, number] {
    throw new NotImplementedError();
  }

  /** The range's first character index. Read-only. */
  get characterStart(): number {
    return this._bounds()[0];
  }

  /** The range's last character index + 1. Read-only. */
  get characterEnd(): number {
    return this._bounds()[1];
  }

  /** `true` while the range lies within the document bounds. Read-only. */
  get isRangeValid(): boolean {
    try {
      this._bounds();
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return false;
    }
    return true;
  }

  toString(): string {
    return `${this.constructor.name}(${this._start},${this._signedEnd})`;
  }

  [INSPECT](): string {
    return `<py_aep.${this.constructor.name}(${this._start},${this._signedEnd})>`;
  }
}

/**
 * A range addressed by an index into a span list (paragraphs or
 * composed lines) and resolved to character bounds.
 *
 * Shares the index storage and the `characterRange()` snapshot; only
 * `_bounds()` (the per-kind span lookup and clamping) differs.
 */
export class _IndexRange extends _TextRange {
  /**
   * A {@link CharacterRange} fixed to the current character bounds.
   *
   * The returned range holds resolved indices and does not follow
   * later changes to this range's paragraphs or lines.
   */
  characterRange(): CharacterRange {
    const [start, end] = this._bounds();
    return new CharacterRange(this._docRef, start, end);
  }
}

// ---------------------------------------------------------------------------
// CharacterRange
// ---------------------------------------------------------------------------

/**
 * A contiguous character span of a {@link TextDocument}.
 *
 * Created via `TextDocument.characterRange(character_start, signed_character_end)`. Most `TextDocument` styling attributes are
 * readable on the range; when the range spans style runs with
 * differing values the attribute reads `null` (ExtendScript
 * `undefined`). Bounds re-resolve on every access, so a range created
 * valid raises `ValueError` once the document shrinks beneath it.
 *
 * Zero-span ranges (`character_start == character_end`) are valid and
 * report the style at that caret position with an empty `text`.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/characterrange/
 */
export class CharacterRange extends _TextRange {
  // Descriptor-backed style fields: installed after the class (see the
  // `descriptor(CharacterRange, ...)` calls at the end of this module).
  /** The range's font size in pixels; `null` when mixed. Read / Write. */
  declare fontSize: number | null;
  /** `true` if faux bold is enabled across the range. Read / Write. */
  declare fauxBold: boolean | null;
  /** `true` if faux italic is enabled across the range. Read / Write. */
  declare fauxItalic: boolean | null;
  /** The range's horizontal scale; `null` when mixed. Read / Write. */
  declare horizontalScale: number | null;
  /** The range's vertical scale; `null` when mixed. Read / Write. */
  declare verticalScale: number | null;
  /** The range's spacing between characters; `null` when mixed. Read / Write. */
  declare tracking: number | null;
  /** The range's baseline shift in pixels; `null` when mixed. Read / Write. */
  declare baselineShift: number | null;
  /** The range's font caps option; `null` when mixed. Read / Write. */
  declare fontCapsOption: FontCapsOption | null;
  /** The range's font baseline option; `null` when mixed. Read / Write. */
  declare fontBaselineOption: FontBaselineOption | null;
  /** `true` when ligature is used across the range. Read / Write. */
  declare ligature: boolean | null;
  /** The range's baseline direction; `null` when mixed. Read / Write. */
  declare baselineDirection: BaselineDirection | null;
  /** The range's tsume value (0.0 to 1.0); `null` when mixed. Read / Write. */
  declare tsume: number | null;
  /** `true` when no-break is applied across the range. Read / Write. */
  declare noBreak: boolean | null;
  /** When `true`, the range shows a fill; `null` when mixed. Read / Write. */
  declare applyFill: boolean | null;
  /** When `true`, the range shows a stroke; `null` when mixed. Read / Write. */
  declare applyStroke: boolean | null;
  /** When `true`, the stroke appears over the fill; `null` when mixed. Read / Write. */
  declare strokeOverFill: boolean | null;
  /** The range's line join type for strokes; `null` when mixed. Read / Write. */
  declare lineJoinType: LineJoinType | null;
  /** The range's stroke thickness; `null` when mixed. Read / Write. */
  declare strokeWidth: number | null;
  /** The range's digit set option; `null` when mixed. Read / Write. */
  declare digitSet: DigitSet | null;
  /** The justification of paragraphs in the range; `null` when mixed. Read / Write. */
  declare justification: ParagraphJustification | null;
  /** The paragraphs' first line indent; `null` when mixed. Read / Write. */
  declare firstLineIndent: number | null;
  /** The paragraphs' start indent; `null` when mixed. Read / Write. */
  declare startIndent: number | null;
  /** The paragraphs' end indent; `null` when mixed. Read / Write. */
  declare endIndent: number | null;
  /** The paragraphs' space before; `null` when mixed. Read / Write. */
  declare spaceBefore: number | null;
  /** The paragraphs' space after; `null` when mixed. Read / Write. */
  declare spaceAfter: number | null;
  /** The paragraphs' leading type; `null` when mixed. Read / Write. */
  declare leadingType: LeadingType | null;
  /** The paragraphs' auto-hyphenate option; `null` when mixed. Read / Write. */
  declare autoHyphenate: boolean | null;
  /** The paragraphs' Roman Hanging Punctuation; `null` when mixed. Read / Write. */
  declare hangingRoman: boolean | null;
  /** The paragraphs' Every-Line Composer option; `null` when mixed. Read / Write. */
  declare everyLineComposer: boolean | null;
  /** The paragraphs' direction; `null` when mixed. Read / Write. */
  declare direction: ParagraphDirection | null;
  /**
   * `fillColor`: the range's fill color as `[r, g, b]`. Read / Write.
   *
   * Only characters with `applyFill` participate in the read; `null`
   * when no character in the range has a fill or the colors are mixed.
   * Setting writes the paint only - like the stroke, it does not enable
   * `applyFill`.
   */
  declare fillColor: number[] | null;
  /**
   * `strokeColor`: the range's stroke color as `[r, g, b]`. Read / Write.
   *
   * Only characters with `applyStroke` participate in the read; `null`
   * when no character in the range has a stroke or the colors are
   * mixed. Setting writes the paint only - AE does NOT enable
   * `applyStroke` (probed `W_STROKE_GATE`; the Scripting Guide claims
   * otherwise).
   */
  declare strokeColor: number[] | null;

  // -- Bounds --------------------------------------------------------------

  /**
   * Resolve `(start, end)` against the current document.
   *
   * @throws {@link ValueError} When the range is outside the document bounds.
   */
  _bounds(): [number, number] {
    const visible = _visibleLength(this._docRef);
    const end = this._signedEnd === -1 ? visible : this._signedEnd;
    if (this._start < 0 || this._start > visible || end < this._start || end > visible) {
      throw new ValueError(CHARACTER_RANGE_OOB);
    }
    return [this._start, end];
  }

  // -- Mixed-value resolution ----------------------------------------------

  /**
   * Run payloads overlapping the half-open range.
   *
   * A zero-span range resolves to the single run containing its
   * caret index (the raw runs cover the terminator, so an EOF caret
   * still lands inside the final run).
   */
  _overlapping(spans: [number, number, CosDict][]): CosDict[] {
    const [start, end] = this._bounds();
    if (start === end) {
      for (const [runStart, runEnd, payload] of spans) {
        if (runStart <= start && start < runEnd) return [payload];
      }
      return spans.length ? [spans[spans.length - 1][2]] : [];
    }
    const out: CosDict[] = [];
    for (const [runStart, runEnd, payload] of spans) {
      if (runStart < end && runEnd > start) out.push(payload);
    }
    return out;
  }

  _spansFor(kind: RangeKind): [number, number, CosDict][] {
    if (kind === "char") return _charRunSpans(this._docRef);
    if (kind === "para") return _paraRunSpans(this._docRef);
    return _kernRunSpans(this._docRef);
  }

  /**
   * Resolve one style key over the overlapping runs.
   *
   * Uniform value -\> that value; disagreement -\> `null`; every run
   * gated out -\> `null`.
   */
  _resolveMixed<T>(kind: RangeKind, key: string, transform: (raw: CosNode) => T, default_: T | null, gate: string | null): T | null {
    let payloads = this._overlapping(this._spansFor(kind));
    if (gate != null) {
      payloads = payloads.filter((p) => pyBool(p.get(gate) ?? null));
      if (!payloads.length) return null;
    }
    if (!payloads.length) return default_;
    const values = payloads.map((payload) => _extract(payload, key, transform, default_));
    const first = values[0];
    return values.slice(1).every((value) => pyEq(value, first)) ? first : null;
  }

  _propagate(): void {
    // Python `getattr(self._doc_ref, "_propagateCos", None)`: duck-typed test documents may lack it.
    if (typeof this._docRef._propagateCos === "function") this._docRef._propagateCos();
  }

  // -- Content ---------------------------------------------------------------

  /**
   * The text within the range. Read / Write.
   *
   * Line breaks are normalized to `\n` like `TextDocument.text`
   * (ExtendScript returns raw `\r`). A range splitting a surrogate
   * pair yields a lone surrogate, as in AE. Writing replaces the
   * ranged characters: the replacement takes the first replaced
   * character's style, and this range keeps its creation indices
   * (re-resolving against the new text, exactly like AE).
   */
  get text(): string {
    const [start, end] = this._bounds();
    return u16Slice(_rawText(this._docRef), start, end).replaceAll("\r", "\n");
  }

  set text(value: string) {
    validateText(value);
    const doc = this._docRef;
    const raw = _rawText(doc);
    let [start, end] = this._bounds();
    [start, end] = _snapToPairs(raw, start, end);
    const normalized = value.replaceAll("\r\n", "\r").replaceAll("\n", "\r");
    _spliceText(doc, start, end, normalized);
    this._propagate();
  }

  /**
   * Paste the source range's text and character styling here.
   *
   * Mirrors ExtendScript's `pasteFrom()` (AE 25.1+, probed via the
   * `W_PASTE_*` / `X_PASTE_KERN` fixtures): the ranged characters
   * are replaced by the source span's text with its character style
   * runs and manual-kern values transplanted. Cross-document pastes
   * remap font references into this document's font array,
   * prepending missing fonts like AE. This range keeps its creation
   * indices and may become invalid when the pasted text is shorter.
   *
   * @param sourceRange - The {@link CharacterRange} to copy from (may belong to another document
   *   or project).
   */
  pasteFrom(sourceRange: CharacterRange): void {
    if (!(sourceRange instanceof CharacterRange)) {
      throw new TypeError("pasteFrom expects a CharacterRange");
    }
    const doc = this._docRef;
    const srcDoc = sourceRange._docRef;
    const srcRaw = _rawText(srcDoc);
    let [srcStart, srcEnd] = sourceRange._bounds();
    [srcStart, srcEnd] = _snapToPairs(srcRaw, srcStart, srcEnd);
    const textSlice = u16Slice(srcRaw, srcStart, srcEnd);

    const entries: CosNode[] = [];
    let pos: PyNum = 0;
    const srcRuns = cosGet(srcDoc._doc, "0", "6", "0");
    for (const run of cosIter(pyBool(srcRuns) ? srcRuns : [])) {
      const runEnd = pyAdd(pos, _runCount(run));
      // `max(pos, src_start)` / `min(run_end, src_end)` keep the winning
      // operand itself, so a float position stays a float.
      const overlapStart: PyNum = srcStart > float(pos) ? srcStart : pos;
      const overlapEnd: PyNum = srcEnd < float(runEnd) ? srcEnd : runEnd;
      if (float(overlapEnd) > float(overlapStart)) {
        const clone = deepcopy(run);
        cosSetitem(clone, "1", pySub(overlapEnd, overlapStart));
        entries.push(clone);
      }
      pos = runEnd;
    }

    if (srcDoc !== doc) {
      const needed = new Map<number, string>();
      for (const clone of entries) {
        const style = cosGet(clone, "0", "0", "6");
        if (style instanceof Map) {
          const index = read(charStyle, style, "0");
          if (index != null && 0 <= Number(index) && Number(index) < srcDoc._fonts.length) {
            needed.set(Number(index), srcDoc._fonts[Number(index)].postScriptName);
          }
        }
      }
      const existing = new Set<string>(doc._fonts.map((f) => f.postScriptName));
      for (const name of needed.values()) {
        if (!existing.has(name)) {
          _registerFontAt(doc, name);
          existing.add(name);
        }
      }
      const targetIndex = new Map<string, number>();
      for (const [i, f] of doc._fonts.entries()) targetIndex.set(f.postScriptName, i);
      for (const clone of entries) {
        const style = cosGet(clone, "0", "0", "6");
        if (style instanceof Map) {
          const index = read(charStyle, style, "0");
          const name = index != null ? needed.get(Number(index)) : undefined;
          if (name !== undefined) style.set("0", getitem(targetIndex, name));
        }
      }
    }

    const kernSlice = _kernValues(srcDoc).slice(srcStart, srcEnd);
    let srcEdge: number | boolean | null = null;
    if (srcStart === 0) {
      const edge = cosGet(srcDoc._doc, "0", "7");
      if (is(pyInt, edge)) srcEdge = edge;
    }
    const raw = _rawText(doc);
    let [start, end] = this._bounds();
    [start, end] = _snapToPairs(raw, start, end);
    _spliceText(doc, start, end, textSlice, entries, kernSlice);
    if (srcEdge != null) {
      // The source's leading-edge kern value (pair before char 0)
      // follows the paste: it stays the leading edge when pasting at
      // 0, otherwise it becomes the pair value between the preceding
      // character and the pasted text (probed Y_PASTE_EDGE0/_MID).
      if (start === 0) {
        cosSetitem(cosSetdefault(doc._doc, "0", new Map()), "7", srcEdge);
      } else {
        const values = _kernValues(doc);
        if (start - 1 < values.length) {
          values[start - 1] = srcEdge;
          _rebuildKernRuns(doc, values);
        }
      }
    }
    this._propagate();
  }

  // -- Paragraph / leading style accessors ---------------------------------

  /**
   * The range's auto-leading option; `null` when mixed. Read / Write.
   *
   * Enabling auto-leading also resets the explicit leading key to
   * AE's sentinel (probed `X_AL_SET`).
   */
  get autoLeading(): boolean | null {
    return this._resolveMixed("char", "4", bool, true, null);
  }

  set autoLeading(value: boolean) {
    validateBool(value);
    const [start, end] = this._bounds();
    _applyCharKey(this._docRef, start, end, "4", value);
    if (value) {
      _applyCharKey(this._docRef, start, end, "5", pyfloat(0.01));
    }
    this._propagate();
  }

  /**
   * The range's auto kern type option; `null` when mixed. Read / Write.
   *
   * Setting a non-manual kern type clears the manual kerning values
   * over the range; AE drops the kern-run array entirely when no
   * values remain (probed `X_AKT_SET`).
   */
  get autoKernType(): AutoKernType | null {
    return this._resolveMixed("char", "11", (raw) => enumFromCos(AutoKernType, raw), AutoKernType.NO_AUTO_KERN, null);
  }

  set autoKernType(value: AutoKernType) {
    validateEnum(AutoKernType)(value);
    const doc = this._docRef;
    const [start, end] = _snapToPairs(_rawText(doc), ...this._bounds());
    if (start === end) {
      // Zero-span writes are no-ops (W_ZERO_STYLE); guard before
      // the kern-clearing side effects below.
      return;
    }
    _applyCharKey(doc, start, end, "11", AutoKernType.toBinary(AutoKernType.of(value)));
    if (value !== AutoKernType.NO_AUTO_KERN) {
      const values = _kernValues(doc);
      for (let i = start; i < Math.min(end, values.length); i++) values[i] = null;
      _rebuildKernRuns(doc, values);
      if (start === 0) {
        cosPop(cosGetOr(doc._doc, "0", new Map()), "7");
      }
    }
    this._propagate();
  }

  // -- Font ------------------------------------------------------------------

  /**
   * The range's font PostScript name; `null` when mixed. Read / Write.
   *
   * Setting a font absent from the document's font array prepends
   * it and reindexes existing references, matching AE.
   */
  get font(): string | null {
    const fontObj = this.fontObject;
    return fontObj != null ? fontObj.postScriptName : null;
  }

  set font(value: string) {
    validateFontName(value);
    const doc = this._docRef;
    const [start, end] = _snapToPairs(_rawText(doc), ...this._bounds());
    if (start === end) {
      // Zero-span writes are no-ops (W_ZERO_STYLE); guard before
      // registering the font, which mutates the whole document.
      return;
    }
    let index: number | null = null;
    for (const [i, fontObj] of doc._fonts.entries()) {
      if (fontObj.postScriptName === value) {
        index = i;
        break;
      }
    }
    if (index == null) index = _registerFontAt(doc, value);
    _applyCharKey(doc, start, end, "0", index);
    this._propagate();
  }

  /** The range's {@link FontObject}; `null` when mixed. Read-only. */
  get fontObject(): FontObject | null {
    const idx = this._resolveMixed("char", "0", (raw) => raw, null, null);
    const fonts = this._docRef._fonts;
    if (is(pyInt, idx) && 0 <= Number(idx) && Number(idx) < fonts.length) {
      return fonts[Number(idx)];
    }
    return null;
  }

  /**
   * The range's spacing between lines. Read / Write.
   *
   * AE reads `undefined` while auto-leading is active (or mixed)
   * anywhere in the range; the explicit value only surfaces when
   * auto-leading is uniformly disabled. Setting an explicit value
   * also disables auto-leading over the range (probed `W_LEAD`);
   * setting `null` clears the explicit value without touching
   * auto-leading.
   */
  get leading(): number | null {
    const auto = this.autoLeading;
    if (auto == null || auto) return null;
    return this._resolveMixed("char", "5", cosFloat, null, null);
  }

  set leading(value: number | null) {
    if (value != null) validatePositiveNumber(value);
    const [start, end] = this._bounds();
    if (value == null) {
      _applyCharKey(this._docRef, start, end, "5", null);
    } else {
      _applyCharKey(this._docRef, start, end, "5", pyfloat(value));
      _applyCharKey(this._docRef, start, end, "4", false);
    }
    this._propagate();
  }

  /**
   * The range's manual kerning value. Read / Write.
   *
   * AE reads `undefined` unless auto-kerning is uniformly disabled
   * AND a manual value is stored for every character in the range
   * (probed `X_TEXT_KERN`: spliced-in characters under NO_AUTO_KERN
   * without values read undefined). Values live in dedicated kerning
   * runs (`doc["0"]["8"]`) and read `null` when mixed. Setting a
   * value affects characters `[max(0, start - 1), end)` - AE's pair
   * shift - disables auto-kerning for them, and stores the
   * leading-edge value at `doc["0"]["7"]` when the range starts at 0.
   * A boolean stored where AE writes an int reads back as itself.
   */
  get kerning(): number | boolean | null {
    if (this.autoKernType !== AutoKernType.NO_AUTO_KERN) return null;
    const value = this._resolveMixed("kern", "0", (raw) => raw, null, null);
    return is(pyInt, value) ? value : null;
  }

  set kerning(value: number | boolean | null) {
    validateS4(value, this._docRef);
    // `validateS4` accepts a float (see its definition): round it on
    // write, matching the sibling `tracking` field, whose `RangeField.int`
    // sets `reverse=round`. `round` also normalizes bools (a subclass of
    // int) so the serializer emits an integer, not a `true`/`false` token.
    const rounded = round(cosNum(value));
    const doc = this._docRef;
    const raw = _rawText(doc);
    let [start, end] = this._bounds();
    [start, end] = _snapToPairs(raw, start, end);
    if (start === end) return;
    // Kern runs mutate before the auto-kern flag write reaches
    // _apply_char_key, so mark (and calibrate) here first.
    _markLayoutDirty(doc);
    // No visible-end extension here: AE never kerns the raw `\r`
    // terminator (every probed kern fixture leaves it in an empty
    // run); `_applyCharKey` below re-extends the style write.
    const kernStart = Math.max(0, start - 1);
    const values = _kernValues(doc);
    for (let i = kernStart; i < Math.min(end, values.length); i++) values[i] = rounded;
    _rebuildKernRuns(doc, values);
    if (start === 0) {
      // Pair position 0 (before the first character): AE stores the
      // leading-edge value at doc["0"]["7"], created after key "8".
      cosSetitem(cosSetdefault(doc._doc, "0", new Map()), "7", rounded);
    }
    _applyCharKey(doc, kernStart, end, "11", AutoKernType.toBinary(AutoKernType.NO_AUTO_KERN));
    this._propagate();
  }

  /** `true` if the range has All Caps enabled; `null` when mixed. Read-only. */
  get allCaps(): boolean | null {
    const caps = this.fontCapsOption;
    if (caps == null) return null;
    return caps === FontCapsOption.FONT_ALL_CAPS;
  }

  /** `true` if the range has Small Caps enabled; `null` when mixed. Read-only. */
  get smallCaps(): boolean | null {
    const caps = this.fontCapsOption;
    if (caps == null) return null;
    return caps === FontCapsOption.FONT_SMALL_CAPS;
  }

  /** `true` if the range is superscript; `null` when mixed. Read-only. */
  get superscript(): boolean | null {
    const baseline = this.fontBaselineOption;
    if (baseline == null) return null;
    return baseline === FontBaselineOption.FONT_FAUXED_SUPERSCRIPT;
  }

  /** `true` if the range is subscript; `null` when mixed. Read-only. */
  get subscript(): boolean | null {
    const baseline = this.fontBaselineOption;
    if (baseline == null) return null;
    return baseline === FontBaselineOption.FONT_FAUXED_SUBSCRIPT;
  }

  /** The document's composer engine (document-wide). Read-only. */
  get composerEngine(): ComposerEngine | null {
    return this._docRef.composerEngine;
  }
}

// ---------------------------------------------------------------------------
// ParagraphRange / ComposedLineRange
// ---------------------------------------------------------------------------

/**
 * A paragraph span of a {@link TextDocument}.
 *
 * Created via `TextDocument.paragraphRange(paragraph_index_start, signed_paragraph_index_end)`. Paragraph character boundaries include
 * each paragraph's trailing `\r`; the final boundary is clamped to
 * the visible text length, so a trailing empty paragraph reports a
 * zero-span range.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/paragraphrange/
 */
export class ParagraphRange extends _IndexRange {
  /**
   * Resolve the paragraph indices to character bounds.
   *
   * @throws {@link ValueError} When the paragraph indices are out of bounds.
   */
  _bounds(): [number, number] {
    const spans = _paraRunSpans(this._docRef);
    const count = spans.length;
    const end = this._signedEnd === -1 ? count : this._signedEnd;
    if (this._start < 0 || this._start >= count || end <= this._start || end > count) {
      throw new ValueError(PARAGRAPH_RANGE_OOB);
    }
    const visible = _visibleLength(this._docRef);
    return [Math.min(spans[this._start][0], visible), Math.min(spans[end - 1][1], visible)];
  }
}

/**
 * A composed-line span of a {@link TextDocument}.
 *
 * Created via `TextDocument.composedLineRange( composed_line_index_start, signed_composed_line_index_end)`.
 * Point text derives its lines from the paragraphs (always fresh).
 * Box text reads the layout cache AE persisted at save time; after a
 * layout-affecting py-side write the calibrated composed-line
 * resolver recomposes it (see `TextDocument.compositionStale`).
 * When no calibrated composer is available the stale cache behaves
 * like AE's own un-reapplied TextDocument values: line boundaries
 * clamp to the current text and lines falling wholly outside it
 * raise `ValueError`.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/composedlinerange/
 */
export class ComposedLineRange extends _IndexRange {
  /**
   * Resolve the line indices to character bounds.
   *
   * @throws {@link ValueError} When the line indices are out of bounds, or the cached line lies
   *   wholly outside the current text.
   */
  _bounds(): [number, number] {
    const spans = _composedLineSpans(this._docRef);
    if (spans == null) throw new ValueError(COMPOSED_LINE_OOB);
    const count = spans.length;
    const end = this._signedEnd === -1 ? count : this._signedEnd;
    if (this._start < 0 || this._start >= count || end <= this._start || end > count) {
      throw new ValueError(COMPOSED_LINE_OOB);
    }
    const visible = _visibleLength(this._docRef);
    const startChar = spans[this._start][0];
    // A stale cached line lying wholly beyond the current text raises;
    // a line starting exactly at the end is a valid zero-span (e.g. the
    // trailing empty paragraph's line).
    if (startChar > visible) throw new ValueError(COMPOSED_LINE_OOB);
    return [startChar, Math.min(spans[end - 1][1], visible)];
  }
}

// ---------------------------------------------------------------------------
// Descriptor-backed CharacterRange fields (class-body RangeField assignments)
// ---------------------------------------------------------------------------

descriptor(CharacterRange, "fontSize", RangeField.float("char", "1", { validate: validatePositiveNonzeroNumber }));

descriptor(CharacterRange, "fauxBold", RangeField.bool("char", "2"));

descriptor(CharacterRange, "fauxItalic", RangeField.bool("char", "3"));

descriptor(CharacterRange, "horizontalScale", RangeField.float("char", "6", { validate: validateNumber }));

descriptor(CharacterRange, "verticalScale", RangeField.float("char", "7", { validate: validateNumber }));

descriptor(CharacterRange, "tracking", RangeField.int("char", "8", { validate: validateS4 }));

descriptor(CharacterRange, "baselineShift", RangeField.float("char", "9", { validate: validateNumber }));

descriptor(CharacterRange, "fontCapsOption", RangeField.enum(FontCapsOption, "char", "12"));

descriptor(CharacterRange, "fontBaselineOption", RangeField.enum(FontBaselineOption, "char", "13"));

descriptor(CharacterRange, "ligature", RangeField.bool("char", "18", { default: false }));

descriptor(
  CharacterRange,
  "baselineDirection",
  RangeField.enum(BaselineDirection, "char", "35", { default: BaselineDirection.BASELINE_WITH_STREAM }),
);

descriptor(
  CharacterRange,
  "tsume",
  RangeField.float("char", "36", { default: 0.0, validate: validateNormalizedFloat }),
);

descriptor(CharacterRange, "noBreak", RangeField.bool("char", "52", { default: false }));

descriptor(CharacterRange, "applyFill", RangeField.bool("char", "56"));

descriptor(CharacterRange, "applyStroke", RangeField.bool("char", "57", { default: false }));

descriptor(CharacterRange, "strokeOverFill", RangeField.bool("char", "58", { default: true }));

descriptor(
  CharacterRange,
  "lineJoinType",
  RangeField.enum(LineJoinType, "char", "62", { default: LineJoinType.LINE_JOIN_MITER }),
);

descriptor(
  CharacterRange,
  "strokeWidth",
  RangeField.float("char", "63", { default: 1.0, validate: validatePositiveNonzeroNumber }),
);

descriptor(CharacterRange, "digitSet", RangeField.enum(DigitSet, "char", "70", { default: DigitSet.DEFAULT_DIGITS }));

descriptor(CharacterRange, "justification", RangeField.enum(ParagraphJustification, "para", "0"));

descriptor(CharacterRange, "firstLineIndent", RangeField.float("para", "1", { default: 0.0, validate: validateNumber }));

descriptor(CharacterRange, "startIndent", RangeField.float("para", "2", { default: 0.0, validate: validateNumber }));

descriptor(CharacterRange, "endIndent", RangeField.float("para", "3", { default: 0.0, validate: validateNumber }));

descriptor(CharacterRange, "spaceBefore", RangeField.float("para", "4", { default: 0.0, validate: validateNumber }));

descriptor(CharacterRange, "spaceAfter", RangeField.float("para", "5", { default: 0.0, validate: validateNumber }));

descriptor(CharacterRange, "leadingType", RangeField.enum(LeadingType, "para", "8", { default: LeadingType.ROMAN_LEADING_TYPE }));

descriptor(CharacterRange, "autoHyphenate", RangeField.bool("para", "9"));

descriptor(CharacterRange, "hangingRoman", RangeField.bool("para", "21", { default: false }));

descriptor(CharacterRange, "everyLineComposer", RangeField.bool("para", "29", { default: false }));

descriptor(
  CharacterRange,
  "direction",
  RangeField.enum(ParagraphDirection, "para", "33", { default: ParagraphDirection.DIRECTION_LEFT_TO_RIGHT }),
);

descriptor(
  CharacterRange,
  "fillColor",
  new RangeField("char", "53", {
    transform: _parseColor,
    gate: "56",
    reverse: _buildColorPaint,
    validate: validateRgbColor,
  }),
);

descriptor(
  CharacterRange,
  "strokeColor",
  new RangeField("char", "54", {
    transform: _parseColor,
    gate: "57",
    reverse: _buildColorPaint,
    validate: validateRgbColor,
  }),
);
