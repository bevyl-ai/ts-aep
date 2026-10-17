/**
 * Text range models mirroring the AE 24.3+ ExtendScript range API.
 *
 * `CharacterRange`, `ParagraphRange` and `ComposedLineRange` are computed,
 * read-only views over a {@link TextDocument | TextDocument}'s
 * parsed COS data. They are created via the `TextDocument` factory methods
 * (`character_range`, `paragraph_range`, `composed_line_range`), never
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

import {
  AttributeError,
  NotImplementedError,
  TypeError_,
  ValueError,
  deepcopy,
  float,
  getitem,
  max,
  py_assert,
  py_bool,
  py_eq,
  repr,
  round,
  sorted,
  split,
  str,
  descriptor,
  pyfloat,
} from "../../../pyrt/index.ts";
import { CosField, CosName, cos_get, run_spans } from "../../cos/index.ts";
import type { CosDict, CosNode } from "../../cos/cos.ts";
import { _extract, bool_field, enum_field, float_field, int_field, enum_from_cos, type CosEnum, type CosFieldExtras, type InstanceValue } from "../../cos/descriptors.ts";
import { cos_dict, cos_float, cos_get_or, cos_in, cos_insert, cos_int, cos_iter, cos_num, cos_pop, cos_setdefault, cos_setitem, is, py_add, py_int, py_num, py_number, py_sub, type PyNum } from "../../cos/kinds.ts";
import { cache_line, char_style, font_ref, read } from "../../cos/schema.ts";
import { AutoKernType, BaselineDirection, DigitSet, FontBaselineOption, FontCapsOption, LeadingType, LineJoinType, ParagraphDirection, ParagraphJustification } from "../../enums/index.ts";
import type { ComposerEngine } from "../../enums/index.ts";
import { CompositionUnsupported, compose_lines } from "../../resolvers/text_composition.ts";
import { font_version_string } from "../../svg/fonts.ts";
import { validate_bool, validate_enum, validate_font_name, validate_normalized_float, validate_number, validate_positive_nonzero_number, validate_positive_number, validate_rgb_color, validate_s4, validate_text, type InstanceValidator } from "../validators.ts";
import { FontObject } from "./font_object.ts";
import type { TextDocument } from "./text_document.ts";

export const bool = (x: CosNode): boolean => py_bool(x);

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
export function u16_len(s: string): number {
  return s.length;
}

/**
 * Slice `s` by UTF-16 code-unit offsets.
 *
 * A slice that splits a surrogate pair yields a lone surrogate, exactly
 * as AE does (JS keeps lone surrogates in a string, as `surrogatepass` does).
 */
export function u16_slice(s: string, start: number, end: number): string {
  return s.slice(start, end);
}

// ---------------------------------------------------------------------------
// COS accessors shared with TextDocument
// ---------------------------------------------------------------------------

/** The stored text, including the terminator `\r`. */
export function _raw_text(doc: TextDocument): string {
  const val = cos_get(doc._doc, "0", "0");
  return val != null ? str(val) : "";
}

/**
 * Length in UTF-16 units of the user-visible text.
 *
 * The stored run counts cover one trailing terminator `\r` that
 * ExtendScript's indices never expose; everything user-facing is
 * clamped to this length.
 */
export function _visible_length(doc: TextDocument): number {
  const raw = _raw_text(doc);
  const n = u16_len(raw);
  if (raw.endsWith("\r")) return n - 1;
  return n;
}

/** Character style-run spans. */
export function _char_run_spans(doc: TextDocument): [number, number, CosDict][] {
  return run_spans(doc._doc, "6", "6");
}

/** Paragraph style-run spans (one run per paragraph). */
export function _para_run_spans(doc: TextDocument): [number, number, CosDict][] {
  return run_spans(doc._doc, "5", "5");
}

/** Manual-kerning run spans; payload key `"0"` holds the value. */
export function _kern_run_spans(doc: TextDocument): [number, number, CosDict][] {
  return run_spans(doc._doc, "8", null);
}

/**
 * The persisted `/L` line records of the layout cache, in order.
 *
 * The cache lives at `doc["1"]["2"]` as a `/PC` node; `/L` records are
 * collected depth-first through the nested `"6"` arrays. Empty when the
 * document has no cache.
 */
export function _cached_line_nodes(doc: TextDocument): CosDict[] {
  const entries = cos_get(doc._doc, "1", "2");
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
 * the `/L` nodes should fetch them once with `_cached_line_nodes` and
 * use `_line_data_from_nodes` to avoid a second cache walk.
 */
export function _cached_line_data(doc: TextDocument): [[number, number][], (number | null)[]] | null {
  return _line_data_from_nodes(_cached_line_nodes(doc));
}

/**
 * Line `(start, end)` spans + baselines from `/L` cache nodes.
 *
 * Each line's length is the sum of its `/S` segment counts
 * (`seg["15"]["0"]`) and its baseline is the `/L` `"10"` value. Returns
 * `null` for an empty node list (no cache).
 */
export function _line_data_from_nodes(nodes: CosDict[]): [[number, number][], (number | null)[]] | null {
  const lengths: number[] = [];
  const baselines: (number | null)[] = [];
  for (const node of nodes) {
    let total = 0;
    const children = node.get("6") ?? null;
    if (Array.isArray(children)) {
      for (const seg of children) {
        const count = cos_get(seg, "15", "0");
        if (is(py_int, count)) total += Number(count);
      }
    }
    lengths.push(total);
    const baseline = read(cache_line, node, "10");
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
export function _line_origin(node: CosDict): [number, number] {
  const origin = cos_get(node, "0", "0");
  if (Array.isArray(origin) && origin.length >= 2) return [cos_float(origin[0]), cos_float(origin[1])];
  const baseline = read(cache_line, node, "10");
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
export function _line_advances(node: CosDict): number[] {
  const out: number[] = [];
  let base = 0.0;
  const children = node.get("6") ?? null;
  if (!Array.isArray(children)) return out;
  for (const seg of children) {
    const advances = cos_get(seg, "15", "7", "7");
    if (!Array.isArray(advances)) continue;
    for (const advance of advances) {
      if (is(py_number, advance)) out.push(base + float(advance));
    }
    if (out.length) base = out[out.length - 1];
  }
  return out;
}

const is_spans = (v: InstanceValue): v is [number, number][] =>
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
export function _fresh_composed_spans(doc: TextDocument): [number, number][] | null {
  if (doc._composition_calibrated !== true) return null;
  if (doc.__dict__.has("_composed_cache")) {
    const memo = doc.__dict__.get("_composed_cache") ?? null;
    return memo != null && is_spans(memo) ? memo : null;
  }
  let spans: [number, number][] | null;
  try {
    spans = compose_lines(doc).spans;
  } catch (e) {
    if (!(e instanceof CompositionUnsupported)) throw e;
    spans = null;
  }
  doc.__dict__.set("_composed_cache", spans);
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
export function _composed_line_spans(doc: TextDocument): [number, number][] | null {
  if (!doc.box_text) {
    const para = _para_run_spans(doc);
    if (!para.length) return null;
    return para.map(([start, end]): [number, number] => [start, end]);
  }
  if (doc._layout_dirty) {
    const fresh = _fresh_composed_spans(doc);
    if (fresh != null) return fresh;
  }
  const cached = _cached_line_data(doc);
  return cached != null ? cached[0] : null;
}

/** Extract `[R, G, B]` from a COS SimplePaint structure. */
export function _parse_color(paint: CosNode): number[] | null {
  const argb = cos_get(paint, "0", "1");
  if (Array.isArray(argb) && argb.length >= 4) {
    return [cos_float(argb[1]), cos_float(argb[2]), cos_float(argb[3])];
  }
  return null;
}

/**
 * Build a COS SimplePaint dict from `[R, G, B]`.
 *
 * The 4-float array is `[alpha, R, G, B]`; AE stores a fully opaque
 * alpha of `1.0`.
 */
export function _build_color_paint(rgb: number[]): CosDict {
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
export function _build_font_entry(post_script_name: string): CosDict {
  return new Map<string, CosNode>([
    [
      "0",
      new Map<string, CosNode>([
        ["99", new CosName("CoolTypeFont")],
        ["0", new Map<string, CosNode>([["0", post_script_name], ["2", 1]])],
      ]),
    ],
  ]);
}

/**
 * Insert a font entry at `index` and reindex the existing references.
 *
 * Every reference at or after `index` is bumped by one. Font indices live
 * in the char-run styles of every keyframe document sharing this
 * `_cos_data`, the document-default character style at `cos["1"]["2"]`,
 * the typography settings at `cos["1"]["0"]`, the used-font records at
 * `cos["1"]["5"][*]["4"]` (which also gain a record for the new font) and
 * the header style presets at `cos["0"]["5"]["0"]`; the layout cache holds
 * none. The host font's version string (name ID 5) is stamped on the entry
 * and the used-font record like AE does, when the font is installed.
 *
 * `index` 0 is AE's insertion point for a new font on a style write
 * (probed: `W_FONT`, `W_PASTE_XDOC`); `Project.replace_font` inserts
 * directly after the font being replaced instead, and passes
 * `used_record=False` because a replacement repoints the used-font
 * record of the font it replaces rather than adding one. Returns `index`.
 */
export function _register_font_at(
  doc: TextDocument,
  post_script_name: string,
  index = 0,
  kw: { used_record?: boolean } = {},
): number {
  const { used_record = true } = kw;
  const cos = doc._cos_data;
  const font_array = cos_setdefault(cos_setdefault(cos_setdefault(cos, "0", new Map()), "1", new Map()), "0", []);
  const entry = _build_font_entry(post_script_name);
  const font_entry = entry.get("0");
  const font_data = font_entry instanceof Map ? font_entry.get("0") : null;
  py_assert(font_entry instanceof Map && font_data instanceof Map);
  const version = font_version_string(post_script_name);
  if (version != null) font_data.set("5", version);
  cos_insert(font_array, index, entry);

  const bump = (holder: CosDict): void => {
    const current = read(font_ref, holder, "0");
    if (current != null && Number(current) >= index) {
      holder.set("0", Number(current) + 1);
    }
  };

  const state = cos_get_or(cos, "1", new Map());
  const entry_docs = cos_get_or(state, "1", []);
  for (const entry_doc of cos_iter(py_bool(entry_docs) ? entry_docs : [])) {
    const runs = cos_get(entry_doc, "0", "6", "0");
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      const style = cos_get(run, "0", "0", "6");
      if (style instanceof Map) bump(style);
    }
  }
  const default_char = cos_get(cos, "1", "2");
  if (default_char instanceof Map) bump(default_char);
  const typography = cos_get(cos, "1", "0", "0");
  if (typography instanceof Map) bump(typography);
  const presets = cos_get(cos, "0", "5", "0");
  if (Array.isArray(presets)) {
    for (const preset of presets) {
      const style = cos_get(preset, "0", "6");
      if (style instanceof Map) bump(style);
    }
  }
  const sessions = cos_get(cos, "1", "5");
  const new_record: CosDict = new Map([["0", index]]);
  if (version != null) new_record.set("1", version);
  if (Array.isArray(sessions)) {
    let appended = false;
    for (const session of sessions) {
      const records = session instanceof Map ? session.get("4") ?? null : null;
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (record instanceof Map) bump(record);
      }
      if (used_record && !appended) {
        records.push(new_record);
        appended = true;
      }
    }
  }
  doc._fonts.splice(index, 0, new FontObject({ _font_data: font_data, _font_entry: font_entry }));
  return index;
}

/**
 * Repoint one text layer's `from_name` character runs at `to_name`.
 *
 * All of a layer's keyframe documents share one font table and one COS
 * tree, so the font is registered once per layer. After Effects inserts
 * the replacement directly AFTER the font it replaces and leaves the old
 * entry in place (probed AE 2026: `Verdana`\@0 -\> `Georgia`\@1), which is
 * what `_register_font_at` reproduces.
 *
 * A font table can hold SEVERAL entries with one PostScript name (AE
 * writes a second `MyriadPro-Regular` when a style reset re-applies the
 * panel font), and the runs may reference any of them, so every entry
 * carrying `from_name` is matched - taking only the first would silently
 * skip layers whose runs point at a later duplicate.
 */
export function _replace_layer_font(docs: TextDocument[], from_name: string, to_name: string): boolean {
  const first = docs[0];
  const from_indices = new Set<number>();
  for (const [i, font] of first._fonts.entries()) {
    if (font.post_script_name === from_name) from_indices.add(i);
  }
  if (!from_indices.size) return false;
  const referenced = docs.some((doc) =>
    _char_run_spans(doc).some(([, , style]) => cos_in(style.get("0"), from_indices)),
  );
  if (!referenced) return false;

  let to_index: number | null = null;
  for (const [i, font] of first._fonts.entries()) {
    if (font.post_script_name === to_name) {
      to_index = i;
      break;
    }
  }
  if (to_index == null) {
    // Inserting past the LAST matching entry leaves every from-index
    // unshifted (`_register_font_at` only bumps references at or after
    // the insertion point).
    to_index = _register_font_at(first, to_name, max(from_indices) + 1, { used_record: false });
  }

  for (const doc of docs) {
    for (const [, , style] of _char_run_spans(doc)) {
      if (cos_in(style.get("0"), from_indices)) style.set("0", to_index);
    }
  }
  _repoint_used_font_record(first, from_indices, to_index, to_name);
  first._propagate_cos();
  return true;
}

/**
 * Point the replaced font's used-font records at its replacement.
 *
 * After Effects rewrites the existing record in place - index and name-ID-5
 * version - rather than appending one and leaving the now-unused font
 * behind (probed AE 2026: Verdana's record becomes Georgia's).
 */
export function _repoint_used_font_record(
  doc: TextDocument,
  from_indices: Set<number>,
  to_index: number,
  to_name: string,
): void {
  const version = font_version_string(to_name);
  const sessions = cos_get(doc._cos_data, "1", "5");
  if (!Array.isArray(sessions)) return;
  for (const session of sessions) {
    const records = session instanceof Map ? session.get("4") ?? null : null;
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!(record instanceof Map) || !cos_in(record.get("0"), from_indices)) continue;
      record.set("0", to_index);
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
export function _mark_layout_dirty(doc: TextDocument): void {
  // Python `getattr(doc, "_mark_layout_dirty", None)`: duck-typed test
  // documents may lack the hook.
  if (typeof doc._mark_layout_dirty === "function") doc._mark_layout_dirty();
}

/**
 * Re-point `_char_style` / `_para_style` at the current first runs.
 *
 * TextDocument's document-level accessors alias the first run's style
 * dict by object identity; merges can replace that object, so every
 * structural op must end here.
 */
export function _refresh_style_aliases(doc: TextDocument): void {
  const char = cos_get(doc._doc, "0", "6", "0", 0, "0", "0", "6");
  if (char instanceof Map) doc._char_style = char;
  const para = cos_get(doc._doc, "0", "5", "0", 0, "0", "0", "5");
  if (para instanceof Map) doc._para_style = para;
}

/**
 * Expand u16 boundaries outward so they never split a surrogate pair.
 *
 * AE expands a mid-pair style write to cover the whole pair
 * (`W_SURROGATE_STYLE`). A zero-span caret cannot expand - it moves
 * past the pair instead, so caret writes stay zero-span no-ops
 * (`W_ZERO_STYLE`) rather than covering (or deleting) the glyph.
 */
export function _snap_to_pairs(raw: string, start: number, end: number): [number, number] {
  // No surrogate code units -> no pairs to split, so snapping is a no-op.
  // Skips the repeated scans below on the common (BMP) path.
  if (!/[\uD800-\uDFFF]/.test(raw)) return [start, end];

  const mid_pair = (index: number): boolean => {
    if (index <= 0 || index >= u16_len(raw)) return false;
    const before = u16_slice(raw, index - 1, index).charCodeAt(0);
    const after = u16_slice(raw, index, index + 1).charCodeAt(0);
    return 0xd800 <= before && before <= 0xdbff && 0xdc00 <= after && after <= 0xdfff;
  };

  if (start === end) {
    if (mid_pair(start)) return [start + 1, end + 1];
    return [start, end];
  }
  if (mid_pair(start)) start -= 1;
  if (mid_pair(end)) end += 1;
  return [start, end];
}

/** A run entry's count, `run.get("1", 0)`, as a Python number (`TypeError` for other kinds). */
function _run_count(run: CosNode): PyNum {
  return py_num(cos_get_or(run, "1", 0));
}

/**
 * Split `{"0": payload, "1": count}` entries in place at u16 offsets.
 *
 * The original entry keeps its identity as the LEFT fragment, so run
 * 0's payload object only ever narrows (never detaches) and the
 * `_char_style` alias stays inside the serialized tree.
 */
export function _split_run_array(runs: CosNode[], offsets: Set<number>): void {
  const cuts = sorted(offsets);
  let pos: PyNum = 0;
  let i = 0;
  while (i < runs.length) {
    const run_end = py_add(pos, _run_count(runs[i]));
    let cut: number | null = null;
    for (const offset of cuts) {
      if (float(pos) < offset && offset < float(run_end)) {
        cut = offset;
        break;
      }
    }
    if (cut == null) {
      pos = run_end;
      i += 1;
      continue;
    }
    const clone = deepcopy(runs[i]);
    cos_setitem(runs[i], "1", py_sub(cut, pos));
    cos_setitem(clone, "1", py_sub(run_end, cut));
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
export function _merge_adjacent_runs(runs: CosNode[]): void {
  let i = 0;
  while (i + 1 < runs.length) {
    const here = cos_dict(runs[i], "get").get("0") ?? null;
    if (py_eq(here, cos_dict(runs[i + 1], "get").get("0") ?? null)) {
      cos_setitem(runs[i], "1", py_add(_run_count(runs[i]), _run_count(runs[i + 1])));
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
export function _apply_char_key(doc: TextDocument, start: number, end: number, key: string, value: CosNode): void {
  const raw = _raw_text(doc);
  [start, end] = _snap_to_pairs(raw, start, end);
  if (start === end) return;
  if (!_NON_LAYOUT_CHAR_KEYS.has(key)) _mark_layout_dirty(doc);
  if (end === _visible_length(doc)) end = u16_len(raw);
  const runs = cos_get(doc._doc, "0", "6", "0");
  if (!Array.isArray(runs) || !runs.length) return;
  _split_run_array(runs, new Set([start, end]));
  let pos: PyNum = 0;
  for (const run of runs) {
    const run_end = py_add(pos, _run_count(run));
    if (float(pos) >= start && float(run_end) <= end) {
      const style = cos_get(run, "0", "0", "6");
      if (style instanceof Map) {
        if (value == null) style.delete(key);
        else style.set(key, value);
      }
    }
    pos = run_end;
  }
  _merge_adjacent_runs(runs);
  _refresh_style_aliases(doc);
}

/** Per-character manual-kern values decoded from the kern runs (the stored values; `null` where none). */
export function _kern_values(doc: TextDocument): CosNode[] {
  const total = u16_len(_raw_text(doc));
  const values: CosNode[] = new Array<CosNode>(total).fill(null);
  for (const [start, end, payload] of _kern_run_spans(doc)) {
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
export function _rebuild_kern_runs(doc: TextDocument, values: CosNode[]): void {
  const inner = cos_setdefault(doc._doc, "0", new Map());
  const has_value = values.some((v) => v != null);
  if (!has_value) {
    // AE drops the array entirely once no manual values remain
    // (probed `X_AKT_SET`); the leading-edge value at "7" only
    // exists alongside the array, so it goes too.
    cos_pop(inner, "8");
    cos_pop(inner, "7");
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
  const holder = cos_dict(inner, "get").get("8");
  if (holder instanceof Map) {
    holder.set("0", runs);
  } else {
    cos_setitem(inner, "8", new Map([["0", runs]]));
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
 * (`W_TEXT_*`, `X_TEXT_KERN`, `X_TEXT_END`). `insert_runs` /
 * `insert_kern` override the donor styling for paste transplants.
 */
export function _splice_text(
  doc: TextDocument,
  start: number,
  end: number,
  new_text: string,
  insert_runs: CosNode[] | null = null,
  insert_kern: CosNode[] | null = null,
): void {
  const raw = _raw_text(doc);
  const total = u16_len(raw);
  const insert_len = u16_len(new_text);
  if (start === end && insert_len === 0 && insert_runs == null) return;
  _mark_layout_dirty(doc);
  const kern_values = _kern_values(doc);
  const new_raw = u16_slice(raw, 0, start) + new_text + u16_slice(raw, end, total);
  let parts = split(new_raw, "\r");
  if (parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  const inner = cos_setdefault(doc._doc, "0", new Map());

  const runs = cos_get(inner, "6", "0");
  if (Array.isArray(runs) && runs.length) {
    let insert_entries: CosNode[];
    if (insert_runs == null) {
      let donor: CosNode | undefined;
      let pos: PyNum = 0;
      for (const run of runs) {
        const run_end = py_add(pos, _run_count(run));
        if (float(pos) <= start && start < float(run_end)) {
          donor = deepcopy(run);
          break;
        }
        pos = run_end;
      }
      if (donor === undefined) donor = deepcopy(runs[runs.length - 1]);
      cos_setitem(donor, "1", insert_len);
      insert_entries = insert_len ? [donor] : [];
    } else {
      insert_entries = insert_runs;
    }
    _split_run_array(runs, new Set([start, end]));
    const rebuilt: CosNode[] = [];
    let pos: PyNum = 0;
    let inserted = false;
    for (const run of runs) {
      const run_end = py_add(pos, _run_count(run));
      if (float(run_end) <= start) {
        rebuilt.push(run);
      } else if (float(pos) >= end) {
        if (!inserted) {
          rebuilt.push(...insert_entries);
          inserted = true;
        }
        rebuilt.push(run);
      }
      pos = run_end;
    }
    if (!inserted) rebuilt.push(...insert_entries);
    runs.splice(0, runs.length, ...rebuilt);
    _merge_adjacent_runs(runs);
  }

  const para_runs = cos_get(inner, "5", "0");
  if (Array.isArray(para_runs) && para_runs.length) {
    const old_spans: [number, number, CosNode][] = [];
    let pos: PyNum = 0;
    for (const entry of para_runs) {
      const length = _run_count(entry);
      old_spans.push([float(pos), float(py_add(pos, length)), entry]);
      pos = py_add(pos, length);
    }

    const donor_entry = (new_pos: number): CosNode => {
      let old_pos: number;
      if (new_pos < start) old_pos = new_pos;
      else if (new_pos >= start + insert_len) old_pos = new_pos - insert_len + (end - start);
      else old_pos = start;
      old_pos = total ? Math.min(old_pos, total - 1) : 0;
      for (const [span_start, span_end, entry] of old_spans) {
        if (span_start <= old_pos && old_pos < span_end) return entry;
      }
      return old_spans[old_spans.length - 1][2];
    };

    const new_para_runs: CosNode[] = [];
    let pos2 = 0;
    for (const [i, part] of parts.entries()) {
      const entry = donor_entry(pos2);
      // Keep the first run's object identity when it stays first
      // (aliased by `_para_style`); clone everything else.
      const clone = i === 0 && entry === para_runs[0] ? entry : deepcopy(entry);
      const part_len = u16_len(part) + 1;
      cos_setitem(clone, "1", part_len);
      new_para_runs.push(clone);
      pos2 += part_len;
    }
    para_runs.splice(0, para_runs.length, ...new_para_runs);
  }

  if (insert_kern == null) insert_kern = new Array<CosNode>(insert_len).fill(null);
  _rebuild_kern_runs(doc, [...kern_values.slice(0, start), ...insert_kern, ...kern_values.slice(end)]);
  if (start === 0) {
    // Replacing the leading edge invalidates the pair-0 kern value
    // (AE-unprobed; dropping it mirrors the auto_kern_type setter).
    cos_pop(inner, "7");
  }

  cos_setitem(inner, "0", new_raw);
  // Python `getattr(doc, "_rebuild_line_count_runs", None)`: duck-typed test documents may lack it.
  if (typeof doc._rebuild_line_count_runs === "function") doc._rebuild_line_count_runs(parts);
  _refresh_style_aliases(doc);
}

/**
 * Write one paragraph-style key to every paragraph overlapping the
 * range (paragraph runs are structural: never split, never merged -
 * `W_PARA_PARTIAL` styles the whole containing paragraph).
 */
export function _apply_para_key(doc: TextDocument, start: number, end: number, key: string, value: CosNode): void {
  if (start === end) return;
  _mark_layout_dirty(doc);
  const runs = cos_get(doc._doc, "0", "5", "0");
  if (!Array.isArray(runs)) return;
  let pos: PyNum = 0;
  for (const run of runs) {
    const run_end = py_add(pos, _run_count(run));
    if (float(pos) < end && float(run_end) > start) {
      const style = cos_get(run, "0", "0", "5");
      if (style instanceof Map) {
        if (value == null) style.delete(key);
        else style.set(key, value);
      }
    }
    pos = run_end;
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
  read_only?: boolean;
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
 * leading/auto-leading) stay `read_only` until their phase lands.
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
  declare read_only: boolean;
  declare public_name: string;

  constructor(kind: RangeKind, key: string, kw: RangeFieldOptions<T>) {
    const { transform, default: default_ = null, gate = null, reverse = null, validate = null, read_only = false } = kw;
    this.kind = kind;
    this.key = key;
    this.transform = transform;
    this.default_ = default_;
    this.gate = gate;
    this.reverse = reverse;
    this.validate = validate;
    this.read_only = read_only;
  }

  __set_name__(owner: Function, name: string): void {
    this.public_name = name;
  }

  __get__(obj: CharacterRange | null, objtype?: Function | null): T | null | this {
    if (obj == null) return this;
    return obj._resolve_mixed(this.kind, this.key, this.transform, this.default_, this.gate);
  }

  __set__(obj: CharacterRange, value: T | null): void {
    if (this.read_only) throw new AttributeError(`${repr(this.public_name)} is read-only.`);
    let raw: CosNode = null;
    if (value != null) {
      if (this.validate != null) this.validate(value, obj._doc_ref);
      // Every writable field declares its reverse; only read-only ones omit it.
      if (this.reverse == null) throw new AttributeError(`${repr(this.public_name)} is read-only.`);
      raw = this.reverse(value);
    }
    const [start, end] = obj._bounds();
    if (this.kind === "char") _apply_char_key(obj._doc_ref, start, end, this.key, raw);
    else _apply_para_key(obj._doc_ref, start, end, this.key, raw);
    obj._propagate();
  }

  /** Create a RangeField for boolean style flags. */
  static bool(kind: RangeKind, key: string, kwargs: RangeFieldExtras<boolean> = {}): RangeField<boolean> {
    return new RangeField<boolean>(kind, key, { transform: bool, reverse: bool, ...kwargs });
  }

  /** Create a RangeField that coerces to float. */
  static float(kind: RangeKind, key: string, kwargs: RangeFieldExtras<number> = {}): RangeField<number> {
    // The stored value is a Python float, so box it to keep `1.0` from serializing as `1`.
    return new RangeField<number>(kind, key, { transform: cos_float, reverse: (x: number) => pyfloat(x), ...kwargs });
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
    return new RangeField<number>(kind, key, { transform: cos_int, reverse: (x: number) => round(x), ...kwargs });
  }

  /**
   * Create a RangeField for IntEnum-backed style keys. Writes reject
   * out-of-enum ints (ExtendScript parity); reads stay tolerant via
   * `from_binary`. Without the check a stray int serializes a value
   * that reads back as `None`/undefined.
   */
  static enum<V extends number>(enum_cls: CosEnum<V>, kind: RangeKind, key: string, kwargs: RangeFieldExtras<V> = {}): RangeField<V> {
    return new RangeField<V>(kind, key, {
      transform: (raw: CosNode) => enum_from_cos(enum_cls, raw),
      reverse: (value: V) => enum_cls.to_binary(value),
      validate: validate_enum(enum_cls),
      ...kwargs,
    });
  }
}

/** A `TextDocument` style dict attribute. */
type StyleAttr = "_char_style" | "_para_style";

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
    const is_char = this.dict_attr === "_char_style";
    const backing = obj[this.dict_attr];
    let runs: CosNode = null;
    if (backing != null) {
      runs = cos_get(obj._doc, "0", is_char ? "6" : "5", "0");
    }
    if (!Array.isArray(runs) || !runs.length) {
      // Single style dict (or a parser fallback with no runs): the
      // base descriptor's first-run write is already document-wide.
      super.__set__(obj, value);
      return;
    }
    this._check_writable(obj);
    obj.__dict__.delete(this.public_name);
    const raw_value = value == null ? null : this._coerce(obj, value);
    const total = u16_len(_raw_text(obj));
    if (is_char) _apply_char_key(obj, 0, total, this.key, raw_value);
    else _apply_para_key(obj, 0, total, this.key, raw_value);
    if (typeof obj._propagate_cos === "function") obj._propagate_cos();
  }

  /** `CosField.bool`: a boolean flag on the document's first char / para style. */
  static bool<D extends boolean | null>(dict_attr: StyleAttr, key: string, kw: CosFieldExtras<D, TextDocument>): DocumentWideCosField<boolean | D> {
    return new DocumentWideCosField(dict_attr, key, bool_field(kw));
  }

  /** `CosField.float`: a float style key, coerced to float in both directions. */
  static float<D extends number | null>(dict_attr: StyleAttr, key: string, kw: CosFieldExtras<D, TextDocument>): DocumentWideCosField<number | D> {
    return new DocumentWideCosField(dict_attr, key, float_field(kw));
  }

  /** `CosField.int`: an integer-stored style key. */
  static int<D extends number | null>(dict_attr: StyleAttr, key: string, kw: CosFieldExtras<D, TextDocument>): DocumentWideCosField<number | D> {
    return new DocumentWideCosField(dict_attr, key, int_field(kw));
  }

  /**
   * `CosField.enum`, rejecting out-of-enum ints on write (ExtendScript
   * parity). Mirrors `RangeField.enum`; the base `CosField.enum` does
   * not validate, so a stray int would serialize a value that reads back
   * as `null`/undefined. Reads stay tolerant via `from_binary`.
   */
  static enum<V extends number, D extends V | null>(enum_cls: CosEnum<V>, dict_attr: StyleAttr, key: string, kw: CosFieldExtras<D, TextDocument>): DocumentWideCosField<V | D> {
    return new DocumentWideCosField(dict_attr, key, enum_field(enum_cls, { validate: validate_enum(enum_cls), ...kw }));
  }
}

// ---------------------------------------------------------------------------
// Range base classes
// ---------------------------------------------------------------------------

/**
 * Shared boundary/validity/repr behavior for the text range views.
 *
 * Subclasses store `_doc_ref`, `_start` and `_signed_end`, and
 * implement `_bounds()` (returning the current
 * `(character_start, character_end)` and raising `ValueError` when the
 * range is out of bounds). The public accessors and string forms below
 * are shared across all three range types.
 */
export class _TextRange {
  declare _doc_ref: TextDocument;
  declare _start: number;
  declare _signed_end: number;

  constructor(doc: TextDocument, start: number, signed_end: number) {
    this._doc_ref = doc;
    this._start = start;
    this._signed_end = signed_end;
    // AE validates at creation time and raises immediately.
    this._bounds();
  }

  _bounds(): [number, number] {
    throw new NotImplementedError();
  }

  /** The range's first character index. Read-only. */
  get character_start(): number {
    return this._bounds()[0];
  }

  /** The range's last character index + 1. Read-only. */
  get character_end(): number {
    return this._bounds()[1];
  }

  /** `true` while the range lies within the document bounds. Read-only. */
  get is_range_valid(): boolean {
    try {
      this._bounds();
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return false;
    }
    return true;
  }

  __str__(): string {
    return `${this.constructor.name}(${this._start},${this._signed_end})`;
  }

  toString(): string {
    return this.__str__();
  }

  __repr__(): string {
    return `<py_aep.${this.constructor.name}(${this._start},${this._signed_end})>`;
  }
}

/**
 * A range addressed by an index into a span list (paragraphs or
 * composed lines) and resolved to character bounds.
 *
 * Shares the index storage and the `character_range()` snapshot; only
 * `_bounds()` (the per-kind span lookup and clamping) differs.
 */
export class _IndexRange extends _TextRange {
  /**
   * A {@link CharacterRange} fixed to the current character bounds.
   *
   * The returned range holds resolved indices and does not follow
   * later changes to this range's paragraphs or lines.
   */
  character_range(): CharacterRange {
    const [start, end] = this._bounds();
    return new CharacterRange(this._doc_ref, start, end);
  }
}

// ---------------------------------------------------------------------------
// CharacterRange
// ---------------------------------------------------------------------------

/**
 * A contiguous character span of a {@link TextDocument}.
 *
 * Created via `TextDocument.character_range(character_start, signed_character_end)`. Most `TextDocument` styling attributes are
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
  declare font_size: number | null;
  declare faux_bold: boolean | null;
  declare faux_italic: boolean | null;
  declare horizontal_scale: number | null;
  declare vertical_scale: number | null;
  declare tracking: number | null;
  declare baseline_shift: number | null;
  declare font_caps_option: FontCapsOption | null;
  declare font_baseline_option: FontBaselineOption | null;
  declare ligature: boolean | null;
  declare baseline_direction: BaselineDirection | null;
  declare tsume: number | null;
  declare no_break: boolean | null;
  declare apply_fill: boolean | null;
  declare apply_stroke: boolean | null;
  declare stroke_over_fill: boolean | null;
  declare line_join_type: LineJoinType | null;
  declare stroke_width: number | null;
  declare digit_set: DigitSet | null;
  declare justification: ParagraphJustification | null;
  declare first_line_indent: number | null;
  declare start_indent: number | null;
  declare end_indent: number | null;
  declare space_before: number | null;
  declare space_after: number | null;
  declare leading_type: LeadingType | null;
  declare auto_hyphenate: boolean | null;
  declare hanging_roman: boolean | null;
  declare every_line_composer: boolean | null;
  declare direction: ParagraphDirection | null;
  declare fill_color: number[] | null;
  declare stroke_color: number[] | null;

  // -- Bounds --------------------------------------------------------------

  /**
   * Resolve `(start, end)` against the current document.
   *
   * @throws {@link ValueError} When the range is outside the document bounds.
   */
  _bounds(): [number, number] {
    const visible = _visible_length(this._doc_ref);
    const end = this._signed_end === -1 ? visible : this._signed_end;
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
      for (const [run_start, run_end, payload] of spans) {
        if (run_start <= start && start < run_end) return [payload];
      }
      return spans.length ? [spans[spans.length - 1][2]] : [];
    }
    const out: CosDict[] = [];
    for (const [run_start, run_end, payload] of spans) {
      if (run_start < end && run_end > start) out.push(payload);
    }
    return out;
  }

  _spans_for(kind: RangeKind): [number, number, CosDict][] {
    if (kind === "char") return _char_run_spans(this._doc_ref);
    if (kind === "para") return _para_run_spans(this._doc_ref);
    return _kern_run_spans(this._doc_ref);
  }

  /**
   * Resolve one style key over the overlapping runs.
   *
   * Uniform value -\> that value; disagreement -\> `null`; every run
   * gated out -\> `null`.
   */
  _resolve_mixed<T>(kind: RangeKind, key: string, transform: (raw: CosNode) => T, default_: T | null, gate: string | null): T | null {
    let payloads = this._overlapping(this._spans_for(kind));
    if (gate != null) {
      payloads = payloads.filter((p) => py_bool(p.get(gate) ?? null));
      if (!payloads.length) return null;
    }
    if (!payloads.length) return default_;
    const values = payloads.map((payload) => _extract(payload, key, transform, default_));
    const first = values[0];
    return values.slice(1).every((value) => py_eq(value, first)) ? first : null;
  }

  _propagate(): void {
    // Python `getattr(self._doc_ref, "_propagate_cos", None)`: duck-typed test documents may lack it.
    if (typeof this._doc_ref._propagate_cos === "function") this._doc_ref._propagate_cos();
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
    return u16_slice(_raw_text(this._doc_ref), start, end).replaceAll("\r", "\n");
  }

  set text(value: string) {
    validate_text(value);
    const doc = this._doc_ref;
    const raw = _raw_text(doc);
    let [start, end] = this._bounds();
    [start, end] = _snap_to_pairs(raw, start, end);
    const normalized = value.replaceAll("\r\n", "\r").replaceAll("\n", "\r");
    _splice_text(doc, start, end, normalized);
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
   * @param source_range - The {@link CharacterRange} to copy from (may belong to another document
   *   or project).
   */
  paste_from(source_range: CharacterRange): void {
    if (!(source_range instanceof CharacterRange)) {
      throw new TypeError_("paste_from expects a CharacterRange");
    }
    const doc = this._doc_ref;
    const src_doc = source_range._doc_ref;
    const src_raw = _raw_text(src_doc);
    let [src_start, src_end] = source_range._bounds();
    [src_start, src_end] = _snap_to_pairs(src_raw, src_start, src_end);
    const text_slice = u16_slice(src_raw, src_start, src_end);

    const entries: CosNode[] = [];
    let pos: PyNum = 0;
    const src_runs = cos_get(src_doc._doc, "0", "6", "0");
    for (const run of cos_iter(py_bool(src_runs) ? src_runs : [])) {
      const run_end = py_add(pos, _run_count(run));
      // `max(pos, src_start)` / `min(run_end, src_end)` keep the winning
      // operand itself, so a float position stays a float.
      const overlap_start: PyNum = src_start > float(pos) ? src_start : pos;
      const overlap_end: PyNum = src_end < float(run_end) ? src_end : run_end;
      if (float(overlap_end) > float(overlap_start)) {
        const clone = deepcopy(run);
        cos_setitem(clone, "1", py_sub(overlap_end, overlap_start));
        entries.push(clone);
      }
      pos = run_end;
    }

    if (src_doc !== doc) {
      const needed = new Map<number, string>();
      for (const clone of entries) {
        const style = cos_get(clone, "0", "0", "6");
        if (style instanceof Map) {
          const index = read(char_style, style, "0");
          if (index != null && 0 <= Number(index) && Number(index) < src_doc._fonts.length) {
            needed.set(Number(index), src_doc._fonts[Number(index)].post_script_name);
          }
        }
      }
      const existing = new Set<string>(doc._fonts.map((f) => f.post_script_name));
      for (const name of needed.values()) {
        if (!existing.has(name)) {
          _register_font_at(doc, name);
          existing.add(name);
        }
      }
      const target_index = new Map<string, number>();
      for (const [i, f] of doc._fonts.entries()) target_index.set(f.post_script_name, i);
      for (const clone of entries) {
        const style = cos_get(clone, "0", "0", "6");
        if (style instanceof Map) {
          const index = read(char_style, style, "0");
          const name = index != null ? needed.get(Number(index)) : undefined;
          if (name !== undefined) style.set("0", getitem(target_index, name));
        }
      }
    }

    const kern_slice = _kern_values(src_doc).slice(src_start, src_end);
    let src_edge: number | boolean | null = null;
    if (src_start === 0) {
      const edge = cos_get(src_doc._doc, "0", "7");
      if (is(py_int, edge)) src_edge = edge;
    }
    const raw = _raw_text(doc);
    let [start, end] = this._bounds();
    [start, end] = _snap_to_pairs(raw, start, end);
    _splice_text(doc, start, end, text_slice, entries, kern_slice);
    if (src_edge != null) {
      // The source's leading-edge kern value (pair before char 0)
      // follows the paste: it stays the leading edge when pasting at
      // 0, otherwise it becomes the pair value between the preceding
      // character and the pasted text (probed Y_PASTE_EDGE0/_MID).
      if (start === 0) {
        cos_setitem(cos_setdefault(doc._doc, "0", new Map()), "7", src_edge);
      } else {
        const values = _kern_values(doc);
        if (start - 1 < values.length) {
          values[start - 1] = src_edge;
          _rebuild_kern_runs(doc, values);
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
  get auto_leading(): boolean | null {
    return this._resolve_mixed("char", "4", bool, true, null);
  }

  set auto_leading(value: boolean) {
    validate_bool(value);
    const [start, end] = this._bounds();
    _apply_char_key(this._doc_ref, start, end, "4", value);
    if (value) {
      _apply_char_key(this._doc_ref, start, end, "5", pyfloat(0.01));
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
  get auto_kern_type(): AutoKernType | null {
    return this._resolve_mixed("char", "11", (raw) => enum_from_cos(AutoKernType, raw), AutoKernType.NO_AUTO_KERN, null);
  }

  set auto_kern_type(value: AutoKernType) {
    validate_enum(AutoKernType)(value);
    const doc = this._doc_ref;
    const [start, end] = _snap_to_pairs(_raw_text(doc), ...this._bounds());
    if (start === end) {
      // Zero-span writes are no-ops (W_ZERO_STYLE); guard before
      // the kern-clearing side effects below.
      return;
    }
    _apply_char_key(doc, start, end, "11", AutoKernType.to_binary(AutoKernType.of(value)));
    if (value !== AutoKernType.NO_AUTO_KERN) {
      const values = _kern_values(doc);
      for (let i = start; i < Math.min(end, values.length); i++) values[i] = null;
      _rebuild_kern_runs(doc, values);
      if (start === 0) {
        cos_pop(cos_get_or(doc._doc, "0", new Map()), "7");
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
    const font_obj = this.font_object;
    return font_obj != null ? font_obj.post_script_name : null;
  }

  set font(value: string) {
    validate_font_name(value);
    const doc = this._doc_ref;
    const [start, end] = _snap_to_pairs(_raw_text(doc), ...this._bounds());
    if (start === end) {
      // Zero-span writes are no-ops (W_ZERO_STYLE); guard before
      // registering the font, which mutates the whole document.
      return;
    }
    let index: number | null = null;
    for (const [i, font_obj] of doc._fonts.entries()) {
      if (font_obj.post_script_name === value) {
        index = i;
        break;
      }
    }
    if (index == null) index = _register_font_at(doc, value);
    _apply_char_key(doc, start, end, "0", index);
    this._propagate();
  }

  /** The range's {@link FontObject}; `null` when mixed. Read-only. */
  get font_object(): FontObject | null {
    const idx = this._resolve_mixed("char", "0", (raw) => raw, null, null);
    const fonts = this._doc_ref._fonts;
    if (is(py_int, idx) && 0 <= Number(idx) && Number(idx) < fonts.length) {
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
    const auto = this.auto_leading;
    if (auto == null || auto) return null;
    return this._resolve_mixed("char", "5", cos_float, null, null);
  }

  set leading(value: number | null) {
    if (value != null) validate_positive_number(value);
    const [start, end] = this._bounds();
    if (value == null) {
      _apply_char_key(this._doc_ref, start, end, "5", null);
    } else {
      _apply_char_key(this._doc_ref, start, end, "5", pyfloat(value));
      _apply_char_key(this._doc_ref, start, end, "4", false);
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
    if (this.auto_kern_type !== AutoKernType.NO_AUTO_KERN) return null;
    const value = this._resolve_mixed("kern", "0", (raw) => raw, null, null);
    return is(py_int, value) ? value : null;
  }

  set kerning(value: number | boolean | null) {
    validate_s4(value, this._doc_ref);
    // `validate_s4` accepts a float (see its definition): round it on
    // write, matching the sibling `tracking` field, whose `RangeField.int`
    // sets `reverse=round`. `round` also normalizes bools (a subclass of
    // int) so the serializer emits an integer, not a `true`/`false` token.
    const rounded = round(cos_num(value));
    const doc = this._doc_ref;
    const raw = _raw_text(doc);
    let [start, end] = this._bounds();
    [start, end] = _snap_to_pairs(raw, start, end);
    if (start === end) return;
    // Kern runs mutate before the auto-kern flag write reaches
    // _apply_char_key, so mark (and calibrate) here first.
    _mark_layout_dirty(doc);
    // No visible-end extension here: AE never kerns the raw `\r`
    // terminator (every probed kern fixture leaves it in an empty
    // run); `_apply_char_key` below re-extends the style write.
    const kern_start = Math.max(0, start - 1);
    const values = _kern_values(doc);
    for (let i = kern_start; i < Math.min(end, values.length); i++) values[i] = rounded;
    _rebuild_kern_runs(doc, values);
    if (start === 0) {
      // Pair position 0 (before the first character): AE stores the
      // leading-edge value at doc["0"]["7"], created after key "8".
      cos_setitem(cos_setdefault(doc._doc, "0", new Map()), "7", rounded);
    }
    _apply_char_key(doc, kern_start, end, "11", AutoKernType.to_binary(AutoKernType.NO_AUTO_KERN));
    this._propagate();
  }

  /** `true` if the range has All Caps enabled; `null` when mixed. Read-only. */
  get all_caps(): boolean | null {
    const caps = this.font_caps_option;
    if (caps == null) return null;
    return caps === FontCapsOption.FONT_ALL_CAPS;
  }

  /** `true` if the range has Small Caps enabled; `null` when mixed. Read-only. */
  get small_caps(): boolean | null {
    const caps = this.font_caps_option;
    if (caps == null) return null;
    return caps === FontCapsOption.FONT_SMALL_CAPS;
  }

  /** `true` if the range is superscript; `null` when mixed. Read-only. */
  get superscript(): boolean | null {
    const baseline = this.font_baseline_option;
    if (baseline == null) return null;
    return baseline === FontBaselineOption.FONT_FAUXED_SUPERSCRIPT;
  }

  /** `true` if the range is subscript; `null` when mixed. Read-only. */
  get subscript(): boolean | null {
    const baseline = this.font_baseline_option;
    if (baseline == null) return null;
    return baseline === FontBaselineOption.FONT_FAUXED_SUBSCRIPT;
  }

  /** The document's composer engine (document-wide). Read-only. */
  get composer_engine(): ComposerEngine | null {
    return this._doc_ref.composer_engine;
  }
}

// ---------------------------------------------------------------------------
// ParagraphRange / ComposedLineRange
// ---------------------------------------------------------------------------

/**
 * A paragraph span of a {@link TextDocument}.
 *
 * Created via `TextDocument.paragraph_range(paragraph_index_start, signed_paragraph_index_end)`. Paragraph character boundaries include
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
    const spans = _para_run_spans(this._doc_ref);
    const count = spans.length;
    const end = this._signed_end === -1 ? count : this._signed_end;
    if (this._start < 0 || this._start >= count || end <= this._start || end > count) {
      throw new ValueError(PARAGRAPH_RANGE_OOB);
    }
    const visible = _visible_length(this._doc_ref);
    return [Math.min(spans[this._start][0], visible), Math.min(spans[end - 1][1], visible)];
  }
}

/**
 * A composed-line span of a {@link TextDocument}.
 *
 * Created via `TextDocument.composed_line_range( composed_line_index_start, signed_composed_line_index_end)`.
 * Point text derives its lines from the paragraphs (always fresh).
 * Box text reads the layout cache AE persisted at save time; after a
 * layout-affecting py-side write the calibrated composed-line
 * resolver recomposes it (see `TextDocument.composition_stale`).
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
    const spans = _composed_line_spans(this._doc_ref);
    if (spans == null) throw new ValueError(COMPOSED_LINE_OOB);
    const count = spans.length;
    const end = this._signed_end === -1 ? count : this._signed_end;
    if (this._start < 0 || this._start >= count || end <= this._start || end > count) {
      throw new ValueError(COMPOSED_LINE_OOB);
    }
    const visible = _visible_length(this._doc_ref);
    const start_char = spans[this._start][0];
    // A stale cached line lying wholly beyond the current text raises;
    // a line starting exactly at the end is a valid zero-span (e.g. the
    // trailing empty paragraph's line).
    if (start_char > visible) throw new ValueError(COMPOSED_LINE_OOB);
    return [start_char, Math.min(spans[end - 1][1], visible)];
  }
}

// ---------------------------------------------------------------------------
// Descriptor-backed CharacterRange fields (class-body RangeField assignments)
// ---------------------------------------------------------------------------

/** `font_size`: the range's font size in pixels; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "font_size", RangeField.float("char", "1", { validate: validate_positive_nonzero_number }));

/** `faux_bold`: `true` if faux bold is enabled across the range. Read / Write. */
descriptor(CharacterRange, "faux_bold", RangeField.bool("char", "2"));

/** `faux_italic`: `true` if faux italic is enabled across the range. Read / Write. */
descriptor(CharacterRange, "faux_italic", RangeField.bool("char", "3"));

/** `horizontal_scale`: the range's horizontal scale; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "horizontal_scale", RangeField.float("char", "6", { validate: validate_number }));

/** `vertical_scale`: the range's vertical scale; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "vertical_scale", RangeField.float("char", "7", { validate: validate_number }));

/** `tracking`: the range's spacing between characters; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "tracking", RangeField.int("char", "8", { validate: validate_s4 }));

/** `baseline_shift`: the range's baseline shift in pixels; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "baseline_shift", RangeField.float("char", "9", { validate: validate_number }));

/** `font_caps_option`: the range's font caps option; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "font_caps_option", RangeField.enum(FontCapsOption, "char", "12"));

/** `font_baseline_option`: the range's font baseline option; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "font_baseline_option", RangeField.enum(FontBaselineOption, "char", "13"));

/** `ligature`: `true` when ligature is used across the range. Read / Write. */
descriptor(CharacterRange, "ligature", RangeField.bool("char", "18", { default: false }));

/** `baseline_direction`: the range's baseline direction; `null` when mixed. Read / Write. */
descriptor(
  CharacterRange,
  "baseline_direction",
  RangeField.enum(BaselineDirection, "char", "35", { default: BaselineDirection.BASELINE_WITH_STREAM }),
);

/** `tsume`: the range's tsume value (0.0 to 1.0); `null` when mixed. Read / Write. */
descriptor(
  CharacterRange,
  "tsume",
  RangeField.float("char", "36", { default: 0.0, validate: validate_normalized_float }),
);

/** `no_break`: `true` when no-break is applied across the range. Read / Write. */
descriptor(CharacterRange, "no_break", RangeField.bool("char", "52", { default: false }));

/** `apply_fill`: when `true`, the range shows a fill; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "apply_fill", RangeField.bool("char", "56"));

/** `apply_stroke`: when `true`, the range shows a stroke; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "apply_stroke", RangeField.bool("char", "57", { default: false }));

/** `stroke_over_fill`: when `true`, the stroke appears over the fill; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "stroke_over_fill", RangeField.bool("char", "58", { default: true }));

/** `line_join_type`: the range's line join type for strokes; `null` when mixed. Read / Write. */
descriptor(
  CharacterRange,
  "line_join_type",
  RangeField.enum(LineJoinType, "char", "62", { default: LineJoinType.LINE_JOIN_MITER }),
);

/** `stroke_width`: the range's stroke thickness; `null` when mixed. Read / Write. */
descriptor(
  CharacterRange,
  "stroke_width",
  RangeField.float("char", "63", { default: 1.0, validate: validate_positive_nonzero_number }),
);

/** `digit_set`: the range's digit set option; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "digit_set", RangeField.enum(DigitSet, "char", "70", { default: DigitSet.DEFAULT_DIGITS }));

/** `justification`: the justification of paragraphs in the range; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "justification", RangeField.enum(ParagraphJustification, "para", "0"));

/** `first_line_indent`: the paragraphs' first line indent; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "first_line_indent", RangeField.float("para", "1", { default: 0.0, validate: validate_number }));

/** `start_indent`: the paragraphs' start indent; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "start_indent", RangeField.float("para", "2", { default: 0.0, validate: validate_number }));

/** `end_indent`: the paragraphs' end indent; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "end_indent", RangeField.float("para", "3", { default: 0.0, validate: validate_number }));

/** `space_before`: the paragraphs' space before; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "space_before", RangeField.float("para", "4", { default: 0.0, validate: validate_number }));

/** `space_after`: the paragraphs' space after; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "space_after", RangeField.float("para", "5", { default: 0.0, validate: validate_number }));

/** `leading_type`: the paragraphs' leading type; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "leading_type", RangeField.enum(LeadingType, "para", "8", { default: LeadingType.ROMAN_LEADING_TYPE }));

/** `auto_hyphenate`: the paragraphs' auto-hyphenate option; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "auto_hyphenate", RangeField.bool("para", "9"));

/** `hanging_roman`: the paragraphs' Roman Hanging Punctuation; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "hanging_roman", RangeField.bool("para", "21", { default: false }));

/** `every_line_composer`: the paragraphs' Every-Line Composer option; `null` when mixed. Read / Write. */
descriptor(CharacterRange, "every_line_composer", RangeField.bool("para", "29", { default: false }));

/** `direction`: the paragraphs' direction; `null` when mixed. Read / Write. */
descriptor(
  CharacterRange,
  "direction",
  RangeField.enum(ParagraphDirection, "para", "33", { default: ParagraphDirection.DIRECTION_LEFT_TO_RIGHT }),
);

/**
 * `fill_color`: the range's fill color as `[r, g, b]`. Read / Write.
 *
 * Only characters with `apply_fill` participate in the read; `null`
 * when no character in the range has a fill or the colors are mixed.
 * Setting writes the paint only - like the stroke, it does not enable
 * `apply_fill`.
 */
descriptor(
  CharacterRange,
  "fill_color",
  new RangeField("char", "53", {
    transform: _parse_color,
    gate: "56",
    reverse: _build_color_paint,
    validate: validate_rgb_color,
  }),
);

/**
 * `stroke_color`: the range's stroke color as `[r, g, b]`. Read / Write.
 *
 * Only characters with `apply_stroke` participate in the read; `null`
 * when no character in the range has a stroke or the colors are
 * mixed. Setting writes the paint only - AE does NOT enable
 * `apply_stroke` (probed `W_STROKE_GATE`; the Scripting Guide claims
 * otherwise).
 */
descriptor(
  CharacterRange,
  "stroke_color",
  new RangeField("char", "54", {
    transform: _parse_color,
    gate: "57",
    reverse: _build_color_paint,
    validate: validate_rgb_color,
  }),
);
