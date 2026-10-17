/**
 * Tests for TextDocument and FontObject model parsing and roundtrip.
 */

import { describe, expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import { get_comp } from "../helpers.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import { CosName } from "../../src/py_aep/cos/index.ts";
import { AutoKernType, BaselineDirection, BoxAutoFitPolicy, BoxFirstBaselineAlignment, BoxVerticalAlignment, DigitSet, LineJoinType, LineOrientation, ParagraphDirection, ParagraphJustification } from "../../src/py_aep/enums/index.ts";
import { contains, getattr, getitem, Path, py_eq, ValueError } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "layer");

/** Parse and return the first text document from an .aep file. */
function _get_text_document(aep_path: Path, comp_name: string | null = null): [any, any] {
  const app = parse_aep(aep_path);
  let comp: any;
  if (comp_name) {
    comp = get_comp(app.project, comp_name);
  } else {
    comp = app.project.compositions[0];
  }
  const text_layer = comp.text_layers[0];
  return [app.project, text_layer.text.source_text.value];
}

describe("TestRoundtripFontSize", () => {
  /** Roundtrip tests for TextDocument.font_size. */

  test("test_modify_font_size", () => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.font_size).toBe(36.0);

    doc.font_size = 72.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const [_project2, doc2] = _get_text_document(out, "type_text");
    expect(doc2.font_size).toBe(72.0);
  });
});

describe("TestRoundtripFauxBold", () => {
  /** Roundtrip tests for TextDocument.faux_bold. */

  test("test_enable_faux_bold", () => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.faux_bold).toBe(false);

    doc.faux_bold = true;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const [_project2, doc2] = _get_text_document(out, "type_text");
    expect(doc2.faux_bold).toBe(true);
  });
});

describe("TestRoundtripFillColor", () => {
  /** Roundtrip tests for TextDocument.fill_color. */

  test("test_modify_fill_color", () => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");

    doc.fill_color = [1.0, 0.0, 0.0];
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const [_project2, doc2] = _get_text_document(out, "type_text");
    expect(doc2.fill_color != null).toBe(true);
    expect(doc2.fill_color[0]).toBe(1.0);
    expect(doc2.fill_color[1]).toBe(0.0);
    expect(doc2.fill_color[2]).toBe(0.0);
  });
});

describe("TestRoundtripText", () => {
  /** Roundtrip tests for TextDocument.text. */

  test("test_modify_text", () => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");

    doc.text = "Modified";
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const [_project2, doc2] = _get_text_document(out, "type_text");
    expect(py_eq(doc2.text, "Modified")).toBe(true);
  });
});

describe("TestRoundtripJustification", () => {
  /** Roundtrip tests for TextDocument.justification. */

  test("test_modify_justification", () => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.justification).toBe(ParagraphJustification.LEFT_JUSTIFY);

    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const [_project2, doc2] = _get_text_document(out, "type_text");
    expect(doc2.justification).toBe(ParagraphJustification.CENTER_JUSTIFY);
  });
});

describe("TestRoundtripTracking", () => {
  /** Roundtrip tests for TextDocument.tracking. */

  test("test_modify_tracking", () => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");

    doc.tracking = 50.0;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const [_project2, doc2] = _get_text_document(out, "type_text");
    expect(doc2.tracking).toBe(50.0);
  });
});

describe("TestRoundtripWiredAttributes", () => {
  /** Set -> save -> reparse roundtrip for newly-wired attributes. */

  test.each([
    ["tsume", 0.5],
    ["auto_leading", false],
    ["leading", 60.0],
    ["auto_kern_type", AutoKernType.OPTICAL_KERN],
    ["baseline_direction", BaselineDirection.BASELINE_VERTICAL_ROTATED],
    ["ligature", true],
    ["no_break", true],
    ["digit_set", DigitSet.ARABIC_DIGITS],
    ["line_join_type", LineJoinType.LINE_JOIN_ROUND],
    ["direction", ParagraphDirection.DIRECTION_RIGHT_TO_LEFT],
    ["every_line_composer", true],
    ["line_orientation", LineOrientation.VERTICAL_RIGHT_TO_LEFT],
  ])("test_roundtrip[%#]", (attr: string, value: any) => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    (doc as any)[attr] = value;
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const [_project2, doc2] = _get_text_document(out, "type_text");
    expect(py_eq(getattr(doc2, attr), value)).toBe(true);
  });
});

describe("TestBoxText", () => {
  /** Box (paragraph) text attributes via point->box conversion + roundtrip. */

  test("test_convert_point_to_box", () => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.point_text).toBe(true);
    expect(doc.box_text_size == null).toBe(true);

    doc.box_text_size = [320.0, 180.0];
    expect(doc.box_text).toBe(true);
    const out = tmp_path.div("box.aep");
    project.save(out);

    const [_p2, doc2] = _get_text_document(out, "type_text");
    expect(doc2.box_text).toBe(true);
    expect(py_eq(doc2.box_text_size, [320.0, 180.0])).toBe(true);
  });

  test("test_box_text_pos_requires_box", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    raises(
      ValueError,
      () => {
        doc.box_text_pos = [10.0, 20.0];
      },
      "box text",
    );
  });

  test.each([
    ["box_text_size", [240.0, 120.0]],
    ["box_text_pos", [15.0, 25.0]],
    ["box_inset_spacing", 4.0],
    ["box_vertical_alignment", BoxVerticalAlignment.CENTER],
    ["box_vertical_alignment", BoxVerticalAlignment.JUSTIFY],
    ["box_auto_fit_policy", BoxAutoFitPolicy.HEIGHT_BASELINE],
    ["box_first_baseline_alignment", BoxFirstBaselineAlignment.CAP_HEIGHT],
    ["box_first_baseline_alignment", BoxFirstBaselineAlignment.MINIMUM_VALUE_ROMAN],
    ["box_first_baseline_alignment_minimum", 7.0],
  ])("test_box_attr_roundtrip[%#]", (attr: string, value: any) => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    doc.box_text_size = [300.0, 150.0]; // convert to box first
    (doc as any)[attr] = value;
    const out = tmp_path.div("box.aep");
    project.save(out);

    const [_p2, doc2] = _get_text_document(out, "type_text");
    expect(py_eq(getattr(doc2, attr), value)).toBe(true);
  });
});

describe("TestRegisterFont", () => {
  /**
   * Regression: setting a font absent from the document registers it.
   *
   * The new font entry's `99` type tag must be a COS name (`/CoolTypeFont`),
   * matching how AE and the parser represent it, not a plain string.
   */

  test("test_new_font_tag_is_cos_name", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    doc.font = "Arial-BoldMT"; // not in the template -> _register_font
    const g: (o: any, k: any) => any = getitem;
    const new_entry = g(g(g(doc._cos_data, "0"), "1"), "0").at(-1);
    expect(g(g(new_entry, "0"), "99") instanceof CosName).toBe(true);
  });

  test("test_new_font_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    doc.font = "Arial-BoldMT";
    const out = tmp_path.div("out.aep");
    project.save(out);

    const [_project2, doc2] = _get_text_document(out, "type_text");
    expect(py_eq(doc2.font, "Arial-BoldMT")).toBe(true);
  });
});

describe("TestColorAndLeadingNone", () => {
  /**
   * Setting fill/stroke color or leading to `None` clears, not raises.
   *
   * Regression: the setters validated unconditionally, so the documented
   * `None` branch (popping the COS char-style key) raised TypeError.
   */

  test("test_fill_color_none_pops_cos_key", () => {
    const tmp_path = make_tmp_path();
    const [project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.fill_color != null).toBe(true);

    doc.fill_color = null;
    expect(doc._char_style != null).toBe(true);
    expect(contains(doc._char_style, "53")).toBe(false);
    expect(doc.fill_color == null).toBe(true);

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const [_project2, doc2] = _get_text_document(out, "type_text");
    expect(doc2.fill_color == null).toBe(true);
  });

  test("test_stroke_color_none_pops_cos_key", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.stroke_color != null).toBe(true);

    doc.stroke_color = null;
    expect(doc._char_style != null).toBe(true);
    expect(contains(doc._char_style, "54")).toBe(false);
    expect(doc.stroke_color == null).toBe(true);
  });

  test("test_leading_none_does_not_raise", () => {
    const [_project, doc] = _get_text_document(SAMPLES_DIR.div("type.aep"), "type_text");

    doc.leading = null;
    // The explicit-leading branch is skipped; auto-leading still
    // resolves the displayed value (font_size * 1.2).
    expect(approx(doc.leading, 43.2)).toBe(true);
  });
});
