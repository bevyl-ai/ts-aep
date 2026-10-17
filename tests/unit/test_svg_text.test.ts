/**
 * Tests for SVG `<text>` / `<tspan>` outlining (svg.text + reader._visit_text).
 *
 * Geometry is checked against a tiny font built on the fly with `fontBuilder`
 * (known square glyphs at 1000 upm), so assertions are exact and machine
 * independent. Reader-level tests monkeypatch font resolution for determinism.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { approx, make_tmp_path, warns } from "../../src/pyrt/pytest.ts";
import { NotImplementedError, Path, py_assert, py_eq } from "../../src/pyrt/index.ts";
import * as reader_mod from "../../src/py_aep/svg/reader.ts";
import { read_svg } from "../../src/py_aep/svg/index.ts";
import { parse_path } from "../../src/py_aep/svg/path_data.ts";
import { TextRun, _glyphs, outline_runs, outline_text_path } from "../../src/py_aep/svg/text.ts";
import { IDENTITY } from "../../src/py_aep/svg/transform.ts";
import { FontBuilder, TTGlyphPen, saveTTC } from "../_fontbuilder.ts";
import * as fonts_mod from "../../src/py_aep/svg/fonts.ts";

// `monkeypatch.setattr`: ESM bindings are read-only, so patched names route through
// the setter hooks exported by svg/reader.ts and svg/fonts.ts; restored after each test.
const monkeypatch_setattr = (obj: unknown, name: string, value: any): void => {
  if (obj === reader_mod && name === "resolve_font") reader_mod._set_resolve_font(value);
  else if (obj === fonts_mod && name === "_font_dirs") fonts_mod._set_font_dirs(value);
  else if (obj === fonts_mod && name === "_index") fonts_mod._set_index(value);
  else throw new NotImplementedError(`monkeypatch.setattr ${name}`);
};
afterEach(() => {
  reader_mod._set_resolve_font(null);
  fonts_mod._set_font_dirs(null);
  fonts_mod._set_index(null);
});

function _build_test_font(path: Path): void {
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    const pen = new TTGlyphPen();
    pen.moveTo([x0, y0]);
    pen.lineTo([x1, y0]);
    pen.lineTo([x1, y1]);
    pen.lineTo([x0, y1]);
    pen.closePath();
    return pen.glyph();
  };

  const empty = new TTGlyphPen().glyph();
  const fb = new FontBuilder(1000, { isTTF: true });
  fb.setupGlyphOrder([".notdef", "space", "A", "B"]);
  fb.setupCharacterMap({ 0x20: "space", 0x41: "A", 0x42: "B" });
  // 'A' and 'B' are identical 400x700 boxes; advance 600 units.
  fb.setupGlyf({
    ".notdef": empty,
    space: empty,
    A: box(100, 0, 500, 700),
    B: box(100, 0, 500, 700),
  });
  fb.setupHorizontalMetrics({
    ".notdef": [600, 0],
    space: [600, 0],
    A: [600, 100],
    B: [600, 100],
  });
  fb.setupHorizontalHeader({ ascent: 800, descent: -200 });
  fb.setupNameTable({ familyName: "PyAepTest", styleName: "Regular" });
  fb.setupOS2();
  fb.setupPost();
  fb.save(String(path));
}

// Python: @pytest.fixture(scope="module") test_font(tmp_path_factory).
// Renamed fixture_test_font so each test can bind `const test_font = ...`
// and keep every body reference verbatim.
let _test_font_cache: Path | null = null;
function fixture_test_font(): Path {
  if (_test_font_cache == null) {
    const fonts_dir = make_tmp_path().div("fonts");
    fonts_dir.mkdir({ parents: true, exist_ok: true });
    const path = fonts_dir.div("pyaeptest.ttf");
    _build_test_font(path);
    _test_font_cache = path;
  }
  return _test_font_cache;
}

function _xrange(sp: any): [number, number] {
  const xs = sp.vertices.map((v: any) => v[0]);
  return [Math.min(...xs), Math.max(...xs)];
}

function _yrange(sp: any): [number, number] {
  const ys = sp.vertices.map((v: any) => v[1]);
  return [Math.min(...ys), Math.max(...ys)];
}

test("test_glyph_outline_geometry", () => {
  const test_font = fixture_test_font();
  // 'A' box 100..500 x, 0..700 y at font-size 100 (scale 0.1), baseline 0:
  // x -> 10..50, y flipped -> -70..0.
  const [subs] = outline_runs([new TextRun("A", test_font, 100.0)], 0.0, 0.0, IDENTITY);
  expect(subs.length).toBe(1);
  const sp = subs[0];
  expect(sp.closed).toBe(true);
  expect(sp.vertices.length).toBe(4);
  expect(py_eq(_xrange(sp), [10.0, 50.0])).toBe(true);
  expect(py_eq(_yrange(sp), [-70.0, 0.0])).toBe(true);
});

test("test_advance_layout", () => {
  const test_font = fixture_test_font();
  // Two glyphs in one run; advance 600 * 0.1 = 60, so 'B' shifts right by 60.
  const [subs] = outline_runs([new TextRun("AB", test_font, 100.0)], 0.0, 0.0, IDENTITY);
  expect(subs.length).toBe(2);
  expect(py_eq(_xrange(subs[0]), [10.0, 50.0])).toBe(true);
  expect(py_eq(_xrange(subs[1]), [70.0, 110.0])).toBe(true);
});

test("test_anchor_end_shifts_left", () => {
  const test_font = fixture_test_font();
  // Run width 60; text-anchor=end shifts the whole run left by its width.
  const [subs] = outline_runs([new TextRun("A", test_font, 100.0)], 0.0, 0.0, IDENTITY, "end");
  expect(py_eq(_xrange(subs[0]), [-50.0, -10.0])).toBe(true);
});

test("test_anchor_middle_centers", () => {
  const test_font = fixture_test_font();
  const [subs] = outline_runs([new TextRun("A", test_font, 100.0)], 0.0, 0.0, IDENTITY, "middle");
  expect(py_eq(_xrange(subs[0]), [-20.0, 20.0])).toBe(true);
});

test("test_reader_outlines_text", () => {
  const test_font = fixture_test_font();
  monkeypatch_setattr(reader_mod, "resolve_font", (...a: any[]) => [test_font, 0]);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">' +
    '<text x="10" y="80" font-size="100" fill="#ff0000">AB</text></svg>';
  const doc = read_svg(svg);
  expect(doc.drawables.length).toBe(1);
  const d = doc.drawables[0];
  expect(d.subpaths.length).toBe(2);
  expect(d.fill != null).toBe(true);
  expect(py_eq(Array.from((d.fill as any).color.slice(0, 3)), [1.0, 0.0, 0.0])).toBe(true);
});

test("test_reader_tspan_per_run_fill", () => {
  const test_font = fixture_test_font();
  // Parent text and a <tspan> with its own fill become two drawables.
  monkeypatch_setattr(reader_mod, "resolve_font", (...a: any[]) => [test_font, 0]);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">' +
    '<text x="10" y="80" font-size="100" fill="#000000">A' +
    '<tspan fill="#ff0000">B</tspan></text></svg>';
  const doc = read_svg(svg);
  expect(doc.drawables.length).toBe(2);
  expect(py_eq(Array.from((doc.drawables[0].fill as any).color.slice(0, 3)), [0.0, 0.0, 0.0])).toBe(true);
  expect(py_eq(Array.from((doc.drawables[1].fill as any).color.slice(0, 3)), [1.0, 0.0, 0.0])).toBe(true);
});

test("test_reader_tspan_inherits_font_size", () => {
  const test_font = fixture_test_font();
  // The <tspan> has no font-size; it must inherit 100 from the parent <text>
  // (advance 60), so 'B' lands at x 70..110 just like the single-run case.
  monkeypatch_setattr(reader_mod, "resolve_font", (...a: any[]) => [test_font, 0]);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">' +
    '<text x="0" y="100" font-size="100">A<tspan>B</tspan></text></svg>';
  const doc = read_svg(svg);
  expect(doc.drawables.length).toBe(2);
  const b = doc.drawables[1].subpaths[0];
  expect(py_eq(_xrange(b), [70.0, 110.0])).toBe(true);
});

test("test_reader_text_skipped_without_font", () => {
  monkeypatch_setattr(reader_mod, "resolve_font", (...a: any[]) => null);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<text x="0" y="50">hi</text></svg>';
  expect(py_eq(read_svg(svg).drawables, [])).toBe(true);
});

test("test_letter_spacing", () => {
  const test_font = fixture_test_font();
  // letter-spacing adds to each glyph's advance: 'B' shifts by 60 + 20.
  const [subs] = outline_runs(
    [new TextRun("AB", test_font, 100.0, 20.0)],
    0.0,
    0.0,
    IDENTITY,
  );
  expect(py_eq(_xrange(subs[0]), [10.0, 50.0])).toBe(true);
  expect(py_eq(_xrange(subs[1]), [90.0, 130.0])).toBe(true);
});

test("test_reader_text_stroke", () => {
  const test_font = fixture_test_font();
  // A stroked, unfilled <text> yields a stroked drawable with no fill.
  monkeypatch_setattr(reader_mod, "resolve_font", (...a: any[]) => [test_font, 0]);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">' +
    '<text x="10" y="80" font-size="100" fill="none" ' +
    'stroke="#00ff00" stroke-width="4">A</text></svg>';
  const doc = read_svg(svg);
  expect(doc.drawables.length).toBe(1);
  const d = doc.drawables[0];
  expect(d.fill == null).toBe(true);
  py_assert(d.stroke != null);
  expect(py_eq(Array.from((d.stroke.paint as any).color.slice(0, 3)), [0.0, 1.0, 0.0])).toBe(true);
  expect(d.stroke.width).toBe(4.0);
});

test("test_textpath_horizontal_matches_inline", () => {
  const test_font = fixture_test_font();
  // On a horizontal path, midpoint placement reproduces the inline advance
  // layout at baseline 100 (glyphs sit above the baseline: y 30..100).
  const path = parse_path("M0,100 L300,100");
  const subs = outline_text_path("AB", path, test_font, 100.0, IDENTITY);
  expect(subs.length).toBe(2);
  expect(py_eq(_xrange(subs[0]), [10.0, 50.0])).toBe(true);
  expect(py_eq(_yrange(subs[0]), [30.0, 100.0])).toBe(true);
  expect(py_eq(_xrange(subs[1]), [70.0, 110.0])).toBe(true);
});

test("test_textpath_offpath_glyphs_dropped", () => {
  const test_font = fixture_test_font();
  // 'A' midpoint at 30 fits; 'B' midpoint at 90 runs past the 80-unit path.
  const path = parse_path("M0,100 L80,100");
  const subs = outline_text_path("AB", path, test_font, 100.0, IDENTITY);
  expect(subs.length).toBe(1);
  expect(py_eq(_xrange(subs[0]), [10.0, 50.0])).toBe(true);
});

test("test_reader_textpath", () => {
  const test_font = fixture_test_font();
  monkeypatch_setattr(reader_mod, "resolve_font", (...a: any[]) => [test_font, 0]);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 300 200">' +
    '<defs><path id="p" d="M0,100 L300,100"/></defs>' +
    '<text font-size="100" fill="#ff0000">' +
    '<textPath xlink:href="#p">AB</textPath></text></svg>';
  const doc = read_svg(svg);
  expect(doc.drawables.length).toBe(1);
  const d = doc.drawables[0];
  expect(d.subpaths.length).toBe(2);
  expect(py_eq(Array.from((d.fill as any).color.slice(0, 3)), [1.0, 0.0, 0.0])).toBe(true);
});

test("test_reader_textpath_applies_path_transform", () => {
  const test_font = fixture_test_font();
  // The referenced path's OWN transform must apply: translate(0,100) puts the
  // baseline at y=100, so 'A' spans y 30..100 (x is unchanged by the y-shift).
  monkeypatch_setattr(reader_mod, "resolve_font", (...a: any[]) => [test_font, 0]);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 300 200">' +
    '<defs><path id="p" d="M0,0 L300,0" transform="translate(0,100)"/></defs>' +
    '<text font-size="100" fill="#000000">' +
    '<textPath xlink:href="#p">A</textPath></text></svg>';
  const doc = read_svg(svg);
  expect(doc.drawables.length).toBe(1);
  const sp = doc.drawables[0].subpaths[0];
  expect(py_eq(_xrange(sp), [10.0, 50.0])).toBe(true);
  expect(py_eq(_yrange(sp), [30.0, 100.0])).toBe(true);
});

test("test_reader_image_skipped_with_warning", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">' +
    '<image x="0" y="0" width="50" height="50" xlink:href="foo.png"/></svg>';
  let doc: any;
  warns(() => {
    doc = read_svg(svg);
  }, "image");
  expect(py_eq(doc.drawables, [])).toBe(true);
});

test("test_reader_image_does_not_block_vectors", () => {
  // An <image> next to a <rect> is skipped (warned) but the rect still imports.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">' +
    '<rect x="0" y="0" width="10" height="10" fill="#ff0000"/>' +
    '<image x="0" y="0" width="50" height="50" xlink:href="foo.png"/></svg>';
  let doc: any;
  warns(() => {
    doc = read_svg(svg);
  });
  expect(doc.drawables.length).toBe(1);
});

/**
 * Duck-typed TTFont whose getBestCmap() is null (a symbol font, e.g.
 * Windows Wingdings/Webdings/Symbol/Marlett, which has no Unicode cmap).
 */
class _NoCmapFont {
  // fontkit-shaped twins of the Python duck type: the TS `_glyphs` reads
  // `font._cmapProcessor` (null = no Unicode cmap), `font.unitsPerEm` and
  // `glyph_set.numGlyphs` instead of getBestCmap()/getGlyphSet()/font["head"].
  _cmapProcessor: null = null;
  unitsPerEm = 1000;
  numGlyphs = 0;

  getBestCmap(): null {
    return null;
  }

  getGlyphSet(): Map<string, unknown> {
    return new Map();
  }

  __getitem__(key: string): any {
    return { unitsPerEm: 1000 };
  }
}

test("test_glyphs_handles_font_without_unicode_cmap", () => {
  // Regression: getBestCmap() returns None for symbol fonts; _glyphs used to
  // crash with AttributeError, taking down the whole read_svg(). It must now
  // map every char to no glyph so the run is simply dropped.
  const [names, advances, upm, _] = _glyphs(new _NoCmapFont() as unknown as Parameters<typeof _glyphs>[0], "AB");
  expect(py_eq(names, [null, null])).toBe(true);
  expect(py_eq(advances, [0.0, 0.0])).toBe(true);
});

test("test_reader_collapses_indentation_whitespace", () => {
  const test_font = fixture_test_font();
  // Regression: a pretty-printed <text> with leading/trailing indentation
  // used to render those spaces as glyph advances, shifting the text right.
  // SVG collapses internal whitespace and trims the run's edges.
  monkeypatch_setattr(reader_mod, "resolve_font", (...a: any[]) => [test_font, 0]);
  const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">';

  const min_x = (svg: string): number =>
    Math.min(
      ...read_svg(svg).drawables[0].subpaths.flatMap((sp: any) => sp.vertices.map((v: any) => v[0])),
    );

  const flush = head + '<text x="0" y="100" font-size="100">AB</text></svg>';
  const indented = head + '<text x="0" y="100" font-size="100">\n   AB\n  </text></svg>';
  expect(approx(min_x(indented), min_x(flush))).toBe(true);
});

test("test_per_chunk_anchor_ignores_abs_x_run_width", () => {
  const test_font = fixture_test_font();
  // Two text chunks: "A" continues from the origin, "B" resets to x=200.
  // Both are end-anchored. Each chunk must anchor to its OWN width - the old
  // code summed both widths into one shift, dragging "A" far left.
  const runs = [
    new TextRun("A", test_font, 100.0, undefined, undefined, undefined, undefined, undefined, "end"),
    new TextRun("B", test_font, 100.0, undefined, 200.0, undefined, undefined, undefined, "end"),
  ];
  const [a, b] = outline_runs(runs, 0.0, 0.0, IDENTITY);
  // Chunk "A": advance 60 end-anchored at 0 -> glyph box [-50, -10].
  expect(py_eq(_xrange(a[0]), [-50.0, -10.0])).toBe(true);
  // Chunk "B": advance 60 end-anchored at 200 -> glyph box [150, 190].
  expect(py_eq(_xrange(b[0]), [150.0, 190.0])).toBe(true);
});

test("test_reader_per_tspan_text_anchor", () => {
  const test_font = fixture_test_font();
  // A <tspan> that resets x and sets its own text-anchor establishes its own
  // chunk with that anchor; the parent run keeps the default start anchor.
  monkeypatch_setattr(reader_mod, "resolve_font", (...a: any[]) => [test_font, 0]);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">' +
    '<text x="0" y="100" font-size="100">A' +
    '<tspan x="300" text-anchor="end">B</tspan></text></svg>';
  const doc = read_svg(svg);
  expect(doc.drawables.length).toBe(2);
  expect(py_eq(_xrange(doc.drawables[0].subpaths[0]), [10.0, 50.0])).toBe(true); // A at origin
  expect(py_eq(_xrange(doc.drawables[1].subpaths[0]), [250.0, 290.0])).toBe(true); // B ends at 300
});

test("test_resolve_font_finds_ttc_secondary_face", () => {
  // Regression: a family that ships only as a non-zero face of a .ttc
  // collection must be discoverable, and resolve to that exact face index.
  const tmp_path = make_tmp_path();

  const build_face = (family: string): Uint8Array => {
    const pen = new TTGlyphPen();
    pen.moveTo([0, 0]);
    pen.lineTo([100, 0]);
    pen.lineTo([100, 100]);
    pen.closePath();
    const fb = new FontBuilder(1000, { isTTF: true });
    fb.setupGlyphOrder([".notdef", "A"]);
    fb.setupCharacterMap({ 0x41: "A" });
    fb.setupGlyf({ ".notdef": new TTGlyphPen().glyph(), A: pen.glyph() });
    fb.setupHorizontalMetrics({ ".notdef": [600, 0], A: [600, 0] });
    fb.setupHorizontalHeader({ ascent: 800, descent: -200 });
    fb.setupNameTable({ familyName: family, styleName: "Regular" });
    fb.setupOS2();
    fb.setupPost();
    return fb.build();
  };

  const ttc = tmp_path.div("combo.ttc");
  saveTTC(String(ttc), [build_face("PrimaryFam"), build_face("SecondaryFam")]);

  monkeypatch_setattr(fonts_mod, "_font_dirs", () => [tmp_path]);
  monkeypatch_setattr(fonts_mod, "_index", null);
  expect(py_eq(fonts_mod.resolve_font("PrimaryFam"), [ttc, 0])).toBe(true);
  expect(py_eq(fonts_mod.resolve_font("SecondaryFam"), [ttc, 1])).toBe(true);
});
