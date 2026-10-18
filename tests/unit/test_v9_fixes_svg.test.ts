/**
 * Regression tests for the v9 SVG import fixes.
 *
 * Expected values are the SVG / CSS specifications' and, where stated, what
 * After Effects 2026 writes for its own import of the same SVG.
 */

import { describe, expect, test } from "bun:test";
import { ImportAsType, ImportOptions, new as new_ } from "../../src/py_aep/index.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { GradientPaint, SolidPaint, UnsupportedSVGError, read_svg } from "../../src/py_aep/svg/index.ts";
import { parse_color } from "../../src/py_aep/svg/colors.ts";
import { IDENTITY, parse_transform } from "../../src/py_aep/svg/transform.ts";
import { at, encode, max, min, py_assert, py_eq, zip, type Path } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { as_instance } from "../helpers.ts";

const NS = 'xmlns="http://www.w3.org/2000/svg"';

function _svg(body: string, attrs = 'viewBox="0 0 200 100"'): string {
  return `<svg ${NS} ${attrs}>${body}</svg>`;
}

function _vertices(markup: string): number[][] {
  return read_svg(markup).drawables[0].subpaths[0].vertices;
}

function _bbox(markup: string): [number, number, number, number] {
  const vs = _vertices(markup);
  const xs = vs.map((v) => v[0]);
  const ys = vs.map((v) => v[1]);
  return [min(xs), min(ys), max(xs), max(ys)];
}

function _import(tmp_path: Path, markup: string): CompItem {
  const svg = tmp_path.div("probe.svg");
  // encoding="utf-8" is the default of pyrt Path.write_text.
  svg.write_text(markup);
  const app = new_();
  const opts = new ImportOptions(svg);
  opts.import_as = ImportAsType.COMP_CROPPED_LAYERS;
  const comp = app.project.import_file(opts);
  return as_instance(comp, CompItem);
}

function _approx(a: number[], b: number[], tol = 1e-9): boolean {
  return zip(a, b).every(([x, y]) => Math.abs(x - y) <= tol);
}

describe("TestMiterLimit", () => {
  test.each(["0.5", "0", "-4"])("test_below_one_clamps_to_one[%#]", (value) => {
    const tmp_path = make_tmp_path();
    // AE 2026 imports stroke-miterlimit="0.5" with Miter Limit 1.0.
    const comp = _import(
      tmp_path,
      _svg(
        "<path d='M10 10 L50 50 L90 10' stroke='red' fill='none' " +
          `stroke-miterlimit='${value}'/>`,
      ),
    );
    const contents = comp.layers[0].property("ADBE Root Vectors Group");
    const stroke = as_instance(contents.__getitem__(0), PropertyGroup)
      .__getitem__("ADBE Vectors Group")
      .__getitem__("ADBE Vector Graphic - Stroke");
    expect(stroke.__getitem__("ADBE Vector Stroke Miter Limit").value).toBe(1.0);
  });
});

describe("TestBoundingBoxGradients", () => {
  const _RECT = "<rect x='20' y='10' width='80' height='40' fill='url(#g)'/>";

  const _paint = (gradient: string): GradientPaint => {
    const paint = read_svg(_svg(`<defs>${gradient}</defs>${_RECT}`)).drawables[0].fill;
    return as_instance(paint, GradientPaint);
  };

  test("test_plain_number_radius_is_a_box_fraction", () => {
    // AE 2026: r="0.25" on an 80 x 40 box -> a 20 px x radius and Grad
    // Scale [100, 50].
    const paint = _paint(
      "<radialGradient id='g' r='0.25'><stop offset='0' stop-color='red'/>" +
        "<stop offset='1' stop-color='blue'/></radialGradient>",
    );
    expect(_approx(paint.start, [60.0, 30.0])).toBe(true);
    expect(_approx(paint.end, [80.0, 30.0])).toBe(true);
    expect(_approx(paint.scale, [100.0, 50.0])).toBe(true);
  });

  test("test_gradient_transform_rotates_in_box_space", () => {
    // AE 2026: rotate(90) turns the left-to-right gradient top-to-bottom.
    const paint = _paint(
      "<linearGradient id='g' gradientTransform='rotate(90)'>" +
        "<stop offset='0' stop-color='red'/><stop offset='1' stop-color='blue'/>" +
        "</linearGradient>",
    );
    expect(_approx(paint.start, [20.0, 10.0])).toBe(true);
    expect(_approx(paint.end, [20.0, 50.0])).toBe(true);
  });

  test("test_gradient_transform_translates_in_box_units", () => {
    // AE 2026: translate(0.5, 0) moves the gradient half the box (40 px).
    const paint = _paint(
      "<linearGradient id='g' gradientTransform='translate(0.5,0)'>" +
        "<stop offset='0' stop-color='red'/><stop offset='1' stop-color='blue'/>" +
        "</linearGradient>",
    );
    expect(_approx(paint.start, [60.0, 10.0])).toBe(true);
    expect(_approx(paint.end, [140.0, 10.0])).toBe(true);
  });

  test("test_out_of_order_stops_clamp_to_the_running_maximum", () => {
    // AE 2026 and SVG: 0.6 red then 0.3 blue is red, then blue at 0.6.
    const paint = _paint(
      "<linearGradient id='g'><stop offset='0.6' stop-color='red'/>" +
        "<stop offset='0.3' stop-color='blue'/></linearGradient>",
    );
    expect(
      py_eq(
        paint.stops.map((s) => [s.offset, s.color.slice(0, 3)]),
        [
          [0.6, [1.0, 0.0, 0.0]],
          [0.6, [0.0, 0.0, 1.0]],
        ],
      ),
    ).toBe(true);
  });
});

describe("TestMalformedInput", () => {
  test("test_wrong_arity_transform_is_ignored", () => {
    // AE 2026 imports a `matrix(1 0 0 1)` group untransformed.
    expect(py_eq([...parse_transform("matrix(1 0 0 1)")], [...IDENTITY])).toBe(true);
    expect(py_eq([...parse_transform("translate(5) skewX()")], [...IDENTITY])).toBe(true);
    const bbox = _bbox(
      _svg("<g transform='matrix(1 0 0 1)'><rect x='3' width='10' height='10'/></g>"),
    );
    expect(py_eq(bbox, [3.0, 0.0, 13.0, 10.0])).toBe(true);
  });

  test("test_non_finite_transform_is_ignored", () => {
    expect(py_eq([...parse_transform("rotate(1e400)")], [...IDENTITY])).toBe(true);
    expect(py_eq([...parse_transform("skewY(1e400)")], [...IDENTITY])).toBe(true);
  });

  test("test_unknown_transform_still_raises", () => {
    raises(UnsupportedSVGError, () => parse_transform("perspective(3)"), "perspective");
  });

  test("test_tiny_arc_radius_scales_up", () => {
    // Radii too small to reach the end point grow to a half ellipse
    // (SVG F.6.6) instead of dividing by an underflowed square.
    const vs = _vertices(
      _svg("<path d='M10 10 A 1e-200 1e-200 0 0 1 80 40' stroke='red'/>"),
    );
    expect(_approx(vs[0], [10.0, 10.0])).toBe(true);
    expect(_approx(at(vs, -1), [80.0, 40.0], 1e-9)).toBe(true);
  });

  test.each([
    ["<path d='M0 0 L 1e400 10 L 0 10 Z'/>"],
    // Finite, but past float32: the saved path could not hold it.
    ["<path d='M0 0 L 1e39 10 L 0 10 Z'/>"],
    ["<rect width='10' height='10' stroke='red' stroke-width='1e400'/>"],
  ])("test_out_of_range_number_raises_unsupported[%#]", (body) => {
    raises(UnsupportedSVGError, () => read_svg(_svg(body)), "out of range");
  });

  test.each([[""], ["not xml"], [`<svg ${NS}><rect>`], [`<svg ${NS}>&undefined;</svg>`]])(
    "test_malformed_xml_raises_unsupported[%#]",
    (markup) => {
      raises(UnsupportedSVGError, () => read_svg(encode(markup, "utf-8")), "Malformed SVG");
    },
  );

  test.each([['viewBox="0 0 0.5 100"'], ['viewBox="0 0 1e400 100"'], ['viewBox="0 0 0 0"'], [""]])(
    "test_unusable_canvas_raises_unsupported[%#]",
    (attrs) => {
      const tmp_path = make_tmp_path();
      raises(
        UnsupportedSVGError,
        () => _import(tmp_path, _svg("<rect width='2' height='2'/>", attrs)),
        "1 to 30000 px",
      );
    },
  );
});

describe("TestLengths", () => {
  test("test_percentage_corner_radius_refers_to_the_viewport", () => {
    // AE 2026: rx="10%" in a 200-wide viewport is 20 (ry = rx, clamped
    // to half the 20 px height).
    const vs = _vertices(_svg("<rect width='50' height='20' rx='10%'/>"));
    expect(_approx(vs[0], [20.0, 0.0])).toBe(true);
  });

  test("test_percentage_stroke_width_refers_to_the_diagonal", () => {
    // AE 2026: 5 % of a 200 x 100 viewBox is 7.906.
    const stroke = read_svg(
      _svg("<rect width='10' height='10' stroke='red' stroke-width='5%'/>"),
    ).drawables[0].stroke;
    py_assert(stroke != null);
    expect(approx(stroke.width, 0.05 * Math.sqrt((200 ** 2 + 100 ** 2) / 2))).toBe(true);
  });

  test.each([
    ["1in", 96.0],
    ["2.54cm", 96.0],
    ["25.4mm", 96.0],
    ["72pt", 96.0],
    ["6pc", 96.0],
    ["3em", 48.0],
    ["4px", 4.0],
  ])("test_absolute_units_follow_css[%#]", (value, px) => {
    const bbox = _bbox(_svg(`<rect width='${value}' height='10'/>`));
    expect(approx(bbox[2], px)).toBe(true);
  });

  test("test_em_follows_the_font_size", () => {
    const bbox = _bbox(_svg("<rect width='2em' height='10' font-size='20'/>"));
    expect(approx(bbox[2], 40.0)).toBe(true);
  });

  test("test_auto_radius_takes_the_other_one", () => {
    // SVG 2 `auto`: a 20-radius circle (py_aep dropped the ellipse; AE
    // 2026 imports it zero-width - a documented divergence).
    const bbox = _bbox(_svg("<ellipse cx='50' cy='50' rx='auto' ry='20'/>"));
    expect(_approx(bbox, [30.0, 30.0, 70.0, 70.0])).toBe(true);
  });
});

describe("TestCascadeAndViewports", () => {
  test("test_important_rule_beats_inline_style", () => {
    // AE 2026: `rect{fill:red !important}` wins over style="fill:blue".
    const fill = read_svg(
      _svg(
        "<style>rect{fill:red !important}</style>" +
          "<rect style='fill:blue' width='10' height='10'/>",
      ),
    ).drawables[0].fill;
    expect(py_eq(as_instance(fill, SolidPaint).color, [1.0, 0.0, 0.0, 1.0])).toBe(true);
  });

  test("test_inline_important_beats_important_rule", () => {
    const fill = read_svg(
      _svg(
        "<style>rect{fill:red !important}</style>" +
          "<rect style='fill:blue !important' width='10' height='10'/>",
      ),
    ).drawables[0].fill;
    expect(py_eq(as_instance(fill, SolidPaint).color, [0.0, 0.0, 1.0, 1.0])).toBe(true);
  });

  test("test_nested_svg_maps_its_viewbox", () => {
    // AE 2026: a 10 x 10 viewBox shown in a 50 x 50 box at (10, 10).
    const bbox = _bbox(
      _svg(
        "<svg x='10' y='10' width='50' height='50' viewBox='0 0 10 10'>" +
          "<rect width='10' height='10'/></svg>",
      ),
    );
    expect(_approx(bbox, [10.0, 10.0, 60.0, 60.0])).toBe(true);
  });

  test("test_nested_svg_meets_and_centres", () => {
    const bbox = _bbox(
      _svg(
        "<svg width='100' height='50' viewBox='0 0 10 10'>" +
          "<rect width='10' height='10'/></svg>",
      ),
    );
    expect(_approx(bbox, [25.0, 0.0, 75.0, 50.0])).toBe(true);
  });

  test("test_nested_svg_percentages_use_its_viewbox", () => {
    const bbox = _bbox(
      _svg(
        "<svg width='100' height='100' viewBox='0 0 10 10'>" +
          "<rect width='50%' height='10'/></svg>",
      ),
    );
    expect(_approx(bbox, [0.0, 0.0, 50.0, 100.0])).toBe(true);
  });

  test("test_use_maps_a_symbol_viewbox", () => {
    // AE 2026: a 10 x 10 symbol instanced at x=20 with width 50 is a
    // 50 x 50 square at (20, 0).
    const bbox = _bbox(
      _svg(
        "<symbol id='s' viewBox='0 0 10 10'><rect width='10' height='10'/>" +
          "</symbol><use href='#s' x='20' width='50' height='50'/>",
      ),
    );
    expect(_approx(bbox, [20.0, 0.0, 70.0, 50.0])).toBe(true);
  });
});

describe("TestRadialRotation", () => {
  test.each([
    ["rotate(30 100 50)", 330.0],
    ["rotate(-60 100 50)", 420.0],
    ["", 360.0],
  ])("test_grad_rotation_is_360_minus_the_screen_angle[%#]", (rotate, expected) => {
    // AE 2026 writes Grad Rotation 330 / 420 / 360 for these.
    const paint = read_svg(
      _svg(
        "<defs><radialGradient id='g' gradientUnits='userSpaceOnUse' " +
          `cx='100' cy='50' r='30' gradientTransform='${rotate}'>` +
          "<stop offset='0' stop-color='white'/>" +
          "<stop offset='1' stop-color='blue'/></radialGradient></defs>" +
          "<rect x='40' width='120' height='100' fill='url(#g)'/>",
      ),
    ).drawables[0].fill;
    expect(approx(as_instance(paint, GradientPaint).rotation, expected)).toBe(true);
  });
});

describe("TestColors", () => {
  test("test_hsl_clamps_saturation_and_lightness_first", () => {
    expect(py_eq(parse_color("hsl(400, 150%, -5%)"), [0.0, 0.0, 0.0, 1.0])).toBe(true);
    expect(py_eq(parse_color("hsl(120, 100%, 25%)"), [0.0, 0.5, 0.0, 1.0])).toBe(true);
  });
});
