/** Tests for the SVG reader package (`py_aep.svg`). */

import { describe, expect, test } from "bun:test";


import { Path, at, b, getOrThrow, assert, valueEquals, zip } from "../../src/pyrt/index.ts";
import { asInstance } from "../helpers.ts";
import { GradientPaint, type GradientStop, SolidPaint, SvgDocument, UnsupportedSVGError, readSvg } from "../../src/py_aep/svg/index.ts";
import { parseColor } from "../../src/py_aep/svg/colors.ts";
import { parsePath } from "../../src/py_aep/svg/path_data.ts";
import { cubicsToSubpath, elementSubpaths } from "../../src/py_aep/svg/shapes.ts";
import { parseCss, resolveProperties } from "../../src/py_aep/svg/style.ts";
import { IDENTITY, parseTransform } from "../../src/py_aep/svg/transform.ts";
import { approx, raises, skip } from "../support/pytest.ts";
import { min, sorted } from "../support/python.ts";

// Python: Path(__file__).parent.parent.parent / "samples" / ...
const SAMPLE = new Path(import.meta.path).parent.parent.parent.div("samples", "assets", "svg.svg");

function _approx(a: Iterable<number>, b: Iterable<number>, tol = 1e-6): boolean {
  return zip([...a], [...b]).every(([x, y]) => Math.abs(x - y) <= tol);
}

describe("TestTransform", () => {
  test("test_translate", () => {
    const t = parseTransform("translate(10, 20)");
    expect(valueEquals(t.apply(1.0, 2.0), [11.0, 22.0])).toBe(true);
  });

  test("test_scale_single_arg_uniform", () => {
    const t = parseTransform("scale(3)");
    expect(valueEquals(t.apply(2.0, 4.0), [6.0, 12.0])).toBe(true);
  });

  test("test_matrix", () => {
    const t = parseTransform("matrix(1,0,0,1,530,-84)");
    expect(valueEquals(t.apply(480.5, 316.5), [1010.5, 232.5])).toBe(true);
  });

  test("test_rotate_90", () => {
    const t = parseTransform("rotate(90)");
    const [x, y] = t.apply(1.0, 0.0);
    expect(_approx([x, y], [0.0, 1.0], 1e-9)).toBe(true);
  });

  test("test_rotate_about_center", () => {
    const t = parseTransform("rotate(180 5 5)");
    expect(_approx(t.apply(5.0, 0.0), [5.0, 10.0], 1e-9)).toBe(true);
  });

  test("test_compose_left_applies_last", () => {
    // translate then scale: scale applies first to the point.
    const t = parseTransform("translate(10,0) scale(2)");
    expect(valueEquals(t.apply(3.0, 0.0), [16.0, 0.0])).toBe(true);
  });

  test("test_mean_scale", () => {
    expect(approx(parseTransform("scale(2,8)").meanScale, 4.0)).toBe(true);
  });

  test("test_unknown_transform_raises", () => {
    raises(UnsupportedSVGError, () => parseTransform("warp(3)"));
  });
});

describe("TestPathData", () => {
  test("test_move_line_close_square", () => {
    const subs = parsePath("M0,0 L10,0 L10,10 L0,10 Z");
    expect(subs.length).toBe(1);
    expect(subs[0].closed).toBe(true);
    // 4 drawn segments + a closing segment back to start would be 5, but
    // the explicit return is not needed; closing segment added since the
    // last point (0,10) != start (0,0).
    expect(subs[0].segments.length).toBe(4);
  });

  test("test_horizontal_vertical", () => {
    const subs = parsePath("M0,0 H10 V10");
    const [seg0, seg1] = subs[0].segments;
    expect(valueEquals([seg0[6], seg0[7]], [10.0, 0.0])).toBe(true);
    expect(valueEquals([seg1[6], seg1[7]], [10.0, 10.0])).toBe(true);
  });

  test("test_cubic", () => {
    const subs = parsePath("M0,0 C1,2 3,4 5,6");
    const seg = subs[0].segments[0];
    expect(valueEquals(seg, [0, 0, 1, 2, 3, 4, 5, 6])).toBe(true);
  });

  test("test_smooth_cubic_reflects_control", () => {
    const subs = parsePath("M0,0 C1,1 2,2 3,3 S5,5 6,6");
    const s2 = subs[0].segments[1];
    // Reflected control of (2,2) about (3,3) is (4,4).
    expect(valueEquals([s2[2], s2[3]], [4.0, 4.0])).toBe(true);
  });

  test("test_quadratic_elevated_to_cubic", () => {
    const subs = parsePath("M0,0 Q3,3 6,0");
    const seg = subs[0].segments[0];
    expect(_approx([seg[2], seg[3]], [2.0, 2.0])).toBe(true);
    expect(_approx([seg[4], seg[5]], [4.0, 2.0])).toBe(true);
  });

  test("test_relative_commands", () => {
    const subs = parsePath("m10,10 l5,0 l0,5");
    const [seg0, seg1] = subs[0].segments;
    expect(valueEquals([seg0[6], seg0[7]], [15.0, 10.0])).toBe(true);
    expect(valueEquals([seg1[6], seg1[7]], [15.0, 15.0])).toBe(true);
  });

  test("test_multiple_subpaths", () => {
    const subs = parsePath("M0,0 L1,0 M5,5 L6,5 Z");
    expect(subs.length).toBe(2);
    expect(subs[0].closed).toBe(false);
    expect(subs[1].closed).toBe(true);
  });

  test("test_arc_quarter_circle", () => {
    // Quarter circle radius 10 from (10,0) to (0,10).
    const subs = parsePath("M10,0 A10,10 0 0 1 0,10");
    const seg = at(subs[0].segments, -1);
    expect(_approx([seg[6], seg[7]], [0.0, 10.0], 1e-6)).toBe(true);
  });

  test("test_arc_compacted_flags_match_spaced", () => {
    // The W3C path grammar allows the large-arc-flag and sweep-flag to be
    // written with no separator from each other or the next coordinate
    // (e.g. "11" or fused "110"); they must parse the same as the spaced
    // form. Regression for the context-free tokenizer that misread "11"
    // as the single number 11 (crash or wrong arc). AE 2026 imports the
    // compacted arc to exactly this geometry.
    const spaced = parsePath("M10,0 A10,10 0 1 1 0,10");
    const compact = parsePath("M10,0 A10,10 0 11 0,10");
    const fused = parsePath("M10,0 A10,10 0 110,10");
    expect(valueEquals(compact[0].segments, spaced[0].segments)).toBe(true);
    expect(valueEquals(fused[0].segments, spaced[0].segments)).toBe(true);
  });

  test("test_arc_compacted_zero_flags", () => {
    // "00" must split into two 0/0 flags, not the number 0.
    const spaced = parsePath("M10,0 A10,10 0 0 0 0,10");
    const compact = parsePath("M10,0 A10,10 0 00 0,10");
    expect(valueEquals(compact[0].segments, spaced[0].segments)).toBe(true);
  });
});

describe("TestShapes", () => {
  test("test_rect_sharp", () => {
    const raws = elementSubpaths(
      "rect",
      new Map([["x", "0"], ["y", "0"], ["width", "4"], ["height", "2"]]),
    );
    const sp = cubicsToSubpath(raws[0], IDENTITY);
    if (sp == null) throw new Error("no subpath");
    expect(sp.closed).toBe(true);
    expect(valueEquals(sp.vertices, [[0, 0], [4, 0], [4, 2], [0, 2]])).toBe(true);
    expect(sp.outTangents.every((t) => valueEquals(t, [0.0, 0.0]))).toBe(true);
  });

  test("test_rect_rounded_has_bezier_corners", () => {
    const raws = elementSubpaths(
      "rect",
      new Map([["width", "10"], ["height", "10"], ["rx", "2"], ["ry", "2"]]),
    );
    const sp = cubicsToSubpath(raws[0], IDENTITY);
    if (sp == null) throw new Error("no subpath");
    expect(sp.vertices.length).toBe(8);
    expect(sp.inTangents.some((t) => !valueEquals(t, [0.0, 0.0]))).toBe(true);
  });

  test("test_ellipse_four_vertices", () => {
    const raws = elementSubpaths(
      "ellipse",
      new Map([["cx", "0"], ["cy", "0"], ["rx", "10"], ["ry", "5"]]),
    );
    const sp = cubicsToSubpath(raws[0], IDENTITY);
    if (sp == null) throw new Error("no subpath");
    expect(sp.vertices.length).toBe(4);
    expect(sp.closed).toBe(true);
    // AE 2026 starts an imported circle/ellipse at the top vertex and runs
    // clockwise (top, right, bottom, left), out tangent pointing right.
    expect(_approx(sp.vertices[0], [0.0, -5.0])).toBe(true);
    expect(_approx(sp.vertices[1], [10.0, 0.0])).toBe(true);
    expect(_approx(sp.outTangents[0], [10.0 * 0.5522847498307936, 0.0])).toBe(true);
  });

  test("test_polygon_closed", () => {
    const raws = elementSubpaths("polygon", new Map([["points", "0,0 10,0 5,8"]]));
    const sp = cubicsToSubpath(raws[0], IDENTITY);
    if (sp == null) throw new Error("no subpath");
    expect(sp.closed).toBe(true);
    expect(valueEquals(sp.vertices, [[0, 0], [10, 0], [5, 8]])).toBe(true);
  });

  test("test_polyline_open", () => {
    const raws = elementSubpaths("polyline", new Map([["points", "0,0 10,0 5,8"]]));
    const sp = cubicsToSubpath(raws[0], IDENTITY);
    if (sp == null) throw new Error("no subpath");
    expect(sp.closed).toBe(false);
  });

  test("test_unsupported_element", () => {
    raises(UnsupportedSVGError, () => elementSubpaths("image", new Map()));
  });

  test("test_transform_applied_to_vertices", () => {
    const raws = elementSubpaths("rect", new Map([["width", "2"], ["height", "2"]]));
    const sp = cubicsToSubpath(raws[0], parseTransform("translate(100,50)"));
    if (sp == null) throw new Error("no subpath");
    expect(valueEquals(sp.vertices[0], [100.0, 50.0])).toBe(true);
  });
});

describe("TestColors", () => {
  test("test_hex6", () => {
    const color = parseColor("#ffa619");
    assert(color != null);
    expect(_approx(color, [1.0, 166 / 255, 25 / 255, 1.0])).toBe(true);
  });

  test("test_hex3_expands", () => {
    expect(valueEquals(parseColor("#fff"), [1.0, 1.0, 1.0, 1.0])).toBe(true);
  });

  test("test_rgb", () => {
    expect(valueEquals(parseColor("rgb(255,0,0)"), [1.0, 0.0, 0.0, 1.0])).toBe(true);
  });

  test("test_rgba_alpha", () => {
    expect(valueEquals(parseColor("rgba(0,0,0,0.5)"), [0.0, 0.0, 0.0, 0.5])).toBe(true);
  });

  test("test_named", () => {
    expect(valueEquals(parseColor("red"), [1.0, 0.0, 0.0, 1.0])).toBe(true);
  });

  test("test_hsl_red", () => {
    const color = parseColor("hsl(0,100%,50%)");
    assert(color != null);
    expect(_approx(color, [1.0, 0.0, 0.0, 1.0])).toBe(true);
  });

  test("test_none_is_none", () => {
    expect(parseColor("none") == null).toBe(true);
  });

  test("test_currentcolor", () => {
    expect(
      valueEquals(parseColor("currentColor", [0.1, 0.2, 0.3, 1.0]), [0.1, 0.2, 0.3, 1.0]),
    ).toBe(true);
  });
});

describe("TestStyle", () => {
  test("test_inheritance_of_fill", () => {
    const parent = resolveProperties(new Map(), "svg", new Map([["fill", "none"]]), []);
    const child = resolveProperties(parent, "path", new Map(), []);
    expect(getOrThrow(child, "fill")).toBe("none");
  });

  test("test_child_overrides_parent", () => {
    const parent = resolveProperties(new Map(), "g", new Map([["fill", "red"]]), []);
    const child = resolveProperties(parent, "path", new Map([["fill", "blue"]]), []);
    expect(getOrThrow(child, "fill")).toBe("blue");
  });

  test("test_opacity_not_inherited", () => {
    const parent = resolveProperties(new Map(), "g", new Map([["opacity", "0.5"]]), []);
    const child = resolveProperties(parent, "path", new Map(), []);
    expect(child.has("opacity")).toBe(false);
  });

  test("test_css_class_beats_presentation_attr", () => {
    const rules = parseCss(".hi { fill: green; }");
    const style = resolveProperties(
      new Map(),
      "path",
      new Map([["class", "hi"], ["fill", "red"]]),
      rules,
    );
    expect(getOrThrow(style, "fill")).toBe("green");
  });

  test("test_inline_style_strongest", () => {
    const rules = parseCss("path { fill: green; }");
    const style = resolveProperties(
      new Map(),
      "path",
      new Map([["style", "fill:purple"], ["fill", "red"]]),
      rules,
    );
    expect(getOrThrow(style, "fill")).toBe("purple");
  });

  test("test_id_specificity_beats_class", () => {
    const rules = parseCss(".c { fill: green; } #a { fill: orange; }");
    const style = resolveProperties(
      new Map(),
      "path",
      new Map([["id", "a"], ["class", "c"]]),
      rules,
    );
    expect(getOrThrow(style, "fill")).toBe("orange");
  });
});

describe("TestReadSvgSample", () => {
  test("test_canvas_from_viewbox", () => {
    const doc = readSvg(SAMPLE);
    expect(valueEquals([doc.width, doc.height], [1070.0, 456.0])).toBe(true);
  });

  test("test_drawable_count_matches_ae", () => {
    // AE 2026 produced 29 vector groups for this SVG (one per leaf).
    const doc = readSvg(SAMPLE);
    expect(doc.drawables.length).toBe(29);
  });

  test("test_group_opacity_folded_into_drawable", () => {
    // svg.svg has two <g opacity="0.3"> groups; AE bakes group opacity
    // into the leaf's paint opacity, so the reader folds it into each
    // affected drawable (the rest stay fully opaque).
    const doc = readSvg(SAMPLE);
    const opacities = sorted(
      doc.drawables.filter((d) => d.opacity !== 1.0).map((d) => d.opacity),
    );
    expect(approx(opacities, [0.3, 0.3])).toBe(true);
  });

  test("test_nested_opacity_multiplies", () => {
    // Nested element/group opacities composite multiplicatively.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<g opacity="0.5"><g opacity="0.4">' +
      '<rect x="0" y="0" width="4" height="4" fill="#f00"/>' +
      "</g></g></svg>";
    const doc = readSvg(svg);
    expect(doc.drawables.length).toBe(1);
    expect(approx(doc.drawables[0].opacity, 0.2)).toBe(true);
  });

  test("test_fill_stroke_opacity_attrs_applied", () => {
    // fill-opacity / stroke-opacity scale their own paint's alpha (After
    // Effects' import ignores both; py_aep renders what the SVG says).
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<rect x="0" y="0" width="4" height="4" fill="rgba(255,0,0,0.8)" ' +
      'fill-opacity="0.5" stroke="#00f" stroke-width="1" ' +
      'stroke-opacity="25%"/></svg>';
    const drawable = readSvg(svg).drawables[0];
    assert(drawable.fill instanceof SolidPaint);
    expect(approx(drawable.fill.color[3], 0.4)).toBe(true);
    if (drawable.stroke == null) throw new Error("drawable has no stroke");
    assert(drawable.stroke.paint instanceof SolidPaint);
    expect(approx(drawable.stroke.paint.color[3], 0.25)).toBe(true);
    expect(drawable.opacity).toBe(1.0);
  });

  test("test_fill_opacity_inherits", () => {
    // Unlike `opacity`, fill-opacity is inherited from a group.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<g fill-opacity="0.5"><rect width="4" height="4" fill="#f00"/></g>' +
      "</svg>";
    const drawable = readSvg(svg).drawables[0];
    expect(approx(asInstance(drawable.fill, SolidPaint).color[3], 0.5)).toBe(true);
    expect(drawable.opacity).toBe(1.0);
  });

  test("test_fill_opacity_scales_gradient_stops", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<linearGradient id="g"><stop offset="0" stop-color="#f00"/>' +
      '<stop offset="1" stop-color="#00f" stop-opacity="0.5"/>' +
      "</linearGradient>" +
      '<rect width="4" height="4" fill="url(#g)" fill-opacity="0.5"/></svg>';
    const fill = readSvg(svg).drawables[0].fill;
    assert(fill instanceof GradientPaint);
    expect(approx(fill.stops.map((s: GradientStop) => s.color[3]), [0.5, 0.25])).toBe(true);
  });

  test("test_first_drawable_geometry_absolute", () => {
    const doc = readSvg(SAMPLE);
    // Tail Shape 1, group matrix(1,0,0,1,530,-84), path M480.5,316.5.
    expect(valueEquals(doc.drawables[0].subpaths[0].vertices[0], [1010.5, 232.5])).toBe(true);
  });

  test("test_stroke_only_paths_have_no_fill", () => {
    // Root <svg fill="none"> -> stroke-only paths inherit no fill.
    const doc = readSvg(SAMPLE);
    const strokeOnly = doc.drawables.filter((d) => d.stroke != null && d.fill == null);
    expect(strokeOnly.length).toBe(4);
  });

  test("test_smil_animation_dropped", () => {
    // The SVG has animateTransform elements; none should appear as
    // geometry, and the count stays at the leaf-drawable total.
    const doc = readSvg(SAMPLE);
    expect(doc.drawables.every((d) => d.fill == null || d.fill instanceof SolidPaint)).toBe(true);
  });
});

describe("TestReadSvgFeatures", () => {
  test("test_use_expands_reference", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <defs><rect id="r" width="10" height="10"/></defs>
          <use href="#r" x="5" y="5"/>
        </svg>`;
    const doc = readSvg(svg);
    expect(doc.drawables.length).toBe(1);
    expect(valueEquals(doc.drawables[0].subpaths[0].vertices[0], [5.0, 5.0])).toBe(true);
  });

  test("test_gradient_fill_resolved", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <defs>
            <linearGradient id="g" gradientUnits="userSpaceOnUse"
                x1="0" y1="0" x2="100" y2="0">
              <stop offset="0" stop-color="#ff0000"/>
              <stop offset="1" stop-color="#0000ff"/>
            </linearGradient>
          </defs>
          <rect width="100" height="100" fill="url(#g)"/>
        </svg>`;
    const doc = readSvg(svg);
    const paint = doc.drawables[0].fill;
    assert(paint instanceof GradientPaint);
    expect(paint.kind).toBe("linear");
    expect(paint.stops.length).toBe(2);
    expect(_approx(paint.start, [0.0, 0.0])).toBe(true);
    expect(_approx(paint.end, [100.0, 0.0])).toBe(true);
  });

  test("test_gradient_stop_offset_over_one_clamped", () => {
    // SVG spec clamps stop offsets to [0, 1]; an offset > 100% must not
    // crash the strict normalized-float validator in the AE gradient model.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <defs><linearGradient id="g">
            <stop offset="0%" stop-color="#ff0000"/>
            <stop offset="150%" stop-color="#0000ff"/>
          </linearGradient></defs>
          <rect width="100" height="100" fill="url(#g)"/>
        </svg>`;
    const paint = readSvg(svg).drawables[0].fill;
    assert(paint instanceof GradientPaint);
    expect(at(paint.stops, -1).offset).toBe(1.0);
  });

  test("test_gradient_coord_with_unit_suffix", () => {
    // A unit-suffixed gradient coordinate/radius (legal in userSpaceOnUse)
    // must parse, not raise on bare float("40px").
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <defs><radialGradient id="g" gradientUnits="userSpaceOnUse"
              cx="50" cy="50" r="40px">
            <stop offset="0" stop-color="#fff"/>
            <stop offset="1" stop-color="#000"/>
          </radialGradient></defs>
          <circle cx="50" cy="50" r="40" fill="url(#g)"/>
        </svg>`;
    const paint = readSvg(svg).drawables[0].fill;
    assert(paint instanceof GradientPaint);
    expect(_approx(paint.start, [50.0, 50.0])).toBe(true);
    expect(_approx(paint.end, [90.0, 50.0])).toBe(true);
  });

  test("test_radial_gradient_transform_maps_to_grad_scale", () => {
    // A radial gradientTransform that stretches the gradient vertically
    // (the matrix translation keeps the centre fixed) must surface as an
    // AE Grad Scale aspect ratio, not collapse into a circle. This is the
    // butterfly-wing case (matrix(1 0 0 N 0 ...)).
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <defs><radialGradient id="g" gradientUnits="userSpaceOnUse"
              cx="50" cy="50" r="20"
              gradientTransform="matrix(1 0 0 2 0 -50)">
            <stop offset="0" stop-color="#fff"/>
            <stop offset="1" stop-color="#000"/>
          </radialGradient></defs>
          <circle cx="50" cy="50" r="20" fill="url(#g)"/>
        </svg>`;
    const paint = readSvg(svg).drawables[0].fill;
    assert(paint instanceof GradientPaint);
    // Centre stays put and the x-radius (start/end) is unchanged...
    expect(_approx(paint.start, [50.0, 50.0])).toBe(true);
    expect(_approx(paint.end, [70.0, 50.0])).toBe(true);
    // ...while the 2x vertical stretch lands in Grad Scale Y.
    expect(_approx(paint.scale, [100.0, 200.0], 1e-4)).toBe(true);
    expect(approx(paint.rotation, 360.0)).toBe(true);
  });

  test("test_radial_gradient_unrotated_baseline_is_360", () => {
    // AE stamps an un-rotated, un-stretched radial gradient with a
    // 360-degree rotation (visually 0) and unit scale.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <defs><radialGradient id="g" gradientUnits="userSpaceOnUse"
              cx="50" cy="50" r="20">
            <stop offset="0" stop-color="#fff"/>
            <stop offset="1" stop-color="#000"/>
          </radialGradient></defs>
          <circle cx="50" cy="50" r="20" fill="url(#g)"/>
        </svg>`;
    const paint = readSvg(svg).drawables[0].fill;
    assert(paint instanceof GradientPaint);
    expect(_approx(paint.scale, [100.0, 100.0], 1e-4)).toBe(true);
    expect(approx(paint.rotation, 360.0)).toBe(true);
  });

  test("test_linear_gradient_has_no_scale_or_rotation", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <defs><linearGradient id="g" gradientUnits="userSpaceOnUse"
              x1="0" y1="0" x2="100" y2="0">
            <stop offset="0" stop-color="#f00"/>
            <stop offset="1" stop-color="#00f"/>
          </linearGradient></defs>
          <rect width="100" height="100" fill="url(#g)"/>
        </svg>`;
    const paint = readSvg(svg).drawables[0].fill;
    assert(paint instanceof GradientPaint);
    expect(valueEquals(paint.scale, [100.0, 100.0])).toBe(true);
    expect(paint.rotation === 0.0).toBe(true);
  });

  test("test_deeply_nested_groups_raise_clean_error", () => {
    // Unbounded <g> nesting must raise UnsupportedSVGError, not RecursionError.
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>" +
      "<g>".repeat(600) +
      "<rect width='1' height='1'/>" +
      "</g>".repeat(600) +
      "</svg>";
    raises(UnsupportedSVGError, () => readSvg(svg));
  });

  test("test_display_none_skipped", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
          <rect width="5" height="5" display="none"/>
          <rect width="5" height="5"/>
        </svg>`;
    expect(readSvg(svg).drawables.length).toBe(1);
  });

  test("test_nested_group_transforms_compose", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <g transform="translate(10,10)">
            <g transform="scale(2)">
              <rect width="1" height="1"/>
            </g>
          </g>
        </svg>`;
    const doc = readSvg(svg);
    expect(valueEquals(doc.drawables[0].subpaths[0].vertices[0], [10.0, 10.0])).toBe(true);
    expect(valueEquals(doc.drawables[0].subpaths[0].vertices[2], [12.0, 12.0])).toBe(true);
  });

  test("test_non_svg_root_raises", () => {
    raises(UnsupportedSVGError, () => readSvg("<html xmlns='http://www.w3.org/2000/svg'></html>"));
  });

  test("test_accepts_bytes", () => {
    const svg = b("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'><rect width='8' height='8'/></svg>");
    const doc = readSvg(svg);
    expect(doc instanceof SvgDocument).toBe(true);
    expect(doc.width).toBe(8.0);
  });
});

/** Significant whitespace between adjacent <tspan> runs is preserved. */
class TestTextWhitespace {
  static _last_run_min_x(svg: string): number | null {
    const doc = readSvg(svg);
    // Text outlining needs a resolvable font; if none is installed the
    // runs produce no drawables and there is nothing to assert.
    if (doc.drawables.length < 2) return null;
    return min(
      at(doc.drawables, -1).subpaths.flatMap((sp) => sp.vertices.map((v) => v[0])),
    );
  }
}

describe("TestTextWhitespace", () => {
  test("test_inter_tspan_space_advances_next_run", () => {
    const head =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">' +
      '<text x="20" y="130" font-size="72">';
    const spaced = TestTextWhitespace._last_run_min_x(
      head + "<tspan>foo</tspan> <tspan>bar</tspan></text></svg>",
    );
    const flush = TestTextWhitespace._last_run_min_x(
      head + "<tspan>foo</tspan><tspan>bar</tspan></text></svg>",
    );
    if (spaced == null || flush == null) {
      return skip("no outline font available to render text");
    }
    // The space between the runs pushes `bar` to the right; without the
    // fix the two runs lay out flush and the min-x would be equal.
    expect(spaced > flush).toBe(true);
  });
});
