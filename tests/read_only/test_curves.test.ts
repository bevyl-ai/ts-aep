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
  bytes_eq,
  getitem,
  len,
  max,
  min,
  py_assert,
  py_bool,
  py_eq,
  range,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { Curves } from "../../src/py_aep/models/properties/curves.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { get_comp_from_json_by_name, load_expected, parse_project } from "../conftest.ts";
import { json_field, type ExpectedKeyframe } from "../helpers.ts";
import { as_instance } from "../helpers.ts";

// Python: Path(__file__).parent.parent.parent / "samples" / "models" / "property"
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");

/** Python `next(x for x in items if predicate(x))`. */
function _next<T>(items: T[], predicate: (item: T) => boolean): T {
  for (const item of items) {
    if (predicate(item)) return item;
  }
  throw new StopIteration();
}

function _curves_property(layer_name: string): Property {
  const project = parse_project(SAMPLES_DIR.div("curves.aep"));
  const layer = _next(project.compositions[0].layers, (ly) => ly.name === layer_name);
  const effect = as_instance(layer.property("ADBE Effect Parade").property(0), PropertyGroup);
  const prop = effect.property("ADBE CurvesCustom-0001");
  py_assert(prop instanceof Property);
  return prop;
}

function _expected_is_modified(layer_name: string): boolean {
  const comp = get_comp_from_json_by_name(load_expected(SAMPLES_DIR, "curves"), "Comp 1");
  const layer = _next(comp.layers, (ly) => ly.name === layer_name);
  const parade = _next(layer.properties, (p) => p.matchName === "ADBE Effect Parade");
  const effect = json_field(parade, "properties")[0];
  const prop = _next(json_field(effect, "properties"), (p) => p.matchName === "ADBE CurvesCustom-0001");
  return py_bool(prop.isModified);
}

test.each(["pencil", "untouched", "points", "keyed"])("test_is_modified_matches_json[%#]", (layer_name: string) => {
  const prop = _curves_property(layer_name);
  expect(prop.is_modified).toBe(_expected_is_modified(layer_name));
});

test("test_untouched_curves_are_identity", () => {
  const curves = _curves_property("untouched").value;
  expect(curves instanceof Curves).toBe(true);
  expect(curves.uses_points).toBe(true);
  expect(curves.is_identity).toBe(true);
});

test("test_pencil_curve_decodes_its_map", () => {
  const curves: Curves = _curves_property("pencil").value;
  expect(curves instanceof Curves).toBe(true);
  expect(curves.uses_points).toBe(false);
  expect(
    py_eq(
      [...curves.channels].filter(([, ch]) => !ch.is_identity).map(([name]) => name),
      ["rgb"],
    ),
  ).toBe(true);
  const rgb = getitem(curves.channels, "rgb");
  // The first levels of the master map as drawn in AE 2026.
  expect(py_eq(rgb.map.slice(0, 12), [1, 7, 12, 18, 24, 29, 35, 40, 45, 50, 55, 60])).toBe(true);
  // Read linearly between levels: halfway from level 0 (1) to 1 (7).
  expect(approx(curves.evaluate("rgb", 0.5 / 255.0), 4.0 / 255.0)).toBe(true);
});

test("test_untouched_curves_equal_the_parT_default", () => {
  const prop = _curves_property("untouched");
  py_assert(prop._default_arbp != null);
  py_assert(prop._arbs != null);
  // `(arbp,) = ...` raises ValueError on a length mismatch.
  if (len(prop._arbs.chunks) !== 1) throw new ValueError("not exactly one value to unpack");
  const [arbp] = prop._arbs.chunks;
  expect(bytes_eq(arbp.data, prop._default_arbp.data)).toBe(true);
});

test("test_curves_are_read_only", () => {
  const prop = _curves_property("pencil");
  raises(ValueError, () => {
    prop.value = prop.value;
  }, "read-only");
  raises(ValueError, () => {
    prop.set_value_at_time(1.0, prop.value);
  }, "read-only");
});

/** The edited channels whose map the rounded spline reproduces. */
function _rounded_spline_is_the_map(curves: Curves): string[] {
  const matching: string[] = [];
  for (const [name, channel] of curves.channels) {
    if (channel.is_identity) continue;
    const spline = channel._spline;
    const levels = Array.from(range(256), (level) =>
      Math.floor(min([max([spline.__call__(level), 0.0]), 255.0]) + 0.5),
    );
    if (py_eq(levels, channel.map)) matching.push(name);
  }
  return matching;
}

test("test_point_curves_reproduce_their_maps", () => {
  const curves: Curves = _curves_property("points").value;
  expect(curves instanceof Curves).toBe(true);
  expect(curves.uses_points).toBe(true);
  expect(
    py_eq(getitem(curves.channels, "rgb").points, [
      [0, 0],
      [90, 36],
      [107, 180],
      [178, 204],
      [255, 255],
    ]),
  ).toBe(true);
  expect(py_eq(getitem(curves.channels, "red").points, [[0, 0], [131, 184], [255, 255]])).toBe(true);
  // No half-level tie on these curves: every level is exact.
  expect(py_eq(_rounded_spline_is_the_map(curves), ["rgb", "red"])).toBe(true);
});

function _keyed_json(): ExpectedKeyframe[] {
  const comp = get_comp_from_json_by_name(load_expected(SAMPLES_DIR, "curves"), "Comp 1");
  const layer = _next(comp.layers, (ly) => ly.name === "keyed");
  const parade = _next(layer.properties, (p) => p.matchName === "ADBE Effect Parade");
  const effect = json_field(parade, "properties")[0];
  const prop = _next(json_field(effect, "properties"), (p) => p.matchName === "ADBE CurvesCustom-0001");
  return [...json_field(prop, "keyframes")];
}

test("test_keyed_curves_decode_each_key", () => {
  const prop = _curves_property("keyed");
  const keys_json = _keyed_json();
  expect(approx(prop.keyframes.map((kf) => kf.time), keys_json.map((k) => k.time))).toBe(true);
  const middles: Array<[number, number]> = [];
  for (const kf of prop.keyframes) {
    const curves = as_instance(kf.value, Curves);
    expect(curves instanceof Curves).toBe(true);
    expect(py_eq(_rounded_spline_is_the_map(curves), ["rgb"])).toBe(true);
    middles.push(getitem(curves.channels, "rgb").points[1]);
  }
  expect(py_eq(middles, [[103, 164], [211, 166], [173, 89]])).toBe(true);
});

test("test_keyed_curves_at_a_time", () => {
  const prop = _curves_property("keyed");
  const unpacked = prop.keyframes.map((kf) => kf.value);
  if (len(unpacked) !== 3) throw new ValueError("not exactly 3 values to unpack");
  const [first, second, last] = unpacked;
  py_assert(first instanceof Curves);
  py_assert(second instanceof Curves);
  py_assert(last instanceof Curves);

  const points = (time: number): Array<[number, number]> | null => {
    const value = prop.value_at_time(time);
    return value == null ? null : getitem(as_instance(value, Curves).channels, "rgb").points;
  };

  expect(py_eq(points(0.0), getitem(first.channels, "rgb").points)).toBe(true);
  expect(py_eq(points(prop.keyframes[1].time), getitem(second.channels, "rgb").points)).toBe(true);
  expect(py_eq(points(5.0), getitem(last.channels, "rgb").points)).toBe(true);
  // Between two linear keys AE blends the curves, which cannot be read.
  expect(points(0.5) == null).toBe(true);
});

test("test_keyed_curves_keys_are_read_only", () => {
  const prop = _curves_property("keyed");
  raises(ValueError, () => {
    prop.remove_key(0);
  }, "read-only");
  raises(ValueError, () => {
    prop.remove_all_keys();
  }, "read-only");
  raises(ValueError, () => {
    prop.keyframes[0].value = prop.keyframes[1].value;
  }, "read-only");
  py_assert(prop._arbs != null);
  expect(len(prop.keyframes)).toBe(len(prop._arbs.chunks));
  expect(len(prop.keyframes)).toBe(3);
});
