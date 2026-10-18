/**
 * `Property.valueAtTime` on the value kinds AE blends as one quantity.
 *
 * Ground truth is the per-frame `valueAtTime` export of two AE 2026 probe
 * projects (`scripts/jsx/export_value_at_time.jsx`):
 *
 * - `property_path_orientation_pin` - a mask path, a shape-layer path, an
 *   Orientation and a puppet pin, deliberately on layers SMALLER than the
 *   composition so a layer-vs-comp normalization error shows up.
 * - `property_path_orientation_ease` - the same kinds under asymmetric and
 *   mixed LINEAR/BEZIER eases, which pin down the progress curve.
 * - `property_vat_edge_cases` - path keyframe pairs holding different vertex
 *   counts, and Orientation eases carrying a non-zero speed.
 */

import { describe, expect, test } from "bun:test";
import {
  AssertionError,
  Path,
  degrees,
  enumerate,
  float,
  floatRepr,
  getOrThrow,
  len,
  min,
  mod,
  assert,
  truthy,
  valueEquals,
  repr,
  round,
  StopIteration,
  sum,
  zip,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { asInstance, getComp, loadExpectedValueAtTime, parseProject, type ExpectedShape } from "../helpers.ts";
import { Shape } from "../../src/py_aep/models/properties/shape.ts";
import type { Property } from "../../src/py_aep/models/properties/property.ts";
import { _subdivisionCuts, eulerToQuaternion, interpolateShapes, slerpOrientation } from "../../src/py_aep/resolvers/interpolation.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";

// import.meta.dir is already the file's own directory (Python's
// `Path(__file__).parent`), so two more `.parent`s reach the TS root.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "property");
const VAT_DIR = SAMPLES_DIR.div("value_at_time");

// Path vertices are stored as float32, so a blend of two of them cannot be
// closer than about 1e-5 of AE's double. An effect point follows AE's own
// arc-length model and matches to the digits ExtendScript prints.
// Python dict -> Map so a missing match name raises KeyError via getOrThrow().
const _TOLERANCE = new Map<string, number>([
  ["ADBE Mask Shape", 1e-4],
  ["ADBE Vector Shape", 1e-4],
  ["ADBE Orientation", 1e-8],
  ["ADBE FreePin3 PosPin Position", 1e-9],
  ["ADBE Opacity", 1e-9],
]);

/** The single property under `layer` with this match name. */
function _find(layer: Layer, matchName: string): Property {
  const found = Array.from(layer._leafProperties()).filter((p) => p.matchName === matchName);
  assert(len(found) === 1, `${matchName}: expected 1 match, got ${len(found)}`);
  return found[0];
}

/** Every number in a value, in a stable order. */
function _flatten(value: Shape | ExpectedShape | number[] | number): number[] {
  if (value instanceof Shape) {
    const numbers: number[] = [];
    for (const points of [value.vertices, value.inTangents, value.outTangents]) {
      for (const point of points) numbers.push(...point);
    }
    return numbers;
  }
  // Python `dict`. Frame values come from JSON, so they are plain records
  // (identifier keys read by name), not Maps.
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const numbers: number[] = [];
    for (const key of ["vertices", "inTangents", "outTangents"] as const) {
      for (const point of value[key]) numbers.push(...point);
    }
    return numbers;
  }
  if (Array.isArray(value)) return value.map((v) => float(v));
  assert(typeof value === "number");
  return [float(value)];
}

/**
 * Compare two Orientations as rotations, not as angle triples.
 *
 * At a Y of +/-90 degrees X and Z turn about the same axis, so only
 * their sum is recoverable and the split between them is arbitrary. AE
 * is not even self-consistent there: `sp_one_side` reads
 * [37.5, 90, 37.5] one frame and [0, 90, 75] the next, the same
 * rotation written two ways. Comparing the rotation itself is the
 * assertion that means something; the angles are compared too wherever
 * the chart is well conditioned.
 */
function _assertSameRotation(
  actual: number[],
  expected: number[],
  tolerance: number,
  layerName: string,
  time: number,
): void {
  const qActual = eulerToQuaternion(actual);
  const qExpected = eulerToQuaternion(expected);
  const dot = min([1.0, Math.abs(sum(zip(qActual, qExpected).map(([a, b]) => a * b)))]);
  const between = degrees(2.0 * Math.acos(dot));
  assert(
    between <= Math.max(tolerance, 1e-3),
    `${layerName} t=${floatRepr(time)}: ${repr(actual)} is ${floatRepr(between)} degrees from ${repr(expected)}`,
  );
  // Python `%` is floored (sign of the divisor), so mod(), not JS `%`.
  if (Math.abs(Math.abs(mod(expected[1], 360.0)) - 90.0) > 0.01) {
    for (const [index, [a, b]] of enumerate(zip(actual, expected))) {
      assert(
        Math.abs(a - b) <= tolerance,
        `${layerName} t=${floatRepr(time)} [${index}]: ${floatRepr(a)} != ${floatRepr(b)}`,
      );
    }
  }
}

/** (base name, comp name, layer name, match name) per exported property. */
function _cases(): [string, string, string, string][] {
  const out: [string, string, string, string][] = [];
  for (const base of [
    "property_path_orientation_pin",
    "property_path_orientation_ease",
    "property_vat_edge_cases",
  ]) {
    const data = loadExpectedValueAtTime(VAT_DIR, `${base}_value_at_time`);
    for (const comp of data.comps) {
      for (const layer of comp.layers) {
        for (const prop of layer.properties) {
          out.push([base, comp.name, layer.name, prop.matchName]);
        }
      }
    }
  }
  return out;
}

/**
 * The exported frames for one property, or fail loudly.
 *
 * Looked up rather than scanned for: a scan that falls off the end
 * silently passes the case instead of reporting the missing fixture.
 */
function _expectedFrames(base: string, compName: string, layerName: string, matchName: string) {
  const data = loadExpectedValueAtTime(VAT_DIR, `${base}_value_at_time`);
  const compData = data.comps.find((c) => c.name === compName);
  if (compData === undefined) throw new StopIteration();
  const layers = compData.layers.filter((ly) => ly.name === layerName);
  assert(
    len(layers) === 1,
    `${base}/${compName}: expected 1 layer named ${layerName}, got ${len(layers)}`,
  );
  const props = layers[0].properties.filter((p) => p.matchName === matchName);
  assert(
    len(props) === 1,
    `${base}/${compName}/${layerName}: expected 1 ${matchName}, got ${len(props)}`,
  );
  const frames = props[0].frames;
  assert(truthy(frames), `${base}/${compName}/${layerName}/${matchName}: no frames exported`);
  return frames;
}

test.each(_cases())("test_matches_extendscript[%#]", (base, compName, layerName, matchName) => {
  const frames = _expectedFrames(base, compName, layerName, matchName);
  const project = parseProject(SAMPLES_DIR.div(`${base}.aep`));
  const comp = getComp(project, compName);
  const matches = comp.layers.filter((layer) => layer.name === layerName);
  assert(
    len(matches) === 1,
    `${compName}: expected 1 layer named ${layerName}, got ${len(matches)}`,
  );
  const prop = _find(matches[0], matchName);
  const tolerance = getOrThrow(_TOLERANCE, matchName);

  for (const frame of frames) {
    const got = prop.valueAtTime(frame.time);
    const expected = _flatten(frame.value);
    const actual = _flatten(got);
    assert(
      len(actual) === len(expected),
      `${matchName} t=${floatRepr(frame.time)}: ` +
        `${len(actual)} values, expected ${len(expected)}`,
    );
    if (matchName === "ADBE Orientation") {
      _assertSameRotation(actual, expected, tolerance, layerName, frame.time);
    } else {
      for (const [index, [a, b]] of enumerate(zip(actual, expected))) {
        assert(
          Math.abs(a - b) <= tolerance,
          `${layerName}.${matchName} t=${floatRepr(frame.time)} [${index}]: ${floatRepr(a)} != ${floatRepr(b)}`,
        );
      }
    }
    // Python dict check; frame values are JSON-loaded plain records.
    if (typeof frame.value === "object" && frame.value !== null && !Array.isArray(frame.value)) {
      expect(got instanceof Shape).toBe(true);
      expect(got.closed).toBe(frame.value.closed);
    }
  }
});

/** The static read path, on the same layers-smaller-than-comp fixture. */
class TestValueSpaces {
  static _probe_layer(name: string): Layer {
    const project = parseProject(SAMPLES_DIR.div("property_path_orientation_pin.aep"));
    const comp = getComp(project, "vat_probe");
    const found = comp.layers.find((layer) => layer.name === name);
    if (found === undefined) throw new StopIteration();
    return found;
  }
}

describe("TestValueSpaces", () => {
  test("test_mask_shape_is_bound_to_its_layer_at_parse_time", () => {
    // Reached through `_value` / `_ldatItem`, never through `.value`:
    // the binding is the parser's job, so a read must not be what
    // establishes it. `_parse_shape_shap` raises if a mask path is
    // parsed without its layer, which makes a missed parse site loud
    // rather than silently comp-scaled.
    const layer = TestValueSpaces._probe_layer("probe_solid");
    const prop = _find(layer, "ADBE Mask Shape");
    expect(prop._value != null).toBe(true);
    expect(asInstance(prop._value, Shape)._layer).toBe(layer);
    for (const keyframe of prop.keyframes) {
      const value = keyframe._value;
      expect(value).toBeInstanceOf(Shape);
      if (value instanceof Shape) expect(value._layer).toBe(layer);
    }
  });

  test("test_mask_keyframes_are_in_layer_space", () => {
    // The layer is 200x100 inside a 400x300 comp, so a Shape scaled by
    // the comp instead of the layer reads 2x / 3x too large.
    const prop = _find(TestValueSpaces._probe_layer("probe_solid"), "ADBE Mask Shape");
    const first = prop.keyframes[0].value;
    assert(first instanceof Shape);
    for (const [got, expected] of zip(first.vertices, [[20, 20], [120, 20], [120, 80], [20, 80]])) {
      expect(Math.abs(got[0] - expected[0]) < 1e-4).toBe(true);
      expect(Math.abs(got[1] - expected[1]) < 1e-4).toBe(true);
    }
  });

  test("test_puppet_pin_is_in_pixels", () => {
    // AE reports the pin in layer pixels; the file holds it normalized
    // against the 200x100 layer.
    const prop = _find(TestValueSpaces._probe_layer("probe_puppet"), "ADBE FreePin3 PosPin Position");
    expect(prop.unitsText).toBe("pixels");
    const value = prop.keyframes[0].value;
    assert(Array.isArray(value));
    for (const [got, expected] of zip(value, [50.0, 25.0])) {
      expect(Math.abs(got - expected) < 1e-6).toBe(true);
    }
  });

  test("test_orientation_keyframe_ease_reads_the_stored_influence", () => {
    // The orientation ldat item has no value slot, so reading it as a
    // 1-D value item shifted every ease field by one double.
    const project = parseProject(SAMPLES_DIR.div("property_path_orientation_ease.aep"));
    const comp = getComp(project, "vat_ease");
    const layer = comp.layers.find((ly) => ly.name === "orient_asym");
    if (layer === undefined) throw new StopIteration();
    const prop = _find(layer, "ADBE Orientation");
    const outEase = prop.keyframes[0].outTemporalEase[0];
    const inEase = prop.keyframes[1].inTemporalEase[0];
    expect(valueEquals([outEase.speed, outEase.influence], [0.0, 90.0])).toBe(true);
    expect(valueEquals([inEase.speed, inEase.influence], [0.0, 20.0])).toBe(true);
  });

  test("test_linear_orientation_ease_speed_is_one", () => {
    // AE reports 1 for a LINEAR side of a value with no scalar
    // magnitude, not the euler-vector slope.
    const prop = _find(TestValueSpaces._probe_layer("probe_solid"), "ADBE Orientation");
    expect(prop.keyframes[0].outTemporalEase[0].speed).toBe(1.0);
    expect(prop.keyframes[1].inTemporalEase[0].speed).toBe(1.0);
  });
});

/** Behaviour the AE fixtures do not cover. */
describe("TestShapeInterpolationEdges", () => {
  const subdivisionRows: [number, number, number[][]][] = [
    // AE bisects breadth-first: every segment once in path order,
    // then every half in that order. Read off AE 2026 across
    // sources of 2 to 5 segments and targets up to 12.
    [3, 3, [[], [], []]],
    [3, 4, [[0.5], [], []]],
    [3, 5, [[0.5], [0.5], []]],
    [3, 6, [[0.5], [0.5], [0.5]]],
    [3, 7, [[0.25, 0.5], [0.5], [0.5]]],
    [3, 8, [[0.25, 0.5, 0.75], [0.5], [0.5]]],
    [3, 9, [[0.25, 0.5, 0.75], [0.25, 0.5], [0.5]]],
    [3, 10, [[0.25, 0.5, 0.75], [0.25, 0.5, 0.75], [0.5]]],
    [4, 6, [[0.5], [0.5], [], []]],
    [4, 9, [[0.25, 0.5], [0.5], [0.5], [0.5]]],
    [5, 7, [[0.5], [0.5], [], [], []]],
  ];

  test.each(subdivisionRows)("test_subdivision_is_breadth_first[%#]", (segments, target, expected) => {
    expect(valueEquals(_subdivisionCuts(segments, target), expected)).toBe(true);
  });

  test("test_vertex_count_mismatch_resamples_the_shorter_path", () => {
    const left = new Shape([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]);
    const right = new Shape([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [-5.0, 5.0]]);
    const blended = interpolateShapes(left, right, 0.0);
    expect(blended != null).toBe(true);
    if (blended == null) throw new AssertionError("interpolate_shapes returned null");
    // At progress 0 the blend IS the resampled left path: the same
    // outline, two extra vertices, and still straight.
    expect(
      valueEquals(blended.vertices, [
        [0.0, 0.0],
        [5.0, 0.0],
        [10.0, 0.0],
        [10.0, 5.0],
        [10.0, 10.0],
      ]),
    ).toBe(true);
    expect(valueEquals(blended.inTangents, Array.from({ length: 5 }, () => [0.0, 0.0]))).toBe(true);
    expect(valueEquals(blended.outTangents, Array.from({ length: 5 }, () => [0.0, 0.0]))).toBe(true);
  });

  test("test_resampling_a_curve_preserves_its_shape", () => {
    // One curved segment split in half: de Casteljau puts the new
    // vertex at the curve's midpoint and halves the outer handles.
    const left = new Shape(
      [[0.0, 0.0], [100.0, 0.0]],
      [[0.0, 0.0], [-40.0, 0.0]],
      [[40.0, 0.0], [0.0, 0.0]],
      { closed: false },
    );
    const right = new Shape([[0.0, 0.0], [50.0, 0.0], [100.0, 0.0]], undefined, undefined, { closed: false });
    const blended = interpolateShapes(left, right, 0.0);
    expect(blended != null).toBe(true);
    if (blended == null) throw new AssertionError("interpolate_shapes returned null");
    expect(valueEquals(blended.vertices, [[0.0, 0.0], [50.0, 0.0], [100.0, 0.0]])).toBe(true);
    expect(valueEquals(blended.outTangents[0], [20.0, 0.0])).toBe(true);
    expect(valueEquals(blended.inTangents[2], [-20.0, 0.0])).toBe(true);
  });

  test("test_empty_shapes_hold_the_left_key", () => {
    expect(interpolateShapes(new Shape([]), new Shape([]), 0.5)).toBeNull();
  });

  test("test_closed_comes_from_the_left_key", () => {
    const left = new Shape([[0.0, 0.0], [10.0, 0.0]], undefined, undefined, { closed: false });
    const right = new Shape([[0.0, 0.0], [10.0, 0.0]], undefined, undefined, { closed: true });
    const blended = interpolateShapes(left, right, 0.5);
    expect(blended != null).toBe(true);
    if (blended == null) throw new AssertionError("interpolate_shapes returned null");
    expect(blended.closed).toBe(false);
  });
});

/** The quaternion path, independently of any sample. */
describe("TestOrientationSlerp", () => {
  test("test_midpoint_is_not_a_per_axis_blend", () => {
    const got = slerpOrientation([0.0, 0.0, 0.0], [45.0, 90.0, 30.0], 0.5);
    // AE 2026; a per-axis blend would give [22.5, 45, 15].
    for (const [a, b] of zip(got, [22.083206323481, 42.8193869722279, 22.083206323481])) {
      expect(Math.abs(a - b) < 1e-9).toBe(true);
    }
  });

  test("test_takes_the_short_way_round", () => {
    // 10 -> 350 degrees is -20 degrees the short way, and AE reports the
    // result wrapped into [0, 360).
    const got = slerpOrientation([0.0, 0.0, 10.0], [0.0, 0.0, 350.0], 0.5);
    expect(Math.abs(got[2] - 0.0) < 1e-9 || Math.abs(got[2] - 360.0) < 1e-9).toBe(true);
  });

  test("test_endpoints_round_trip", () => {
    for (const angles of [[0.0, 0.0, 0.0], [10.0, 20.0, 30.0], [45.0, 80.0, 30.0]]) {
      const start = slerpOrientation(angles, [1.0, 2.0, 3.0], 0.0);
      for (const [a, b] of zip(start, angles)) {
        expect(Math.abs(a - b) < 1e-9).toBe(true);
      }
    }
  });

  test("test_gimbal_lock_keeps_the_rotation", () => {
    // At Y = 90 degrees X and Z turn about the same axis, so only their
    // sum is recoverable: [45, 90, 30] comes back as [0, 90, 75], the
    // same rotation. All of it lands on Z because that is where AE puts
    // it - measured by reparenting a 3D layer onto the pole, which AE
    // writes back as [0, 270, g]. `interpolate_keyframes` returns a
    // keyframe's own value at its own time, so this never reshapes a
    // stored angle.
    const got = slerpOrientation([45.0, 90.0, 30.0], [1.0, 2.0, 3.0], 0.0);
    expect(valueEquals(got.map((v) => round(v, 9)), [0.0, 90.0, 75.0])).toBe(true);
    const original = eulerToQuaternion([45.0, 90.0, 30.0]);
    const recovered = eulerToQuaternion(got);
    expect(Math.abs(Math.abs(sum(zip(original, recovered).map(([a, b]) => a * b))) - 1.0) < 1e-12).toBe(true);
  });
});
