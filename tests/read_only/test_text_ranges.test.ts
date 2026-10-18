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
import { Path, ValueError, at, getOr, fspath, getMember, getOrThrow, int, len, lruCache, assert, truthy, valueEquals, repr, str } from "../../src/pyrt/index.ts";

import { parseProject } from "../helpers.ts";
import type { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import { approx, raises } from "../support/pytest.ts";
import { split } from "../support/python.ts";

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

function _loadProbe() {
  return JSON.parse(fs.readFileSync(fspath(PROBE), "utf-8"));
}

/** ES text -> py text: CR becomes LF, marker escapes become chars.
 *
 * The probe writer replaces lone surrogates with `<U+XXXX>` markers
 * (a raw lone surrogate kills ExtendScript's File.write); decode them
 * back to compare against py_aep's surrogatepass slicing.
 */
function _expectedText(value: string): string {
  const decoded = value.replace(_MARKER_RE, (_m: string, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  return decoded.replaceAll("\r", "\n");
}

/** Build the CharacterRange a probe dict key describes (e.g. `0_-1`). */
function _rangeFromKey(doc: TextDocument, key: string) {
  const i = key.lastIndexOf("_");
  const startS = key.slice(0, i);
  const endS = key.slice(i + 1);
  const start = int(startS);
  if (endS === "def") return doc.characterRange(start);
  return doc.characterRange(start, int(endS));
}

/** Return a mismatch description, or `null` when values agree. */
function _compare(pyVal: unknown, expected: ProbeJson, attr: string): string | null {
  if (expected === "<<undefined>>") {
    if (pyVal == null) return null;
    return `${attr}: expected None (ES undefined), got ${repr(pyVal)}`;
  }
  if (attr === "fontObject") {
    const expectedName = typeof expected === "string" ? at(split(expected, ":", 1), 1) : null;
    const actualName = pyVal != null ? getMember(pyVal, "postScriptName") : null;
    if (valueEquals(actualName, expectedName)) return null;
    return `${attr}: expected ${repr(expectedName)}, got ${repr(actualName)}`;
  }
  if (attr === "text") {
    assert(typeof expected === "string");
    expected = _expectedText(expected);
    if (valueEquals(pyVal, expected)) return null;
    return `${attr}: expected ${repr(expected)}, got ${repr(pyVal)}`;
  }
  if (Array.isArray(expected)) {
    if (pyVal != null && approx(pyVal, expected, { abs: 1e-5 })) return null;
    return `${attr}: expected ${repr(expected)}, got ${repr(pyVal)}`;
  }
  // NOTE(port): JS has one number type so this also takes ints; approx(abs=1e-5) agrees with py_eq on integers.
  if (typeof expected === "number" || typeof pyVal === "number") {
    if (pyVal != null && approx(pyVal, expected, { abs: 1e-5 })) return null;
    return `${attr}: expected ${repr(expected)}, got ${repr(pyVal)}`;
  }
  // bools, ints, IntEnums (IntEnum == int holds for ExtendScript values)
  if (valueEquals(pyVal, expected)) return null;
  return `${attr}: expected ${repr(expected)}, got ${repr(pyVal)}`;
}

/** Python repr of a JSON-decoded value (dict/list/scalars). */
function _dictRepr(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(_dictRepr).join(", ")}]`;
  if (v != null && typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${repr(k)}: ${_dictRepr(x)}`).join(", ")}}`;
  }
  return repr(v);
}

/** Python dict equality: py_eq cannot compare plain records, so lift them to Maps. */
function _asDict(d: object) {
  return d instanceof Map ? d : new Map(Object.entries(d));
}

// Module-scoped fixtures from the Python file, as lazily cached module state.
const probe = lruCache(_loadProbe);

const docs = lruCache((): Map<string, TextDocument> => {
  // NOTE(port): parse_project is synchronous in the TS helpers, as in Python.
  const project = parseProject(SAMPLE);
  const comp = project.compositions[0];
  return new Map(
    comp.textLayers.map((layer): [string, TextDocument] => {
      const text = layer.text;
      assert(text != null);
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
    expect(getOrThrow(docs(), name).text).toBe(_expectedText(expected.text));
  });

  test.each(LAYER_NAMES)("test_paragraph_count[%#]", (name: string) => {
    const expected = probe().layers[name].paragraphCount;
    if (expected.ok) {
      expect(getOrThrow(docs(), name).paragraphCount).toBe(expected.value);
    }
  });

  test.each(LAYER_NAMES)("test_composed_line_count[%#]", (name: string) => {
    const expected = probe().layers[name].composedLineCount;
    if (expected.ok) {
      expect(getOrThrow(docs(), name).composedLineCount).toBe(expected.value);
    }
  });

  test("test_document_kerning_reads_zero", () => {
    // ExtendScript exports kerning=0 on every TextDocument value object,
    // even with manual per-character kerning present; the real values
    // are only reachable through character_range(...).kerning.
    expect(getOrThrow(docs(), "RangesKernLead").kerning).toBe(0);
    expect(getOrThrow(docs(), "RangesKernLead").characterRange(1, 4).kerning).toBe(200);
  });
});

/** Paragraph / composed-line boundary and index-lookup parity. */
describe("TestRangeBoundaries", () => {
  test.each(LAYER_NAMES)("test_paragraph_ranges[%#]", (name: string) => {
    const doc = getOrThrow(docs(), name);
    for (const entry of probe().layers[name].paragraphRanges) {
      assert(entry.ok, `${name}: ES probe failed: ${_dictRepr(entry)}`);
      const exp = entry.value;
      const pr = doc.paragraphRange(exp.index);
      expect(str(pr)).toBe(exp.str);
      expect(pr.characterStart).toBe(exp.characterStart);
      expect(pr.characterEnd).toBe(exp.characterEnd);
      expect(pr.isRangeValid).toBe(exp.isRangeValid);
      expect(pr.characterRange().text).toBe(_expectedText(exp.charRangeText));
    }
  });

  test.each(LAYER_NAMES)("test_composed_line_ranges[%#]", (name: string) => {
    const doc = getOrThrow(docs(), name);
    for (const entry of probe().layers[name].composedLineRanges) {
      assert(entry.ok, `${name}: ES probe failed: ${_dictRepr(entry)}`);
      const exp = entry.value;
      const clr = doc.composedLineRange(exp.index);
      expect(str(clr)).toBe(exp.str);
      expect(clr.characterStart).toBe(exp.characterStart);
      expect(clr.characterEnd).toBe(exp.characterEnd);
      expect(clr.isRangeValid).toBe(exp.isRangeValid);
      expect(clr.characterRange().text).toBe(_expectedText(exp.charRangeText));
    }
  });

  test.each(LAYER_NAMES)("test_character_indexes_at[%#]", (name: string) => {
    const doc = getOrThrow(docs(), name);
    const layerProbe = probe().layers[name];
    // NOTE(port): Object.entries orders integer-like keys ascending; the probe JSON keys are already in ascending order.
    for (const [idxS, entry] of Object.entries<ProbeResult<ProbeRecord>>(layerProbe.paragraphCharacterIndexesAt)) {
      if (entry.ok) {
        expect(
          valueEquals(_asDict(doc.paragraphCharacterIndexesAt(int(idxS))), _asDict(entry.value)),
        ).toBe(true);
      }
    }
    for (const [idxS, entry] of Object.entries<ProbeResult<ProbeRecord>>(layerProbe.composedLineCharacterIndexesAt)) {
      if (entry.ok) {
        expect(
          valueEquals(_asDict(doc.composedLineCharacterIndexesAt(int(idxS))), _asDict(entry.value)),
        ).toBe(true);
      }
    }
  });
});

/** Every probed attribute of every probed range, against ES values. */
describe("TestCharacterRangeAttributes", () => {
  test.each(LAYER_NAMES)("test_attribute_parity[%#]", (name: string) => {
    const doc = getOrThrow(docs(), name);
    const mismatches: string[] = [];
    for (const [key, entry] of Object.entries<ProbeResult<ProbeRecord>>(probe().layers[name].charRanges)) {
      if (!entry.ok) {
        // Creation must fail on the py side too.
        raises(ValueError, () => _rangeFromKey(doc, key));
        continue;
      }
      const rng = _rangeFromKey(doc, key);
      for (const [esAttr, expected] of Object.entries(entry.value)) {
        const pyAttr = getOr(ATTR_MAP, esAttr);
        if (pyAttr == null) continue;
        const mismatch = _compare(getMember(rng, pyAttr), expected, esAttr);
        if (mismatch != null) mismatches.push(`[${key}] ${mismatch}`);
      }
    }
    assert(!truthy(mismatches), `${name}:\n` + mismatches.join("\n"));
  });
});

/** Creation-time errors and zero-span semantics from the edge probes. */
describe("TestEdgeCases", () => {
  const _assertEdge = (doc: TextDocument, edge: ProbeResult<ProbeJson>, build: () => unknown): void => {
    if (edge.ok) {
      build();
      return;
    }
    let expectedMessage: string = edge.error;
    if (expectedMessage.startsWith(_AE_ERROR_PREFIX)) {
      expectedMessage = expectedMessage.slice(_AE_ERROR_PREFIX.length);
    }
    const exc = raises(ValueError, build);
    expect(exc.message).toBe(expectedMessage);
  };

  test("test_point_edges", () => {
    const doc = getOrThrow(docs(), "RangesPoint");
    const edges = probe().layers.RangesPoint.edges;
    const length = len(doc.text);

    _assertEdge(doc, edges.eof_default_end, () => doc.characterRange(length));
    _assertEdge(doc, edges.neg_two_end, () => doc.characterRange(0, -2));
    _assertEdge(doc, edges.para_0_0, () => doc.paragraphRange(0, 0));
    _assertEdge(doc, edges.start_oob, () => doc.characterRange(9999));
    _assertEdge(doc, edges.end_oob, () => doc.characterRange(0, 9999));
    _assertEdge(doc, edges.end_before_start, () => doc.characterRange(5, 2));
    _assertEdge(doc, edges.para_oob, () => doc.paragraphRange(99));

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
    const doc = getOrThrow(docs(), "RangesEmpty");
    const edges = probe().layers.RangesEmpty.edges;
    _assertEdge(doc, edges.char_0_def, () => doc.characterRange(0));
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
    const doc = getOrThrow(docs(), "RangesEmoji");
    const edges = probe().layers.RangesEmoji.edges;
    const split_ = edges.split_surrogate_range.value;
    const rng = doc.characterRange(2, 3);
    expect(rng.characterStart).toBe(split_.s);
    expect(rng.characterEnd).toBe(split_.e);
    expect(rng.text).toBe(_expectedText(split_.text));
    expect(rng.fontSize).toBe(split_.fontSize);
    const prefix = edges.split_surrogate_text.value;
    expect(doc.characterRange(0, 3).text).toBe(_expectedText(prefix));
  });
});
