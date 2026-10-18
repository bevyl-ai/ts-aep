/**
 * Issue #225 + v8 finding 1: keyframe evaluation and insertion.
 *
 * Every expected number was measured in After Effects 2026 through
 * `valueAtTime`. AE's own sampling is quoted in the docstrings so a future change
 * can be judged against it rather than against py's current output.
 */

import { describe, expect, test } from "bun:test";
import * as py_aep from "../../src/py_aep/index.ts";
import { KeyframeEase, KeyframeInterpolationType, Property, PropertyGroup, type Application, type AVLayer, type CompItem } from "../../src/py_aep/index.ts";
import { at, getattr, len, max, min, py_assert, py_bool, StopIteration, sum, zip } from "../../src/pyrt/index.ts";
import type { Path } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path } from "../../src/pyrt/pytest.ts";
import { SAMPLES_DIR, as_instance, parse_app_fresh } from "../helpers.ts";

const PROPERTY_DIR = SAMPLES_DIR.div("models", "property");

function _new_comp(width = 800, height = 400, fps = 24.0): [Application, CompItem] {
  const app = py_aep.new();
  const comp = app.project.root_folder.add_comp("C", width, height, 1.0, 10.0, fps);
  return [app, comp];
}

function _position_with(
  comp: CompItem,
  name: string,
  keys: [number, number[]][],
  out_tan: number[] | null = null,
  in_tan: number[] | null = null,
  eases: [KeyframeEase, KeyframeEase] | null = null,
): [AVLayer, Property] {
  const layer = comp.add_solid([1, 0, 0], name, 100, 100, 1.0);
  const pos = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Position"), Property);
  for (const [t, value] of keys) {
    pos.set_value_at_time(t, value);
  }
  if (out_tan != null) {
    pos.keyframes[0].out_spatial_tangent = out_tan;
  }
  if (in_tan != null) {
    at(pos.keyframes, -1).in_spatial_tangent = in_tan;
  }
  if (eases != null) {
    const [out_ease, in_ease] = eases;
    pos.keyframes[0].out_temporal_ease = [out_ease];
    at(pos.keyframes, -1).in_temporal_ease = [in_ease];
  }
  return [layer, pos];
}

/**
 * Issue #225: a 1-D BEZIER segment whose keys hold the SAME value
 * evaluated flat, because the ease handles were normalized by `v1 - v0`.
 * AE places them absolutely, so the curve still bows.
 */
describe("TestFlatBezierSegment", () => {
  // AE 2026, opacity 50 -> 50 over 2 s, out ease 100/33, in ease -100/33.
  const AE = new Map<number, number>([
    [0.0, 50.0],
    [0.25, 71.778350],
    [0.5, 87.217522],
    [0.75, 96.435069],
    [1.0, 99.5],
    [1.5, 87.217522],
    [2.0, 50.0],
  ]);

  function _build(): [Application, Property] {
    const [app, comp] = _new_comp(200, 200);
    const layer = comp.add_solid([1, 0, 0], "L", 100, 100, 1.0);
    const op = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Opacity"), Property);
    op.set_value_at_time(0.0, 50.0);
    op.set_value_at_time(2.0, 50.0);
    for (const kf of op.keyframes) {
      kf.in_interpolation_type = KeyframeInterpolationType.BEZIER;
      kf.out_interpolation_type = KeyframeInterpolationType.BEZIER;
    }
    op.keyframes[0].out_temporal_ease = [new KeyframeEase(100.0, 33.0)];
    op.keyframes[1].in_temporal_ease = [new KeyframeEase(-100.0, 33.0)];
    return [app, op];
  }

  test("test_matches_after_effects", () => {
    const [_app, op] = _build();
    for (const [t, want] of AE) {
      expect(approx(op.value_at_time(t), want, { abs: 1e-4 })).toBe(true);
    }
  });

  /** The headline symptom: every sample used to read exactly 50. */
  test("test_peaks_between_the_keys", () => {
    const [_app, op] = _build();
    expect(op.value_at_time(1.0) > 99.0).toBe(true);
  });

  /** The absolute and normalized forms agree whenever `v1 != v0`. */
  test("test_still_linear_when_the_values_differ", () => {
    const [app, comp] = _new_comp(200, 200);
    const layer = comp.add_solid([1, 0, 0], "L", 100, 100, 1.0);
    const op = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Opacity"), Property);
    op.set_value_at_time(0.0, 0.0);
    op.set_value_at_time(2.0, 100.0);
    for (const kf of op.keyframes) {
      kf.in_interpolation_type = KeyframeInterpolationType.LINEAR;
      kf.out_interpolation_type = KeyframeInterpolationType.LINEAR;
    }
    expect(approx(op.value_at_time(1.0), 50.0, { abs: 1e-6 })).toBe(true);
  });
});

/**
 * Issue #225 item 2: a LINEAR side sets that side's EASE; the path still
 * follows the spatial tangents. py lerped between the keys instead.
 */
describe("TestLinearSideKeepsTheMotionPath", () => {
  // AE 2026: (50,50) -> (350,50), tangents (100,200) / (-100,200), LINEAR.
  const AE = new Map<number, number[]>([
    [0.0, [50.0, 50.0]],
    [0.5, [108.389427, 144.050019]],
    [1.0, [199.997539, 200.0]],
    [1.5, [291.611424, 144.048980]],
    [2.0, [350.0, 50.0]],
  ]);

  test("test_follows_the_cubic", () => {
    const [_app, comp] = _new_comp(400, 400);
    const [_layer, pos] = _position_with(
      comp,
      "LinearOut",
      [
        [0.0, [50.0, 50.0, 0.0]],
        [2.0, [350.0, 50.0, 0.0]],
      ],
      [100.0, 200.0, 0.0],
      [-100.0, 200.0, 0.0],
    );
    for (const kf of pos.keyframes) {
      kf.in_interpolation_type = KeyframeInterpolationType.LINEAR;
      kf.out_interpolation_type = KeyframeInterpolationType.LINEAR;
    }

    for (const [t, want] of AE) {
      const got = pos.value_at_time(t);
      expect(approx(got.slice(0, 2), want, { abs: 1e-6 })).toBe(true);
    }
  });

  /**
   * On the line, but not at the exact halfway point.
   *
   * AE reads a position off the arc-length spline it fits to the
   * segment, which puts even a straight LINEAR path ~1e-3 px off the
   * exact lerp. AE 2026, (0,0) -> (100,200) LINEAR: 50.0007773538156 /
   * 100.001554707631 at half time (the value depends on the duration
   * only through that fraction).
   */
  test("test_a_tangentless_linear_segment_is_still_a_line", () => {
    const [_app, comp] = _new_comp(400, 400);
    const [_layer, pos] = _position_with(comp, "Plain", [
      [0.0, [0.0, 0.0, 0.0]],
      [2.0, [100.0, 200.0, 0.0]],
    ]);
    for (const kf of pos.keyframes) {
      kf.in_interpolation_type = KeyframeInterpolationType.LINEAR;
      kf.out_interpolation_type = KeyframeInterpolationType.LINEAR;
    }
    const [x, y] = pos.value_at_time(1.0).slice(0, 2);
    expect(y).toBe(2.0 * x);
    expect(approx([x, y], [50.0007773538156, 100.001554707631], { abs: 1e-9 })).toBe(true);
  });
});

/**
 * Issue #225 item 1: the ease speed divides by the path's ARC LENGTH
 * (one number for the segment), and a handle that reaches past the unit
 * square is shortened along its own slope rather than clamped in y.
 */
describe("TestSpatialEaseDivisorAndClamp", () => {
  // AE 2026: (50,100) -> (750,100), tangents +/-(400,0), ease 900/90.
  const AE = new Map<number, number>([
    [0.0, 50.0],
    [0.25, 236.611771],
    [0.5, 347.368151],
    [1.0, 400.001294],
    [1.5, 452.634536],
    [2.0, 750.0],
  ]);

  test("test_overshooting_handle_keeps_its_speed", () => {
    const [_app, comp] = _new_comp(800, 400);
    const [_layer, pos] = _position_with(
      comp,
      "Overshoot",
      [
        [0.0, [50.0, 100.0, 0.0]],
        [2.0, [750.0, 100.0, 0.0]],
      ],
      [400.0, 0.0, 0.0],
      [-400.0, 0.0, 0.0],
      [new KeyframeEase(900.0, 90.0), new KeyframeEase(900.0, 90.0)],
    );
    for (const kf of pos.keyframes) {
      kf.in_interpolation_type = KeyframeInterpolationType.BEZIER;
      kf.out_interpolation_type = KeyframeInterpolationType.BEZIER;
    }

    for (const [t, want_x] of AE) {
      expect(approx(pos.value_at_time(t)[0], want_x, { abs: 1e-6 })).toBe(true);
    }
  });
});

/**
 * Issue #225 item 3: the enclosing anchors' ease applies ONCE across the
 * whole roving run, and the keys are spaced along that single eased span.
 */
describe("TestRovingRunIsOneEasedSpan", () => {
  // AE 2026 placed the two roving keys of a 4-point 8 s run at these times.
  const AE_TIMES = [0.0, 3.544840, 4.308594, 8.0];
  // AE's sampled positions on the same run.
  const AE_CURVE = new Map<number, number[]>([
    [1.0, [56.981111, 196.509445]],
    [3.0, [157.599662, 146.200169]],
    [5.0, [638.297201, 244.681120]],
    [7.0, [742.754934, 202.898026]],
  ]);

  function _build(): Property<number[]> {
    const [_app, comp] = _new_comp(800, 400);
    const layer = comp.add_solid([0, 0, 1], "Roving", 100, 100, 1.0);
    const pos = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Position"), Property);
    const keys: [number, number[]][] = [
      [0.0, [50.0, 200.0, 0.0]],
      [2.0, [250.0, 100.0, 0.0]],
      [5.0, [500.0, 300.0, 0.0]],
      [8.0, [750.0, 200.0, 0.0]],
    ];
    for (const [t, value] of keys) {
      pos.set_value_at_time(t, value);
    }
    // AE's fixture has straight sub-segments; auto tangents would change
    // the arc lengths the roving keys are spaced along.
    for (const kf of pos.keyframes) {
      kf.in_spatial_tangent = [0.0, 0.0, 0.0];
      kf.out_spatial_tangent = [0.0, 0.0, 0.0];
    }
    // The anchors must be BEZIER for their ease to apply at all - a
    // LINEAR anchor carries no ease, and the run is then spaced evenly by
    // arc length (which is what AE does too).
    for (const kf of [pos.keyframes[0], at(pos.keyframes, -1)]) {
      kf.in_interpolation_type = KeyframeInterpolationType.BEZIER;
      kf.out_interpolation_type = KeyframeInterpolationType.BEZIER;
    }
    const ease = new KeyframeEase(0.0, 80.0);
    pos.keyframes[0].out_temporal_ease = [ease];
    at(pos.keyframes, -1).in_temporal_ease = [ease];
    pos.keyframes[1].roving = true;
    pos.keyframes[2].roving = true;
    return pos;
  }

  test("test_key_times_match_after_effects", () => {
    const pos = _build();
    const times = pos.keyframes.map((kf) => kf.time);
    expect(approx(times, AE_TIMES, { abs: 1e-6 })).toBe(true);
  });

  test("test_curve_matches_after_effects", () => {
    const pos = _build();
    for (const [t, want] of AE_CURVE) {
      expect(approx(pos.value_at_time(t).slice(0, 2), want, { abs: 1e-6 })).toBe(true);
    }
  });
});

/**
 * v8 finding 1: `add_key` inserted a LINEAR key with a default ease,
 * silently reshaping the animation. AE leaves `valueAtTime` untouched.
 */
describe("TestAddKeyPreservesTheCurve", () => {
  // Samples whose animated transform property is 1-D. The spatial cases
  // are covered by the AE-measured fixtures above: inserting a key there
  // also splits the motion path, which AE itself only preserves closely.
  const SAMPLES = [
    "keyframe_1D.aep",
    "keyframe_HOLD.aep",
    "keyframe_mixed_interpolation.aep",
    "keyframe_bezier_ease_in_out_1D.aep",
  ];

  test.each(SAMPLES)("test_curve_is_unchanged[%#]", (sample: string) => {
    const app = parse_app_fresh(PROPERTY_DIR.div(sample));
    const times = [0.0, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0];
    let checked = 0;
    for (const comp of app.project.compositions) {
      for (const layer of comp.layers) {
        for (const prop of [...layer.transform].filter((p) => p instanceof Property)) {
          if (!py_bool(getattr(prop, "keyframes", null)) || len(prop.keyframes) < 2) {
            continue;
          }
          if (prop.is_spatial) {
            continue; // covered by the AE-measured cases above
          }
          const key_times = prop.keyframes.map((kf) => kf.time);
          const mid = (key_times[0] + key_times[1]) / 2.0;
          if (key_times.some((t) => Math.abs(mid - t) < 1e-6)) {
            continue;
          }
          const before = times.map((t) => prop.value_at_time(t));
          prop.add_key(mid);
          const after = times.map((t) => prop.value_at_time(t));
          expect(approx(after, before, { abs: 1e-6 })).toBe(true);
          checked += 1;
        }
      }
    }
    py_assert(checked, "no property exercised");
  });

  /**
   * A key added on a bowed motion path splits the cubic where the path
   * was at the key's time, so the path itself does not move. Splitting
   * at the nearest of 128 arc samples instead, with the value read at
   * the unrounded time, bent this one by 0.15 px.
   */
  test("test_spatial_split_keeps_the_motion_path", () => {
    function point(curve: number[][], t: number): number[] {
      const m = 1.0 - t;
      return zip(...curve).map(
        ([a, b, c, d]) => m * m * m * a + 3 * m * m * t * b + 3 * m * t * t * c + t * t * t * d,
      );
    }

    function distance_to(p: number[], a: number[], b: number[]): number {
      const ab = zip(a, b).map(([x, y]) => y - x);
      const ap = zip(a, p).map(([x, y]) => y - x);
      const length = sum(ab.map((v) => v * v));
      // Python max(0.0, min(1.0, ...)) with two positional args -> pyrt max/min over arrays.
      const t = max([0.0, min([1.0, sum(zip(ab, ap).map(([x, y]) => x * y)) / length])]);
      const q = zip(a, ab).map(([x, v]) => x + t * v);
      return Math.sqrt(sum(zip(p, q).map(([x, y]) => (x - y) ** 2)));
    }

    const app = parse_app_fresh(PROPERTY_DIR.div("keyframe_spatial_bezier_arc.aep"));
    const pos = app.project.compositions[0].layers[0].transform.property("ADBE Position");
    const k0 = pos.keyframes[0];
    const k1 = pos.keyframes[1];
    const out_tangent = k0.out_spatial_tangent;
    const in_tangent = k1.in_spatial_tangent;
    if (out_tangent == null || in_tangent == null) throw new Error("spatial keyframe has no tangents");
    const curve = [
      k0.value,
      zip(k0.value, out_tangent).map(([v, t]) => v + t),
      zip(k1.value, in_tangent).map(([v, t]) => v + t),
      k1.value,
    ];
    const path = Array.from({ length: 2001 }, (_, i) => point(curve, i / 2000));
    const t0 = k0.time;
    const t1 = k1.time;

    pos.add_key(t0 + (t1 - t0) * 0.37);

    let worst = 0.0;
    for (let i = 1; i < 50; i++) {
      const p = pos.value_at_time(t0 + (t1 - t0) * i / 50);
      worst = max([
        worst,
        min(zip(path, path.slice(1)).map(([a, b]) => distance_to(p, a, b))),
      ]);
    }
    expect(worst < 1e-4).toBe(true);
  });

  /**
   * AE splits a 5 s 0->100 segment eased 0/75 at 2.5 s into a BEZIER
   * key of value 50 with 80.0 / 12.5 on both sides.
   */
  test("test_bezier_split_matches_after_effects", () => {
    const app = parse_app_fresh(PROPERTY_DIR.div("keyframe_bezier_ease_in_out_1D.aep"));
    const prop = app.project.compositions
      .flatMap((comp) => comp.layers.flatMap((layer) => [...layer.transform].filter((p) => p instanceof Property)))
      .find((p) => py_bool(getattr(p, "keyframes", null)) && len(p.keyframes) === 2);
    if (prop == null) throw new StopIteration();

    const index = prop.add_key(2.5);

    const kf = prop.keyframes[index];
    expect(approx(kf.time, 2.5)).toBe(true);
    expect(approx(kf.value, 50.0)).toBe(true);
    expect(kf.in_interpolation_type).toBe(KeyframeInterpolationType.BEZIER);
    expect(kf.out_interpolation_type).toBe(KeyframeInterpolationType.BEZIER);
    expect(approx(kf.in_temporal_ease[0].speed, 80.0, { abs: 1e-3 })).toBe(true);
    expect(approx(kf.in_temporal_ease[0].influence, 12.5, { abs: 1e-3 })).toBe(true);
    expect(approx(kf.out_temporal_ease[0].speed, 80.0, { abs: 1e-3 })).toBe(true);
    expect(approx(kf.out_temporal_ease[0].influence, 12.5, { abs: 1e-3 })).toBe(true);
    // AE leaves the neighbours' handles alone in this case.
    expect(approx(prop.keyframes[0].out_temporal_ease[0].influence, 75.0)).toBe(true);
    expect(approx(prop.keyframes[2].in_temporal_ease[0].influence, 75.0)).toBe(true);
  });

  /**
   * AE gives the new key HOLD on both sides (speed 0, default
   * influence), so the value never ramps.
   */
  test("test_hold_segment_stays_held", () => {
    const [app, comp] = _new_comp(200, 200);
    const layer = comp.add_solid([1, 0, 0], "L", 100, 100, 1.0);
    const op = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Opacity"), Property);
    op.set_value_at_time(0.0, 100.0);
    op.set_value_at_time(4.0, 0.0);
    for (const kf of op.keyframes) {
      kf.in_interpolation_type = KeyframeInterpolationType.HOLD;
      kf.out_interpolation_type = KeyframeInterpolationType.HOLD;
    }

    const before = [0.0, 1.0, 2.0, 3.0, 4.0].map((t) => op.value_at_time(t));
    op.add_key(2.0);
    const after = [0.0, 1.0, 2.0, 3.0, 4.0].map((t) => op.value_at_time(t));

    expect(approx(after, before)).toBe(true);
    expect(op.keyframes[1].out_interpolation_type).toBe(KeyframeInterpolationType.HOLD);
  });

  test("test_add_then_remove_restores_the_keyframes", () => {
    const tmp_path: Path = make_tmp_path();
    const app = parse_app_fresh(PROPERTY_DIR.div("keyframe_bezier_ease_in_out_1D.aep"));
    const prop = app.project.compositions
      .flatMap((comp) => comp.layers.flatMap((layer) => [...layer.transform].filter((p) => p instanceof Property)))
      .find(
        (p) =>
          py_bool(getattr(p, "keyframes", null)) && len(p.keyframes) >= 2 && !p.is_spatial,
      );
    if (prop == null) throw new StopIteration();
    const times = [0.0, 0.5, 1.0, 1.5, 2.0, 3.0];
    const before = times.map((t) => prop.value_at_time(t));
    const mid = (prop.keyframes[0].time + prop.keyframes[1].time) / 2.0;

    const index = prop.add_key(mid);
    prop.remove_key(index);

    expect(approx(times.map((t) => prop.value_at_time(t)), before, { abs: 1e-6 })).toBe(true);
  });
});
