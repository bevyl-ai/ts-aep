/** Regression tests for the v9 fuzz findings on masks, paths and effects.

After Effects numbers below were measured on AE 2026 (26.0x67) running the
same scripted operation on a `py_aep.new()` project holding a 400x300 comp
("C") with a 200x100 solid, then reading the values back and saving.
*/

import { describe, expect, test } from "bun:test";
import * as py_aep from "../../src/py_aep/index.ts";
import { parse } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { filter_by_list_type, find_by_type } from "../../src/py_aep/binary/utils.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { FeatherPoint, Shape } from "../../src/py_aep/models/properties/shape.ts";
import {
  AttributeError,
  len,
  Path,
  py_bool,
  py_eq,
  round,
  TypeError_,
  ValueError,
} from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { as_instance, project_bytes } from "../helpers.ts";

// Python `Path(__file__).parent.parent.parent / "samples"`.
const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");
const FEATHER = SAMPLES.div("models", "property", "shape_feather.aep");

const ZERO3 = Array(3).fill([0.0, 0.0]);
const TRIANGLE = [[10.0, 10.0], [150.0, 20.0], [100.0, 90.0]];
const QUAD = [[10.0, 10.0], [150.0, 20.0], [100.0, 90.0], [20.0, 80.0]];

function _solid_mask(width = 200, height = 100): any[] {
  const app = py_aep.new();
  const comp = app.project.root_folder.add_comp("C", 400, 300, 1.0, 5.0, 24.0);
  const solid = comp.add_solid([1.0, 0.0, 0.0], "S", width, height, 1.0);
  const mask = as_instance(solid.masks, PropertyGroup).add_property("ADBE Mask Atom");
  return [app, comp, solid, mask];
}

function _reparse_mask(app: py_aep.Application, tmp_path: Path): any {
  const path = tmp_path.div("out.aep");
  app.project.save(path);
  const comp = parse(path).project.compositions.find((c) => String(c.name) === "C")!;
  return as_instance(comp.layers.find((lyr) => String(lyr.name) === "S")!.masks, PropertyGroup).properties[0];
}

function _tensions(path_prop: any): number[][] {
  const shaps = filter_by_list_type(path_prop._kf_value_container.chunks, "shap");
  return shaps.map((s) =>
    find_by_type(s.chunks, "omtn").tensions.map((t) => round(t.value, 6)),
  );
}

function _round(points: number[][], digits = 3): number[][] {
  return points.map((p) => p.map((x) => round(x, digits)));
}

// NOTE(port): local helper equals `pytest.raises((A, B))` for a tuple; the pyrt `raises` takes a single class.
function raises_any(classes: (abstract new (...a: any[]) => Error)[], fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (classes.some((c) => e instanceof c)) return e as Error;
    throw e;
  }
  throw new Error(`DID NOT RAISE ${classes.map((c) => c.name).join(", ")}`);
}

describe("TestRotoBezierTensions", () => {
  test("test_enabling_keeps_a_polygon_a_polygon", () => {
    const tmp_path = make_tmp_path();
    // AE 2026: setValue(triangle) then rotoBezier = true -> every tangent
    // [0, 0], omtn [1, 1, 1].
    const [app, , , mask] = _solid_mask();
    mask.property("ADBE Mask Shape").value = new Shape(TRIANGLE);
    mask.roto_bezier = true;
    const reread = _reparse_mask(app, tmp_path);
    const path = reread.property("ADBE Mask Shape");
    expect(py_bool(reread.roto_bezier)).toBe(true);
    expect(py_eq(_tensions(path), [[1.0, 1.0, 1.0]])).toBe(true);
    expect(py_eq(_round(path.value.in_tangents), ZERO3)).toBe(true);
    expect(py_eq(_round(path.value.out_tangents), ZERO3)).toBe(true);
  });

  test("test_enabling_curves_only_vertices_with_handles", () => {
    const tmp_path = make_tmp_path();
    // AE 2026: handles on vertex 1 only -> tensions [1, 1/3, 1, 1], and
    // the stored handles become the drawn tangents.
    const [app, , , mask] = _solid_mask();
    const handles_in = [[0.0, 0.0], [-20.0, 5.0], [0.0, 0.0], [0.0, 0.0]];
    const handles_out = [[0.0, 0.0], [20.0, -5.0], [0.0, 0.0], [0.0, 0.0]];
    mask.property("ADBE Mask Shape").value = new Shape(QUAD, handles_in, handles_out);
    mask.roto_bezier = true;
    const path = _reparse_mask(app, tmp_path).property("ADBE Mask Shape");
    expect(py_eq(_tensions(path), [[1.0, 0.333333, 1.0, 1.0]])).toBe(true);
    const drawn_in = [[0.0, 0.0], [-34.968, -31.083], [0.0, 0.0], [0.0, 0.0]];
    const drawn_out = [[0.0, 0.0], [21.432, 19.05], [0.0, 0.0], [0.0, 0.0]];
    expect(py_eq(_round(path.value.in_tangents), drawn_in)).toBe(true);
    expect(py_eq(_round(path.value.out_tangents), drawn_out)).toBe(true);
    expect(py_eq(_round(path.value._stored_tangents(-1)), drawn_in)).toBe(true);
  });

  test("test_value_set_on_a_roto_mask_has_tension_one", () => {
    const tmp_path = make_tmp_path();
    // AE 2026: rotoBezier = true then setValue(quad with handles) -> all
    // tangents [0, 0] (tension 1 everywhere), the handles stay stored.
    const [app, , , mask] = _solid_mask();
    mask.roto_bezier = true;
    const handles = [[-5.0, 0.0], [-20.0, 5.0], [5.0, 5.0], [0.0, -5.0]];
    mask.property("ADBE Mask Shape").value = new Shape(QUAD, handles, handles);
    const path = _reparse_mask(app, tmp_path).property("ADBE Mask Shape");
    expect(py_eq(_tensions(path), [[1.0, 1.0, 1.0, 1.0]])).toBe(true);
    expect(py_eq(_round(path.value.in_tangents), Array(4).fill([0.0, 0.0]))).toBe(true);
  });

  test("test_keys_set_on_a_roto_mask_have_tension_one", () => {
    const tmp_path = make_tmp_path();
    const [app, , , mask] = _solid_mask();
    mask.roto_bezier = true;
    const path = mask.property("ADBE Mask Shape");
    path.set_value_at_time(0.0, new Shape(QUAD));
    const handles = [[-5.0, 0.0], [0.0, 5.0], [5.0, 0.0], [0.0, 0.0]];
    path.set_value_at_time(2.0, new Shape(QUAD, handles, handles));
    const reread = _reparse_mask(app, tmp_path).property("ADBE Mask Shape");
    expect(py_eq(_tensions(reread), [Array(4).fill(1.0), Array(4).fill(1.0)])).toBe(true);
  });

  test("test_enabling_on_a_keyed_path_treats_each_key", () => {
    const tmp_path = make_tmp_path();
    // AE 2026: key 1 without handles -> tension 1; key 2 with handles on
    // every vertex -> 1/3.
    const [app, , , mask] = _solid_mask();
    const path = mask.property("ADBE Mask Shape");
    path.set_value_at_time(0.0, new Shape(TRIANGLE));
    const ins = [[-5.0, 0.0], [0.0, 5.0], [5.0, 0.0]];
    const outs = [[5.0, 0.0], [0.0, -5.0], [-5.0, 0.0]];
    path.set_value_at_time(2.0, new Shape([[20, 10], [180, 30], [90, 95]], ins, outs));
    mask.roto_bezier = true;
    const reread = _reparse_mask(app, tmp_path).property("ADBE Mask Shape");
    expect(py_eq(_tensions(reread), [Array(3).fill(1.0), Array(3).fill(0.333333)])).toBe(true);
    const k2 = reread.keyframes[1].value;
    expect(
      py_eq(_round(k2.in_tangents), [
        [-29.756, 21.49],
        [-34.168, -41.49],
        [36.72, 4.59],
      ]),
    ).toBe(true);
  });

  test("test_disabling_keeps_the_drawn_tangents", () => {
    const tmp_path = make_tmp_path();
    // AE 2026: rotoBezier on then off -> omtn emptied, the handles are the
    // tangents RotoBezier drew.
    const [app, , , mask] = _solid_mask();
    const ins = [[-5.0, 0.0], [0.0, 5.0], [5.0, 0.0]];
    const outs = [[5.0, 0.0], [0.0, -5.0], [-5.0, 0.0]];
    mask.property("ADBE Mask Shape").value = new Shape(TRIANGLE, ins, outs);
    mask.roto_bezier = true;
    mask.roto_bezier = false;
    const reread = _reparse_mask(app, tmp_path);
    const path = reread.property("ADBE Mask Shape");
    expect(py_bool(reread.roto_bezier)).toBe(false);
    expect(py_eq(_tensions(path), [[]])).toBe(true);
    expect(
      py_eq(_round(path.value.in_tangents), [
        [-23.33, 32.662],
        [-34.968, -31.083],
        [28.602, 2.043],
      ]),
    ).toBe(true);
  });
});

describe("TestMaskNaming", () => {
  test.each([
    [["Mask 01"], "Mask 02"],
    [["Mask 001"], "Mask 002"],
    [["Mask 0099"], "Mask 0100"],
    [["Mask 09"], "Mask 10"],
    [["Mask 999"], "Mask 1000"],
    [["Mask 03", "Mask 3"], "Mask 04"],
    [["Mask 3", "Mask 03"], "Mask 4"],
    [["Mask 9", "Mask 08"], "Mask 10"],
    [["Mask"], "Mask 2"],
    [["Mask", "Mask 2"], "Mask 3"],
    [["Mask 0"], "Mask 1"],
    [["Mask 00"], "Mask 1"],
    [["Mask 999999"], "Mask 1000000"],
    [["Mask 000001"], "Mask 000002"],
    [["Mask 1234567"], "Mask 1"],
    [["Mask 0000099"], "Mask 1"],
    [["Mask 12345678"], "Mask 1"],
    [["Mask 2147483647"], "Mask 1"],
    [["Mask ٣"], "Mask 1"],
    [["Mask 5 "], "Mask 1"],
    [["stored"], "Mask 1"],
    [["Mask 10", "Mask 9"], "Mask 11"],
  ])("test_new_mask_name[%#]", (existing: string[], expected: string) => {
    // AE 2026 addProperty("ADBE Mask Atom") beside masks so named.
    const [, , solid, mask] = _solid_mask();
    mask.name = existing[0];
    for (const name of existing.slice(1)) {
      solid.masks.add_property("ADBE Mask Atom").name = name;
    }
    expect(String(solid.masks.add_property("ADBE Mask Atom").name)).toBe(expected);
  });
});

describe("TestPathValueValidation", () => {
  test.each([[[[1, 2], [3, 4]]], [null], [5], [[1, 2]]])(
    "test_non_shape_rejected_without_mutation[%#]",
    (value: any) => {
      // AE 2026 refuses `setValue([[0,0],[1,1]])` on a mask path ("Array is
      // not of the correct type").
      const [app, , , mask] = _solid_mask();
      const path = mask.property("ADBE Mask Shape");
      const before = project_bytes(app.project);
      raises(TypeError_, () => {
        path.value = value;
      });
      expect(py_eq(project_bytes(app.project), before)).toBe(true);
      path.value = new Shape(TRIANGLE);
      const before2 = project_bytes(app.project);
      raises(TypeError_, () => {
        path.value = value;
      });
      expect(py_eq(project_bytes(app.project), before2)).toBe(true);
      expect(path.value instanceof Shape).toBe(true);
    },
  );

  test("test_shape_layer_path_rejects_non_shape", () => {
    const app = py_aep.new();
    const comp = app.project.root_folder.add_comp("C", 400, 300, 1.0, 5.0, 24.0);
    const group = comp.add_shape().__getitem__("ADBE Root Vectors Group") as any;
    const path = group
      .add_property("ADBE Vector Shape - Group")
      .property("ADBE Vector Shape");
    raises(TypeError_, () => {
      path.value = [[1, 2], [3, 4]];
    });
  });

  test.each([
    [(p: any) => p.add_key(1e9)],
    [(p: any) => p.add_key("1")],
    [(p: any) => p.set_value_at_time(1e9, new Shape(TRIANGLE))],
    [(p: any) => p.set_value_at_time(1.0, [[0, 0], [1, 1]])],
  ])("test_rejected_key_leaves_a_fresh_mask_untouched[%#]", (call: (p: any) => unknown) => {
    const [app, , , mask] = _solid_mask();
    const before = project_bytes(app.project);
    raises_any([TypeError_, ValueError], () => call(mask.property("ADBE Mask Shape")));
    expect(py_eq(project_bytes(app.project), before)).toBe(true);
  });
});

describe("TestFreshMaskNoOps", () => {
  test("test_default_value_writes_no_path", () => {
    // AE 2026: maskPath.setValue(maskPath.value) on a fresh mask saves the
    // bare atom; so does setValue of an equal, newly built rectangle.
    const [app, , , mask] = _solid_mask();
    const path = mask.property("ADBE Mask Shape");
    const before = project_bytes(app.project);
    path.value = path.value;
    path.value = new Shape([[0, 0], [0, 100], [200, 100], [200, 0]]);
    path.expression_enabled = false;
    expect(py_eq(project_bytes(app.project), before)).toBe(true);
  });

  test("test_a_different_value_writes_the_path", () => {
    const [app, , , mask] = _solid_mask();
    const before = project_bytes(app.project);
    mask.property("ADBE Mask Shape").value = new Shape([[0, 0], [0, 100], [200, 100], [201, 0]]);
    expect(py_eq(project_bytes(app.project), before)).toBe(false);
  });
});

describe("TestShapeGeometry", () => {
  test.each([
    [{ vertices: [[1e39, 0.0], [1.0, 1.0]] }],
    [
      {
        vertices: [[3e38, 0.0], [1.0, 1.0]],
        in_tangents: [[3e38, 0.0], [0, 0]],
      },
    ],
    [{ vertices: [[0.0, 0.0]], out_tangents: [[Infinity, 0.0]] }],
  ])("test_beyond_float32_is_rejected[%#]", (kwargs: any) => {
    raises(ValueError, () => new Shape(kwargs.vertices, kwargs.in_tangents, kwargs.out_tangents));
  });

  test("test_closed_must_be_a_bool", () => {
    raises(TypeError_, () => new Shape([[0, 0]], undefined, undefined, { closed: 1 as any }));
  });

  test("test_vertex_move_keeps_relative_tangents", () => {
    const shape = new Shape([[0, 0], [10, 0], [5, 5]], [[1, 1], [0, 0], [0, 0]]);
    shape.vertices = [[100, 100], [110, 100], [105, 105]];
    expect(py_eq(shape.vertices, [[100, 100], [110, 100], [105, 105]])).toBe(true);
    expect(py_eq(_round(shape.in_tangents), [[1, 1], [0, 0], [0, 0]])).toBe(true);
  });

  test("test_flat_path_takes_new_coordinates", () => {
    const shape = new Shape([[0, 5], [10, 5], [20, 5]]);
    shape.vertices = [[0, 0], [10, 10], [20, 0]];
    shape.in_tangents = [[1, 1], [1, 1], [1, 1]];
    expect(py_eq(shape.vertices, [[0, 0], [10, 10], [20, 0]])).toBe(true);
    expect(py_eq(_round(shape.in_tangents), Array(3).fill([1, 1]))).toBe(true);
  });

  test("test_new_shape_then_vertices", () => {
    // The ExtendScript idiom: `new Shape()`, then assign the vertices.
    const shape = new Shape();
    shape.vertices = [[0, 0], [10, 0], [5, 5]];
    shape.out_tangents = [[1, 0], [0, 1], [0, 0]];
    expect(py_eq(shape.vertices, [[0, 0], [10, 0], [5, 5]])).toBe(true);
    expect(py_eq(_round(shape.out_tangents), [[1, 0], [0, 1], [0, 0]])).toBe(true);
  });

  test("test_empty_vertices_rejected", () => {
    // AE 2026: "Value array does not have at least 1 element(s)".
    raises(ValueError, () => {
      new Shape([[0, 0]]).vertices = [];
    });
  });

  test("test_tangent_count_must_match", () => {
    const shape = new Shape([[0, 0], [10, 0], [5, 5]]);
    raises(ValueError, () => {
      shape.in_tangents = [[1, 1]];
    });
    expect(py_eq(_round(shape.in_tangents), ZERO3)).toBe(true);
  });

  test("test_parsed_path_keeps_its_vertex_count", () => {
    const [app, , , mask] = _solid_mask();
    const path = mask.property("ADBE Mask Shape");
    path.value = new Shape(TRIANGLE);
    const before = project_bytes(app.project);
    raises(ValueError, () => {
      path.value.vertices = QUAD;
    });
    expect(py_eq(project_bytes(app.project), before)).toBe(true);
  });
});

describe("TestShapeCopies", () => {
  const _two_layers = (): any[] => {
    const app = py_aep.new();
    const comp = app.project.root_folder.add_comp("C", 800, 600, 1.0, 5.0, 24.0);
    const a = comp.add_solid([1.0, 0.0, 0.0], "A", 200, 100, 1.0);
    const b = comp.add_solid([0.0, 1.0, 0.0], "B", 400, 400, 1.0);
    const mask_a = as_instance(a.masks, PropertyGroup).add_property("ADBE Mask Atom") as any;
    mask_a.property("ADBE Mask Shape").value = new Shape(TRIANGLE);
    return [app, comp, b, mask_a];
  };

  test("test_mask_copied_to_a_bigger_layer_keeps_its_pixels", () => {
    const tmp_path = make_tmp_path();
    // AE 2026: B.maskPath.setValue(A.maskPath.value) -> the same pixel
    // vertices on the 400x400 layer as on the 200x100 one.
    const [app, , b, mask_a] = _two_layers();
    const mask_b = b.masks.add_property("ADBE Mask Atom");
    mask_b.property("ADBE Mask Shape").value = mask_a.property("ADBE Mask Shape").value;
    expect(py_eq(_round(mask_b.property("ADBE Mask Shape").value.vertices), TRIANGLE)).toBe(true);
    const path = tmp_path.div("copy.aep");
    app.project.save(path);
    const comp = parse(path).project.compositions[0];
    const b2 = comp.layers.find((lyr) => String(lyr.name) === "B")!;
    expect(
      py_eq(
        _round((as_instance(b2.masks, PropertyGroup).properties[0] as any).property("ADBE Mask Shape").value.vertices),
        TRIANGLE,
      ),
    ).toBe(true);
  });

  test("test_mask_copied_to_a_shape_path_keeps_its_pixels", () => {
    const [, comp, , mask_a] = _two_layers();
    const group = comp.add_shape().__getitem__("ADBE Root Vectors Group") as any;
    const path = group
      .add_property("ADBE Vector Shape - Group")
      .property("ADBE Vector Shape");
    path.value = mask_a.property("ADBE Mask Shape").value;
    expect(py_eq(_round(path.value.vertices), TRIANGLE)).toBe(true);
  });
});

describe("TestFeatherPoints", () => {
  test("test_new_shape_keeps_feather_points", () => {
    const tmp_path = make_tmp_path();
    const app = parse(FEATHER);
    const path = (as_instance(app.project.compositions[0].layers[0].masks, PropertyGroup).properties[0] as any).property(
      "ADBE Mask Shape",
    );
    const value = path.value;
    const expected = value.feather_points.map((fp: FeatherPoint) => [fp.seg_loc, fp.rel_seg_loc, fp.radius]);
    expect(len(expected)).toBe(4);
    path.value = new Shape(value.vertices, value.in_tangents, value.out_tangents, {
      closed: value.closed,
      feather_points: value.feather_points,
    });
    const out = tmp_path.div("feather.aep");
    app.project.save(out);
    const reread = as_instance(parse(out).project.compositions[0].layers[0].masks, PropertyGroup).properties[0] as any;
    const points = reread.property("ADBE Mask Shape").value.feather_points;
    expect(
      py_eq(
        points.map((fp: FeatherPoint) => [fp.seg_loc, fp.rel_seg_loc, fp.radius]),
        expected,
      ),
    ).toBe(true);
  });

  test("test_feather_points_must_be_feather_points", () => {
    raises(TypeError_, () => new Shape([[0, 0]], undefined, undefined, { feather_points: "x" as any }));
  });
});

describe("TestExpressionNul", () => {
  test("test_nul_rejected", () => {
    // AE 2026 keeps only the text before a NUL ("50\0 + 1" reads "50").
    const [, , solid] = _solid_mask();
    const opacity = solid
      .__getitem__("ADBE Transform Group")
      .__getitem__("ADBE Opacity");
    raises(ValueError, () => {
      opacity.expression = "50\x00 + 1";
    });
  });
});

describe("TestGroupAttributeWrites", () => {
  test.each([
    ["ADBE Transform Group", "roto_bezier", true],
    ["ADBE Transform Group", "position", [1.0, 2.0]],
    ["ADBE Effect Parade", "value", 42],
  ])("test_unknown_attribute_rejected[%#]", (group_name: string, attr: string, value: any) => {
    const [app, , solid] = _solid_mask();
    const group = solid.__getitem__(group_name);
    const before = project_bytes(app.project);
    raises(AttributeError, () => {
      group[attr] = value;
    });
    expect(py_eq(project_bytes(app.project), before)).toBe(true);
    if (attr === "position") {
      // Attribute access still reaches the child property.
      expect(String(group.position.match_name)).toBe("ADBE Position");
    }
  });
});

describe("TestNewLayerMatchNames", () => {
  test("test_text_and_shape_layers", () => {
    const app = py_aep.new();
    const comp = app.project.root_folder.add_comp("C", 400, 300, 1.0, 5.0, 24.0);
    expect(String(comp.add_text("x").match_name)).toBe("ADBE Text Layer");
    expect(String(comp.add_shape().match_name)).toBe("ADBE Vector Layer");
  });
});
