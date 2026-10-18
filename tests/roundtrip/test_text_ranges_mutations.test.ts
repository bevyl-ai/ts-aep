/**
 * Mutation tests for the text-range prerequisites.
 *
 * Covers the AE-parity behaviors around py-side edits: the `text` setter's
 * style-run rebuild (probed via the `RangesTextReset` fixture), trailing
 * line-break preservation, and the stale composed-line clamp semantics.
 */

import { describe, expect, test } from "bun:test";
import { parse_app_fresh } from "../helpers.ts";
import type { Application } from "../../src/py_aep/index.ts";
import { cos_get } from "../../src/py_aep/cos/index.ts";
import { cos_dict, cos_iter, is, py_int } from "../../src/py_aep/cos/kinds.ts";
import { BoxVerticalAlignment } from "../../src/py_aep/enums/index.ts";
import { resolve_postscript } from "../../src/py_aep/svg/fonts.ts";
import type { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import {
  Path,
  py_eq,
  py_or,
  sorted,
  StopIteration,
  ValueError,
} from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises, skip } from "../../src/pyrt/pytest.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "text");
const SAMPLE = SAMPLES_DIR.div("text_ranges.aep");

/** `_fresh_doc(name, app=None)` -> `(app, layer.text.sourceText.value)`. */
function _fresh_doc(name: string, app: Application | null = null): [Application, TextDocument] {
  app = app == null ? parse_app_fresh(SAMPLE) : app;
  const comp = app.project.compositions[0];
  const layer = comp.textLayers.find((ly) => ly.name === name);
  if (layer === undefined) throw new StopIteration();
  if (layer.text == null) throw new Error("text layer has no text group");
  return [app, layer.text.sourceText.value];
}

/**
 * Skip when the calibrated composer cannot run on this machine
 * (no uharfbuzz, or a font the doc's style runs use is missing).
 *
 * Only run-referenced fonts matter: `_fonts` also registers entries
 * no run points at (e.g. AdobeInvisFont), which never get shaped.
 *
 * Returns the skip reason, or null when the composer may run. The shim's
 * `skip` is throw-free, so callers do `if (reason != null) return skip(reason);`.
 */
function _require_composer(doc: TextDocument): string | null {
  // NOTE(port): importorskip("uharfbuzz") never skips here: text_composition.ts loads harfbuzzjs unconditionally at module load.
  const fonts = doc._fonts.map((font) => font.postScriptName);
  const used = new Set<string>();
  for (const run of cos_iter(py_or(cos_get(doc._doc, "0", "6", "0"), []))) {
    const style = py_or(cos_get(run, "0", "0", "6"), new Map());
    const index = cos_dict(style, "get").get("0") ?? null;
    if (is(py_int, index) && 0 <= Number(index) && Number(index) < fonts.length) {
      used.add(fonts[Number(index)]);
    }
  }
  const missing = sorted([...used].filter((name) => resolve_postscript(name) == null));
  if (missing.length) return `fixture fonts not installed: ${missing.join(", ")}`;
  return null;
}

/** Setting `text` collapses styling like AE (RangesTextReset probe). */
describe("TestTextSetterRunRebuild", () => {
  test("test_char_runs_collapse_to_first_style", () => {
    const tmp_path = make_tmp_path();
    const [app, doc] = _fresh_doc("RangesPoint");
    // Styled sample: chars 0-5 are 72pt red, the rest differs.
    expect(doc.characterRange(0, -1).fontSize == null).toBe(true);

    doc.text = "New text\rhere";
    expect(doc.paragraphCount).toBe(2);
    const full = doc.characterRange(0, -1);
    expect(full.fontSize).toBe(72.0);
    expect(approx(full.fillColor, [1.0, 0.0, 0.0])).toBe(true);

    const out = tmp_path.div("reset.aep");
    app.project.save(out);
    const [_app2, doc2] = _fresh_doc("RangesPoint", parse_app_fresh(out));
    expect(doc2.text).toBe("New text\nhere");
    expect(doc2.paragraphCount).toBe(2);
    expect(doc2.characterRange(0, -1).fontSize).toBe(72.0);
    expect(
      py_eq(
        [doc2.paragraphRange(1).characterStart, doc2.paragraphRange(1).characterEnd],
        [9, 13],
      ),
    ).toBe(true);
  });

  test("test_kerning_runs_dropped", () => {
    const [_app, doc] = _fresh_doc("RangesKernLead");
    expect(doc.characterRange(1, 4).kerning).toBe(200);
    doc.text = "AVAWAY";
    // Manual kerning values are dropped. Without stored values the
    // read is undefined even under NO_AUTO_KERN (probed X_TEXT_KERN).
    expect(doc.characterRange(0, -1).kerning == null).toBe(true);
  });

  test("test_trailing_line_breaks_preserved", () => {
    const tmp_path = make_tmp_path();
    const [app, doc] = _fresh_doc("RangesPoint");
    doc.text = "A\nB\n";
    expect(doc.text).toBe("A\nB\n");
    expect(doc.paragraphCount).toBe(3);
    const pr = doc.paragraphRange(2);
    expect(py_eq([pr.characterStart, pr.characterEnd], [4, 4])).toBe(true);

    const out = tmp_path.div("trailing.aep");
    app.project.save(out);
    const [_app2, doc2] = _fresh_doc("RangesPoint", parse_app_fresh(out));
    expect(doc2.text).toBe("A\nB\n");
    expect(doc2.paragraphCount).toBe(3);
  });
});

/**
 * Post-mutation composed-line freshness via the calibrated composer.
 *
 * The expected values are AE ground truth: opening the py-authored
 * gate files, AE itself recomposed the shrunk box to 1 line and the
 * grown text to 7 lines (gate_shrink / gate_grow, 2026-07-08), and
 * reproduced the empty-paragraph / trailing-empty-paragraph /
 * empty-text / zero-kept-lines spans byte-for-byte (gate_compose on
 * mutated box_matrix layers, 2026-07-11).
 */
describe("TestRecomposition", () => {
  test("test_box_shrink_recomposes", () => {
    const [_app, doc] = _fresh_doc("RangesBox");
    const reason = _require_composer(doc);
    if (reason != null) return skip(reason);
    doc.text = "tiny";
    expect(doc._composition_calibrated).toBe(true);
    expect(doc.compositionStale).toBe(false);
    expect(doc.composedLineCount).toBe(1); // AE-verified
    const rng = doc.composedLineRange(0);
    expect(py_eq([rng.characterStart, rng.characterEnd], [0, 4])).toBe(true);
    expect(doc.boxOverflow).toBe(false);
  });

  test("test_box_growth_recomposes", () => {
    const [_app, doc] = _fresh_doc("RangesBox");
    const reason = _require_composer(doc);
    if (reason != null) return skip(reason);
    doc.text = "much longer text than before ".repeat(4);
    expect(doc.composedLineCount).toBe(7); // AE-verified
    expect(doc.boxOverflow).toBe(true);
    expect(doc.compositionStale).toBe(false);
  });

  test("test_point_text_is_always_fresh", () => {
    const [_app, doc] = _fresh_doc("RangesPoint");
    doc.text = "one\ntwo\nthree";
    expect(doc.compositionStale).toBe(false);
    expect(doc.composedLineCount).toBe(3);
    const rng = doc.composedLineRange(2);
    expect(py_eq([rng.characterStart, rng.characterEnd], [8, 13])).toBe(true);
  });

  test("test_unresolvable_font_falls_back_to_stale", () => {
    const [_app, doc] = _fresh_doc("RangesBox");
    const reason = _require_composer(doc);
    if (reason != null) return skip(reason);
    doc.characterRange(0, 4).font = "NotInstalled-Font";
    // Calibration (taken before the write) passed, but recomposition
    // now refuses; the stale cache stays, with clamp semantics.
    expect(doc.compositionStale).toBe(true);
    expect(doc.composedLineCount).toBe(6);
  });

  test("test_empty_paragraph_recomposes", () => {
    const [_app, doc] = _fresh_doc("RangesBox");
    const reason = _require_composer(doc);
    if (reason != null) return skip(reason);
    doc.text = "a\n\nb";
    // The empty paragraph composes to its own (empty) line and the
    // spans stay contiguous over the raw text (gate_compose M_W300).
    expect(doc.compositionStale).toBe(false);
    expect(doc.composedLineCount).toBe(3);
    // NOTE(port): the list of {"start", "end"} dicts is deep-compared with toEqual (py_eq does not walk plain objects).
    expect(doc.composedLineRanges).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
    ]);
    expect(doc.boxOverflow).toBe(false);
  });

  test("test_trailing_empty_paragraph_recomposes", () => {
    const [_app, doc] = _fresh_doc("RangesBox");
    const reason = _require_composer(doc);
    if (reason != null) return skip(reason);
    doc.text = "hello\n";
    // The trailing empty paragraph is its own zero-span line
    // (gate_compose M_H40: ranges [0, 6] and [6, 6]).
    expect(doc.compositionStale).toBe(false);
    expect(doc.composedLineCount).toBe(2);
    // NOTE(port): toEqual deep-compare, see test_empty_paragraph_recomposes.
    expect(doc.composedLineRanges).toEqual([
      { start: 0, end: 6 },
      { start: 6, end: 6 },
    ]);
  });

  test("test_empty_text_composes_one_line", () => {
    const [_app, doc] = _fresh_doc("RangesBox");
    const reason = _require_composer(doc);
    if (reason != null) return skip(reason);
    doc.text = "";
    // AE composes one empty line for empty box text (gate_compose
    // M_H55: count 1, range [0, 0], no overflow).
    expect(doc.composedLineCount).toBe(1);
    expect(doc.boxOverflow).toBe(false);
  });

  test("test_zero_kept_lines_reports_overflow", () => {
    const [_app, doc] = _fresh_doc("RangesBox");
    const reason = _require_composer(doc);
    if (reason != null) return skip(reason);
    // Box shorter than the first baseline: every line is clipped.
    // AE agrees (gate_compose M_H70: count 0, overflow true).
    doc.boxTextSize = [200.0, 1.0];
    expect(doc.composedLineCount).toBe(0);
    expect(doc.boxOverflow).toBe(true);
    expect(doc.compositionStale).toBe(false);
  });

  test("test_frame_write_marks_sibling_keyframe_docs", () => {
    const app = parse_app_fresh(SAMPLE);
    const comp = app.project.compositions[0];
    const layer = comp.textLayers.find((ly) => ly.name === "RangesBox");
    if (layer === undefined) throw new StopIteration();
    if (layer.text == null) throw new Error("text layer has no text group");
    const prop = layer.text.property("ADBE Text Document");
    prop.addKey(0.0);
    prop.addKey(1.0);
    const doc_a = prop.keyframes[0].value;
    const doc_b = prop.keyframes[1].value;
    expect(doc_a !== doc_b).toBe(true);
    const reason = _require_composer(doc_a);
    if (reason != null) return skip(reason);

    // The box frame is layer-shared: resizing through one keyframe's
    // document must not leave the sibling serving its pre-resize
    // cache as fresh.
    doc_a.boxTextSize = [220.0, 90.0];
    expect(doc_b._layout_dirty).toBe(true);
    expect(doc_b.compositionStale).toBe(false);
    expect(doc_a.composedLineCount).toBe(doc_b.composedLineCount);
  });

  test("test_unmodeled_layout_write_falls_back_to_stale", () => {
    const [_app, doc] = _fresh_doc("RangesBox");
    const reason = _require_composer(doc);
    if (reason != null) return skip(reason);
    doc.boxVerticalAlignment = BoxVerticalAlignment.CENTER;
    // Dirty-marked but outside the composer's verified envelope:
    // honest staleness, never a silent guess.
    expect(doc.compositionStale).toBe(true);
    expect(doc.composedLineCount).toBe(6);
  });
});

/** Composer-less fallback: cached lines clamp; out-of-text lines raise. */
describe("TestStaleComposedLines", () => {
  test("test_shrink_clamps_first_line_and_raises_beyond", () => {
    const [_app, doc] = _fresh_doc("RangesBox");
    expect(doc.composedLineCount).toBe(6);

    const held = doc.characterRange(0, 10);
    const held_line = doc.composedLineRange(1);
    doc.text = "tiny";
    // Force the composer-less path: an uncalibrated document keeps
    // the stale cache (AE-parity clamp semantics).
    doc._composition_calibrated = false;

    // The cached count stays (ExtendScript behavior on an un-reapplied
    // value object); line 0 clamps, deeper lines raise at creation.
    expect(doc.composedLineCount).toBe(6);
    const first = doc.composedLineRange(0);
    expect(py_eq([first.characterStart, first.characterEnd], [0, 4])).toBe(true);
    expect(first.characterRange().text).toBe("tiny");
    raises(ValueError, () => doc.composedLineRange(1), "ComposedLine index range");

    expect(held.isRangeValid).toBe(false);
    raises(ValueError, () => held.text, "Character index range");
    expect(held_line.isRangeValid).toBe(false);
  });

  test("test_growth_revalidates_fixed_end_range", () => {
    const [_app, doc] = _fresh_doc("RangesBox");
    const held = doc.characterRange(0, 50);
    doc.text = "tiny";
    expect(held.isRangeValid).toBe(false);
    doc.text = "x".repeat(60);
    expect(held.isRangeValid).toBe(true);
    expect(held.characterEnd).toBe(50);
  });
});
