/** Tests for TextDocument and FontObject model parsing and roundtrip. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. Python test classes become `describe` blocks; the
// helper methods of `TestBoxOverflow` become closures inside it.

import { describe, expect, test } from "bun:test";
import { approx } from "../../src/pyrt/pytest.ts";
import { len, Path, assert, valueEquals, StopIteration } from "../../src/pyrt/index.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import type { Project } from "../../src/py_aep/models/project.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import type { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import "../../src/py_aep/binary/_register.ts";
import { getComp } from "../conftest.ts";
import { AutoKernType, BaselineDirection, DigitSet, FontBaselineOption, FontCapsOption, LeadingType, LineJoinType, LineOrientation, ParagraphDirection, ParagraphJustification } from "../../src/py_aep/enums/index.ts";

// Path(__file__).parent x3 is the TS root (this file lives in tests/read_only).
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const TEXT_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "text");

/** Parse and return the first text document from an .aep file. */
function _getTextDocument(aepPath: Path, compName: string | null = null): [Project, TextDocument] {
  const app = parseAep(aepPath);
  let comp: CompItem;
  if (compName) {
    comp = getComp(app.project, compName);
  } else {
    comp = app.project.compositions[0];
  }
  const textLayer = comp.textLayers[0];
  assert(textLayer.text != null);
  return [app.project, textLayer.text.sourceText.value];
}

describe("TestBoxOverflow", () => {
  /** box_overflow derived from the persisted layout cache. */

  function _doc(layerName: string): TextDocument {
    const app = parseAep(TEXT_SAMPLES_DIR.div("box_overflow.aep"));
    const comp = app.project.compositions[0];
    const layer = comp.textLayers.find((ly) => ly.name === layerName);
    if (layer === undefined) throw new StopIteration();
    assert(layer.text != null);
    return layer.text.sourceText.value;
  }

  test("test_overflowing_box", () => {
    expect(_doc("BoxOverflows").boxOverflow).toBe(true);
  });

  test("test_fitting_box", () => {
    expect(_doc("BoxFits").boxOverflow).toBe(false);
  });

  test("test_point_text_reads_none", () => {
    // ExtendScript reads undefined for point text.
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.boxOverflow == null).toBe(true);
  });
});

describe("TestTextDocumentParsing", () => {
  /** Tests for TextDocument lazy COS field access. */

  test("test_text", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.text).toBe("TextLayer");
  });

  test("test_font", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.font).toBe("TimesNewRomanPSMT");
  });

  test("test_font_size", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.fontSize).toBe(36.0);
  });

  test("test_fill_color", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    assert(doc.fillColor != null);
    expect(len(doc.fillColor)).toBe(3);
    // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); this check cannot distinguish an int-valued float from an int.
    expect(doc.fillColor.every((c) => typeof c === "number")).toBe(true);
  });

  test("test_stroke_color", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.strokeColor != null).toBe(true);
    expect(valueEquals(doc.strokeColor, [0.0, 0.0, 0.0])).toBe(true);
  });

  test("test_faux_bold", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.fauxBold).toBe(false);
  });

  test("test_faux_italic", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.fauxItalic).toBe(false);
  });

  test("test_tracking", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.tracking != null).toBe(true);
  });

  test("test_justification", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.justification).toBe(ParagraphJustification.LEFT_JUSTIFY);
  });

  test("test_font_caps_option", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.fontCapsOption).toBe(FontCapsOption.FONT_NORMAL_CAPS);
  });

  test("test_font_baseline_option", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.fontBaselineOption).toBe(FontBaselineOption.FONT_NORMAL_BASELINE);
  });

  test("test_derived_all_caps", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.allCaps).toBe(false);
  });

  test("test_derived_small_caps", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.smallCaps).toBe(false);
  });

  test("test_derived_superscript", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.superscript).toBe(false);
  });

  test("test_derived_subscript", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.subscript).toBe(false);
  });

  test("test_paragraph_count", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.paragraphCount).toBe(1);
  });

  test("test_auto_leading", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.autoLeading).toBe(true);
  });

  test("test_auto_hyphenate", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.autoHyphenate).toBe(true);
  });

  test("test_every_line_composer", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.everyLineComposer).toBe(false);
  });

  test("test_hanging_roman", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.hangingRoman).toBe(false);
  });

  test("test_auto_kern_type", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.autoKernType).toBe(AutoKernType.METRIC_KERN);
  });

  test("test_leading_type", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.leadingType).toBe(LeadingType.ROMAN_LEADING_TYPE);
  });

  test("test_apply_fill", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.applyFill).toBe(true);
  });

  test("test_apply_stroke", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.applyStroke).toBe(false);
  });
});

describe("TestFontObject", () => {
  /** Tests for FontObject COS field access. */

  test("test_post_script_name", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    assert(doc.fontObject != null);
    expect(doc.fontObject.postScriptName).toBe("TimesNewRomanPSMT");
  });

  test("test_version", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    assert(doc.fontObject != null);
    expect(doc.fontObject.version).toBe("Version 7.00");
  });
});

describe("TestTextDocumentWiredAttributes", () => {
  /**
   * Read tests for attributes wired to COS keys in this change.
   *
   * Expected values for `type.aep` were validated against ExtendScript.
   */

  test("test_baseline_direction", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.baselineDirection).toBe(BaselineDirection.BASELINE_WITH_STREAM);
  });

  test("test_ligature", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.ligature).toBe(false);
  });

  test("test_no_break", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.noBreak).toBe(false);
  });

  test("test_digit_set", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.digitSet).toBe(DigitSet.DEFAULT_DIGITS);
  });

  test("test_line_join_type", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.lineJoinType).toBe(LineJoinType.LINE_JOIN_MITER);
  });

  test("test_direction", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.direction).toBe(ParagraphDirection.DIRECTION_LEFT_TO_RIGHT);
  });

  test("test_line_orientation", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.lineOrientation).toBe(LineOrientation.HORIZONTAL);
  });

  test("test_tsume", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.tsume).toBe(0.0);
  });

  test("test_kerning", () => {
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.kerning).toBe(0);
  });

  test("test_leading_auto", () => {
    // Auto-leading on: leading == font_size * 1.2 (43.2 for 36px).
    const [_project, doc] = _getTextDocument(SAMPLES_DIR.div("type.aep"), "type_text");
    expect(doc.autoLeading).toBe(true);
    expect(approx(doc.leading, 43.2)).toBe(true);
  });
});
