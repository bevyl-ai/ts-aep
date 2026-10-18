/** Regression tests for the v9 fuzz findings on masks, paths and effects.

After Effects numbers below were measured on AE 2026 (26.0x67) running the
same scripted operation on a `newProject()` project holding a 400x300 comp
("C") with a 200x100 solid, then reading the values back and saving.
*/

import { describe, expect, test } from "bun:test";
import * as py_aep from "../../src/py_aep/index.ts";
import { parse } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { filterByListType, findByType } from "../../src/py_aep/binary/utils.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { FeatherPoint, Shape } from "../../src/py_aep/models/properties/shape.ts";
import { MaskPropertyGroup } from "../../src/py_aep/models/properties/mask_property_group.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { AttributeError, len, Path, assert, truthy, valueEquals, setMember, StopIteration, ValueError } from "../../src/pyrt/index.ts";

import { asInstance, projectBytes } from "../helpers.ts";
import { makeTmpPath, raises } from "../support/pytest.ts";
import { round } from "../support/python.ts";

// Python `Path(__file__).parent.parent.parent / "samples"`.
const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples");
const FEATHER = SAMPLES.div("models", "property", "shape_feather.aep");

const ZERO3 = Array(3).fill([0.0, 0.0]);
const TRIANGLE = [[10.0, 10.0], [150.0, 20.0], [100.0, 90.0]];
const QUAD = [[10.0, 10.0], [150.0, 20.0], [100.0, 90.0], [20.0, 80.0]];

function _solidMask(width = 200, height = 100) {
  const app = py_aep.newProject();
  const comp = app.project.rootFolder.addComp("C", 400, 300, 1.0, 5.0, 24.0);
  const solid = comp.addSolid([1.0, 0.0, 0.0], "S", width, height, 1.0);
  const mask = asInstance(solid.masks, PropertyGroup).addProperty("ADBE Mask Atom");
  return [app, comp, solid, mask] as const;
}

// NOTE(port): local stand-in for Python `next(genexpr)`; first match or StopIteration, as in CPython.
function _next<T>(items: Iterable<T>, pred: (x: T) => boolean): T {
  for (const x of items) if (pred(x)) return x;
  throw new StopIteration();
}

function _reparseMask(app: py_aep.Application, tmpPath: Path): MaskPropertyGroup {
  const path = tmpPath.div("out.aep");
  app.project.save(path);
  const comp = _next(parse(path).project.compositions, (c) => String(c.name) === "C");
  const masks = _next(comp.layers, (lyr) => String(lyr.name) === "S").masks;
  return asInstance(asInstance(masks, PropertyGroup).properties[0], MaskPropertyGroup);
}

function _tensions(pathProp: Property<Shape>): number[][] {
  const container = pathProp._kfValueContainer;
  assert(container != null, "no keyframe value container");
  const shaps = filterByListType(container.chunks, "shap");
  return shaps.map((s) =>
    findByType(s.chunks, "omtn").tensions.map((t) => round(t.value, 6)),
  );
}

function _round(points: number[][], digits = 3): number[][] {
  return points.map((p) => p.map((x) => round(x, digits)));
}

// NOTE(port): local helper equals `pytest.raises((A, B))` for a tuple; the pyrt `raises` takes a single class.
function raisesAny(classes: (abstract new (...a: never[]) => Error)[], fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    for (const c of classes) if (e instanceof c) return e;
    throw e;
  }
  throw new Error(`DID NOT RAISE ${classes.map((c) => c.name).join(", ")}`);
}

describe("TestRotoBezierTensions", () => {
  test("test_enabling_keeps_a_polygon_a_polygon", () => {
    const tmpPath = makeTmpPath();
    // AE 2026: setValue(triangle) then rotoBezier = true -> every tangent
    // [0, 0], omtn [1, 1, 1].
    const [app, , , mask] = _solidMask();
    mask.property("ADBE Mask Shape").value = new Shape(TRIANGLE);
    mask.rotoBezier = true;
    const reread = _reparseMask(app, tmpPath);
    const path = reread.property("ADBE Mask Shape");
    expect(truthy(reread.rotoBezier)).toBe(true);
    expect(valueEquals(_tensions(path), [[1.0, 1.0, 1.0]])).toBe(true);
    expect(valueEquals(_round(path.value.inTangents), ZERO3)).toBe(true);
    expect(valueEquals(_round(path.value.outTangents), ZERO3)).toBe(true);
  });

  test("test_enabling_curves_only_vertices_with_handles", () => {
    const tmpPath = makeTmpPath();
    // AE 2026: handles on vertex 1 only -> tensions [1, 1/3, 1, 1], and
    // the stored handles become the drawn tangents.
    const [app, , , mask] = _solidMask();
    const handlesIn = [[0.0, 0.0], [-20.0, 5.0], [0.0, 0.0], [0.0, 0.0]];
    const handlesOut = [[0.0, 0.0], [20.0, -5.0], [0.0, 0.0], [0.0, 0.0]];
    mask.property("ADBE Mask Shape").value = new Shape(QUAD, handlesIn, handlesOut);
    mask.rotoBezier = true;
    const path = _reparseMask(app, tmpPath).property("ADBE Mask Shape");
    expect(valueEquals(_tensions(path), [[1.0, 0.333333, 1.0, 1.0]])).toBe(true);
    const drawnIn = [[0.0, 0.0], [-34.968, -31.083], [0.0, 0.0], [0.0, 0.0]];
    const drawnOut = [[0.0, 0.0], [21.432, 19.05], [0.0, 0.0], [0.0, 0.0]];
    expect(valueEquals(_round(path.value.inTangents), drawnIn)).toBe(true);
    expect(valueEquals(_round(path.value.outTangents), drawnOut)).toBe(true);
    expect(valueEquals(_round(path.value._storedTangents(-1)), drawnIn)).toBe(true);
  });

  test("test_value_set_on_a_roto_mask_has_tension_one", () => {
    const tmpPath = makeTmpPath();
    // AE 2026: rotoBezier = true then setValue(quad with handles) -> all
    // tangents [0, 0] (tension 1 everywhere), the handles stay stored.
    const [app, , , mask] = _solidMask();
    mask.rotoBezier = true;
    const handles = [[-5.0, 0.0], [-20.0, 5.0], [5.0, 5.0], [0.0, -5.0]];
    mask.property("ADBE Mask Shape").value = new Shape(QUAD, handles, handles);
    const path = _reparseMask(app, tmpPath).property("ADBE Mask Shape");
    expect(valueEquals(_tensions(path), [[1.0, 1.0, 1.0, 1.0]])).toBe(true);
    expect(valueEquals(_round(path.value.inTangents), Array(4).fill([0.0, 0.0]))).toBe(true);
  });

  test("test_keys_set_on_a_roto_mask_have_tension_one", () => {
    const tmpPath = makeTmpPath();
    const [app, , , mask] = _solidMask();
    mask.rotoBezier = true;
    const path = mask.property("ADBE Mask Shape");
    path.setValueAtTime(0.0, new Shape(QUAD));
    const handles = [[-5.0, 0.0], [0.0, 5.0], [5.0, 0.0], [0.0, 0.0]];
    path.setValueAtTime(2.0, new Shape(QUAD, handles, handles));
    const reread = _reparseMask(app, tmpPath).property("ADBE Mask Shape");
    expect(valueEquals(_tensions(reread), [Array(4).fill(1.0), Array(4).fill(1.0)])).toBe(true);
  });

  test("test_enabling_on_a_keyed_path_treats_each_key", () => {
    const tmpPath = makeTmpPath();
    // AE 2026: key 1 without handles -> tension 1; key 2 with handles on
    // every vertex -> 1/3.
    const [app, , , mask] = _solidMask();
    const path = mask.property("ADBE Mask Shape");
    path.setValueAtTime(0.0, new Shape(TRIANGLE));
    const ins = [[-5.0, 0.0], [0.0, 5.0], [5.0, 0.0]];
    const outs = [[5.0, 0.0], [0.0, -5.0], [-5.0, 0.0]];
    path.setValueAtTime(2.0, new Shape([[20, 10], [180, 30], [90, 95]], ins, outs));
    mask.rotoBezier = true;
    const reread = _reparseMask(app, tmpPath).property("ADBE Mask Shape");
    expect(valueEquals(_tensions(reread), [Array(3).fill(1.0), Array(3).fill(0.333333)])).toBe(true);
    const k2 = reread.keyframes[1].value;
    expect(
      valueEquals(_round(k2.inTangents), [
        [-29.756, 21.49],
        [-34.168, -41.49],
        [36.72, 4.59],
      ]),
    ).toBe(true);
  });

  test("test_disabling_keeps_the_drawn_tangents", () => {
    const tmpPath = makeTmpPath();
    // AE 2026: rotoBezier on then off -> omtn emptied, the handles are the
    // tangents RotoBezier drew.
    const [app, , , mask] = _solidMask();
    const ins = [[-5.0, 0.0], [0.0, 5.0], [5.0, 0.0]];
    const outs = [[5.0, 0.0], [0.0, -5.0], [-5.0, 0.0]];
    mask.property("ADBE Mask Shape").value = new Shape(TRIANGLE, ins, outs);
    mask.rotoBezier = true;
    mask.rotoBezier = false;
    const reread = _reparseMask(app, tmpPath);
    const path = reread.property("ADBE Mask Shape");
    expect(truthy(reread.rotoBezier)).toBe(false);
    expect(valueEquals(_tensions(path), [[]])).toBe(true);
    expect(
      valueEquals(_round(path.value.inTangents), [
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
    const [, , solid, mask] = _solidMask();
    mask.name = existing[0];
    for (const name of existing.slice(1)) {
      asInstance(solid.masks, PropertyGroup).addProperty("ADBE Mask Atom").name = name;
    }
    expect(String(asInstance(solid.masks, PropertyGroup).addProperty("ADBE Mask Atom").name)).toBe(expected);
  });
});

describe("TestPathValueValidation", () => {
  test.each([[[[1, 2], [3, 4]]], [null], [5], [[1, 2]]])(
    "test_non_shape_rejected_without_mutation[%#]",
    (value) => {
      // AE 2026 refuses `setValue([[0,0],[1,1]])` on a mask path ("Array is
      // not of the correct type").
      const [app, , , mask] = _solidMask();
      const path = mask.property("ADBE Mask Shape");
      const before = projectBytes(app.project);
      raises(TypeError, () => {
        // @ts-expect-error deliberately assigns a non-Shape to check runtime validation
        path.value = value;
      });
      expect(valueEquals(projectBytes(app.project), before)).toBe(true);
      path.value = new Shape(TRIANGLE);
      const before2 = projectBytes(app.project);
      raises(TypeError, () => {
        // @ts-expect-error deliberately assigns a non-Shape to check runtime validation
        path.value = value;
      });
      expect(valueEquals(projectBytes(app.project), before2)).toBe(true);
      expect(path.value instanceof Shape).toBe(true);
    },
  );

  test("test_shape_layer_path_rejects_non_shape", () => {
    const app = py_aep.newProject();
    const comp = app.project.rootFolder.addComp("C", 400, 300, 1.0, 5.0, 24.0);
    const group = comp.addShape().property("ADBE Root Vectors Group");
    const path = group
      .addProperty("ADBE Vector Shape - Group")
      .property("ADBE Vector Shape");
    raises(TypeError, () => {
      // @ts-expect-error deliberately assigns a non-Shape to check runtime validation
      path.value = [[1, 2], [3, 4]];
    });
  });

  test.each([
    [(p: Property<Shape>) => p.addKey(1e9)],
    // @ts-expect-error deliberately passes a string time to check runtime validation
    [(p: Property<Shape>) => p.addKey("1")],
    [(p: Property<Shape>) => p.setValueAtTime(1e9, new Shape(TRIANGLE))],
    // @ts-expect-error deliberately passes a non-Shape value to check runtime validation
    [(p: Property<Shape>) => p.setValueAtTime(1.0, [[0, 0], [1, 1]])],
  ])("test_rejected_key_leaves_a_fresh_mask_untouched[%#]", (call: (p: Property<Shape>) => unknown) => {
    const [app, , , mask] = _solidMask();
    const before = projectBytes(app.project);
    raisesAny([TypeError, ValueError], () => call(mask.property("ADBE Mask Shape")));
    expect(valueEquals(projectBytes(app.project), before)).toBe(true);
  });
});

describe("TestFreshMaskNoOps", () => {
  test("test_default_value_writes_no_path", () => {
    // AE 2026: maskPath.setValue(maskPath.value) on a fresh mask saves the
    // bare atom; so does setValue of an equal, newly built rectangle.
    const [app, , , mask] = _solidMask();
    const path = mask.property("ADBE Mask Shape");
    const before = projectBytes(app.project);
    path.value = path.value;
    path.value = new Shape([[0, 0], [0, 100], [200, 100], [200, 0]]);
    path.expressionEnabled = false;
    expect(valueEquals(projectBytes(app.project), before)).toBe(true);
  });

  test("test_a_different_value_writes_the_path", () => {
    const [app, , , mask] = _solidMask();
    const before = projectBytes(app.project);
    mask.property("ADBE Mask Shape").value = new Shape([[0, 0], [0, 100], [200, 100], [201, 0]]);
    expect(valueEquals(projectBytes(app.project), before)).toBe(false);
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
  ])("test_beyond_float32_is_rejected[%#]", (kwargs: { vertices: number[][]; in_tangents?: number[][]; out_tangents?: number[][] }) => {
    raises(ValueError, () => new Shape(kwargs.vertices, kwargs.in_tangents, kwargs.out_tangents));
  });

  test("test_closed_must_be_a_bool", () => {
    raises(
      TypeError,
      // @ts-expect-error deliberately passes a non-bool closed to check runtime validation
      () => new Shape([[0, 0]], undefined, undefined, { closed: 1 }),
    );
  });

  test("test_vertex_move_keeps_relative_tangents", () => {
    const shape = new Shape([[0, 0], [10, 0], [5, 5]], [[1, 1], [0, 0], [0, 0]]);
    shape.vertices = [[100, 100], [110, 100], [105, 105]];
    expect(valueEquals(shape.vertices, [[100, 100], [110, 100], [105, 105]])).toBe(true);
    expect(valueEquals(_round(shape.inTangents), [[1, 1], [0, 0], [0, 0]])).toBe(true);
  });

  test("test_flat_path_takes_new_coordinates", () => {
    const shape = new Shape([[0, 5], [10, 5], [20, 5]]);
    shape.vertices = [[0, 0], [10, 10], [20, 0]];
    shape.inTangents = [[1, 1], [1, 1], [1, 1]];
    expect(valueEquals(shape.vertices, [[0, 0], [10, 10], [20, 0]])).toBe(true);
    expect(valueEquals(_round(shape.inTangents), Array(3).fill([1, 1]))).toBe(true);
  });

  test("test_new_shape_then_vertices", () => {
    // The ExtendScript idiom: `new Shape()`, then assign the vertices.
    const shape = new Shape();
    shape.vertices = [[0, 0], [10, 0], [5, 5]];
    shape.outTangents = [[1, 0], [0, 1], [0, 0]];
    expect(valueEquals(shape.vertices, [[0, 0], [10, 0], [5, 5]])).toBe(true);
    expect(valueEquals(_round(shape.outTangents), [[1, 0], [0, 1], [0, 0]])).toBe(true);
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
      shape.inTangents = [[1, 1]];
    });
    expect(valueEquals(_round(shape.inTangents), ZERO3)).toBe(true);
  });

  test("test_parsed_path_keeps_its_vertex_count", () => {
    const [app, , , mask] = _solidMask();
    const path = mask.property("ADBE Mask Shape");
    path.value = new Shape(TRIANGLE);
    const before = projectBytes(app.project);
    raises(ValueError, () => {
      path.value.vertices = QUAD;
    });
    expect(valueEquals(projectBytes(app.project), before)).toBe(true);
  });
});

describe("TestShapeCopies", () => {
  const _twoLayers = () => {
    const app = py_aep.newProject();
    const comp = app.project.rootFolder.addComp("C", 800, 600, 1.0, 5.0, 24.0);
    const a = comp.addSolid([1.0, 0.0, 0.0], "A", 200, 100, 1.0);
    const b = comp.addSolid([0.0, 1.0, 0.0], "B", 400, 400, 1.0);
    const maskA = asInstance(a.masks, PropertyGroup).addProperty("ADBE Mask Atom");
    maskA.property("ADBE Mask Shape").value = new Shape(TRIANGLE);
    return [app, comp, b, maskA] as const;
  };

  test("test_mask_copied_to_a_bigger_layer_keeps_its_pixels", () => {
    const tmpPath = makeTmpPath();
    // AE 2026: B.maskPath.setValue(A.maskPath.value) -> the same pixel
    // vertices on the 400x400 layer as on the 200x100 one.
    const [app, , b, maskA] = _twoLayers();
    const maskB = asInstance(b.masks, PropertyGroup).addProperty("ADBE Mask Atom");
    maskB.property("ADBE Mask Shape").value = maskA.property("ADBE Mask Shape").value;
    expect(valueEquals(_round(maskB.property("ADBE Mask Shape").value.vertices), TRIANGLE)).toBe(true);
    const path = tmpPath.div("copy.aep");
    app.project.save(path);
    const comp = parse(path).project.compositions[0];
    const b2 = _next(comp.layers, (lyr) => String(lyr.name) === "B");
    expect(
      valueEquals(
        _round(
          asInstance(asInstance(b2.masks, PropertyGroup).properties[0], MaskPropertyGroup).property("ADBE Mask Shape").value
            .vertices,
        ),
        TRIANGLE,
      ),
    ).toBe(true);
  });

  test("test_mask_copied_to_a_shape_path_keeps_its_pixels", () => {
    const [, comp, , maskA] = _twoLayers();
    const group = comp.addShape().property("ADBE Root Vectors Group");
    const path = group
      .addProperty("ADBE Vector Shape - Group")
      .property("ADBE Vector Shape");
    path.value = maskA.property("ADBE Mask Shape").value;
    expect(valueEquals(_round(path.value.vertices), TRIANGLE)).toBe(true);
  });
});

describe("TestFeatherPoints", () => {
  test("test_new_shape_keeps_feather_points", () => {
    const tmpPath = makeTmpPath();
    const app = parse(FEATHER);
    const path = asInstance(
      asInstance(app.project.compositions[0].layers[0].masks, PropertyGroup).properties[0],
      MaskPropertyGroup,
    ).property("ADBE Mask Shape");
    const value = path.value;
    const expected = value.featherPoints.map((fp: FeatherPoint) => [fp.segLoc, fp.relSegLoc, fp.radius]);
    expect(len(expected)).toBe(4);
    path.value = new Shape(value.vertices, value.inTangents, value.outTangents, {
      closed: value.closed,
      featherPoints: value.featherPoints,
    });
    const out = tmpPath.div("feather.aep");
    app.project.save(out);
    const reread = asInstance(
      asInstance(parse(out).project.compositions[0].layers[0].masks, PropertyGroup).properties[0],
      MaskPropertyGroup,
    );
    const points = reread.property("ADBE Mask Shape").value.featherPoints;
    expect(
      valueEquals(
        points.map((fp: FeatherPoint) => [fp.segLoc, fp.relSegLoc, fp.radius]),
        expected,
      ),
    ).toBe(true);
  });

  test("test_feather_points_must_be_feather_points", () => {
    raises(
      TypeError,
      // @ts-expect-error deliberately passes a non-list feather_points to check runtime validation
      () => new Shape([[0, 0]], undefined, undefined, { featherPoints: "x" }),
    );
  });
});

describe("TestExpressionNul", () => {
  test("test_nul_rejected", () => {
    // AE 2026 keeps only the text before a NUL ("50\0 + 1" reads "50").
    const [, , solid] = _solidMask();
    const opacity = solid
      .property("ADBE Transform Group")
      .property("ADBE Opacity");
    raises(ValueError, () => {
      opacity.expression = "50\x00 + 1";
    });
  });
});

describe("TestGroupAttributeWrites", () => {
  test.each([
    ["ADBE Transform Group", "rotoBezier", true],
    ["ADBE Transform Group", "position", [1.0, 2.0]],
    ["ADBE Effect Parade", "value", 42],
  ])("test_unknown_attribute_rejected[%#]", (groupName: string, attr: string, value: unknown) => {
    const [app, , solid] = _solidMask();
    const group = solid.property(groupName);
    const before = projectBytes(app.project);
    raises(AttributeError, () => {
      setMember(group, attr, value);
    });
    expect(valueEquals(projectBytes(app.project), before)).toBe(true);
    if (attr === "position") {
      // Attribute access still reaches the child property.
      expect(String(asInstance(Reflect.get(group, "position"), Property).matchName)).toBe("ADBE Position");
    }
  });
});

describe("TestNewLayerMatchNames", () => {
  test("test_text_and_shape_layers", () => {
    const app = py_aep.newProject();
    const comp = app.project.rootFolder.addComp("C", 400, 300, 1.0, 5.0, 24.0);
    expect(String(comp.addText("x").matchName)).toBe("ADBE Text Layer");
    expect(String(comp.addShape().matchName)).toBe("ADBE Vector Layer");
  });
});
