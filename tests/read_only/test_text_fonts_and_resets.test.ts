/**
 * Tests for the font/baseline/reset text APIs against AE 2026 ground truth.
 *
 * Every expectation here is a value After Effects itself reported via
 * ExtendScript (2026-07-15 probe run); the `*_probe.json` files next to the
 * samples are those dumps, and the `*_after.aep` files are AE's own output for
 * the same operation.
 */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. Test classes with helper methods are kept as classes
// and instantiated once per describe block (`self`); class attributes become
// statics.

import { describe, expect, test } from "bun:test";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import {
  AssertionError_,
  dictGet,
  float,
  getattr,
  len,
  Path,
  pyAssert,
  pyEq,
  pyOr,
  sorted,
  StopIteration,
  ValueError,
  zip,
  mod,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { parseProject } from "../conftest.ts";
import { parseProjectFresh } from "../helpers.ts";
import { AutoKernType } from "../../src/py_aep/enums/index.ts";
import { TextLayer } from "../../src/py_aep/models/layers/index.ts";
import { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import { _charRunSpans } from "../../src/py_aep/models/text/ranges.ts";
import { cosGet, type CosNode } from "../../src/py_aep/cos/cos.ts";
import type { Project } from "../../src/py_aep/models/project.ts";

// Path(__file__).parent x3 is the TS root (this file lives in tests/read_only).
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "text");
const BASELINES_AEP = SAMPLES_DIR.div("baseline_locs.aep");
const REPLACE_FONT_AEP = SAMPLES_DIR.div("replace_font.aep");
const REPLACE_FONT_AFTER_AEP = SAMPLES_DIR.div("replace_font_after.aep");
const RESET_AEP = SAMPLES_DIR.div("reset_style.aep");

// AE reports an empty line's start/end as the maximum 32-bit float.
const FLT_MAX = 3.4028234663852886e38;

type UsedFontRecord = { font: { postScriptName: string }; usedAt: { layerID: number; layerTimeD: number }[] };

function _fixture(name: string) {
  return JSON.parse(SAMPLES_DIR.div(name).read_text());
}

function _doc(project: Project, compName: string, layerName: string): TextDocument {
  const comp = project.compositions.find((c) => c.name === compName);
  if (comp === undefined) throw new StopIteration();
  const layer = comp.layers.find((ly) => ly.name === layerName);
  if (layer === undefined) throw new StopIteration();
  pyAssert(layer instanceof TextLayer);
  const text = layer.text;
  if (text == null) throw new AssertionError_(`text layer ${layerName} has no text properties`);
  return text.property("ADBE Text Document").value;
}

describe("TestBaselineLocs", () => {
  /** TextDocument.baselineLocs vs AE's own baselineLocs dump. */
  test.each(["text_point", "text_box", "text_animated"])("test_matches_ae[%#]", (layerName: string) => {
    const expected: number[] = _fixture("baseline_locs_probe.json")[layerName].baselineLocs.value;
    const got = _doc(parseProject(BASELINES_AEP), "PROBE_MAIN", layerName).baselineLocs;
    expect(len(got)).toBe(len(expected));
    for (const [g, w] of zip(got, expected)) {
      if (w > 1e38) {
        // empty-line sentinel
        expect(approx(g, FLT_MAX)).toBe(true);
      } else {
        expect(approx(g, w, { abs: 5e-3 })).toBe(true);
      }
    }
  });

  test("test_empty_line_is_float_max", () => {
    // "Hello\rWorld line two\r\rAfter empty": the third line is empty.
    const locs = _doc(parseProject(BASELINES_AEP), "PROBE_MAIN", "text_point").baselineLocs;
    expect(pyEq(locs.slice(8, 12), Array(4).fill(FLT_MAX))).toBe(true);
  });

  test("test_box_text_offset_by_box_pos", () => {
    // A box's cached origins are box-relative; layer coordinates add
    // box_text_pos (AE: -110/-70 for a centered 220x140 box).
    const doc = _doc(parseProject(BASELINES_AEP), "PROBE_MAIN", "text_box");
    expect(pyEq(doc.boxTextPos, [-110.0, -70.0])).toBe(true);
    expect(approx(doc.baselineLocs[0], -110.0)).toBe(true);
  });

  test("test_four_floats_per_composed_line", () => {
    const doc = _doc(parseProject(BASELINES_AEP), "PROBE_MAIN", "text_box");
    expect(len(doc.baselineLocs)).toBe(4 * pyOr(doc.composedLineCount, 0));
  });

  test("test_detached_document_is_empty", () => {
    expect(pyEq(new TextDocument("hi").baselineLocs, [])).toBe(true);
  });
});

class TestUsedFonts {
  _snapshot(project: Project) {
    return project.usedFonts.map((entry) => [
      entry.font.postScriptName,
      entry.used_at.map((u) => [u.layer_id, u.layer_time]),
    ]);
  }

  _expected(records: UsedFontRecord[]) {
    return records.map((rec) => [
      rec.font.postScriptName,
      rec.usedAt.map((u) => [u.layerID, float(u.layerTimeD)]),
    ]);
  }
}

describe("TestUsedFonts", () => {
  /** Project.usedFonts vs AE's usedFonts dump. */
  const self = new TestUsedFonts();

  test("test_matches_ae", () => {
    const expected = _fixture("used_fonts_probe.json").value;
    const project = parseProject(BASELINES_AEP);
    expect(pyEq(self._snapshot(project), self._expected(expected))).toBe(true);
  });

  test("test_mixed_and_keyframed_fonts_match_ae", () => {
    // Four fonts, a mixed-font document, and a font-keyframed layer.
    const expected = _fixture("replace_font_probe.json").before.usedFonts.value;
    const project = parseProject(REPLACE_FONT_AEP);
    expect(pyEq(self._snapshot(project), self._expected(expected))).toBe(true);
  });

  test("test_sorted_by_post_script_name", () => {
    const names = parseProject(REPLACE_FONT_AEP).usedFonts.map(
      (e) => e.font.postScriptName,
    );
    expect(pyEq(names, sorted(names))).toBe(true);
  });
});

class TestReplaceFont {
  _layer_state(project: Project) {
    const comp = project.compositions.find((c) => c.name === "RFONT");
    if (comp === undefined) throw new StopIteration();
    const state = new Map<string, [string[], [number, number, CosNode][][]]>();
    for (const name of ["rfont_uniform", "rfont_mixed", "rfont_keyed"]) {
      const layer = comp.layers.find((ly) => ly.name === name);
      if (layer === undefined) throw new StopIteration();
      const text = layer.text;
      pyAssert(text != null);
      const prop = text.property("ADBE Text Document");
      const docs = pyOr(
        prop.keyframes.map((kf) => kf.value),
        [prop.value],
      );
      state.set(name, [
        docs[0]._fonts.map((f) => f.postScriptName),
        docs.map((d) =>
          _charRunSpans(d).map(([s, e, style]) => [s, e, dictGet(style, "0")]),
        ),
      ]);
    }
    return state;
  }
}

describe("TestReplaceFont", () => {
  /** Project.replaceFont vs AE's own replaceFont output. */
  const self = new TestReplaceFont();

  test("test_matches_ae_font_tables_and_runs", () => {
    const project = parseProjectFresh(REPLACE_FONT_AEP);
    expect(project.replaceFont("Verdana", "Georgia")).toBe(true);
    // AE inserts the replacement directly after the replaced font and
    // keeps the old entry; unaffected runs are untouched.
    expect(
      pyEq(self._layer_state(project), self._layer_state(parseProject(REPLACE_FONT_AFTER_AEP))),
    ).toBe(true);
  });

  test("test_used_fonts_after_replace_matches_ae", () => {
    const project = parseProjectFresh(REPLACE_FONT_AEP);
    project.replaceFont("Verdana", "Georgia");
    const expected = _fixture("replace_font_probe.json").after.usedFonts.value;
    const got = project.usedFonts.map((e) => [
      e.font.postScriptName,
      e.used_at.map((u) => [u.layer_id, u.layer_time]),
    ]);
    const want = expected.map((r: UsedFontRecord) => [
      r.font.postScriptName,
      r.usedAt.map((u) => [u.layerID, float(u.layerTimeD)]),
    ]);
    expect(pyEq(got, want)).toBe(true);
  });

  test("test_same_font_is_noop", () => {
    const project = parseProjectFresh(REPLACE_FONT_AEP);
    const before = self._layer_state(project);
    expect(project.replaceFont("Verdana", "Verdana")).toBe(false);
    expect(pyEq(self._layer_state(project), before)).toBe(true);
  });

  test("test_unused_font_returns_false", () => {
    const project = parseProjectFresh(REPLACE_FONT_AEP);
    expect(project.replaceFont("NotInstalledFontXYZ", "Georgia")).toBe(false);
  });

  test("test_accepts_font_objects", () => {
    const project = parseProjectFresh(REPLACE_FONT_AEP);
    const verdana = project.usedFonts
      .map((e) => e.font)
      .find((f) => f.postScriptName === "Verdana");
    if (verdana === undefined) throw new StopIteration();
    expect(project.replaceFont(verdana, "Georgia")).toBe(true);
  });

  test("test_survives_save_and_reparse", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(REPLACE_FONT_AEP);
    project.replaceFont("Verdana", "Georgia");
    const out = tmpPath.div("replaced.aep");
    project.save(out);
    const names = parseProjectFresh(out).usedFonts.map(
      (e) => e.font.postScriptName,
    );
    expect(names.includes("Georgia")).toBe(true);
    expect(names.includes("Verdana")).toBe(false);
  });
});

/**
 * reset_char_style / reset_paragraph_style vs AE's own reset output.
 *
 * After Effects restores its Character/Paragraph panel defaults, which
 * live in the AE preferences rather than the project file; py_aep reads
 * the same `["Text Style Sheet"]` / `["Text Paragraph Sheet"]` sections.
 */
class TestResetStyles {
  static CHAR_MAP = new Map<string, string>([
    ["font", "font"],
    ["fontSize", "fontSize"],
    ["fauxBold", "fauxBold"],
    ["fauxItalic", "fauxItalic"],
    ["applyFill", "applyFill"],
    ["applyStroke", "applyStroke"],
    ["strokeWidth", "strokeWidth"],
    ["strokeOverFill", "strokeOverFill"],
    ["tracking", "tracking"],
    ["tsume", "tsume"],
    ["horizontalScale", "horizontalScale"],
    ["verticalScale", "verticalScale"],
    ["baselineShift", "baselineShift"],
    ["autoLeading", "autoLeading"],
  ]);
  static PARA_MAP = new Map<string, string>([
    ["justification", "justification"],
    ["firstLineIndent", "firstLineIndent"],
    ["startIndent", "startIndent"],
    ["endIndent", "endIndent"],
    ["spaceBefore", "spaceBefore"],
    ["spaceAfter", "spaceAfter"],
    ["hangingRoman", "hangingRoman"],
    ["everyLineComposer", "everyLineComposer"],
  ]);
}

describe("TestResetStyles", () => {
  test("test_char_reset_matches_ae", () => {
    const expected = _fixture("reset_style_probe.json").char_after;
    const doc = _doc(parseProjectFresh(RESET_AEP), "RESET2", "rc_char");
    doc.resetCharStyle();
    for (const [aeKey, pyKey] of TestResetStyles.CHAR_MAP.entries()) {
      const got = getattr(doc, pyKey);
      const want = expected[aeKey];
      if (typeof want === "boolean" || typeof want === "string") {
        pyAssert(pyEq(got, want), pyKey);
      } else {
        pyAssert(approx(float(got), float(want), { abs: 1e-3 }), pyKey);
      }
    }
  });

  test("test_char_reset_collapses_runs", () => {
    const doc = _doc(parseProjectFresh(RESET_AEP), "RESET2", "rc_char");
    doc.resetCharStyle();
    // AE leaves a single character run spanning the whole document.
    expect(len(_charRunSpans(doc))).toBe(1);
  });

  test("test_paragraph_reset_matches_ae", () => {
    const expected = _fixture("reset_style_probe.json").para_after;
    const doc = _doc(parseProjectFresh(RESET_AEP), "RESET2", "rp_para");
    doc.resetParagraphStyle();
    for (const [aeKey, pyKey] of TestResetStyles.PARA_MAP.entries()) {
      const got = getattr(doc, pyKey);
      const want = expected[aeKey];
      if (typeof want === "boolean") {
        pyAssert(pyEq(got, want), pyKey);
      } else {
        pyAssert(approx(float(got), float(want), { abs: 1e-3 }), pyKey);
      }
    }
  });

  test("test_paragraph_reset_keeps_auto_hyphenate", () => {
    // Hyphenation has no entry in the Paragraph panel sheet, so AE
    // leaves it alone (probed: True before and after).
    const expected = _fixture("reset_style_probe.json").para_after.autoHyphenate;
    const doc = _doc(parseProjectFresh(RESET_AEP), "RESET2", "rp_para");
    doc.resetParagraphStyle();
    expect(doc.autoHyphenate).toBe(expected);
  });

  test("test_reset_without_prefs_uses_factory_defaults", () => {
    // Parsed with no preferences directory: AE's factory panel values.
    const doc = _doc(parseProjectFresh(RESET_AEP), "RESET2", "rc_char");
    doc.resetCharStyle();
    expect(doc.font).toBe("MyriadPro-Regular");
    expect(approx(doc.fontSize, 36.0)).toBe(true);
    expect(approx(doc.fillColor, Array(3).fill(0.92156994342804))).toBe(true);
  });

  test("test_detached_document_raises", () => {
    for (const method of ["resetCharStyle", "resetParagraphStyle"]) {
      raises(
        ValueError,
        () => {
          const d = new TextDocument("hi");
          getattr(d, method).call(d);
        },
        "not associated with a layer",
      );
    }
  });

  test("test_reset_survives_save_and_reparse", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(RESET_AEP);
    const doc = _doc(project, "RESET2", "rc_char");
    doc.resetCharStyle();
    const out = tmpPath.div("reset.aep");
    project.save(out);
    const reparsed = _doc(parseProjectFresh(out), "RESET2", "rc_char");
    expect(approx(reparsed.fontSize, 36.0)).toBe(true);
    expect(reparsed.fauxBold).toBe(false);
  });
});

class TestFuzzRegressions {
  static BOX_MATRIX = SAMPLES_DIR.div("box_matrix.aep");
  static WRITES = SAMPLES_DIR.div("text_writes.aep");
}

describe("TestFuzzRegressions", () => {
  test("test_baseline_locs_on_ligated_text", () => {
    // The stored advances carry one entry per GLYPH: "affinity " is 9
    // characters but 7 glyphs once "ffi" ligates, so indexing advances by
    // character position ran off the end (IndexError).
    const project = parseProject(TestFuzzRegressions.BOX_MATRIX);
    const comp = project.compositions[0];
    const doc = _doc(project, comp.name, "M_LIGA");
    const locs = doc.baselineLocs;
    expect(len(locs)).toBe(4 * pyOr(doc.composedLineCount, 0));
    // Line 0 is "affinity " - the extent excludes the trailing space.
    expect(approx(locs[2], locs[0] + 104.292, { abs: 5e-3 })).toBe(true);
  });

  test("test_baseline_locs_never_raises_across_the_matrix", () => {
    // 45 text layers covering ligatures, tabs, optical kerning, vertical
    // text, giant words and hyphens.
    const project = parseProject(TestFuzzRegressions.BOX_MATRIX);
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        if (layer.text == null) continue;
        const locs = layer.text.property("ADBE Text Document").value.baselineLocs;
        expect(mod(len(locs), 4)).toBe(0);
      }
    }
  });

  test("test_reset_char_style_resets_kerning", () => {
    // AE's reset takes autoKernType back to the panel default (Metric),
    // which also clears any MANUAL kerning - probed AE 2026. Without it
    // the character runs could not collapse.
    const project = parseProjectFresh(TestFuzzRegressions.WRITES);
    const comp = project.compositions[0];
    const doc = _doc(project, comp.name, "W_KERN_START");
    expect(doc.autoKernType).toBe(AutoKernType.NO_AUTO_KERN);
    expect(cosGet(doc._doc, "0", "8") != null).toBe(true); // manual kern runs

    doc.resetCharStyle();

    expect(doc.autoKernType).toBe(AutoKernType.METRIC_KERN);
    expect(cosGet(doc._doc, "0", "8") == null).toBe(true); // manual kerning cleared
    expect(len(_charRunSpans(doc))).toBe(1);
  });

  test("test_replace_font_reaches_duplicate_table_entries", () => {
    // A font table can hold several entries with one PostScript name (AE
    // writes a second MyriadPro-Regular when a style reset re-applies the
    // panel font). reset_para's runs point at the SECOND one, so matching
    // only the first silently skipped the layer.
    const project = parseProjectFresh(REPLACE_FONT_AEP);
    const doc = _doc(project, "RESET", "reset_para");
    const names = doc._fonts.map((f) => f.postScriptName);
    pyAssert(
      names.filter((n) => n === "MyriadPro-Regular").length === 2,
      "sample lost its duplicate",
    );
    expect(pyEq(doc._used_font_objects().map((f) => f.postScriptName), ["MyriadPro-Regular"])).toBe(
      true,
    );

    expect(project.replaceFont("MyriadPro-Regular", "Georgia")).toBe(true);

    expect(pyEq(doc._used_font_objects().map((f) => f.postScriptName), ["Georgia"])).toBe(true);
    expect(
      project.usedFonts
        .map((e) => e.font.postScriptName)
        .includes("MyriadPro-Regular"),
    ).toBe(false);
  });
});
