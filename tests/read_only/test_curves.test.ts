/**
 * Tests for the Curves effect's curves read from a project (AE 2026).
 *
 * `curves.aep` holds one 1920x1080 comp with four solids, each with a Curves
 * effect drawn in AE 2026:
 *
 * - `pencil`: the master curve drawn with the pencil;
 * - `untouched`: added and left as is;
 * - `points`: points dragged on the master (5 points) and red (3) curves;
 * - `keyed`: the master curve keyed at 0 s, 0.96 s and 2.04 s (linear keys),
 *   a different point curve at each.
 */

import { expect, test } from "bun:test";
import { approx, raises } from "../../src/pyrt/pytest.ts";
import {
  Path,
  StopIteration,
  ValueError,
  bytesEq,
  getitem,
  len,
  max,
  min,
  pyAssert,
  pyBool,
  pyEq,
  range,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { Curves } from "../../src/py_aep/models/properties/curves.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { getCompFromJsonByName, loadExpected, parseProject } from "../conftest.ts";
import { jsonField, type ExpectedKeyframe } from "../helpers.ts";
import { asInstance } from "../helpers.ts";

// Python: Path(__file__).parent.parent.parent / "samples" / "models" / "property"
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");

/** Python `next(x for x in items if predicate(x))`. */
function _next<T>(items: T[], predicate: (item: T) => boolean): T {
  for (const item of items) {
    if (predicate(item)) return item;
  }
  throw new StopIteration();
}

function _curvesProperty(layerName: string): Property {
  const project = parseProject(SAMPLES_DIR.div("curves.aep"));
  const layer = _next(project.compositions[0].layers, (ly) => ly.name === layerName);
  const effect = asInstance(layer.property("ADBE Effect Parade").property(0), PropertyGroup);
  const prop = effect.property("ADBE CurvesCustom-0001");
  pyAssert(prop instanceof Property);
  return prop;
}

function _expectedIsModified(layerName: string): boolean {
  const comp = getCompFromJsonByName(loadExpected(SAMPLES_DIR, "curves"), "Comp 1");
  const layer = _next(comp.layers, (ly) => ly.name === layerName);
  const parade = _next(layer.properties, (p) => p.matchName === "ADBE Effect Parade");
  const effect = jsonField(parade, "properties")[0];
  const prop = _next(jsonField(effect, "properties"), (p) => p.matchName === "ADBE CurvesCustom-0001");
  return pyBool(prop.isModified);
}

test.each(["pencil", "untouched", "points", "keyed"])("test_is_modified_matches_json[%#]", (layerName: string) => {
  const prop = _curvesProperty(layerName);
  expect(prop.isModified).toBe(_expectedIsModified(layerName));
});

test("test_untouched_curves_are_identity", () => {
  const curves = _curvesProperty("untouched").value;
  expect(curves instanceof Curves).toBe(true);
  expect(curves.usesPoints).toBe(true);
  expect(curves.isIdentity).toBe(true);
});

test("test_pencil_curve_decodes_its_map", () => {
  const curves: Curves = _curvesProperty("pencil").value;
  expect(curves instanceof Curves).toBe(true);
  expect(curves.usesPoints).toBe(false);
  expect(
    pyEq(
      [...curves.channels].filter(([, ch]) => !ch.isIdentity).map(([name]) => name),
      ["rgb"],
    ),
  ).toBe(true);
  const rgb = getitem(curves.channels, "rgb");
  // The first levels of the master map as drawn in AE 2026.
  expect(pyEq(rgb.map.slice(0, 12), [1, 7, 12, 18, 24, 29, 35, 40, 45, 50, 55, 60])).toBe(true);
  // Read linearly between levels: halfway from level 0 (1) to 1 (7).
  expect(approx(curves.evaluate("rgb", 0.5 / 255.0), 4.0 / 255.0)).toBe(true);
});

test("test_untouched_curves_equal_the_parT_default", () => {
  const prop = _curvesProperty("untouched");
  pyAssert(prop._defaultArbp != null);
  pyAssert(prop._arbs != null);
  // `(arbp,) = ...` raises ValueError on a length mismatch.
  if (len(prop._arbs.chunks) !== 1) throw new ValueError("not exactly one value to unpack");
  const [arbp] = prop._arbs.chunks;
  expect(bytesEq(arbp.data, prop._defaultArbp.data)).toBe(true);
});

test("test_curves_are_read_only", () => {
  const prop = _curvesProperty("pencil");
  raises(ValueError, () => {
    prop.value = prop.value;
  }, "read-only");
  raises(ValueError, () => {
    prop.setValueAtTime(1.0, prop.value);
  }, "read-only");
});

/** The edited channels whose map the rounded spline reproduces. */
function _roundedSplineIsTheMap(curves: Curves): string[] {
  const matching: string[] = [];
  for (const [name, channel] of curves.channels) {
    if (channel.isIdentity) continue;
    const spline = channel._spline;
    const levels = Array.from(range(256), (level) =>
      Math.floor(min([max([spline.__call__(level), 0.0]), 255.0]) + 0.5),
    );
    if (pyEq(levels, channel.map)) matching.push(name);
  }
  return matching;
}

test("test_point_curves_reproduce_their_maps", () => {
  const curves: Curves = _curvesProperty("points").value;
  expect(curves instanceof Curves).toBe(true);
  expect(curves.usesPoints).toBe(true);
  expect(
    pyEq(getitem(curves.channels, "rgb").points, [
      [0, 0],
      [90, 36],
      [107, 180],
      [178, 204],
      [255, 255],
    ]),
  ).toBe(true);
  expect(pyEq(getitem(curves.channels, "red").points, [[0, 0], [131, 184], [255, 255]])).toBe(true);
  // No half-level tie on these curves: every level is exact.
  expect(pyEq(_roundedSplineIsTheMap(curves), ["rgb", "red"])).toBe(true);
});

function _keyedJson(): ExpectedKeyframe[] {
  const comp = getCompFromJsonByName(loadExpected(SAMPLES_DIR, "curves"), "Comp 1");
  const layer = _next(comp.layers, (ly) => ly.name === "keyed");
  const parade = _next(layer.properties, (p) => p.matchName === "ADBE Effect Parade");
  const effect = jsonField(parade, "properties")[0];
  const prop = _next(jsonField(effect, "properties"), (p) => p.matchName === "ADBE CurvesCustom-0001");
  return [...jsonField(prop, "keyframes")];
}

test("test_keyed_curves_decode_each_key", () => {
  const prop = _curvesProperty("keyed");
  const keysJson = _keyedJson();
  expect(approx(prop.keyframes.map((kf) => kf.time), keysJson.map((k) => k.time))).toBe(true);
  const middles: Array<[number, number]> = [];
  for (const kf of prop.keyframes) {
    const curves = asInstance(kf.value, Curves);
    expect(curves instanceof Curves).toBe(true);
    expect(pyEq(_roundedSplineIsTheMap(curves), ["rgb"])).toBe(true);
    middles.push(getitem(curves.channels, "rgb").points[1]);
  }
  expect(pyEq(middles, [[103, 164], [211, 166], [173, 89]])).toBe(true);
});

test("test_keyed_curves_at_a_time", () => {
  const prop = _curvesProperty("keyed");
  const unpacked = prop.keyframes.map((kf) => kf.value);
  if (len(unpacked) !== 3) throw new ValueError("not exactly 3 values to unpack");
  const [first, second, last] = unpacked;
  pyAssert(first instanceof Curves);
  pyAssert(second instanceof Curves);
  pyAssert(last instanceof Curves);

  const points = (time: number): Array<[number, number]> | null => {
    const value = prop.valueAtTime(time);
    return value == null ? null : getitem(asInstance(value, Curves).channels, "rgb").points;
  };

  expect(pyEq(points(0.0), getitem(first.channels, "rgb").points)).toBe(true);
  expect(pyEq(points(prop.keyframes[1].time), getitem(second.channels, "rgb").points)).toBe(true);
  expect(pyEq(points(5.0), getitem(last.channels, "rgb").points)).toBe(true);
  // Between two linear keys AE blends the curves, which cannot be read.
  expect(points(0.5) == null).toBe(true);
});

test("test_keyed_curves_keys_are_read_only", () => {
  const prop = _curvesProperty("keyed");
  raises(ValueError, () => {
    prop.removeKey(0);
  }, "read-only");
  raises(ValueError, () => {
    prop.removeAllKeys();
  }, "read-only");
  raises(ValueError, () => {
    prop.keyframes[0].value = prop.keyframes[1].value;
  }, "read-only");
  pyAssert(prop._arbs != null);
  expect(len(prop.keyframes)).toBe(len(prop._arbs.chunks));
  expect(len(prop.keyframes)).toBe(3);
});
