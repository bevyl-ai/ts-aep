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
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import {
  AssertionError_,
  dict_get,
  float,
  getattr,
  len,
  Path,
  py_assert,
  py_eq,
  py_or,
  sorted,
  ValueError,
  zip,
  mod,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { parse_project } from "../conftest.ts";
import { parse_project_fresh } from "../helpers.ts";
import { AutoKernType } from "../../src/py_aep/enums/index.ts";
import { TextLayer } from "../../src/py_aep/models/layers/index.ts";
import { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import { _char_run_spans } from "../../src/py_aep/models/text/ranges.ts";
import { cos_get } from "../../src/py_aep/cos/cos.ts";

// Path(__file__).parent x3 is the TS root (this file lives in tests/read_only).
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "text");
const BASELINES_AEP = SAMPLES_DIR.div("baseline_locs.aep");
const REPLACE_FONT_AEP = SAMPLES_DIR.div("replace_font.aep");
const REPLACE_FONT_AFTER_AEP = SAMPLES_DIR.div("replace_font_after.aep");
const RESET_AEP = SAMPLES_DIR.div("reset_style.aep");

// AE reports an empty line's start/end as the maximum 32-bit float.
const FLT_MAX = 3.4028234663852886e38;

function _fixture(name: string): any {
  return JSON.parse(SAMPLES_DIR.div(name).read_text());
}

function _doc(project: any, comp_name: string, layer_name: string): TextDocument {
  const comp = project.compositions.find((c: any) => c.name === comp_name)!;
  const layer = comp.layers.find((ly: any) => ly.name === layer_name)!;
  py_assert(layer instanceof TextLayer);
  const text = layer.text;
  if (text == null) throw new AssertionError_(`text layer ${layer_name} has no text properties`);
  return text.__getitem__("ADBE Text Document").value;
}

describe("TestBaselineLocs", () => {
  /** TextDocument.baseline_locs vs AE's own baselineLocs dump. */
  test.each(["text_point", "text_box", "text_animated"])("test_matches_ae[%#]", (layer_name: string) => {
    const expected = _fixture("baseline_locs_probe.json")[layer_name].baselineLocs.value;
    const got = _doc(parse_project(BASELINES_AEP), "PROBE_MAIN", layer_name).baseline_locs;
    expect(len(got)).toBe(len(expected));
    for (const [g, w] of zip(got, expected)) {
      if ((w as number) > 1e38) {
        // empty-line sentinel
        expect(approx(g, FLT_MAX)).toBe(true);
      } else {
        expect(approx(g, w, { abs: 5e-3 })).toBe(true);
      }
    }
  });

  test("test_empty_line_is_float_max", () => {
    // "Hello\rWorld line two\r\rAfter empty": the third line is empty.
    const locs = _doc(parse_project(BASELINES_AEP), "PROBE_MAIN", "text_point").baseline_locs;
    expect(py_eq(locs.slice(8, 12), Array(4).fill(FLT_MAX))).toBe(true);
  });

  test("test_box_text_offset_by_box_pos", () => {
    // A box's cached origins are box-relative; layer coordinates add
    // box_text_pos (AE: -110/-70 for a centered 220x140 box).
    const doc = _doc(parse_project(BASELINES_AEP), "PROBE_MAIN", "text_box");
    expect(py_eq(doc.box_text_pos, [-110.0, -70.0])).toBe(true);
    expect(approx(doc.baseline_locs[0], -110.0)).toBe(true);
  });

  test("test_four_floats_per_composed_line", () => {
    const doc = _doc(parse_project(BASELINES_AEP), "PROBE_MAIN", "text_box");
    expect(len(doc.baseline_locs)).toBe(4 * py_or(doc.composed_line_count, 0));
  });

  test("test_detached_document_is_empty", () => {
    expect(py_eq(new TextDocument("hi").baseline_locs, [])).toBe(true);
  });
});

class TestUsedFonts {
  _snapshot(project: any): any[] {
    return project.used_fonts.map((entry: any) => [
      entry.font.post_script_name,
      entry.used_at.map((u: any) => [u.layer_id, u.layer_time]),
    ]);
  }

  _expected(records: any[]): any[] {
    return records.map((rec: any) => [
      rec.font.postScriptName,
      rec.usedAt.map((u: any) => [u.layerID, float(u.layerTimeD)]),
    ]);
  }
}

describe("TestUsedFonts", () => {
  /** Project.used_fonts vs AE's usedFonts dump. */
  const self = new TestUsedFonts();

  test("test_matches_ae", () => {
    const expected = _fixture("used_fonts_probe.json").value;
    const project = parse_project(BASELINES_AEP);
    expect(py_eq(self._snapshot(project), self._expected(expected))).toBe(true);
  });

  test("test_mixed_and_keyframed_fonts_match_ae", () => {
    // Four fonts, a mixed-font document, and a font-keyframed layer.
    const expected = _fixture("replace_font_probe.json").before.usedFonts.value;
    const project = parse_project(REPLACE_FONT_AEP);
    expect(py_eq(self._snapshot(project), self._expected(expected))).toBe(true);
  });

  test("test_sorted_by_post_script_name", () => {
    const names = parse_project(REPLACE_FONT_AEP).used_fonts.map(
      (e: any) => e.font.post_script_name,
    );
    expect(py_eq(names, sorted(names))).toBe(true);
  });
});

class TestReplaceFont {
  _layer_state(project: any): Map<string, any> {
    const comp = project.compositions.find((c: any) => c.name === "RFONT")!;
    const state = new Map<string, any>();
    for (const name of ["rfont_uniform", "rfont_mixed", "rfont_keyed"]) {
      const layer = comp.layers.find((ly: any) => ly.name === name)!;
      const prop = layer.text.__getitem__("ADBE Text Document");
      const docs: any[] = py_or(
        prop.keyframes.map((kf: any) => kf.value),
        [prop.value],
      );
      state.set(name, [
        docs[0]._fonts.map((f: any) => f.post_script_name),
        docs.map((d: any) =>
          _char_run_spans(d).map(([s, e, style]: any) => [s, e, dict_get(style, "0")]),
        ),
      ]);
    }
    return state;
  }
}

describe("TestReplaceFont", () => {
  /** Project.replace_font vs AE's own replaceFont output. */
  const self = new TestReplaceFont();

  test("test_matches_ae_font_tables_and_runs", () => {
    const project = parse_project_fresh(REPLACE_FONT_AEP);
    expect(project.replace_font("Verdana", "Georgia")).toBe(true);
    // AE inserts the replacement directly after the replaced font and
    // keeps the old entry; unaffected runs are untouched.
    expect(
      py_eq(self._layer_state(project), self._layer_state(parse_project(REPLACE_FONT_AFTER_AEP))),
    ).toBe(true);
  });

  test("test_used_fonts_after_replace_matches_ae", () => {
    const project = parse_project_fresh(REPLACE_FONT_AEP);
    project.replace_font("Verdana", "Georgia");
    const expected = _fixture("replace_font_probe.json").after.usedFonts.value;
    const got = project.used_fonts.map((e: any) => [
      e.font.post_script_name,
      e.used_at.map((u: any) => [u.layer_id, u.layer_time]),
    ]);
    const want = expected.map((r: any) => [
      r.font.postScriptName,
      r.usedAt.map((u: any) => [u.layerID, float(u.layerTimeD)]),
    ]);
    expect(py_eq(got, want)).toBe(true);
  });

  test("test_same_font_is_noop", () => {
    const project = parse_project_fresh(REPLACE_FONT_AEP);
    const before = self._layer_state(project);
    expect(project.replace_font("Verdana", "Verdana")).toBe(false);
    expect(py_eq(self._layer_state(project), before)).toBe(true);
  });

  test("test_unused_font_returns_false", () => {
    const project = parse_project_fresh(REPLACE_FONT_AEP);
    expect(project.replace_font("NotInstalledFontXYZ", "Georgia")).toBe(false);
  });

  test("test_accepts_font_objects", () => {
    const project = parse_project_fresh(REPLACE_FONT_AEP);
    const verdana = project.used_fonts
      .map((e: any) => e.font)
      .find((f: any) => f.post_script_name === "Verdana")!;
    expect(project.replace_font(verdana, "Georgia")).toBe(true);
  });

  test("test_survives_save_and_reparse", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(REPLACE_FONT_AEP);
    project.replace_font("Verdana", "Georgia");
    const out = tmp_path.div("replaced.aep");
    project.save(out);
    const names = parse_project_fresh(out).used_fonts.map(
      (e: any) => e.font.post_script_name,
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
    ["fontSize", "font_size"],
    ["fauxBold", "faux_bold"],
    ["fauxItalic", "faux_italic"],
    ["applyFill", "apply_fill"],
    ["applyStroke", "apply_stroke"],
    ["strokeWidth", "stroke_width"],
    ["strokeOverFill", "stroke_over_fill"],
    ["tracking", "tracking"],
    ["tsume", "tsume"],
    ["horizontalScale", "horizontal_scale"],
    ["verticalScale", "vertical_scale"],
    ["baselineShift", "baseline_shift"],
    ["autoLeading", "auto_leading"],
  ]);
  static PARA_MAP = new Map<string, string>([
    ["justification", "justification"],
    ["firstLineIndent", "first_line_indent"],
    ["startIndent", "start_indent"],
    ["endIndent", "end_indent"],
    ["spaceBefore", "space_before"],
    ["spaceAfter", "space_after"],
    ["hangingRoman", "hanging_roman"],
    ["everyLineComposer", "every_line_composer"],
  ]);
}

describe("TestResetStyles", () => {
  test("test_char_reset_matches_ae", () => {
    const expected = _fixture("reset_style_probe.json").char_after;
    const doc = _doc(parse_project_fresh(RESET_AEP), "RESET2", "rc_char");
    doc.reset_char_style();
    for (const [ae_key, py_key] of TestResetStyles.CHAR_MAP.entries()) {
      const got = getattr(doc, py_key);
      const want = expected[ae_key];
      if (typeof want === "boolean" || typeof want === "string") {
        py_assert(py_eq(got, want), py_key);
      } else {
        py_assert(approx(float(got), float(want), { abs: 1e-3 }), py_key);
      }
    }
  });

  test("test_char_reset_collapses_runs", () => {
    const doc = _doc(parse_project_fresh(RESET_AEP), "RESET2", "rc_char");
    doc.reset_char_style();
    // AE leaves a single character run spanning the whole document.
    expect(len(_char_run_spans(doc))).toBe(1);
  });

  test("test_paragraph_reset_matches_ae", () => {
    const expected = _fixture("reset_style_probe.json").para_after;
    const doc = _doc(parse_project_fresh(RESET_AEP), "RESET2", "rp_para");
    doc.reset_paragraph_style();
    for (const [ae_key, py_key] of TestResetStyles.PARA_MAP.entries()) {
      const got = getattr(doc, py_key);
      const want = expected[ae_key];
      if (typeof want === "boolean") {
        py_assert(py_eq(got, want), py_key);
      } else {
        py_assert(approx(float(got), float(want), { abs: 1e-3 }), py_key);
      }
    }
  });

  test("test_paragraph_reset_keeps_auto_hyphenate", () => {
    // Hyphenation has no entry in the Paragraph panel sheet, so AE
    // leaves it alone (probed: True before and after).
    const expected = _fixture("reset_style_probe.json").para_after.autoHyphenate;
    const doc = _doc(parse_project_fresh(RESET_AEP), "RESET2", "rp_para");
    doc.reset_paragraph_style();
    expect(doc.auto_hyphenate).toBe(expected);
  });

  test("test_reset_without_prefs_uses_factory_defaults", () => {
    // Parsed with no preferences directory: AE's factory panel values.
    const doc = _doc(parse_project_fresh(RESET_AEP), "RESET2", "rc_char");
    doc.reset_char_style();
    expect(doc.font).toBe("MyriadPro-Regular");
    expect(approx(doc.font_size, 36.0)).toBe(true);
    expect(approx(doc.fill_color, Array(3).fill(0.92156994342804))).toBe(true);
  });

  test("test_detached_document_raises", () => {
    for (const method of ["reset_char_style", "reset_paragraph_style"]) {
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
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(RESET_AEP);
    const doc = _doc(project, "RESET2", "rc_char");
    doc.reset_char_style();
    const out = tmp_path.div("reset.aep");
    project.save(out);
    const reparsed = _doc(parse_project_fresh(out), "RESET2", "rc_char");
    expect(approx(reparsed.font_size, 36.0)).toBe(true);
    expect(reparsed.faux_bold).toBe(false);
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
    const project = parse_project(TestFuzzRegressions.BOX_MATRIX);
    const comp = project.compositions[0];
    const doc = _doc(project, comp.name, "M_LIGA");
    const locs = doc.baseline_locs;
    expect(len(locs)).toBe(4 * py_or(doc.composed_line_count, 0));
    // Line 0 is "affinity " - the extent excludes the trailing space.
    expect(approx(locs[2], locs[0] + 104.292, { abs: 5e-3 })).toBe(true);
  });

  test("test_baseline_locs_never_raises_across_the_matrix", () => {
    // 45 text layers covering ligatures, tabs, optical kerning, vertical
    // text, giant words and hyphens.
    const project = parse_project(TestFuzzRegressions.BOX_MATRIX);
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        if (layer.text == null) continue;
        const locs = layer.text.__getitem__("ADBE Text Document").value.baseline_locs;
        expect(mod(len(locs), 4)).toBe(0);
      }
    }
  });

  test("test_reset_char_style_resets_kerning", () => {
    // AE's reset takes autoKernType back to the panel default (Metric),
    // which also clears any MANUAL kerning - probed AE 2026. Without it
    // the character runs could not collapse.
    const project = parse_project_fresh(TestFuzzRegressions.WRITES);
    const comp = project.compositions[0];
    const doc = _doc(project, comp.name, "W_KERN_START");
    expect(doc.auto_kern_type).toBe(AutoKernType.NO_AUTO_KERN);
    expect(cos_get(doc._doc, "0", "8") != null).toBe(true); // manual kern runs

    doc.reset_char_style();

    expect(doc.auto_kern_type).toBe(AutoKernType.METRIC_KERN);
    expect(cos_get(doc._doc, "0", "8") == null).toBe(true); // manual kerning cleared
    expect(len(_char_run_spans(doc))).toBe(1);
  });

  test("test_replace_font_reaches_duplicate_table_entries", () => {
    // A font table can hold several entries with one PostScript name (AE
    // writes a second MyriadPro-Regular when a style reset re-applies the
    // panel font). reset_para's runs point at the SECOND one, so matching
    // only the first silently skipped the layer.
    const project = parse_project_fresh(REPLACE_FONT_AEP);
    const doc = _doc(project, "RESET", "reset_para");
    const names = doc._fonts.map((f: any) => f.post_script_name);
    py_assert(
      names.filter((n: string) => n === "MyriadPro-Regular").length === 2,
      "sample lost its duplicate",
    );
    expect(py_eq(doc._used_font_objects().map((f: any) => f.post_script_name), ["MyriadPro-Regular"])).toBe(
      true,
    );

    expect(project.replace_font("MyriadPro-Regular", "Georgia")).toBe(true);

    expect(py_eq(doc._used_font_objects().map((f: any) => f.post_script_name), ["Georgia"])).toBe(true);
    expect(
      project.used_fonts
        .map((e: any) => e.font.post_script_name)
        .includes("MyriadPro-Regular"),
    ).toBe(false);
  });
});
