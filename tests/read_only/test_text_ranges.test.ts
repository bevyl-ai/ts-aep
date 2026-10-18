/**
 * Parity tests for CharacterRange / ParagraphRange / ComposedLineRange.
 *
 * Every assertion compares the parsed `samples/models/text/text_ranges.aep`
 * against `text_ranges_probe.json`, the exhaustive ExtendScript ground truth
 * dumped by `scripts/jsx/generate_text_range_samples.jsx` from the very AE
 * session that saved the sample.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  Path,
  ValueError,
  at,
  dict_get,
  fspath,
  getattr,
  getitem,
  int,
  len,
  lru_cache,
  py_assert,
  py_bool,
  py_eq,
  repr,
  split,
  str,
} from "../../src/pyrt/index.ts";
import { approx, raises } from "../../src/pyrt/pytest.ts";
import { parse_project } from "../helpers.ts";
import type { TextDocument } from "../../src/py_aep/models/text/text_document.ts";

// `Path(__file__).parent.parent.parent / "samples" / ...` in the Python source.
const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "text");
const SAMPLE = SAMPLES_DIR.div("text_ranges.aep");
const PROBE = SAMPLES_DIR.div("text_ranges_probe.json");

// ExtendScript attribute -> py_aep CharacterRange attribute. Attributes
// deliberately not exposed (host-font-resolved) are absent: fontFamily,
// fontStyle, fontLocation.
const ATTR_MAP: Map<string, string> = new Map([
  ["characterStart", "characterStart"],
  ["characterEnd", "characterEnd"],
  ["isRangeValid", "isRangeValid"],
  ["text", "text"],
  ["fillColor", "fillColor"],
  ["strokeColor", "strokeColor"],
  ["strokeOverFill", "strokeOverFill"],
  ["strokeWidth", "strokeWidth"],
  ["applyFill", "applyFill"],
  ["applyStroke", "applyStroke"],
  ["font", "font"],
  ["fontObject", "fontObject"],
  ["fontSize", "fontSize"],
  ["fauxBold", "fauxBold"],
  ["fauxItalic", "fauxItalic"],
  ["autoLeading", "autoLeading"],
  ["leading", "leading"],
  ["kerning", "kerning"],
  ["autoKernType", "autoKernType"],
  ["tracking", "tracking"],
  ["baselineShift", "baselineShift"],
  ["horizontalScale", "horizontalScale"],
  ["verticalScale", "verticalScale"],
  ["fontCapsOption", "fontCapsOption"],
  ["fontBaselineOption", "fontBaselineOption"],
  ["ligature", "ligature"],
  ["noBreak", "noBreak"],
  ["baselineDirection", "baselineDirection"],
  ["tsume", "tsume"],
  ["digitSet", "digitSet"],
  ["lineJoinType", "lineJoinType"],
  ["allCaps", "allCaps"],
  ["smallCaps", "smallCaps"],
  ["superscript", "superscript"],
  ["subscript", "subscript"],
  ["composerEngine", "composerEngine"],
  ["justification", "justification"],
  ["firstLineIndent", "firstLineIndent"],
  ["startIndent", "startIndent"],
  ["endIndent", "endIndent"],
  ["spaceBefore", "spaceBefore"],
  ["spaceAfter", "spaceAfter"],
  ["leadingType", "leadingType"],
  ["autoHyphenate", "autoHyphenate"],
  ["hangingRoman", "hangingRoman"],
  ["everyLineComposer", "everyLineComposer"],
  ["direction", "direction"],
]);

const _AE_ERROR_PREFIX = "Error: After Effects error: ";
const _MARKER_RE = /<U\+([0-9A-F]{4})>/g;

type ProbeJson = null | boolean | number | string | ProbeJson[] | { [key: string]: ProbeJson };
type ProbeRecord = { [key: string]: ProbeJson };
type ProbeResult<V> = { ok: true; value: V } | { ok: false; error: string };

function _load_probe() {
  return JSON.parse(fs.readFileSync(fspath(PROBE), "utf-8"));
}

/** ES text -> py text: CR becomes LF, marker escapes become chars.
 *
 * The probe writer replaces lone surrogates with `<U+XXXX>` markers
 * (a raw lone surrogate kills ExtendScript's File.write); decode them
 * back to compare against py_aep's surrogatepass slicing.
 */
function _expected_text(value: string): string {
  const decoded = value.replace(_MARKER_RE, (_m: string, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  return decoded.replaceAll("\r", "\n");
}

/** Build the CharacterRange a probe dict key describes (e.g. `0_-1`). */
function _range_from_key(doc: TextDocument, key: string) {
  const i = key.lastIndexOf("_");
  const start_s = key.slice(0, i);
  const end_s = key.slice(i + 1);
  const start = int(start_s);
  if (end_s === "def") return doc.characterRange(start);
  return doc.characterRange(start, int(end_s));
}

/** Return a mismatch description, or `null` when values agree. */
function _compare(py_val: unknown, expected: ProbeJson, attr: string): string | null {
  if (expected === "<<undefined>>") {
    if (py_val == null) return null;
    return `${attr}: expected None (ES undefined), got ${repr(py_val)}`;
  }
  if (attr === "fontObject") {
    const expected_name = typeof expected === "string" ? at(split(expected, ":", 1), 1) : null;
    const actual_name = py_val != null ? getattr(py_val, "postScriptName") : null;
    if (py_eq(actual_name, expected_name)) return null;
    return `${attr}: expected ${repr(expected_name)}, got ${repr(actual_name)}`;
  }
  if (attr === "text") {
    py_assert(typeof expected === "string");
    expected = _expected_text(expected);
    if (py_eq(py_val, expected)) return null;
    return `${attr}: expected ${repr(expected)}, got ${repr(py_val)}`;
  }
  if (Array.isArray(expected)) {
    if (py_val != null && approx(py_val, expected, { abs: 1e-5 })) return null;
    return `${attr}: expected ${repr(expected)}, got ${repr(py_val)}`;
  }
  // NOTE(port): JS has one number type so this also takes ints; approx(abs=1e-5) agrees with py_eq on integers.
  if (typeof expected === "number" || typeof py_val === "number") {
    if (py_val != null && approx(py_val, expected, { abs: 1e-5 })) return null;
    return `${attr}: expected ${repr(expected)}, got ${repr(py_val)}`;
  }
  // bools, ints, IntEnums (IntEnum == int holds for ExtendScript values)
  if (py_eq(py_val, expected)) return null;
  return `${attr}: expected ${repr(expected)}, got ${repr(py_val)}`;
}

/** Python repr of a JSON-decoded value (dict/list/scalars). */
function _dict_repr(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(_dict_repr).join(", ")}]`;
  if (v != null && typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${repr(k)}: ${_dict_repr(x)}`).join(", ")}}`;
  }
  return repr(v);
}

/** Python dict equality: py_eq cannot compare plain records, so lift them to Maps. */
function _as_dict(d: object) {
  return d instanceof Map ? d : new Map(Object.entries(d));
}

// Module-scoped fixtures from the Python file, as lazily cached module state.
const probe = lru_cache(_load_probe);

const docs = lru_cache((): Map<string, TextDocument> => {
  // NOTE(port): parse_project is synchronous in the TS helpers, as in Python.
  const project = parse_project(SAMPLE);
  const comp = project.compositions[0];
  return new Map(
    comp.textLayers.map((layer): [string, TextDocument] => {
      const text = layer.text;
      py_assert(text != null);
      return [layer.name, text.sourceText.value];
    }),
  );
});

const LAYER_NAMES = [
  "RangesPoint",
  "RangesBox",
  "RangesKernLead",
  "RangesJust",
  "RangesEmpty",
  "RangesTrailing",
  "RangesEmoji",
  "RangesTextReset",
];

/** text / paragraph_count / composed_line_count parity per layer. */
describe("TestDocumentLevel", () => {
  test.each(LAYER_NAMES)("test_text[%#]", (name: string) => {
    const expected = probe().layers[name];
    expect(getitem(docs(), name).text).toBe(_expected_text(expected.text));
  });

  test.each(LAYER_NAMES)("test_paragraph_count[%#]", (name: string) => {
    const expected = probe().layers[name].paragraphCount;
    if (expected.ok) {
      expect(getitem(docs(), name).paragraphCount).toBe(expected.value);
    }
  });

  test.each(LAYER_NAMES)("test_composed_line_count[%#]", (name: string) => {
    const expected = probe().layers[name].composedLineCount;
    if (expected.ok) {
      expect(getitem(docs(), name).composedLineCount).toBe(expected.value);
    }
  });

  test("test_document_kerning_reads_zero", () => {
    // ExtendScript exports kerning=0 on every TextDocument value object,
    // even with manual per-character kerning present; the real values
    // are only reachable through character_range(...).kerning.
    expect(getitem(docs(), "RangesKernLead").kerning).toBe(0);
    expect(getitem(docs(), "RangesKernLead").characterRange(1, 4).kerning).toBe(200);
  });
});

/** Paragraph / composed-line boundary and index-lookup parity. */
describe("TestRangeBoundaries", () => {
  test.each(LAYER_NAMES)("test_paragraph_ranges[%#]", (name: string) => {
    const doc = getitem(docs(), name);
    for (const entry of probe().layers[name].paragraphRanges) {
      py_assert(entry.ok, `${name}: ES probe failed: ${_dict_repr(entry)}`);
      const exp = entry.value;
      const pr = doc.paragraphRange(exp.index);
      expect(str(pr)).toBe(exp.str);
      expect(pr.characterStart).toBe(exp.characterStart);
      expect(pr.characterEnd).toBe(exp.characterEnd);
      expect(pr.isRangeValid).toBe(exp.isRangeValid);
      expect(pr.characterRange().text).toBe(_expected_text(exp.charRangeText));
    }
  });

  test.each(LAYER_NAMES)("test_composed_line_ranges[%#]", (name: string) => {
    const doc = getitem(docs(), name);
    for (const entry of probe().layers[name].composedLineRanges) {
      py_assert(entry.ok, `${name}: ES probe failed: ${_dict_repr(entry)}`);
      const exp = entry.value;
      const clr = doc.composedLineRange(exp.index);
      expect(str(clr)).toBe(exp.str);
      expect(clr.characterStart).toBe(exp.characterStart);
      expect(clr.characterEnd).toBe(exp.characterEnd);
      expect(clr.isRangeValid).toBe(exp.isRangeValid);
      expect(clr.characterRange().text).toBe(_expected_text(exp.charRangeText));
    }
  });

  test.each(LAYER_NAMES)("test_character_indexes_at[%#]", (name: string) => {
    const doc = getitem(docs(), name);
    const layer_probe = probe().layers[name];
    // NOTE(port): Object.entries orders integer-like keys ascending; the probe JSON keys are already in ascending order.
    for (const [idx_s, entry] of Object.entries<ProbeResult<ProbeRecord>>(layer_probe.paragraphCharacterIndexesAt)) {
      if (entry.ok) {
        expect(
          py_eq(_as_dict(doc.paragraphCharacterIndexesAt(int(idx_s))), _as_dict(entry.value)),
        ).toBe(true);
      }
    }
    for (const [idx_s, entry] of Object.entries<ProbeResult<ProbeRecord>>(layer_probe.composedLineCharacterIndexesAt)) {
      if (entry.ok) {
        expect(
          py_eq(_as_dict(doc.composedLineCharacterIndexesAt(int(idx_s))), _as_dict(entry.value)),
        ).toBe(true);
      }
    }
  });
});

/** Every probed attribute of every probed range, against ES values. */
describe("TestCharacterRangeAttributes", () => {
  test.each(LAYER_NAMES)("test_attribute_parity[%#]", (name: string) => {
    const doc = getitem(docs(), name);
    const mismatches: string[] = [];
    for (const [key, entry] of Object.entries<ProbeResult<ProbeRecord>>(probe().layers[name].charRanges)) {
      if (!entry.ok) {
        // Creation must fail on the py side too.
        raises(ValueError, () => _range_from_key(doc, key));
        continue;
      }
      const rng = _range_from_key(doc, key);
      for (const [es_attr, expected] of Object.entries(entry.value)) {
        const py_attr = dict_get(ATTR_MAP, es_attr);
        if (py_attr == null) continue;
        const mismatch = _compare(getattr(rng, py_attr), expected, es_attr);
        if (mismatch != null) mismatches.push(`[${key}] ${mismatch}`);
      }
    }
    py_assert(!py_bool(mismatches), `${name}:\n` + mismatches.join("\n"));
  });
});

/** Creation-time errors and zero-span semantics from the edge probes. */
describe("TestEdgeCases", () => {
  const _assert_edge = (doc: TextDocument, edge: ProbeResult<ProbeJson>, build: () => unknown): void => {
    if (edge.ok) {
      build();
      return;
    }
    let expected_message: string = edge.error;
    if (expected_message.startsWith(_AE_ERROR_PREFIX)) {
      expected_message = expected_message.slice(_AE_ERROR_PREFIX.length);
    }
    const exc = raises(ValueError, build);
    expect(exc.message).toBe(expected_message);
  };

  test("test_point_edges", () => {
    const doc = getitem(docs(), "RangesPoint");
    const edges = probe().layers.RangesPoint.edges;
    const length = len(doc.text);

    _assert_edge(doc, edges.eof_default_end, () => doc.characterRange(length));
    _assert_edge(doc, edges.neg_two_end, () => doc.characterRange(0, -2));
    _assert_edge(doc, edges.para_0_0, () => doc.paragraphRange(0, 0));
    _assert_edge(doc, edges.start_oob, () => doc.characterRange(9999));
    _assert_edge(doc, edges.end_oob, () => doc.characterRange(0, 9999));
    _assert_edge(doc, edges.end_before_start, () => doc.characterRange(5, 2));
    _assert_edge(doc, edges.para_oob, () => doc.paragraphRange(99));

    {
      const eof = edges.eof_zero_span.value;
      const rng = doc.characterRange(length, -1);
      expect(rng.characterStart).toBe(eof.s);
      expect(rng.characterEnd).toBe(eof.e);
      expect(rng.text).toBe(eof.text);
      expect(rng.fontSize).toBe(eof.fontSize);
    }

    {
      const zero = edges.char_0_0.value;
      const rng = doc.characterRange(0, 0);
      expect(rng.characterStart).toBe(zero.s);
      expect(rng.characterEnd).toBe(zero.e);
      expect(rng.text).toBe(zero.text);
    }

    {
      const neg = edges.line_neg_end.value;
      const clr = doc.composedLineRange(0, -1);
      expect(clr.characterStart).toBe(neg.s);
      expect(clr.characterEnd).toBe(neg.e);
    }
  });

  test("test_empty_edges", () => {
    const doc = getitem(docs(), "RangesEmpty");
    const edges = probe().layers.RangesEmpty.edges;
    _assert_edge(doc, edges.char_0_def, () => doc.characterRange(0));
    const para = edges.para_0.value;
    const pr = doc.paragraphRange(0);
    expect(pr.characterStart).toBe(para.s);
    expect(pr.characterEnd).toBe(para.e);
    const line = edges.line_0.value;
    const clr = doc.composedLineRange(0);
    expect(clr.characterStart).toBe(line.s);
    expect(clr.characterEnd).toBe(line.e);
  });

  test("test_split_surrogate", () => {
    const doc = getitem(docs(), "RangesEmoji");
    const edges = probe().layers.RangesEmoji.edges;
    const split_ = edges.split_surrogate_range.value;
    const rng = doc.characterRange(2, 3);
    expect(rng.characterStart).toBe(split_.s);
    expect(rng.characterEnd).toBe(split_.e);
    expect(rng.text).toBe(_expected_text(split_.text));
    expect(rng.fontSize).toBe(split_.fontSize);
    const prefix = edges.split_surrogate_text.value;
    expect(doc.characterRange(0, 3).text).toBe(_expected_text(prefix));
  });
});
