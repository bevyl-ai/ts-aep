/**
 * Unit tests for `resolvers.ai_bounds`, the AI/PDF artwork-box measurer.
 *
 * Each case is a one-layer PDF built in memory from a content-stream snippet, so
 * a rule can be pinned without a sample file. The measured values come from
 * After Effects 2026; `tests/read_only/test_ai_bounds.py` checks the same rules
 * against AE's own fixtures.
 */

import { describe, expect, test } from "bun:test";


import { b, Bytes, encode, getOrThrow, len, assert, valueEquals } from "../../src/pyrt/index.ts";
import { STD14_EXTENT, STD14_FIRST_CODE, STD14_STANDARD_QUOTES, STD14_WIDTHS } from "../../src/py_aep/data/std14_metrics.ts";
import { EMPTY_BOX, footageSize, readAiLayerBounds } from "../../src/py_aep/resolvers/ai_bounds.ts";
import { UnsupportedAiLayersError } from "../../src/py_aep/resolvers/ai_layers.ts";
import { approx as pytestApprox, raises, warns } from "../support/pytest.ts";
import { range, sorted } from "../support/python.ts";

const PAGE = 600;

/** Spelled by code point: a content stream's escapes must reach the measurer
 * as the bytes they are, not as whatever a source-level escape survives as.
 */
const SOLIDUS = String.fromCodePoint(92);
const LF = String.fromCodePoint(10);
const CR = String.fromCodePoint(13);

type Box = [number, number, number, number];
type PdfKw = { extra_objects?: string; resources?: string };
type Approx = { expected: Box | null; opts: { abs: number } };

/**
 * A minimal layered PDF with one optional content group per `layers` body.
 *
 * `extra_objects` is spliced in verbatim after the numbered objects, and
 * `resources` is merged into the page's `/Resources` dictionary, so a case
 * can bring its own font or XObject.
 *
 * Python's `*layers` plus keyword-only options: the trailing object carries them.
 */
function buildPdf(...args: Array<string | PdfKw>): Uint8Array {
  const last = args.at(-1);
  const kw: PdfKw = typeof last === "object" ? last : {};
  const layers = args.filter((arg) => typeof arg === "string");
  const { extra_objects = "", resources = "" } = kw;

  const count = len(layers);
  const ocgFirst = 5;
  const objs = new Map<number, string>();
  const refs = [...range(count)].map((i) => `${ocgFirst + i} 0 R`).join(" ");
  // Like Illustrator: `/Order` lists the layers top first, the reverse of
  // `/OCGs`, so layer i is document index i (bottom first).
  const order = [...range(count)]
    .reverse()
    .map((i) => `${ocgFirst + i} 0 R`)
    .join(" ");
  objs.set(
    1,
    `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [${refs}] ` +
      `/D << /ON [${refs}] /Order [${order}] >> >> >>`,
  );
  objs.set(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const props = [...range(count)].map((i) => `/MC${i} ${ocgFirst + i} 0 R`).join(" ");
  objs.set(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE} ${PAGE}] ` +
      `/Contents 4 0 R /Resources << /Properties << ${props} >> ` +
      `${resources} /ProcSet [/PDF /Text] >> >>`,
  );
  const body = layers.map((content, i) => `/OC /MC${i} BDC\n${content}\nEMC\n`).join("");
  objs.set(4, `<< /Length ${len(body)} >>\nstream\n${body}\nendstream`);
  for (const i of range(count)) {
    objs.set(ocgFirst + i, `<< /Type /OCG /Name (L${i}) >>`);
  }

  let out = "%PDF-1.5\n";
  for (const number of sorted(objs.keys())) {
    out += `${number} 0 obj\n${getOrThrow(objs, number)}\nendobj\n`;
  }
  out += extra_objects;
  // A cross-reference section is required: the COS lexer treats `xref` as
  // end-of-object, and without one an object parse runs on into `trailer`
  // and raises on the unknown keyword.
  out += "xref\n0 1\n0000000000 65535 f \n";
  out += "trailer\n<< /Size 99 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n";
  return encode(out, "latin-1");
}

/** The artwork box of a single-layer PDF built from `content`. */
function measure(content: string, kw: PdfKw = {}): Box | null {
  return readAiLayerBounds("probe.pdf", buildPdf(content, kw))[0];
}

/** `pytest.approx(box)` with a couple of 1/65536 quanta of tolerance. */
function approx(box: Box | null): Approx {
  // A couple of 1/65536 quanta: After Effects' own arithmetic differs from
  // ours in the last fixed-point step or two.
  return { expected: box, opts: { abs: 3 / 65536 } };
}

/** The Python `actual == approx(...)` assertion. */
function expectApprox(actual: Box | null, ap: Approx): void {
  expect(pytestApprox(actual, ap.expected, ap.opts)).toBe(true);
}

describe("TestFills", () => {
  test("test_rect_fill_expands_by_a_quarter_point", () => {
    expectApprox(measure("50 200 100 80 re f"), approx([49.75, 199.75, 150.25, 280.25]));
  });

  test("test_even_odd_fill_matches_non_zero", () => {
    const nonzero = measure("50 200 100 80 re f");
    expectApprox(measure("50 200 100 80 re f*"), approx(nonzero));
  });

  test("test_open_subpath_fill_is_measured", () => {
    expectApprox(
      measure("400 300 m 460 300 l 460 360 l f"),
      approx([399.75, 299.75, 460.25, 360.25]),
    );
  });

  test("test_unpainted_path_contributes_nothing", () => {
    expect(measure("50 200 100 80 re n")).toBe(null);
  });

  test("test_control_point_hull_not_curve_bounds", () => {
    // The cubic peaks 112.5 above its ends; its control points sit 150
    // above, and After Effects measures the control points.
    expectApprox(
      measure("40 480 m 240 630 -60 630 140 480 c f"),
      approx([-60.25, 479.75, 240.25, 630.25]),
    );
  });

  test("test_contributions_union", () => {
    expectApprox(
      measure("20 160 40 40 re f 200 560 30 30 re f"),
      approx([19.75, 159.75, 230.25, 590.25]),
    );
  });
});

describe("TestStrokes", () => {
  test("test_single_straight_segment_has_no_join_term", () => {
    expectApprox(
      measure("10 w 50 250 m 150 250 l S"),
      approx([45.0, 245.0, 155.0, 255.0]),
    );
  });

  test.each([0, 1, 2])("test_cap_style_is_ignored[%#]", (cap) => {
    expectApprox(
      measure(`10 w ${cap} J 50 250 m 150 250 l S`),
      approx([45.0, 245.0, 155.0, 255.0]),
    );
  });

  test.each([0, 1, 2])("test_join_style_is_ignored[%#]", (join) => {
    // All three joins expand by the same worst-case miter term.
    expectApprox(
      measure(`10 w 4 M ${join} j 40 400 m 70 440 l 100 400 l S`),
      approx([30.0, 390.0, 110.0, 450.0]),
    );
  });

  test.each<[number, Box]>([
    [2, [35.0, 395.0, 105.0, 445.0]],
    [4, [30.0, 390.0, 110.0, 450.0]],
  ])("test_joined_stroke_scales_with_the_miter_limit[%#]", (miter: number, expected: Box) => {
    // A joined path expands by (lw / 2) * (miter limit / 2).
    expectApprox(measure(`10 w ${miter} M 40 400 m 70 440 l 100 400 l S`), approx(expected));
  });

  test("test_stroked_rectangle_takes_the_exact_right_angle_miter", () => {
    // sqrt(2) * lw / 2, not the worst-case miter-limit expansion.
    expectApprox(
      measure("10 w 10 M 480 40 60 40 re S"),
      approx([472.9289, 32.9289, 547.0711, 87.0711]),
    );
  });

  test("test_line_width_scales_with_the_matrix", () => {
    expectApprox(
      measure("q 2 0 0 2 0 0 cm 10 w 10 280 m 40 280 l S Q"),
      approx([10.0, 550.0, 90.0, 570.0]),
    );
  });

  test("test_expansion_is_per_axis_not_a_single_scale", () => {
    // A 4x/1x matrix expands x by 20 and y by 5; a geometric-mean scale
    // would give 10 for both.
    expectApprox(
      measure("q 4 0 0 1 0 0 cm 10 w 5 500 m 35 500 l S Q"),
      approx([0.0, 495.0, 160.0, 505.0]),
    );
  });

  test("test_fill_and_stroke_uses_the_stroke_rule_outright", () => {
    // The 0.25 fill pad is not also applied and no max() is taken: at
    // lw 0.04 with miter 4 the expansion is 0.04, well under 0.25.
    expectApprox(
      measure("0.04 w 4 M 400 200 m 460 200 l 460 260 l h B"),
      approx([399.96, 199.96, 460.04, 260.04]),
    );
  });
});

describe("TestShadings", () => {
  const _SHADING =
    "20 0 obj\n<< /ShadingType 2 /ColorSpace /DeviceGray " +
    "/Coords [0 0 1 1] /Function << /FunctionType 2 /C0 [0] /C1 [1] " +
    "/Domain [0 1] /N 1 >> >>\nendobj\n";
  const _RES = "/Shading << /Sh0 20 0 R >>";

  function _shade(content: string): Box | null {
    return measure(content, { extra_objects: _SHADING, resources: _RES });
  }

  test("test_shading_paints_the_clip_region", () => {
    expectApprox(_shade("q 0 0 20 20 re W n /Sh0 sh Q"), approx([-0.25, -0.25, 20.25, 20.25]));
  });

  test.each([
    // A second `W n` at the same level, and one a `q` deeper: both
    // narrow the region, they do not replace it.
    "q 0 0 20 20 re W n 0 0 100 100 re W n /Sh0 sh Q",
    "q 0 0 20 20 re W n q 0 0 100 100 re W n /Sh0 sh Q Q",
    "q 0 0 100 100 re W n q 0 0 20 20 re W n /Sh0 sh Q Q",
  ])("test_a_further_clip_intersects_rather_than_replaces[%#]", (content: string) => {
    expectApprox(_shade(content), approx([-0.25, -0.25, 20.25, 20.25]));
  });

  test("test_a_clip_restored_by_Q_widens_again", () => {
    expectApprox(
      _shade("q 0 0 100 100 re W n q 0 0 20 20 re W n Q /Sh0 sh Q"),
      approx([-0.25, -0.25, 100.25, 100.25]),
    );
  });
});

describe("TestState", () => {
  test("test_graphics_state_spans_layer_boundaries", () => {
    // A `q` pushed in one layer is popped by the next layer's `Q`, so the
    // measurer has to run one state machine over the whole stream.
    const boxes = readAiLayerBounds(
      "probe.pdf",
      buildPdf("q 1 0 0 1 100 100 cm 0 0 40 40 re f", "Q 0 0 40 40 re f"),
    );
    expectApprox(boxes[0], approx([99.75, 99.75, 140.25, 140.25]));
    expectApprox(boxes[1], approx([-0.25, -0.25, 40.25, 40.25]));
  });

  test("test_line_width_persists_across_layers", () => {
    const boxes = readAiLayerBounds("probe.pdf", buildPdf("10 w", "50 250 m 150 250 l S"));
    expectApprox(boxes[1], approx([45.0, 245.0, 155.0, 255.0]));
  });

  test("test_clip_is_ignored_except_for_shadings", () => {
    // Illustrator pre-trims the geometry it writes, and After Effects
    // measures straight through a residual clip.
    expectApprox(
      measure("q 0 0 10 10 re W n 50 200 100 80 re f Q"),
      approx([49.75, 199.75, 150.25, 280.25]),
    );
  });

  test("test_saturates_at_the_fixed_point_range", () => {
    const box = measure("40000 40000 5000 5000 re f");
    assert(box != null);
    const limit = (2 ** 31 - 1) / 65536;
    expect(pytestApprox(box[2], limit, { abs: 1e-4 })).toBe(true);
    expect(pytestApprox(box[3], limit, { abs: 1e-4 })).toBe(true);
    expect(pytestApprox(box[2] - box[0], 0.25, { abs: 1e-3 })).toBe(true);
  });
});

describe("TestXObjects", () => {
  const _FORM =
    "20 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 40 30] " +
    "/Matrix [2 0 0 2 0 0] /Length 0 >>\nstream\n\nendstream\nendobj\n";
  const _IMAGE =
    "21 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 " +
    "/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\n" +
    "stream\nA\nendstream\nendobj\n";
  const _RES = "/XObject << /Fm0 20 0 R /Im0 21 0 R >>";

  test("test_form_bbox_through_matrix_and_ctm_unpadded", () => {
    expectApprox(
      measure("q 1 0 0 1 20 20 cm /Fm0 Do Q", { extra_objects: _FORM, resources: _RES }),
      approx([20.0, 20.0, 100.0, 80.0]),
    );
  });

  test("test_image_unit_square_through_ctm_unpadded", () => {
    expectApprox(
      measure("q 50 0 0 40 200 40 cm /Im0 Do Q", { extra_objects: _IMAGE, resources: _RES }),
      approx([200.0, 40.0, 250.0, 80.0]),
    );
  });

  test("test_inline_image_measures_like_an_image_xobject", () => {
    // `BI ... ID ... EI` is the same painting operator as an image
    // XObject, spelled inline, so it contributes the same unit square.
    const ctm = "q 40 0 0 30 100 100 cm";
    const inline = measure(`${ctm} BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI Q`);
    expectApprox(inline, approx([100.0, 100.0, 140.0, 130.0]));
    expectApprox(
      inline,
      approx(measure(`${ctm} /Im0 Do Q`, { extra_objects: _IMAGE, resources: _RES })),
    );
  });

  test("test_a_layer_may_mix_padded_and_unpadded_contributions", () => {
    // The expansion is applied per contribution, never to the union.
    expectApprox(
      measure("100 100 40 40 re f q 1 0 0 1 300 300 cm /Fm0 Do Q", {
        extra_objects: _FORM,
        resources: _RES,
      }),
      approx([99.75, 99.75, 380.0, 360.0]),
    );
  });
});

/** A font dictionary with neither `/Widths` nor a `/FontDescriptor`. */
function _bareFont(name: string, encoding = ""): string {
  return (
    `20 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /${name}` +
    `${encoding} >>\nendobj\n`
  );
}

describe("TestText", () => {
  const _RES = "/Font << /F1 20 0 R >>";
  const _HELVETICA =
    "20 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica " +
    "/Encoding /WinAnsiEncoding >>\nendobj\n";
  // /Ascent and /Descent deliberately disagree with /FontBBox.
  const _PROBE_FONT =
    "20 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /ProbeFont " +
    "/Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 122 " +
    `/Widths [${Array(91).fill("600").join(" ")}] /FontDescriptor 22 0 R >>\nendobj\n` +
    "22 0 obj\n<< /Type /FontDescriptor /FontName /ProbeFont /Flags 32 " +
    "/FontBBox [-100 -400 1000 1000] /Ascent 800 /Descent -200 >>\n" +
    "endobj\n";

  function _probe(content: string): Box | null {
    return measure(content, { extra_objects: _PROBE_FONT, resources: _RES });
  }

  test("test_vertical_extent_is_the_font_bbox_not_ascent_descent", () => {
    // 1.4 em tall (the FontBBox), not 1.0 em (Ascent minus Descent).
    const box = _probe("BT /F1 24 Tf 40 100 Td (Hg) Tj ET");
    assert(box != null);
    expect(pytestApprox(box[3] - box[1], 33.6, { abs: 1e-3 })).toBe(true);
    expect(pytestApprox(box[1], 100 - 0.4 * 24, { abs: 1e-3 })).toBe(true);
  });

  test("test_horizontal_extent_is_the_full_advance", () => {
    const box = _probe("BT /F1 24 Tf 40 100 Td (Hg) Tj ET");
    assert(box != null);
    expect(pytestApprox(box[2] - box[0], 2 * 0.6 * 24, { abs: 1e-3 })).toBe(true);
  });

  test("test_character_spacing_widens_the_cell", () => {
    const plain = _probe("BT /F1 24 Tf 40 100 Td (Hg) Tj ET");
    const spaced = _probe("BT /F1 24 Tf 5 Tc 40 100 Td (Hg) Tj ET");
    assert(plain != null && spaced != null);
    expect(
      pytestApprox((spaced[2] - spaced[0]) - (plain[2] - plain[0]), 10.0, { abs: 1e-3 }),
    ).toBe(true);
  });

  test("test_horizontal_scaling_widens_only_the_advance", () => {
    const plain = _probe("BT /F1 24 Tf 40 100 Td (Hg) Tj ET");
    const scaled = _probe("BT /F1 24 Tf 200 Tz 40 100 Td (Hg) Tj ET");
    assert(plain != null && scaled != null);
    expect(pytestApprox(scaled[2] - scaled[0], 2 * (plain[2] - plain[0]), { abs: 1e-3 })).toBe(
      true,
    );
    expect(pytestApprox(scaled[3] - scaled[1], plain[3] - plain[1], { abs: 1e-3 })).toBe(true);
  });

  test("test_invisible_render_mode_is_still_measured", () => {
    const plain = _probe("BT /F1 24 Tf 40 100 Td (Hg) Tj ET");
    const hidden = _probe("BT /F1 24 Tf 3 Tr 40 100 Td (Hg) Tj ET");
    expectApprox(hidden, approx(plain));
  });

  test("test_stroking_render_mode_grows_the_cell", () => {
    const box = _probe("BT /F1 24 Tf 1 Tr 10 w 40 100 Td (Hg) Tj ET");
    const plain = _probe("BT /F1 24 Tf 40 100 Td (Hg) Tj ET");
    assert(box != null && plain != null);
    expect(pytestApprox(box[0], plain[0] - 5.0, { abs: 1e-3 })).toBe(true);
    expect(pytestApprox(box[2], plain[2] + 5.0, { abs: 1e-3 })).toBe(true);
  });

  test.each(["Courier", "Courier-Bold", "Times-Bold", "Symbol", "Arial"])(
    "test_built_in_metrics_set_the_cell_height[%#]",
    (font: string) => {
      // That the *values* are right is what the AE fixture in
      // tests/read_only proves; this is the plumbing - a font dictionary
      // with no descriptor reaches the table at all, for every face.
      const [ymin, ymax] = getOrThrow(STD14_EXTENT, font);
      const box = measure("BT /F1 50 Tf 40 300 Td (H) Tj ET", {
        extra_objects: _bareFont(font),
        resources: _RES,
      });
      assert(box != null);
      expect(pytestApprox(box[1], 300.0 + ymin / 20.0)).toBe(true);
      expect(pytestApprox(box[3], 300.0 + ymax / 20.0)).toBe(true);
    },
  );

  test.each(["Courier", "Times-Roman", "ZapfDingbats"])(
    "test_built_in_widths_set_the_advance[%#]",
    (font: string) => {
      // Code 72 is "H"; the table is indexed from STD14_FIRST_CODE.
      const expected = getOrThrow(STD14_WIDTHS, font)[72 - STD14_FIRST_CODE];
      const box = measure("BT /F1 50 Tf 40 300 Td <48> Tj ET", {
        extra_objects: _bareFont(font),
        resources: _RES,
      });
      assert(box != null);
      expect(pytestApprox(box[0], 40.0)).toBe(true);
      expect(pytestApprox(box[2], 40.0 + expected / 20.0)).toBe(true);
    },
  );

  test("test_an_absent_encoding_uses_the_standard_quote_widths", () => {
    // Codes 39 and 96 are the only two in the tabulated range where
    // WinAnsiEncoding and the fonts' built-in StandardEncoding disagree,
    // and After Effects honours whichever the file declares.
    const [quote39, _quote96] = getOrThrow(STD14_STANDARD_QUOTES, "Times-Roman");
    const winansi = getOrThrow(STD14_WIDTHS, "Times-Roman")[39 - STD14_FIRST_CODE];
    expect(quote39).not.toBe(winansi);
    const cases: Array<[string, number]> = [
      ["", quote39],
      [" /Encoding /WinAnsiEncoding", winansi],
    ];
    for (const [encoding, expected] of cases) {
      const box = measure("BT /F1 50 Tf 40 300 Td <27> Tj ET", {
        extra_objects: _bareFont("Times-Roman", encoding),
        resources: _RES,
      });
      assert(box != null);
      expect(pytestApprox(box[2], 40.0 + expected / 20.0)).toBe(true);
    }
  });

  test.each(["[<48>] TJ", "[<48> -50 <48>] TJ"])(
    "test_a_hex_string_in_a_show_array_is_hex_decoded[%#]",
    (shown: string) => {
      // `<48>` is one code (H), not the two characters "4" and "8": the
      // array reader has to decode it exactly as a bare `<48> Tj` does.
      const show = (operands: string): Box | null =>
        measure(`BT /F1 50 Tf 40 300 Td ${operands} ET`, {
          extra_objects: _HELVETICA,
          resources: _RES,
        });

      expectApprox(show(shown), approx(show(shown.replaceAll("<48>", "(H)"))));
    },
  );

  test.each([LF, CR + LF])("test_a_line_continuation_is_not_a_glyph[%#]", (eol: string) => {
    // PDF 7.3.4.2: a reverse solidus before an end-of-line marker is a
    // line continuation, not an escaped newline character.
    const show = (text: string): Box | null =>
      measure(`BT /F1 50 Tf 40 300 Td (${text}) Tj ET`, {
        extra_objects: _HELVETICA,
        resources: _RES,
      });

    const plain = show("HH");
    expectApprox(show("H" + SOLIDUS + eol + "H"), approx(plain));
    // A `SOLIDUS n` escape is a real linefeed character, still measured.
    expect(!valueEquals(show("H" + SOLIDUS + "nH"), plain)).toBe(true);
  });

  test("test_font_outside_the_table_uses_the_generic_extent", () => {
    // A face After Effects can resolve but py_aep has no metrics for.
    const box = measure("BT /F1 50 Tf 40 300 Td (H) Tj ET", {
      extra_objects: _bareFont("Verdana"),
      resources: _RES,
    });
    assert(box != null);
    expect(pytestApprox([box[1], box[3]], [287.5, 337.5])).toBe(true);
  });

  test("test_standard_14_metrics_without_widths_or_descriptor", () => {
    // /Helvetica with neither /Widths nor /FontDescriptor: the built-in
    // AFM widths (722 + 556) and FontBBox (-225 .. 931).
    const box = measure("BT /F1 24 Tf 40 300 Td (Hg) Tj ET", {
      extra_objects: _HELVETICA,
      resources: _RES,
    });
    expectApprox(box, approx([40.0, 294.6, 70.672, 322.344]));
  });
});

describe("TestUnsupported", () => {
  test("test_not_a_pdf_raises", () => {
    raises(
      UnsupportedAiLayersError,
      () => readAiLayerBounds("probe.ai", b("not a pdf at all")),
      "PDF-compatible",
    );
  });

  test("test_no_layers_raises", () => {
    raises(
      UnsupportedAiLayersError,
      () => readAiLayerBounds("probe.pdf", b("%PDF-1.5\nnothing here\n")),
      "no layers",
    );
  });

  test("test_object_streams_raise", () => {
    const data = buildPdf("50 200 100 80 re f", {
      extra_objects: "9 0 obj\n<< /Type /ObjStm >>\nendobj\n",
    });
    raises(
      UnsupportedAiLayersError,
      () => readAiLayerBounds("probe.pdf", data),
      "object streams",
    );
  });

  test("test_encrypted_raises", () => {
    // NOTE(port): pyrt bytes_.replace has no count argument; the pattern occurs once in build_pdf output, so replace-all equals Python's `.replace(..., 1)`.
    const data = Bytes.replace(
      buildPdf("50 200 100 80 re f"),
      b("trailer\n<< /Size 99"),
      b("trailer\n<< /Encrypt 9 0 R /Size 99"),
    );
    raises(UnsupportedAiLayersError, () => readAiLayerBounds("probe.pdf", data), "encrypted");
  });
});

describe("TestMultipleArtboards", () => {
  test("test_warns_and_measures_the_first_page", () => {
    // After Effects measures the SECOND page here and reports
    // first-artboard layers as empty; py_aep measures the first and warns
    // rather than discarding artwork.
    // NOTE(port): warns() matches the message only; "artboards" is emitted solely by py_aep's UserWarning in ai_bounds, so the category check adds nothing here.
    // NOTE(port): pyrt bytes_.replace has no count argument; the pattern occurs once in build_pdf output, so replace-all equals Python's `.replace(..., 1)`.
    const data = Bytes.replace(
      buildPdf("50 200 100 80 re f", {
        extra_objects:
          "30 0 obj\n<< /Type /Page /Parent 2 0 R " + "/MediaBox [0 0 200 200] >>\nendobj\n",
      }),
      b("/Kids [3 0 R] /Count 1"),
      b("/Kids [3 0 R 30 0 R] /Count 2"),
    );
    let boxes: Array<Box | null> = [];
    warns(() => {
      boxes = readAiLayerBounds("probe.pdf", data);
    }, "artboards");
    expectApprox(boxes[0], approx([49.75, 199.75, 150.25, 280.25]));
  });
});

describe("TestFootageSize", () => {
  /** `footage_size`, the pixel size After Effects derives from a box. */

  test("test_empty_layer_floors_at_one_pixel", () => {
    expect(valueEquals(footageSize(null), [1, 1])).toBe(true);
    expect(valueEquals(footageSize(EMPTY_BOX), [1, 1])).toBe(true);
  });

  test("test_a_fractional_extent_ceils", () => {
    expect(valueEquals(footageSize([112.748, 239.5073, 593.931, 675.999]), [482, 437])).toBe(true);
  });

  test.each([0.0, 1e-12, -1e-12])(
    "test_float_noise_around_an_integer_does_not_add_a_pixel[%#]",
    (noise: number) => {
      // The box reaches AE as signed 16.16, so the extent is quantized
      // before it is ceilinged: 80 + 1e-12 must not measure 81 pixels.
      expect(valueEquals(footageSize([10.0, 20.0, 90.0 + noise, 40.0 + noise]), [80, 20])).toBe(true);
    },
  );
});
