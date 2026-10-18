/** Tests for importing SVGs as cropped comps (`Project.importFile`). */

import { describe, expect, test } from "bun:test";
import { at, bytesEqual, getattr, assert, truthy, valueEquals, round, sorted, Path, StopIteration, ValueError } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { ImportAsType, ImportOptions, newProject, parse, type Application } from "../../src/py_aep/index.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { ShapeLayer } from "../../src/py_aep/models/layers/shape_layer.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { findByType, findByTypeOrNull } from "../../src/py_aep/binary/utils.ts";
import { readSvg } from "../../src/py_aep/svg/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { asInstance } from "../helpers.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");
const BASE = SAMPLES.div("models", "folder", "folder.aep");
const ASSETS = SAMPLES.div("assets");

function _import(name: string): [Application, CompItem] {
  const app = parse(BASE);
  const opts = new ImportOptions(ASSETS.div(`${name}.svg`));
  opts.importAs = ImportAsType.COMP_CROPPED_LAYERS;
  const comp = app.project.importFile(opts);
  return [app, asInstance(comp, CompItem)];
}

/** Python's `(x,) = seq` for a one-element list (raises like Python when the length differs). */
function unpackOne<T>(xs: T[]): T {
  if (xs.length > 1) throw new ValueError("too many values to unpack (expected 1)");
  if (xs.length < 1) throw new ValueError("not enough values to unpack (expected 1, got 0)");
  return xs[0];
}

describe("TestSvgImportBasics", () => {
  test("test_can_import_svg_as_cropped", () => {
    const opts = new ImportOptions(ASSETS.div("svg.svg"));
    expect(opts.canImportAs(ImportAsType.COMP_CROPPED_LAYERS)).toBe(true);
    expect(opts.canImportAs(ImportAsType.FOOTAGE)).toBe(false);
    expect(opts.canImportAs(ImportAsType.COMP)).toBe(false);
  });

  test("test_footage_import_of_svg_rejected", () => {
    const app = parse(BASE);
    const opts = new ImportOptions(ASSETS.div("svg.svg")); // default import_as = FOOTAGE
    raises(ValueError, () => app.project.importFile(opts), "[Uu]nsupported footage format");
  });

  test("test_cropped_import_of_unsupported_format_rejected", () => {
    // COMP_CROPPED_LAYERS is supported for SVG and layered .psd/.psb;
    // other formats (here audio) are still rejected.
    const app = parse(BASE);
    const opts = new ImportOptions(ASSETS.div("click.aiff"));
    opts.importAs = ImportAsType.COMP_CROPPED_LAYERS;
    raises(ValueError, () => app.project.importFile(opts), "COMP_CROPPED_LAYERS");
  });

  test("test_creates_comp_and_single_shape_layer", () => {
    const [_app, comp] = _import("svg");
    expect(comp.name).toBe("svg.svg");
    expect(valueEquals([comp.width, comp.height], [1070, 456])).toBe(true);
    expect(comp.frameRate).toBe(30.0);
    expect(comp.layers.length).toBe(1);
    expect(comp.layers[0] instanceof ShapeLayer).toBe(true);
    expect(comp.layers[0].name).toBe("svg.svg");
  });

  test("test_group_count_matches_ae", () => {
    // AE 2026 produces 29 vector groups for this SVG.
    const [_app, comp] = _import("svg");
    const contents = comp.layers[0].property("ADBE Root Vectors Group");
    expect(contents instanceof PropertyGroup).toBe(true);
    const groups = contents.properties.filter((g) => g.matchName === "ADBE Vector Group");
    expect(groups.length).toBe(29);
  });

  test("test_reverse_document_order", () => {
    // AE Contents index 0 is the SVG's last-painted shape; the reader
    // lists document order, so the first group is the last drawable.
    // Vertices are stored centred on their bbox, with the offset in the
    // group's Vector Position (matching AE), so reconstruct the absolute
    // vertex before comparing.
    const doc = readSvg(ASSETS.div("svg.svg"));
    const [_app, comp] = _import("svg");
    const contents = comp.layers[0].property("ADBE Root Vectors Group");
    const group = asInstance(contents.properties[0], PropertyGroup);
    const inner = group.property("ADBE Vectors Group");
    const path = inner.property("ADBE Vector Shape - Group").property("ADBE Vector Shape").value;
    const posProp = group.property("ADBE Vector Transform Group").properties.find(
      (p) => p.matchName === "ADBE Vector Position",
    );
    if (posProp == null) throw new StopIteration();
    const pos: number[] = asInstance(posProp, Property).value;
    const absV0 = [path.vertices[0][0] + pos[0], path.vertices[0][1] + pos[1]];
    const lastDrawableV0 = at(doc.drawables, -1).subpaths[0].vertices[0];
    expect(approx(absV0[0], lastDrawableV0[0], { abs: 1e-3 })).toBe(true);
    expect(approx(absV0[1], lastDrawableV0[1], { abs: 1e-3 })).toBe(true);
  });

  test("test_roundtrip_byte_identical", () => {
    const tmpPath = makeTmpPath();
    const [app, _comp] = _import("svg");
    const out = tmpPath.div("svg_cropped.aep");
    app.project.save(out);
    const again = tmpPath.div("svg_cropped_2.aep");
    parse(out).project.save(again);
    expect(bytesEqual(out.readBytes(), again.readBytes())).toBe(true);
  });
});

describe("TestSvgImportGradients", () => {
  test("test_butterfly_gradient_fills", () => {
    const [_app, comp] = _import("butterfly");
    expect(valueEquals([comp.width, comp.height], [2434, 1699])).toBe(true);
    const contents = comp.layers[0].property("ADBE Root Vectors Group");
    let gfills = 0;
    for (const group of contents.properties) {
      if (group.matchName !== "ADBE Vector Group") continue;
      const inner = asInstance(group, PropertyGroup).property("ADBE Vectors Group");
      for (const child of inner.properties) {
        if (child.matchName === "ADBE Vector Graphic - G-Fill") {
          gfills += 1;
          const gfill = asInstance(child, PropertyGroup);
          const grad = gfill.property("ADBE Vector Grad Colors").value;
          expect(grad.colorStops.length).toBeGreaterThanOrEqual(2);
          expect([1.0, 2.0].includes(asInstance(gfill.property("ADBE Vector Grad Type"), Property).value)).toBe(true);
        }
      }
    }
    // AE imported 15 gradient paints (10 linear + 5 radial).
    expect(gfills).toBe(15);
  });

  test("test_butterfly_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const [app, _comp] = _import("butterfly");
    const out = tmpPath.div("butterfly.aep");
    app.project.save(out);
    const again = tmpPath.div("butterfly_2.aep");
    parse(out).project.save(again);
    expect(bytesEqual(out.readBytes(), again.readBytes())).toBe(true);
  });

  test("test_radial_gradient_transform_becomes_grad_scale", () => {
    // The butterfly's four wings use radial gradients with a vertical
    // gradientTransform stretch (matrix(1 0 0 N ...), N in {2,3,4}). AE
    // 2026 stores that aspect ratio in Grad Scale; without it the wing
    // gradients render as circles instead of tall ellipses. Import into a
    // fresh (2026) project so the Grad Scale / Grad Rotation leaves exist.

    const app = newProject();
    const opts = new ImportOptions(ASSETS.div("butterfly.svg"));
    opts.importAs = ImportAsType.COMP_CROPPED_LAYERS;
    const comp = asInstance(app.project.importFile(opts), CompItem);
    const contents = comp.layers[0].property("ADBE Root Vectors Group");
    expect(contents instanceof PropertyGroup).toBe(true);

    const scalesY: number[] = [];
    for (const group of contents.properties) {
      if (group.matchName !== "ADBE Vector Group") continue;
      const inner = asInstance(group, PropertyGroup).property("ADBE Vectors Group");
      for (const child of inner.properties) {
        if (child.matchName !== "ADBE Vector Graphic - G-Fill") continue;
        const gfill = asInstance(child, PropertyGroup);
        if (asInstance(gfill.property("ADBE Vector Grad Type"), Property).value !== 2.0) continue; // radial only
        // Every radial gradient carries AE's 360-degree baseline.
        expect(approx(asInstance(gfill.property("ADBE Vector Grad Rotation"), Property).value, 360.0)).toBe(true);
        scalesY.push(asInstance(gfill.property("ADBE Vector Grad Scale"), Property).value[1]);
      }
    }
    // Five radial gradients: four stretched wings (200/200/300/400) plus
    // the unstretched body (100).
    expect(valueEquals(sorted(scalesY.map((s) => round(s))), [100, 200, 200, 300, 400])).toBe(true);
  });
});

/** Import an inline 200x200 SVG into a fresh project; return its groups. */
function _importText(tmpPath: Path, body: string): PropertyGroup[] {
  const svg = tmpPath.div("probe.svg");
  svg.writeText(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${body}</svg>`);
  const opts = new ImportOptions(svg);
  opts.importAs = ImportAsType.COMP_CROPPED_LAYERS;
  const comp = asInstance(newProject().project.importFile(opts), CompItem);
  const contents = comp.layers[0].property("ADBE Root Vectors Group");
  expect(contents instanceof PropertyGroup).toBe(true);
  return contents.properties.filter(
    (g): g is PropertyGroup => g instanceof PropertyGroup && g.matchName === "ADBE Vector Group",
  );
}

describe("TestSvgImportAeConventions", () => {
  // Conventions measured on AE 2026's own SVG import.

  test("test_group_centred_on_tangent_hull", () => {
    const tmpPath = makeTmpPath();
    // AE centres a group on the box of its vertices AND tangent handles
    // (all 21 butterfly.svg groups), not on the vertices alone: this
    // bulge's handles at y=10 pull the centre up to (50, 30).
    const group = unpackOne(
      _importText(tmpPath, '<path d="M10,50 C10,10 90,10 90,50 Z" fill="#f00"/>'),
    );
    const pos = group.property("ADBE Vector Transform Group").property("ADBE Vector Position").value;
    expect(approx(pos, [50.0, 30.0])).toBe(true);
    const shape = group
      .property("ADBE Vectors Group")
      .property("ADBE Vector Shape - Group")
      .property("ADBE Vector Shape").value;
    expect(valueEquals(shape.vertices, [[-40.0, 20.0], [40.0, 20.0]])).toBe(true);
  });

  test("test_line_has_no_fill", () => {
    const tmpPath = makeTmpPath();
    // A line has no interior, so the default black fill paints nothing;
    // AE adds only the Stroke.
    const group = unpackOne(
      _importText(tmpPath, '<line x1="20" y1="30" x2="150" y2="170" stroke="#000"/>'),
    );
    const kinds = group.property("ADBE Vectors Group").properties.map((c) => c.matchName);
    expect(valueEquals(kinds, ["ADBE Vector Shape - Group", "ADBE Vector Graphic - Stroke"])).toBe(true);
  });

  test("test_duplicate_alpha_stops_collapse", () => {
    const tmpPath = makeTmpPath();
    // AE writes one alpha stop where consecutive stops share both offset
    // and opacity (two colour stops at offset 0 -> one alpha stop), while
    // every colour stop stays.
    const group = unpackOne(
      _importText(
        tmpPath,
        '<linearGradient id="L" x1="20" y1="20" x2="180" y2="20"' +
          ' gradientUnits="userSpaceOnUse">' +
          '<stop offset="0" stop-color="#f00"/><stop offset="0" stop-color="#00f"/>' +
          '<stop offset="0.5" stop-color="#0f0"/><stop offset="1" stop-color="#00f"/>' +
          '</linearGradient><rect x="20" y="20" width="160" height="100" fill="url(#L)"/>',
      ),
    );
    const fill = group.property("ADBE Vectors Group").property("ADBE Vector Graphic - G-Fill");
    const grad = fill.property("ADBE Vector Grad Colors").value;
    expect(valueEquals(grad.colorStops.map((s) => s.offset), [0.0, 0.0, 0.5, 1.0])).toBe(true);
    expect(
      valueEquals(
        grad.alphaStops.map((s) => [s.offset, s.alpha]),
        [
          [0.0, 1.0],
          [0.5, 1.0],
          [1.0, 1.0],
        ],
      ),
    ).toBe(true);
  });

  test("test_fill_and_stroke_opacity_applied", () => {
    const tmpPath = makeTmpPath();
    // AE 2026 ignores fill-opacity / stroke-opacity (100 % both); py_aep
    // applies each to its own paint, 8-bit quantized like `opacity`, and
    // combined with an element `opacity`.
    const group = unpackOne(
      _importText(
        tmpPath,
        '<rect x="20" y="20" width="100" height="60" fill="#f00" ' +
          'fill-opacity="0.5" stroke="#000" stroke-width="4" ' +
          'stroke-opacity="0.25" opacity="0.5"/>',
      ),
    );
    const inner = group.property("ADBE Vectors Group");
    const fill = inner.property("ADBE Vector Graphic - Fill");
    const stroke = inner.property("ADBE Vector Graphic - Stroke");
    expect(approx(fill.property("ADBE Vector Fill Opacity").value, (64 / 255) * 100, { abs: 1e-5 })).toBe(true);
    expect(approx(stroke.property("ADBE Vector Stroke Opacity").value, (32 / 255) * 100, { abs: 1e-5 })).toBe(true);
  });

  test("test_hard_alpha_edge_keeps_both_stops", () => {
    const tmpPath = makeTmpPath();
    // py honours stop-opacity (AE 2026 drops it and renders the gradient
    // opaque), so two stops at one offset with different opacities stay
    // apart: merging them would erase the hard alpha edge.
    const group = unpackOne(
      _importText(
        tmpPath,
        '<linearGradient id="L" x1="20" y1="20" x2="180" y2="20"' +
          ' gradientUnits="userSpaceOnUse">' +
          '<stop offset="0" stop-color="#f00"/><stop offset="0.5" stop-color="#f00"/>' +
          '<stop offset="0.5" stop-color="#f00" stop-opacity="0.2"/>' +
          '<stop offset="1" stop-color="#f00" stop-opacity="0.2"/>' +
          '</linearGradient><rect x="20" y="20" width="160" height="100" fill="url(#L)"/>',
      ),
    );
    const fill = group.property("ADBE Vectors Group").property("ADBE Vector Graphic - G-Fill");
    const grad = fill.property("ADBE Vector Grad Colors").value;
    expect(
      valueEquals(
        grad.alphaStops.map((s) => [s.offset, round(s.alpha, 4)]),
        [
          [0.0, 1.0],
          [0.5, 1.0],
          [0.5, 0.2],
          [1.0, 0.2],
        ],
      ),
    ).toBe(true);
  });
});

describe("TestSvgImportByteFidelity", () => {
  // Byte-level fidelity fixes surfaced by aep-compare vs AE's import.

  test("test_gradient_paint_opacity_from_group", () => {
    // A group/element opacity over a GRADIENT fill/stroke goes into the
    // Fill/Stroke Opacity leaf (AE 2026 ground truth), NOT the alpha stops.
    // Unlike solid paints it is the RAW percentage, not 8-bit quantized:
    // AE reads the SVG opacity as float32, so 0.3 -> 30.000001907 (not the
    // solid-path 30.196). A fully-opaque gradient leaves Opacity defaulted.

    const tmpPath = makeTmpPath();
    const svg = tmpPath.div("go.svg");
    svg.writeText(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
        '<defs><linearGradient id="g" gradientUnits="objectBoundingBox"' +
        ' x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#f00"/>' +
        '<stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
        '<g opacity="0.3"><rect width="40" height="40" fill="url(#g)"/></g>' +
        '<g opacity="0.5"><rect x="50" y="50" width="40" height="40"' +
        ' fill="none" stroke="url(#g)" stroke-width="6"/></g>' +
        '<rect x="50" width="40" height="40" fill="url(#g)"/>' +
        "</svg>",
    );
    const app = newProject();
    const opts = new ImportOptions(svg);
    opts.importAs = ImportAsType.COMP_CROPPED_LAYERS;
    const comp = asInstance(app.project.importFile(opts), CompItem);
    const contents = comp.layers[0].property("ADBE Root Vectors Group");
    expect(contents instanceof PropertyGroup).toBe(true);

    const fillOps: number[] = [];
    const strokeOps: number[] = [];
    for (const group of contents.properties) {
      if (group.matchName !== "ADBE Vector Group") continue;
      const inner = asInstance(group, PropertyGroup).property("ADBE Vectors Group");
      for (const child of inner.properties) {
        if (child.matchName === "ADBE Vector Graphic - G-Fill") {
          const gfill = asInstance(child, PropertyGroup);
          fillOps.push(gfill.property("ADBE Vector Fill Opacity").value);
          // opacity lives in the leaf, not the gradient alpha stops
          const grad = gfill.property("ADBE Vector Grad Colors").value;
          expect(grad.alphaStops.every((s) => s.alpha === 1.0)).toBe(true);
        } else if (child.matchName === "ADBE Vector Graphic - G-Stroke") {
          strokeOps.push(asInstance(child, PropertyGroup).property("ADBE Vector Stroke Opacity").value);
        }
      }
    }

    // 0.3 fill (float32-exact, not 8-bit), opaque control fill (default 100)
    const sortedFills = sorted(fillOps);
    expect(sortedFills.length).toBe(2);
    expect(approx(sortedFills[0], 30.000001907, { abs: 1e-5 })).toBe(true);
    expect(approx(sortedFills[1], 100.0)).toBe(true);
    expect(strokeOps.length).toBe(1);
    expect(approx(strokeOps[0], 50.0)).toBe(true);
  });

  test("test_shape_layer_anchor_written_raw", () => {
    // AE stores a shape layer's anchor in raw pixels (not normalized by
    // comp size). Setting it must write the raw cdat, not value/comp.
    const app = parse(BASE);
    const comp = app.project.rootFolder.addComp("T", 1070, 456, 1.0, 1.0, 30.0);
    const layer = comp.addShape();
    const anchor = layer.transform.property("ADBE Anchor Point");
    anchor.value = [535.0, 228.0, 0.0];
    const cdat = findByType(anchor._tdbs.chunks, "cdat");
    expect(valueEquals(Array.from(cdat.values).slice(0, 3), [535.0, 228.0, 0.0])).toBe(true);
  });

  test("test_vector_materials_group_tdsb_collapsed", () => {
    // AE writes the Vector Materials Group tdsb with _enable_flags=3
    // (enabled + collapsed); py defaulted to 1.
    const app = parse(BASE);
    const comp = app.project.rootFolder.addComp("T", 100, 100, 1.0, 1.0, 30.0);
    const layer = comp.addShape();
    const contents = layer.property("ADBE Root Vectors Group");
    const group = contents.addProperty("ADBE Vector Group");
    const materials = group.property("ADBE Vector Materials Group");
    assert(materials._tdgp != null);
    const tdsb = findByTypeOrNull(materials._tdgp.chunks, "tdsb");
    if (tdsb == null) throw new StopIteration();
    expect(tdsb._enableFlags).toBe(3);
  });

  test("test_compound_path_gets_merge_paths", () => {
    // A compound path (one SVG <path> with several subpaths) needs a Merge
    // Paths op so overlapping subpaths cut holes via the nonzero winding
    // rule; without it AE fills each subpath solid and the holes vanish. AE
    // adds exactly one (Merge Type 1) to every multi-subpath group and none
    // to single-subpath groups - mirror that.
    const [_app, comp] = _import("butterfly");
    const contents = comp.layers[0].property("ADBE Root Vectors Group");
    expect(contents instanceof PropertyGroup).toBe(true);
    let multi = 0;
    let single = 0;
    for (const group of contents.properties) {
      if (group.matchName !== "ADBE Vector Group") continue;
      const inner = asInstance(group, PropertyGroup).property("ADBE Vectors Group");
      const nshapes = inner.properties.filter((c) => c.matchName === "ADBE Vector Shape - Group").length;
      const merges = inner.properties.filter((c) => c.matchName === "ADBE Vector Filter - Merge");
      if (nshapes > 1) {
        multi += 1;
        assert(merges.length === 1, `${group.name}: nshapes=${nshapes}`);
        expect(asInstance(asInstance(merges[0], PropertyGroup).property("ADBE Vector Merge Type"), Property).value).toBe(1.0);
      } else {
        single += 1;
        assert(!truthy(merges), `${group.name} (single subpath) has a Merge`);
      }
    }
    expect(multi).toBe(3);
    expect(single).toBe(18); // butterfly: 3 compound, 18 simple
  });

  test("test_layer_styles_synthesized_disabled", () => {
    // Every layer style must stay OFF on a freshly synthesized layer. The
    // tdsb enable bit (bit 0) is written to disk, so a stray "enabled"
    // toggle makes AE apply that style on open - notably a default-red
    // Color Overlay, which painted the whole shape red. The in-memory
    // state is masked by _derive_layer_styles_enabled, so the bug only
    // surfaces after a save + reparse: check there.
    const tmpPath = makeTmpPath();
    const app = parse(BASE);
    const comp = app.project.rootFolder.addComp("T", 100, 100, 1.0, 1.0, 30.0);
    comp.addShape();
    const out = tmpPath.div("ls.aep");
    app.project.save(out);

    const reparsed = parse(out);
    const item = [...reparsed.project.items.values()].find((item) => truthy(getattr(item, "layers", null)));
    if (item == null) throw new StopIteration();
    const layer = asInstance(item, CompItem).layers[0];
    const styles = layer.property("ADBE Layer Styles");
    expect(styles instanceof PropertyGroup).toBe(true);
    expect(styles.enabled).toBe(false);
    assert(styles._tdsb != null && styles._tdsb.synthetic === false);
    expect(styles._tdsb._enableFlags).toBe(3); // enabled+collapsed parent
    for (const child of styles.properties) {
      assert(child.enabled === false, child.matchName);
      assert(child._tdsb != null);
      // Blending Options mirrors the parent (3); the 10 style toggles
      // are disabled (2 = bit 0 clear).
      const expected = child.matchName === "ADBE Blend Options Group" ? 3 : 2;
      expect(child._tdsb._enableFlags).toBe(expected);
    }
  });

  test("test_menu_leaf_has_no_bound_chunks", () => {
    // Bounded but non-animatable menu leaves (e.g. Stroke Line Cap) must
    // NOT get tdum/tduM bound chunks - AE omits them.
    const app = parse(BASE);
    const comp = app.project.rootFolder.addComp("T", 100, 100, 1.0, 1.0, 30.0);
    const layer = comp.addShape();
    const contents = layer.property("ADBE Root Vectors Group");
    const stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
    const cap = stroke.property("ADBE Vector Stroke Line Cap");
    cap.value = 2.0; // round - non-default, forces materialization
    expect(cap.canVaryOverTime).toBe(false);
    const kinds = cap._tdbs.chunks.map((c) => c.chunkType);
    expect(kinds.includes("tdum")).toBe(false);
    expect(kinds.includes("tduM")).toBe(false);
  });

  test("test_group_opacity_baked_into_paint_opacity", () => {
    // AE bakes an SVG element/group opacity into the paint's Fill/Stroke
    // Opacity, 8-bit quantized (0.3 -> 77/255*100 = 30.196). Verified
    // byte-for-byte against AE 2026's own import of svg.svg (two
    // <g opacity="0.3"> fills -> 30.196). AE ignores stroke-opacity (its
    // four stroke-opacity="0.5" strokes -> 100); py_aep applies it the
    // same way (-> 50.196), so they render as the SVG says.
    const [_app, comp] = _import("svg");
    const contents = comp.layers[0].property("ADBE Root Vectors Group");
    const fills: number[] = [];
    const strokes: number[] = [];
    for (const group of contents.properties) {
      if (group.matchName !== "ADBE Vector Group") continue;
      const inner = asInstance(group, PropertyGroup).property("ADBE Vectors Group");
      for (const child of inner.properties) {
        if (child.matchName === "ADBE Vector Graphic - Fill") {
          fills.push(asInstance(child, PropertyGroup).property("ADBE Vector Fill Opacity").value);
        } else if (child.matchName === "ADBE Vector Graphic - Stroke") {
          strokes.push(asInstance(child, PropertyGroup).property("ADBE Vector Stroke Opacity").value);
        }
      }
    }
    const low = sorted(fills.filter((v) => v < 99.9));
    expect(low.length).toBe(2);
    for (const v of low) expect(approx(v, 30.19607925, { abs: 1e-5 })).toBe(true);
    const sortedStrokes = sorted(strokes);
    expect(sortedStrokes.length).toBe(8);
    for (const v of sortedStrokes.slice(0, 4)) expect(approx(v, 50.19607843, { abs: 1e-5 })).toBe(true);
    for (const v of sortedStrokes.slice(4)) expect(approx(v, 100.0)).toBe(true);
  });
});
