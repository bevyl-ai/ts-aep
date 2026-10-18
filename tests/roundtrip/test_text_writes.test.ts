/**
 * Byte-parity harness for the text-range write engine (phase W1).
 *
 * Each test replays one write operation from
 * `scripts/jsx/generate_text_write_samples.jsx` on a pristine base document
 * and compares py_aep's resulting btdk COS tree byte-for-byte against the
 * layer AE produced for the same operation in
 * `samples/models/text/text_writes.aep`. The `/PC` layout cache
 * (`doc["1"]["2"]`) is masked on both sides: AE recomposes it on apply,
 * py_aep must leave it untouched.
 */

import { describe, expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import { parseAppFresh } from "../helpers.ts";
import {
  AttributeError,
  dictGet,
  deepcopy,
  getattr,
  len,
  Path,
  pyAssert,
  pyEq,
  pyOr,
  range,
  repr,
  StopIteration,
  ValueError,
  zip,
} from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises, skip } from "../../src/pyrt/pytest.ts";
import { serialize } from "../../src/py_aep/cos/index.ts";
// noqa: F401 (documents the data source)
import { CosParser, type CosDict, type CosNode } from "../../src/py_aep/cos/cos.ts";
import {
  cosAt,
  cosContains,
  cosDict,
  cosGetOr,
  cosItem,
  cosIter,
  cosLen,
  cosPop,
} from "../../src/py_aep/cos/kinds.ts";
import type { Application } from "../../src/py_aep/models/application.ts";
import type { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import { AutoKernType, ParagraphJustification } from "../../src/py_aep/enums/index.ts";
import { _kernValues } from "../../src/py_aep/models/text/ranges.ts";
import { fontVersionString } from "../../src/py_aep/svg/fonts.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "text");
const FIXTURE = SAMPLES_DIR.div("text_writes.aep");
const PROBE = SAMPLES_DIR.div("text_writes_probe.json");
const FIXTURE2 = SAMPLES_DIR.div("text_writes2.aep");
const PROBE2 = SAMPLES_DIR.div("text_writes2_probe.json");
const FIXTURE3 = SAMPLES_DIR.div("text_writes3.aep");
const PROBE3 = SAMPLES_DIR.div("text_writes3_probe.json");

type ProbeJson = null | boolean | number | string | ProbeJson[] | { [key: string]: ProbeJson };
type TextWritesProbe = { ops: { [opName: string]: { perChar: { [esAttr: string]: ProbeJson }[] } } };

/** Module-scoped fixture: computed on first use, then cached for the file. */
function cached<T>(load: () => T): () => T {
  let value: T | undefined;
  return () => {
    if (value === undefined) value = load();
    return value;
  };
}

// The pytest fixtures below are module-scoped in the Python suite, so each is
// loaded at most once per file and shared between tests.
const getProbe = cached(() => JSON.parse(PROBE.readText("utf-8")));
const getFixtureApp = cached(() => parseAppFresh(FIXTURE));
const getProbe2 = cached(() => JSON.parse(PROBE2.readText("utf-8")));
const getFixture2App = cached(() => parseAppFresh(FIXTURE2));
const getProbe3 = cached(() => JSON.parse(PROBE3.readText("utf-8")));
const getFixture3App = cached(() => parseAppFresh(FIXTURE3));

function _docFor(app: Application, layerName: string): TextDocument {
  const comp = app.project.compositions[0];
  const layer = comp.textLayers.find((ly) => ly.name === layerName);
  if (layer === undefined) throw new StopIteration();
  const text = layer.text;
  pyAssert(text != null);
  return text.sourceText.value;
}

/**
 * A pristine single-run document (the fixture's untouched W_NOOP...
 *
 * ...layer is byte-equal to a freshly added text layer). Setting a
 * different base text goes through the py text setter, which collapses
 * runs exactly like AE's `addText` produces them.
 */
function _baseDoc(baseText: string | null = null): [Application, TextDocument] {
  const app = parseAppFresh(FIXTURE);
  const doc = _docFor(app, "W_NOOP");
  if (baseText != null) doc.text = baseText;
  return [app, doc];
}

function _cosPath(node: CosNode, ...keys: (string | number)[]): CosNode {
  return keys.reduce<CosNode>((cur, key) => (typeof key === "number" ? cosAt(cur, key) : cosItem(cur, key)), node);
}

function _maskedBytes(cosData: CosDict): Uint8Array {
  const clone = deepcopy(cosData);
  for (const doc of cosIter(pyOr(cosGetOr(cosGetOr(clone, "1", new Map<string, CosNode>()), "1", []), []))) {
    const page = cosDict(doc, "get").get("1");
    if (page instanceof Map) cosPop(page, "2");
  }
  return serialize(clone);
}

/** The F1 invariant: `_charStyle` must be the live first-run style. */
function _assertAliasIntegrity(doc: TextDocument): void {
  const first = _cosPath(doc._doc, "0", "6", "0", 0, "0", "0", "6");
  expect<CosNode>(doc._charStyle).toBe(first);
}

function _assertByteParity(pyDoc: TextDocument, fixtureApp: Application, opName: string): void {
  const expected = _docFor(fixtureApp, opName);
  pyAssert(
    pyEq(_maskedBytes(pyDoc._cosData), _maskedBytes(expected._cosData)),
    `${opName}: py-written btdk diverges from the AE fixture ` +
      `(outside the masked /PC cache)`,
  );
}

const PER_CHAR_MAP: Record<string, string> = {
  fontSize: "fontSize",
  applyFill: "applyFill",
  applyStroke: "applyStroke",
  justification: "justification",
  autoLeading: "autoLeading",
  fillColor: "fillColor",
  strokeColor: "strokeColor",
  leading: "leading",
  font: "font",
  kerning: "kerning",
  autoKernType: "autoKernType",
};

function _assertPerChar(pyDoc: TextDocument, probe: TextWritesProbe, opName: string, attrs: string[]): void {
  const expectedChars = probe["ops"][opName]["perChar"];
  const n = len(pyDoc.text);
  expect(n).toBe(expectedChars.length);
  for (const i of range(n)) {
    const rng = pyDoc.characterRange(i, i + 1);
    for (const esAttr of attrs) {
      const expected = expectedChars[i][esAttr];
      const actual = getattr(rng, PER_CHAR_MAP[esAttr]);
      if (expected === "<<undefined>>") {
        pyAssert(actual == null, `${opName}[${i}].${esAttr}: ${repr(actual)}`);
      } else if (Array.isArray(expected)) {
        pyAssert(
          approx(actual, expected, { abs: 1e-5 }),
          `${opName}[${i}].${esAttr}: expected ${repr(expected)}, got ${repr(actual)}`,
        );
      } else {
        pyAssert(
          pyEq(actual, expected),
          `${opName}[${i}].${esAttr}: expected ${repr(expected)}, got ${repr(actual)}`,
        );
      }
    }
  }
}

describe("TestScalarWrites", () => {
  test("test_split", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc();
    doc.characterRange(3, 7).fontSize = 72;
    _assertAliasIntegrity(doc);
    _assertByteParity(doc, fixtureApp, "W_SPLIT");
    _assertPerChar(doc, probe, "W_SPLIT", ["fontSize"]);
  });

  test("test_adjacent_equal_writes_merge", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc();
    doc.characterRange(0, 5).fontSize = 72;
    doc.characterRange(5, 10).fontSize = 72;
    _assertAliasIntegrity(doc);
    // AE coalesced this into a single run covering the terminator.
    expect(cosLen(_cosPath(doc._doc, "0", "6", "0"))).toBe(1);
    _assertByteParity(doc, fixtureApp, "W_MERGE_SAME");
    _assertPerChar(doc, probe, "W_MERGE_SAME", ["fontSize"]);
  });

  test("test_noop_write_keeps_structure", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc();
    doc.characterRange(2, 8).fontSize = 36;
    _assertAliasIntegrity(doc);
    expect(cosLen(_cosPath(doc._doc, "0", "6", "0"))).toBe(1);
    _assertByteParity(doc, fixtureApp, "W_NOOP");
  });

  test("test_overlapping_equal_writes", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc();
    doc.characterRange(0, 5).fontSize = 72;
    doc.characterRange(3, 8).fontSize = 72;
    _assertAliasIntegrity(doc);
    _assertByteParity(doc, fixtureApp, "W_PARTIAL_EQ");
    _assertPerChar(doc, probe, "W_PARTIAL_EQ", ["fontSize"]);
  });

  test("test_bool_write", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc();
    doc.characterRange(2, 6).applyFill = false;
    _assertAliasIntegrity(doc);
    _assertByteParity(doc, fixtureApp, "W_FILL_UNAPPLY");
    _assertPerChar(doc, probe, "W_FILL_UNAPPLY", ["applyFill"]);
  });

  test("test_zero_span_write_is_noop", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc();
    doc.characterRange(3, 3).fontSize = 90;
    _assertByteParity(doc, fixtureApp, "W_ZERO_STYLE");
  });

  test("test_validation", () => {
    const [_app, doc] = _baseDoc();
    raises(ValueError, () => {
      doc.characterRange(0, 5).fontSize = 0;
    });
    // Python raises AttributeError on assignment to a getter-only property;
    // strict-mode JS throws TypeError instead, so map it back.
    raises(AttributeError, () => {
      try {
        // @ts-expect-error font_object is read-only; the test checks the runtime refusal
        doc.characterRange(0, 5).fontObject = null;
      } catch (e) {
        if (e instanceof TypeError) throw new AttributeError(e.message);
        throw e;
      }
    });
  });
});

describe("TestColorFontLeadingWrites", () => {
  test("test_stroke_color_does_not_flip_gate", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc();
    doc.characterRange(2, 6).strokeColor = [0, 1, 0];
    _assertByteParity(doc, fixtureApp, "W_STROKE_GATE");
    // AE leaves applyStroke off, so the gated read stays undefined.
    _assertPerChar(doc, probe, "W_STROKE_GATE", ["strokeColor", "applyStroke"]);
  });

  test("test_leading_disables_auto_leading", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc();
    doc.characterRange(1, 4).leading = 50;
    _assertByteParity(doc, fixtureApp, "W_LEAD");
    _assertPerChar(doc, probe, "W_LEAD", ["leading", "autoLeading"]);
  });

  test("test_font_prepends_and_reindexes", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    // The fixture embeds the version string AE resolved from the
    // host font; byte parity only holds where that font matches.
    const expected = _docFor(fixtureApp, "W_FONT");
    const fixtureVersion = dictGet(cosDict(_cosPath(expected._cosData, "0", "1", "0", 0, "0", "0"), "get"), "5");
    if (!pyEq(fontVersionString("Arial-BoldMT"), fixtureVersion)) {
      return skip("Arial-BoldMT not installed at the fixture's version");
    }
    const [_app, doc] = _baseDoc();
    doc.characterRange(3, 7).font = "Arial-BoldMT";
    expect(doc._fonts.map((f) => f.postScriptName)[0]).toBe("Arial-BoldMT");
    _assertByteParity(doc, fixtureApp, "W_FONT");
    _assertPerChar(doc, probe, "W_FONT", ["font"]);
  });

  test("test_existing_font_reuses_index", () => {
    const [_app, doc] = _baseDoc();
    const before = doc._fonts.map((f) => f.postScriptName);
    doc.characterRange(3, 7).font = before[0];
    expect(pyEq(doc._fonts.map((f) => f.postScriptName), before)).toBe(true);
  });

  test("test_fill_color_write_and_clear", () => {
    const [_app, doc] = _baseDoc();
    doc.characterRange(2, 6).fillColor = [1, 0, 0];
    expect(approx(doc.characterRange(2, 6).fillColor, [1.0, 0.0, 0.0])).toBe(true);
    const otherFill = doc.characterRange(0, 2).fillColor;
    // `None != approx(...)` is True in Python; pyrt approx cannot take null.
    expect(otherFill != null && approx(otherFill, [1.0, 0.0, 0.0])).toBe(false);
    doc.characterRange(2, 6).fillColor = null;
    // Cleared paint: the gated read has applyFill runs but no color.
    expect(doc.characterRange(2, 6).fillColor == null).toBe(true);
  });
});

describe("TestKerningWrites", () => {
  test("test_kern_mid_pair_shift", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc("AVAWAYAVAW");
    doc.characterRange(2, 5).kerning = 150;
    _assertByteParity(doc, fixtureApp, "W_KERN_MID");
    _assertPerChar(doc, probe, "W_KERN_MID", ["kerning", "autoKernType"]);
  });

  test("test_kern_at_start_writes_leading_edge", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc("AVAWAYAVAW");
    doc.characterRange(0, 2).kerning = 150;
    expect(_cosPath(doc._doc, "0", "7")).toBe(150);
    expect(doc.kerning).toBe(150);
    _assertByteParity(doc, fixtureApp, "W_KERN_START");
    _assertPerChar(doc, probe, "W_KERN_START", ["kerning", "autoKernType"]);
  });

  test("test_document_kerning_reads_leading_edge", () => {
    const fixtureApp = getFixtureApp();
    expect(_docFor(fixtureApp, "W_KERN_START").kerning).toBe(150);
    expect(_docFor(fixtureApp, "W_KERN_MID").kerning).toBe(0);
  });

  test("test_auto_kern_type_clears_values", () => {
    const fixture2App = getFixture2App();
    const probe2 = getProbe2();

    const [_app, doc] = _baseDoc("AVAWAYAV");
    doc.characterRange(1, 4).kerning = 200;
    doc.characterRange(0, -1).autoKernType = AutoKernType.METRIC_KERN;
    expect(cosContains(_cosPath(doc._doc, "0"), "8")).toBe(false);
    _assertByteParity(doc, fixture2App, "X_AKT_SET");
    _assertPerChar(doc, probe2, "X_AKT_SET", ["kerning", "autoKernType"]);
  });

  test("test_auto_leading_resets_explicit_leading", () => {
    const fixture2App = getFixture2App();
    const probe2 = getProbe2();
    const [_app, doc] = _baseDoc("abcdefgh");
    doc.characterRange(1, 4).leading = 50;
    doc.characterRange(0, -1).autoLeading = true;
    // AE merges back to a single run with the leading sentinel.
    expect(cosLen(_cosPath(doc._doc, "0", "6", "0"))).toBe(1);
    _assertByteParity(doc, fixture2App, "X_AL_SET");
    _assertPerChar(doc, probe2, "X_AL_SET", ["leading", "autoLeading"]);
  });
});

describe("TestParagraphWrites", () => {
  test("test_partial_range_styles_whole_paragraph", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc("Left one\nRight two");
    doc.characterRange(2, 5).justification = ParagraphJustification.RIGHT_JUSTIFY;
    _assertByteParity(doc, fixtureApp, "W_PARA_PARTIAL");
    _assertPerChar(doc, probe, "W_PARA_PARTIAL", ["justification"]);
  });
});

describe("TestTextReplacement", () => {
  const _styledBase = (): [Application, TextDocument] => {
    const [app, doc] = _baseDoc();
    doc.characterRange(0, 5).fillColor = [1, 0, 0];
    doc.characterRange(0, 5).fontSize = 72;
    return [app, doc];
  };

  test("test_replace_shorter", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _styledBase();
    const rng = doc.characterRange(3, 7);
    rng.text = "XY";
    // The range keeps its creation indices against the new text.
    expect(rng.text).toBe("XYhi");
    _assertByteParity(doc, fixtureApp, "W_TEXT_SHORTER");
    _assertPerChar(doc, probe, "W_TEXT_SHORTER", ["fontSize", "fillColor"]);
  });

  test("test_replace_longer", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _styledBase();
    const rng = doc.characterRange(3, 5);
    rng.text = "LONGERBIT";
    expect(rng.text).toBe("LO");
    _assertByteParity(doc, fixtureApp, "W_TEXT_LONGER");
    _assertPerChar(doc, probe, "W_TEXT_LONGER", ["fontSize", "fillColor"]);
  });

  test("test_replace_adds_paragraph", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _styledBase();
    doc.characterRange(3, 5).text = "A\nB";
    expect(doc.paragraphCount).toBe(2);
    _assertByteParity(doc, fixtureApp, "W_TEXT_ADDPARA");
  });

  test("test_zero_span_insert", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _styledBase();
    const rng = doc.characterRange(4, 4);
    rng.text = "ins";
    expect(rng.text).toBe("");
    expect(doc.text).toBe("abcdinsefghij");
    _assertByteParity(doc, fixtureApp, "W_TEXT_INSERT");
    _assertPerChar(doc, probe, "W_TEXT_INSERT", ["fontSize", "fillColor"]);
  });

  test("test_replace_at_visible_end", () => {
    const fixture2App = getFixture2App();
    const probe2 = getProbe2();
    const [_app, doc] = _baseDoc();
    doc.characterRange(0, 4).fontSize = 72;
    doc.characterRange(6, 10).text = "ZZ";
    expect(doc.text).toBe("abcdefZZ");
    _assertByteParity(doc, fixture2App, "X_TEXT_END");
    _assertPerChar(doc, probe2, "X_TEXT_END", ["fontSize"]);
  });

  test("test_replace_splices_kern_values", () => {
    const fixture2App = getFixture2App();
    const probe2 = getProbe2();
    const [_app, doc] = _baseDoc("AVAWAYAV");
    doc.characterRange(1, 4).kerning = 200;
    doc.characterRange(2, 5).text = "xy";
    expect(doc.text).toBe("AVxyYAV");
    _assertByteParity(doc, fixture2App, "X_TEXT_KERN");
    _assertPerChar(doc, probe2, "X_TEXT_KERN", ["kerning", "autoKernType"]);
  });
});

describe("TestPasteFrom", () => {
  test("test_paste_same_document", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc();
    const src = doc.characterRange(0, 3);
    src.fillColor = [1, 0, 0];
    src.fontSize = 72;
    doc.characterRange(6, 9).pasteFrom(doc.characterRange(0, 3));
    _assertByteParity(doc, fixtureApp, "W_PASTE_SAME");
    _assertPerChar(doc, probe, "W_PASTE_SAME", ["fontSize", "fillColor"]);
  });

  test("test_paste_cross_document_remaps_fonts", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [app, doc] = _baseDoc();
    const srcDoc = _docFor(app, "W_SPLIT");
    srcDoc.text = "QQQQ";
    const srcAll = srcDoc.characterRange(0, -1);
    srcAll.font = "Arial-BoldMT";
    srcAll.fontSize = 90;
    doc.characterRange(2, 6).pasteFrom(srcDoc.characterRange(0, 4));
    expect(doc.text).toBe("abQQQQghij");
    _assertPerChar(doc, probe, "W_PASTE_XDOC", ["fontSize", "font"]);
  });

  test("test_paste_shorter_invalidates_target", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [app, doc] = _baseDoc();
    const srcDoc = _docFor(app, "W_SPLIT");
    srcDoc.text = "QQQQ";
    const srcAll = srcDoc.characterRange(0, -1);
    srcAll.font = "Arial-BoldMT";
    srcAll.fontSize = 90;
    const target = doc.characterRange(2, 9);
    target.pasteFrom(srcDoc.characterRange(0, 2));
    expect(doc.text).toBe("abQQj");
    expect(target.isRangeValid).toBe(false);
    raises(ValueError, () => {
      const _ = target.text;
    });
  });

  test("test_paste_transplants_kern_values", () => {
    const fixture2App = getFixture2App();
    const probe2 = getProbe2();
    const [app, doc] = _baseDoc("abcdefgh");
    const srcDoc = _docFor(app, "W_SPLIT");
    srcDoc.text = "AVAV";
    srcDoc.characterRange(1, 3).kerning = 150;
    doc.characterRange(2, 6).pasteFrom(srcDoc.characterRange(0, 4));
    expect(doc.text).toBe("abAVAVgh");
    _assertByteParity(doc, fixture2App, "X_PASTE_KERN");
    _assertPerChar(doc, probe2, "X_PASTE_KERN", ["kerning", "autoKernType"]);
  });

  test("test_transplanted_styles_differ_only_in_font_index", () => {
    const fixtureApp = getFixtureApp();
    // W5 entry gate: the only doc-level index a transplanted style
    // carries is the font reference (key "0").
    const pasted = _docFor(fixtureApp, "W_PASTE_XDOC");
    const source = _docFor(fixtureApp, "PasteSrc");
    const pastedStyle = cosDict(_cosPath(pasted._doc, "0", "6", "0", 1, "0", "0", "6"), "get");
    const sourceStyle = cosDict(_cosPath(source._doc, "0", "6", "0", 0, "0", "0", "6"), "get");
    const keys = new Set<string>([...pastedStyle.keys(), ...sourceStyle.keys()]);
    const diffKeys = new Set(
      [...keys].filter((k) => !pyEq(dictGet(pastedStyle, k), dictGet(sourceStyle, k))),
    );
    expect([...diffKeys].every((k) => k === "0")).toBe(true);
  });
});

describe("TestPasteLeadingEdgeKern", () => {
  const _edgeSource = (app: Application) => {
    const srcDoc = _docFor(app, "W_SPLIT");
    srcDoc.text = "AVAV";
    srcDoc.characterRange(0, 2).kerning = 140;
    return srcDoc;
  };

  test("test_paste_at_zero_keeps_leading_edge", () => {
    const fixture3App = getFixture3App();
    const probe3 = getProbe3();
    const [app, doc] = _baseDoc("abcdef");
    doc.characterRange(0, 3).pasteFrom(_edgeSource(app).characterRange(0, 3));
    expect(_cosPath(doc._doc, "0", "7")).toBe(140);
    expect(doc.kerning).toBe(140);
    _assertByteParity(doc, fixture3App, "Y_PASTE_EDGE0");
    const expected = probe3["ops"]["Y_PASTE_EDGE0"]["kernPerChar"].map((e: { value: ProbeJson }) => e["value"]);
    const actual = [...range(len(expected))].map((i) => [
      doc.characterRange(i, i + 1).kerning,
      doc.characterRange(i, i + 1).autoKernType,
    ]);
    for (const [got, exp] of zip(actual, expected)) {
      expect(got[0] ?? "<<undefined>>").toBe(exp[0]);
      expect(got[1]).toBe(exp[1]);
    }
  });

  test("test_paste_mid_maps_edge_to_preceding_pair", () => {
    const fixture3App = getFixture3App();
    const probe3 = getProbe3();
    const [app, doc] = _baseDoc("abcdef");
    doc.characterRange(2, 5).pasteFrom(_edgeSource(app).characterRange(0, 3));
    expect(cosContains(_cosPath(doc._doc, "0"), "7")).toBe(false);
    // The edge value lands on the pair before the paste (char 1) with
    // NO auto-kern flag change - ES reads it as undefined through the
    // flag, but the binary carries it (probed Y_PASTE_EDGE_MID). AE
    // merges that value run with its equal neighbor; py emits length-1
    // runs - value-identical, so compare decoded values, not bytes.

    expect(pyEq(_kernValues(doc).slice(0, 5), [null, 140, 140, 140, null])).toBe(true);
    const expected = probe3["ops"]["Y_PASTE_EDGE_MID"]["kernPerChar"].map((e: { value: ProbeJson }) => e["value"]);
    const actual = [...range(len(expected))].map((i) => [
      doc.characterRange(i, i + 1).kerning,
      doc.characterRange(i, i + 1).autoKernType,
    ]);
    for (const [got, exp] of zip(actual, expected)) {
      expect(got[0] ?? "<<undefined>>").toBe(exp[0]);
      expect(got[1]).toBe(exp[1]);
    }
  });
});

/** ES TextDocument getters read the FIRST CHARACTER's style on mixed
 * documents (probed Y_DOCREADS) - py's first-run getters match. */
describe("TestDocumentLevelReads", () => {
  test("test_mixed_document_reads_first_character", () => {
    const fixture3App = getFixture3App();
    const probe3 = getProbe3();
    const doc = _docFor(fixture3App, "Y_DOCREADS");
    const expected = probe3["ops"]["Y_DOCREADS"]["docLevel"];
    expect(doc.fontSize).toBe(expected["fontSize"]);
    expect(approx(doc.fillColor, expected["fillColor"], { abs: 1e-5 })).toBe(true);
    expect(doc.font).toBe(expected["font"]);
    expect(doc.fauxBold).toBe(expected["fauxBold"]);
    expect(doc.applyStroke).toBe(expected["applyStroke"]);
    expect(doc.tracking).toBe(expected["tracking"]);
    expect(doc.kerning).toBe(expected["kerning"]);
    expect(doc.autoLeading).toBe(expected["autoLeading"]);
    expect(approx(doc.leading, expected["leading"], { abs: 1e-4 })).toBe(true);
  });

  test("test_leading_reads_first_character_auto_value", () => {
    const fixture3App = getFixture3App();
    const probe3 = getProbe3();
    const doc = _docFor(fixture3App, "Y_DOCREAD_LEAD");
    const expected = probe3["ops"]["Y_DOCREAD_LEAD"];
    expect(approx(doc.leading, expected["leading"]["value"], { abs: 1e-4 })).toBe(true);
    expect(doc.autoLeading).toBe(expected["autoLeading"]["value"]);
  });
});

describe("TestSurrogateWrites", () => {
  test("test_mid_pair_write_expands", () => {
    // Value parity only: AE materialized an emoji fallback font into
    // the font array at composition, which py cannot reproduce.
    const probe = getProbe();
    const [_app, doc] = _baseDoc("ab\u{1F600}cd");
    doc.characterRange(2, 3).fontSize = 72;
    // Per UTF-16 unit, like the ExtendScript probe (the emoji is 2 units).
    const expected = probe["ops"]["W_SURROGATE_STYLE"]["perChar"].map((c: { fontSize: ProbeJson }) => c["fontSize"]);
    const actual = [...range(len(expected))].map((i) => doc.characterRange(i, i + 1).fontSize);
    expect(pyEq(actual, expected)).toBe(true);
  });
});

describe("TestDocumentWideWrites", () => {
  test("test_cosfield_setter_collapses_runs", () => {
    const fixtureApp = getFixtureApp();
    const probe = getProbe();
    const [_app, doc] = _baseDoc();
    doc.characterRange(0, 5).fontSize = 72;
    doc.fontSize = 50;
    expect(cosLen(_cosPath(doc._doc, "0", "6", "0"))).toBe(1);
    _assertByteParity(doc, fixtureApp, "W_DOCLEVEL");
    _assertPerChar(doc, probe, "W_DOCLEVEL", ["fontSize"]);
  });

  test("test_custom_setter_styles_all_runs", () => {
    const fixture2App = getFixture2App();
    const probe2 = getProbe2();
    const [_app, doc] = _baseDoc("abcdefgh");
    doc.characterRange(0, 4).fontSize = 72;
    doc.fillColor = [0, 0, 1];
    _assertByteParity(doc, fixture2App, "X_DOC_FILL");
    _assertPerChar(doc, probe2, "X_DOC_FILL", ["fillColor", "fontSize"]);
  });

  test("test_paragraph_setter_styles_all_paragraphs", () => {
    const fixture2App = getFixture2App();
    const probe2 = getProbe2();
    const [_app, doc] = _baseDoc("One two\nThree four");
    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    _assertByteParity(doc, fixture2App, "X_DOC_JUST");
    _assertPerChar(doc, probe2, "X_DOC_JUST", ["justification"]);
  });

  test("test_auto_leading_resets_sentinel_document_wide", () => {
    const [_app, doc] = _baseDoc();
    doc.characterRange(1, 4).leading = 50;
    doc.autoLeading = true;
    expect(cosLen(_cosPath(doc._doc, "0", "6", "0"))).toBe(1);
    expect(pyEq(cosItem(doc._charStyle, "5"), 0.01)).toBe(true);
  });
});

describe("TestRoundTripAfterWrite", () => {
  test("test_mutated_save_is_idempotent", () => {
    const tmpPath = makeTmpPath();
    const [app, doc] = _baseDoc();
    doc.characterRange(3, 7).fontSize = 72;
    const first = tmpPath.div("first.aep");
    app.project.save(first);
    const app2 = parseAppFresh(first);
    const second = tmpPath.div("second.aep");
    app2.project.save(second);
    expect(pyEq(first.readBytes(), second.readBytes())).toBe(true);
  });

  test("test_document_getter_tracks_first_run_after_writes", () => {
    // After splits and merges, document-level getters (which alias the
    // first run's style dict) must keep reading char 0's actual style.
    const [_app, doc] = _baseDoc();
    doc.characterRange(3, 7).fontSize = 72;
    expect(doc.fontSize).toBe(36.0);
    doc.characterRange(0, 3).fontSize = 72;
    expect(doc.fontSize).toBe(72.0);
  });
});
