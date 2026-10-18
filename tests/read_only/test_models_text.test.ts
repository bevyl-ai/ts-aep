/** Tests for TextDocument and FontObject model parsing and roundtrip. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. Python test classes become `describe` blocks; the
// helper methods of `TestBoxOverflow` become closures inside it.

import { describe, expect, test } from "bun:test";
import { approx } from "../../src/pyrt/pytest.ts";
import { len, Path, py_assert, py_eq, StopIteration } from "../../src/pyrt/index.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import type { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import "../../src/py_aep/binary/_register.ts";
import { get_comp } from "../conftest.ts";
import { AutoKernType, BaselineDirection, DigitSet, FontBaselineOption, FontCapsOption, LeadingType, LineJoinType, LineOrientation, ParagraphDirection, ParagraphJustification } from "../../src/py_aep/enums/index.ts";

// Path(__file__).parent x3 is the TS root (this file lives in tests/read_only).
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const TEXT_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "text");

/** Parse and return the first text document from an .aep file. */
function _get_text_document(aep_path: Path, comp_name: string | null = null): [Project, TextDocument] {
  const app = parse_aep(aep_path);
  let comp: CompItem;
  if (comp_name) {
    comp = get_comp(app.project, comp_name);
  } else {
    comp = app.project.compositions[0];
  }
  const text_layer = comp.text_layers[0];
  py_assert(text_layer.text != null);
  return [app.project, text_layer.text.source_text.value];
}

describe("TestBoxOverflow", () => {
  /** box_overflow derived from the persisted layout cache. */

  function _doc(layer_name: string): TextDocument {
    const app = parse_aep(TEXT_SAMPLES_DIR.div("box_overflow.aep"));
    const comp = app.project.compositions[0];
    const layer = comp.text_layers.find((ly) => ly.name === layer_name);
    if (layer === undefined) throw new StopIteration();
    py_assert(layer.text != null);
    return layer.text.source_text.value;
  }

  test("test_overflowing_box", () => {
    expect(_doc("BoxOverflows").box_overflow).toBe(true);
  });

  test("test_fitting_box", () => {
    expect(_doc("BoxFits").box_overflow).toBe(false);
  });

  test("test_point_text_reads_none", () => {
    // ExtendScript reads undefined for point text.
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.box_overflow == null).toBe(true);
  });
});

describe("TestTextDocumentParsing", () => {
  /** Tests for TextDocument lazy COS field access. */

  test("test_text", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.text).toBe("TextLayer");
  });

  test("test_font", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.font).toBe("TimesNewRomanPSMT");
  });

  test("test_font_size", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.font_size).toBe(36.0);
  });

  test("test_fill_color", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    py_assert(doc.fill_color != null);
    expect(len(doc.fill_color)).toBe(3);
    // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); this check cannot distinguish an int-valued float from an int.
    expect(doc.fill_color.every((c) => typeof c === "number")).toBe(true);
  });

  test("test_stroke_color", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.stroke_color != null).toBe(true);
    expect(py_eq(doc.stroke_color, [0.0, 0.0, 0.0])).toBe(true);
  });

  test("test_faux_bold", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.faux_bold).toBe(false);
  });

  test("test_faux_italic", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.faux_italic).toBe(false);
  });

  test("test_tracking", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.tracking != null).toBe(true);
  });

  test("test_justification", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.justification).toBe(ParagraphJustification.LEFT_JUSTIFY);
  });

  test("test_font_caps_option", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.font_caps_option).toBe(FontCapsOption.FONT_NORMAL_CAPS);
  });

  test("test_font_baseline_option", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.font_baseline_option).toBe(FontBaselineOption.FONT_NORMAL_BASELINE);
  });

  test("test_derived_all_caps", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.all_caps).toBe(false);
  });

  test("test_derived_small_caps", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.small_caps).toBe(false);
  });

  test("test_derived_superscript", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.superscript).toBe(false);
  });

  test("test_derived_subscript", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.subscript).toBe(false);
  });

  test("test_paragraph_count", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.paragraph_count).toBe(1);
  });

  test("test_auto_leading", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.auto_leading).toBe(true);
  });

  test("test_auto_hyphenate", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.auto_hyphenate).toBe(true);
  });

  test("test_every_line_composer", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.every_line_composer).toBe(false);
  });

  test("test_hanging_roman", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.hanging_roman).toBe(false);
  });

  test("test_auto_kern_type", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.auto_kern_type).toBe(AutoKernType.METRIC_KERN);
  });

  test("test_leading_type", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.leading_type).toBe(LeadingType.ROMAN_LEADING_TYPE);
  });

  test("test_apply_fill", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.apply_fill).toBe(true);
  });

  test("test_apply_stroke", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.apply_stroke).toBe(false);
  });
});

describe("TestFontObject", () => {
  /** Tests for FontObject COS field access. */

  test("test_post_script_name", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    py_assert(doc.font_object != null);
    expect(doc.font_object.post_script_name).toBe("TimesNewRomanPSMT");
  });

  test("test_version", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    py_assert(doc.font_object != null);
    expect(doc.font_object.version).toBe("Version 7.00");
  });
});

describe("TestTextDocumentWiredAttributes", () => {
  /**
   * Read tests for attributes wired to COS keys in this change.
   *
   * Expected values for `type.aep` were validated against ExtendScript.
   */

  test("test_baseline_direction", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.baseline_direction).toBe(BaselineDirection.BASELINE_WITH_STREAM);
  });

  test("test_ligature", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.ligature).toBe(false);
  });

  test("test_no_break", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.no_break).toBe(false);
  });

  test("test_digit_set", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.digit_set).toBe(DigitSet.DEFAULT_DIGITS);
  });

  test("test_line_join_type", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.line_join_type).toBe(LineJoinType.LINE_JOIN_MITER);
  });

  test("test_direction", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.direction).toBe(ParagraphDirection.DIRECTION_LEFT_TO_RIGHT);
  });

  test("test_line_orientation", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.line_orientation).toBe(LineOrientation.HORIZONTAL);
  });

  test("test_tsume", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.tsume).toBe(0.0);
  });

  test("test_kerning", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.kerning).toBe(0);
  });

  test("test_leading_auto", () => {
    // Auto-leading on: leading == font_size * 1.2 (43.2 for 36px).
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.auto_leading).toBe(true);
    expect(approx(doc.leading, 43.2)).toBe(true);
  });
});
