/**
 * Tests for Property.valueAtTime() interpolation against ExtendScript ground truth.
 *
 * Ground truth comes from `export_value_at_time.jsx` which evaluates
 * `prop.valueAtTime(frame * comp.frameDuration)` in After Effects and stores
 * the result alongside the frame number and full-precision evaluation time.
 *
 * Spatial properties (position, 2D/3D) follow After Effects' own arc-length
 * model - an ease curve in (seconds, distance) and a spline fitted to each
 * segment's sampled arc length - so they match AE to the digits ExtendScript
 * prints, including the ~0.01 px it deviates from the exact curve.
 */

import { describe, expect, test } from "bun:test";

import { getOr, float, NotImplementedError, Path, assert, valueEquals, zip } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { Property } from "../../src/py_aep/index.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { getFirstLayer, parseProject } from "../conftest.ts";
import { loadExpectedValueAtTime, type ExpectedFrame } from "../helpers.ts";
import { raises } from "../support/pytest.ts";
import { format, max } from "../support/python.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples").div("models").div("property");
const VAT_DIR = SAMPLES_DIR.div("value_at_time");

// Maps matchName -> function to find the property from a parsed layer
const _FINDERS: Map<string, (ly: Layer) => Property> = new Map<string, (ly: Layer) => Property>([
  ["ADBE Opacity", (ly) => ly.transform.property("ADBE Opacity")],
  ["ADBE Position", (ly) => ly.transform.property("ADBE Position")],
  ["ADBE Anchor Point", (ly) => ly.transform.property("ADBE Anchor Point")],
  ["ADBE Position_0", (ly) => ly.transform.property("ADBE Position_0")],
  ["ADBE Scale", (ly) => ly.transform.property("ADBE Scale")],
  ["ADBE Rotate Z", (ly) => ly.transform.property("ADBE Rotate Z")],
]);

/** Load value_at_time JSON and return (matchName, frames). */
function _loadVat(baseName: string): [string, ExpectedFrame[]] {
  const data = loadExpectedValueAtTime(VAT_DIR, `${baseName}_value_at_time`);
  const prop = data.comps[0].layers[0].properties[0];
  return [prop.matchName, prop.frames];
}

/** Parse .aep and return the target property. */
function _getProp(baseName: string): Property {
  const aep = SAMPLES_DIR.div(`${baseName}.aep`);
  const layer = getFirstLayer(parseProject(aep));
  const [matchName] = _loadVat(baseName);
  const finder = getOr(_FINDERS, matchName);
  assert(finder != null, `No finder for ${matchName}`);
  const prop = finder(layer);
  assert(prop != null, `Property ${matchName} not found`);
  return prop;
}

/** Compute maximum abs error across all frames. */
function _maxError(prop: Property, frames: ExpectedFrame[]): number {
  let maxErr = 0.0;
  for (const f of frames) {
    const got = prop.valueAtTime(f.time);
    const expected = f.value;
    let err: number;
    if (Array.isArray(expected) && Array.isArray(got)) {
      err = max(zip(got, expected).map(([g, e]: [number, number]) => Math.abs(g - e)));
    } else if (typeof expected === "number" && typeof got === "number") {
      err = Math.abs(float(got) - float(expected));
    } else {
      err = float("inf");
    }
    maxErr = max([maxErr, err]);
  }
  return maxErr;
}

// -- Tolerance groups -------------------------------------------------------
// Non-spatial samples: max error < 0.001 (exact when time matches AE).
// Spatial samples: max error < 1e-9. AE's arc-length spline puts even a
// straight LINEAR path ~0.01 px off the exact line, and py reproduces it.
const _NON_SPATIAL_SAMPLES: string[] = [
  "keyframe_bezier_asymmetric_ease_1D",
  "keyframe_bezier_ease_in_out_1D",
  "keyframe_bezier_ease_scale",
  "keyframe_bezier_extreme_ease_1D",
  "keyframe_bezier_multi_ease_1D",
  "keyframe_bezier_nonzero_speed",
  "keyframe_bounce_pattern",
  "keyframe_comp_boundaries",
  "keyframe_extrapolation",
  "keyframe_flat_value",
  "keyframe_hold_2D_position",
  "keyframe_HOLD",
  "keyframe_mixed_interpolation",
  "keyframe_separated_dimensions",
  "keyframe_single",
  "keyframe_temporal_auto_bezier",
  "keyframe_temporal_continuous",
  "property_1D_opacity",
  "property_rotation",
  "property_scale",
];

const _SPATIAL_SAMPLES: string[] = [
  "keyframe_bezier_ease_2D_position",
  "keyframe_BEZIER",
  "keyframe_linear_2D_position",
  "keyframe_LINEAR",
  "keyframe_roving",
  "keyframe_roving_eased",
  "keyframe_spatial_anchor_point",
  "keyframe_spatial_auto_bezier",
  "keyframe_spatial_bezier_3D",
  "keyframe_spatial_bezier_arc",
  "keyframe_spatial_bezier_s_curve",
  "keyframe_spatial_continuous",
  "keyframe_spatial_in_hold",
  "keyframe_spatial_pixel_aspect",
  "keyframe_spatial_temporal_auto_bezier",
  "property_2D_position",
  "property_3D_position",
];

/** Non-spatial samples: error < 0.001. */
describe("TestValueAtTimeNonSpatial", () => {
  test.each(_NON_SPATIAL_SAMPLES)("test_value_at_time[%#]", (sample: string) => {
    const prop = _getProp(sample);
    const [, frames] = _loadVat(sample);
    const maxErr = _maxError(prop, frames);
    assert(maxErr < 0.001, `${sample}: max error ${format(maxErr, ".6f")}`);
  });
});

/**
 * Spatial samples: error < 1e-9.
 *
 * Beyond plain Position: a 2.0 pixel aspect comp (AE measures the path in
 * square pixels), a footage layer's Anchor Point (measured in its stored
 * fractions of the layer), temporal auto-bezier (AE derives one speed
 * along the path and stores zeros), an in-side HOLD (the segment holds at
 * its START) and a roving run between eased anchors.
 */
describe("TestValueAtTimeSpatial", () => {
  test.each(_SPATIAL_SAMPLES)("test_value_at_time[%#]", (sample: string) => {
    const prop = _getProp(sample);
    const [, frames] = _loadVat(sample);
    const maxErr = _maxError(prop, frames);
    assert(maxErr < 1e-9, `${sample}: max error ${format(maxErr, ".3e")}`);
  });

  test("test_eased_roving_run_times", () => {
    /** The roving keys' derived times are the ticks AE stored. */
    const prop = _getProp("keyframe_roving_eased");
    const stored = prop.keyframes.map((kf) => kf._ldatItem.timeUnits);
    expect(valueEquals(stored, [0, 56852, 74884, 122880])).toBe(true);
    prop._redistributeRovingKeyframes();
    expect(valueEquals(prop.keyframes.map((kf) => kf._ldatItem.timeUnits), stored)).toBe(true);
  });
});

/** Tests for value_at_time API behavior. */
describe("TestValueAtTimeAPI", () => {
  test("test_pre_expression_false_raises", () => {
    /** pre_expression=False raises NotImplementedError. */
    const prop = _getProp("property_1D_opacity");
    raises(NotImplementedError, () => {
      prop.valueAtTime(0.0, false);
    });
  });

  test("test_static_value", () => {
    /** Static (non-animated) property returns its value at any time. */
    const prop = _getProp("property_1D_opacity");
    const [, frames] = _loadVat("property_1D_opacity");
    for (const f of frames.slice(0, 5)) {
      const result = prop.valueAtTime(f.time);
      const expected = f.value;
      if (typeof expected === "number") {
        expect(Math.abs(float(result) - float(expected)) < 0.001).toBe(true);
      } else if (Array.isArray(expected)) {
        for (const [g, e] of zip(result, expected)) {
          expect(Math.abs(g - e) < 0.001).toBe(true);
        }
      }
    }
  });
});
