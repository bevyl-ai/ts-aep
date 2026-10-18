/**
 * Tests for roving keyframe re-timing on spatial properties.
 *
 * `keyframe_roving.aep` was saved by After Effects with keyframes 1 and 2 of a
 * four-keyframe Position path set to "Rove Across Time", so the times it holds
 * for them are the times AE computed. Re-deriving them has to land on the same
 * values.
 *
 * Mutation tests parse a fresh (uncached) copy so changes do not leak between
 * tests, and the persistence class additionally asserts results survive a
 * save / re-parse round-trip.
 */

import { describe, expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import { parseProjectFresh } from "../helpers.ts";
import {
  at,
  floordiv,
  len,
  mod,
  Path,
  assert,
  valueEquals,
  repr,
  sorted,
  ValueError,
} from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { frameGrid } from "../../src/py_aep/binary/composition_chunks.ts";
import type { Layer, Project, Property } from "../../src/py_aep/models/index.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");

function _position(sample: string): Property {
  const project = parseProjectFresh(SAMPLES_DIR.div(sample));
  const layer: Layer = project.compositions[0].layers[0];
  const prop = layer.transform.property("ADBE Position");
  assert(prop != null);
  return prop;
}

function _positionFrom(project: Project): Property {
  const layer: Layer = project.compositions[0].layers[0];
  const prop = layer.transform.property("ADBE Position");
  assert(prop != null);
  return prop;
}

/** Stored (sub-frame) keyframe times, which `frameTime` would round. */
function _times(prop: Property): number[] {
  return prop.keyframes.map((kf) => kf._ldatItem.timeUnits);
}

describe("TestRoundtripRovingRetimesToAEValues", () => {
  /** The re-timing model reproduces what AE saved. */

  test("test_recompute_is_idempotent", () => {
    const prop = _position("keyframe_roving.aep");
    expect(valueEquals(prop.keyframes.map((kf) => kf.roving), [false, true, true, false])).toBe(true);
    const expected = _times(prop);
    prop._redistributeRovingKeyframes();
    expect(valueEquals(_times(prop), expected)).toBe(true);
  });

  test("test_rederived_from_clobbered_times", () => {
    const prop = _position("keyframe_roving.aep");
    const expected = _times(prop);
    for (const index of [1, 2]) {
      prop.keyframes[index]._ldatItem.timeUnits = 1234 * index;
    }
    // Touching one member re-times the whole run it belongs to.
    prop.keyframes[1].roving = true;
    expect(valueEquals(_times(prop), expected)).toBe(true);
  });

  test("test_bounding_keyframes_keep_their_times", () => {
    const prop = _position("keyframe_roving.aep");
    const [first, last] = [_times(prop)[0], at(_times(prop), -1)];
    prop.keyframes[2].roving = true;
    expect(_times(prop)[0]).toBe(first);
    expect(at(_times(prop), -1)).toBe(last);
  });

  test("test_times_stay_ordered", () => {
    const prop = _position("keyframe_roving.aep");
    prop.keyframes[0].value = [0.0, 0.0, 0.0];
    const times = _times(prop);
    expect(valueEquals(times, sorted(times))).toBe(true);
    expect(len(new Set(times))).toBe(len(times));
  });
});

describe("TestRoundtripRovingFollowsBoundingEase", () => {
  /**
   * The bounding keyframes' ease shapes the run, not just arc length.
   *
   * `keyframe_roving.aep` has three equal-length path segments and no ease
   * (influence 0), so AE spread its run evenly. Adding a symmetric
   * ease-in-out has to pull both roving keyframes toward the middle of the
   * span: the motion starts slow, so covering the first third of the path
   * now takes more than a third of the time.
   */

  test("test_ease_in_out_pulls_the_run_inward", () => {
    const prop = _position("keyframe_roving.aep");
    const span = at(_times(prop), -1);
    expect(valueEquals(_times(prop).slice(1, 3), [floordiv(span, 3), floordiv(span * 2, 3)])).toBe(true);

    prop.keyframes[0].outTemporalEase[0].influence = 100.0 / 3.0;
    at(prop.keyframes, -1).inTemporalEase[0].influence = 100.0 / 3.0;
    prop.keyframes[1].roving = true;

    const eased = _times(prop);
    expect(eased[1] > floordiv(span, 3)).toBe(true);
    expect(eased[2] < floordiv(span * 2, 3)).toBe(true);
    // Symmetric ease on a symmetric path stays symmetric.
    expect(Math.abs((eased[1] - 0) - (span - eased[2])) <= 1).toBe(true);
  });
});

describe("TestRoundtripRovingBoundaryGuard", () => {
  /** The outermost keyframes bound every run and cannot rove themselves. */

  test.each([0, -1])("test_first_and_last_cannot_rove[%#]", (index: number) => {
    const prop = _position("keyframe_roving.aep");
    raises(ValueError, () => {
      at(prop.keyframes, index).roving = true;
    }, "cannot rove");
  });

  test("test_middle_keyframe_is_allowed", () => {
    const prop = _position("keyframe_roving.aep");
    prop.keyframes[1].roving = true;
    expect(prop.keyframes[1].roving).toBe(true);
  });
});

describe("TestRoundtripRovingTriggers", () => {
  /** A bounding keyframe's time or value re-times the run it bounds. */

  test("test_frame_time_retimes_the_run", () => {
    const prop = _position("keyframe_roving.aep");
    const before = _times(prop);
    // Stretching the span the run sits in spreads the run over it.
    prop.keyframes[3].frameTime = 300;
    const after = _times(prop);
    expect(after[1] > before[1]).toBe(true);
    expect(after[2] > before[2]).toBe(true);
    expect(after[0]).toBe(before[0]);
    expect(prop.keyframes[3].frameTime).toBe(300);
  });

  test("test_roved_times_are_not_whole_frames", () => {
    const prop = _position("keyframe_roving.aep");
    prop.keyframes[3].frameTime = 199;
    const unitsPerFrame = frameGrid(prop.keyframes[0]._frameRate)[1];
    // A whole-frame-only implementation could not produce a remainder.
    assert(
      _times(prop).slice(1, 3).some((time) => mod(time, unitsPerFrame) !== 0),
      "roved times should not all land on frame boundaries",
    );
  });

  test("test_value_retimes_the_run", () => {
    const prop = _position("keyframe_roving.aep");
    const before = _times(prop);
    // Lengthening the first path segment pushes the roving keyframes later.
    prop.keyframes[0].value = [-400.0, 150.0, 0.0];
    const after = _times(prop);
    expect(after[1] > before[1]).toBe(true);
    expect(after[2] > before[2]).toBe(true);
    expect(after[0]).toBe(before[0]);
    expect(after[3]).toBe(before[3]);
  });

  test("test_spatial_tangent_retimes_the_run", () => {
    const prop = _position("keyframe_roving.aep");
    const before = _times(prop);
    // Adding a curve to the first segment changes the arc length,
    // which shifts where the roving keyframes land.
    prop.keyframes[0].outSpatialTangent = [100.0, 0.0, 0.0];
    const after = _times(prop);
    expect(!valueEquals(after.slice(1, 3), before.slice(1, 3))).toBe(true);
    expect(after[0]).toBe(before[0]);
    expect(after[3]).toBe(before[3]);
  });

  test("test_clearing_roving_pins_that_keyframe", () => {
    const prop = _position("keyframe_roving.aep");
    const pinned = _times(prop)[2];
    prop.keyframes[2].roving = false;
    expect(prop.keyframes[2].roving).toBe(false);
    expect(_times(prop)[2]).toBe(pinned);
  });
});

describe("TestRoundtripRovingNonSpatial", () => {
  /** AE rejects roving on a non-spatial property with a ValueError. */

  test("test_scale_rejects_roving", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("keyframe_bezier_ease_scale.aep"));
    const prop = project.compositions[0].layers[0].transform.property("ADBE Scale");
    assert(prop != null);
    expect(prop.isSpatial).toBe(false);
    raises(ValueError, () => {
      prop.keyframes[1].roving = true;
    }, "spatial");
  });

  test("test_opacity_rejects_roving", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("keyframe_bounce_pattern.aep"));
    const prop = project.compositions[0].layers[0].transform.property("ADBE Opacity");
    assert(prop != null);
    expect(prop.isSpatial).toBe(false);
    raises(ValueError, () => {
      prop.keyframes[3].roving = true;
    }, "spatial");
  });
});

describe("TestRoundtripRovingPersistence", () => {
  /**
   * A re-timed roved keyframe survives `Project.save()` -> re-parse.
   *
   * `_redistributeRovingKeyframes` writes straight to `_ldat_item.timeUnits`
   * (`Keyframe.frameTime` would quantise a sub-frame roved tick to a whole
   * frame, per its own docstring), so this is the check that the raw value
   * actually round-trips through the binary writer, not just through the
   * in-memory model - `test_roved_times_are_not_whole_frames` above only
   * proves the value is sub-frame, not that it survives a save.
   */

  test("test_roved_tick_is_bit_identical_after_save_reparse", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("keyframe_roving.aep"));
    const prop = _positionFrom(project);
    // Re-derive from a clobbered time, like
    // test_rederived_from_clobbered_times, so the saved value is
    // provably the model's own answer and not just the untouched byte
    // AE originally wrote.
    prop.keyframes[1]._ldatItem.timeUnits = 4321;
    prop.keyframes[1].roving = true;
    const inMemory = _times(prop);

    const out = tmpPath.div("keyframe_roving_saved.aep");
    project.save(out);

    const reparsed = parseProjectFresh(out);
    const onDisk = _times(_positionFrom(reparsed));

    assert(
      valueEquals(onDisk, inMemory),
      "save/reparse did not preserve the re-derived roved ticks " +
        `exactly: in-memory ${repr(inMemory)}, on disk ${repr(onDisk)}`,
    );
  });

  test("test_non_spatial_roving_flag_survives_save_reparse", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("keyframe_bounce_pattern.aep"));
    const prop = project.compositions[0].layers[0].transform.property("ADBE Opacity");
    assert(prop != null);
    const beforeTimes = prop.keyframes.map((kf) => kf._ldatItem.timeUnits);

    prop.keyframes[3]._ldatItem.roving = true;

    const out = tmpPath.div("keyframe_bounce_pattern_saved.aep");
    project.save(out);

    const reparsed = parseProjectFresh(out);
    const reparsedProp = reparsed.compositions[0].layers[0].transform.property("ADBE Opacity");
    assert(reparsedProp != null);
    expect(reparsedProp.keyframes[3].roving).toBe(true);
    expect(valueEquals(reparsedProp.keyframes.map((kf) => kf._ldatItem.timeUnits), beforeTimes)).toBe(true);
  });
});

describe("TestOrientationInert", () => {
  /**
   * Orientation is spatial-valued but does not rove in AE (26.3x87):
   * the menu accepts the command, the keyframe never moves. Unequal
   * segments on purpose - equal spans would make re-timing a no-op and
   * prove nothing.
   */

  test("test_roved_orientation_keeps_its_time", () => {
    const project = parseProjectFresh(SAMPLES_DIR.parent.div("layer", "orientation_0_0_5.aep"));
    let prop: Property | null = null;
    for (const layer of project.compositions[0].layers) {
      const candidate = layer.transform.property("ADBE Orientation");
      if (candidate != null) {
        prop = candidate;
        break;
      }
    }
    assert(prop != null);
    for (const [time, z] of [[0.0, 0.0], [0.5, 10.0], [1.0, 40.0]]) {
      prop.setValueAtTime(time, [0.0, 0.0, z]);
    }
    const keyframes = prop.keyframes;
    keyframes[1]._ldatItem.roving = true;
    const before = keyframes.map((k) => k._ldatItem.timeUnits);
    prop._redistributeRovingKeyframes();
    expect(valueEquals(keyframes.map((k) => k._ldatItem.timeUnits), before)).toBe(true);
    expect(keyframes[1].roving).toBe(true);
  });
});

describe("TestRoundtripRovingTimeIsDerived", () => {
  /**
   * A roving keyframe has no time of its own.
   *
   * Every time write is followed by a redistribution that re-derives it from
   * the path, so accepting one would silently discard the caller's value.
   */

  test("test_setting_time_on_a_roving_keyframe_raises", () => {
    const prop = _position("keyframe_roving.aep");
    const before = _times(prop);
    raises(ValueError, () => {
      prop.keyframes[1].time = 0.25;
    }, "derived from the spatial path");
    expect(valueEquals(_times(prop), before)).toBe(true);
  });

  test("test_setting_frame_time_on_a_roving_keyframe_raises", () => {
    const prop = _position("keyframe_roving.aep");
    const before = _times(prop);
    raises(ValueError, () => {
      prop.keyframes[1].frameTime = 6;
    }, "derived from the spatial path");
    expect(valueEquals(_times(prop), before)).toBe(true);
  });

  test("test_an_anchor_still_moves_and_retimes_the_run", () => {
    const prop = _position("keyframe_roving.aep");
    const before = _times(prop);
    at(prop.keyframes, -1).time = at(prop.keyframes, -1).time + 1.0;
    const after = _times(prop);
    expect(at(after, -1) > at(before, -1)).toBe(true);
    expect(!valueEquals(after.slice(1, 3), before.slice(1, 3))).toBe(true);
  });

  test("test_clearing_roving_makes_the_time_writable_again", () => {
    const prop = _position("keyframe_roving.aep");
    prop.keyframes[1].roving = false;
    prop.keyframes[1].time = 0.25;
    expect(approx(prop.keyframes[1].time, 0.25)).toBe(true);
  });
});

describe("TestRoundtripRovingEarlyOut", () => {
  /**
   * Redistribution runs on every value, time and tangent write, so a
   * property carrying no roving keyframe must be left completely alone.
   */

  test("test_value_write_leaves_a_non_roving_run_untouched", () => {
    const prop = _position("keyframe_roving.aep");
    for (const kf of prop.keyframes) {
      if (kf.roving) {
        kf.roving = false;
      }
    }
    const before = _times(prop);

    prop.keyframes[0].value = [-400.0, 150.0, 0.0];
    prop.keyframes[2].outSpatialTangent = [80.0, 0.0, 0.0];

    expect(valueEquals(_times(prop), before)).toBe(true);
  });

  test("test_roving_run_still_retimes_after_the_early_out", () => {
    const prop = _position("keyframe_roving.aep");
    assert(prop.keyframes.some((kf) => kf.roving), "sample must carry a run");
    const before = _times(prop);
    prop.keyframes[0].value = [-400.0, 150.0, 0.0];
    expect(!valueEquals(_times(prop), before)).toBe(true);
  });
});
