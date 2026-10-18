/**
 * Auto-bezier derivation rules, measured on AE 2018 and AE 2026.
 *
 * After Effects recomputes an auto-bezier keyframe's tangents and ease from the
 * flag and ignores whatever is stored, so its own files legitimately carry stale
 * or zero values on those keyframes. Every expectation here is an AE measurement,
 * not a restatement of the implementation - see
 * `.claude/plans/write-path-companion-state.md`.
 */

import { describe, expect, test } from "bun:test";

import { valueEquals } from "../../src/pyrt/index.ts";

import {
  _DEFAULT_INFLUENCE,
  autoSpatialTangents,
  autoTemporalSpeeds,
} from "../../src/py_aep/resolvers/interpolation.ts";
import { approx } from "../support/pytest.ts";

/** Tangent is +/- one sixth of the chord between the neighbours. */
describe("TestAutoSpatialTangents", () => {
  /**
   * The discriminating case: neighbours that are NOT equidistant in
   * time. AE gives +/-(600-0)/6; the time-weighted rule this replaced
   * would give in=[-50] out=[150].
   */
  test("test_interior_uses_chord_not_time_weighting", () => {
    const values = [
      [0.0, 0.0],
      [100.0, 0.0],
      [600.0, 0.0],
    ];
    const [outTangent, inTangent] = autoSpatialTangents(values, 1);
    expect(approx(outTangent, [100.0, 0.0])).toBe(true);
    expect(approx(inTangent, [-100.0, 0.0])).toBe(true);
  });

  /**
   * AE writes BOTH tangents at an endpoint, from the chord to its one
   * neighbour: k0 gets +/-(100-0)/6, k2 gets +/-(600-100)/6.
   */
  test("test_endpoints_use_the_single_neighbour_chord", () => {
    const values = [
      [0.0, 0.0],
      [100.0, 0.0],
      [600.0, 0.0],
    ];
    const [firstOut, firstIn] = autoSpatialTangents(values, 0);
    expect(approx(firstOut, [100.0 / 6.0, 0.0])).toBe(true);
    expect(approx(firstIn, [-100.0 / 6.0, 0.0])).toBe(true);

    const [lastOut, lastIn] = autoSpatialTangents(values, 2);
    expect(approx(lastOut, [500.0 / 6.0, 0.0])).toBe(true);
    expect(approx(lastIn, [-500.0 / 6.0, 0.0])).toBe(true);
  });

  test("test_two_keyframes_share_the_same_chord", () => {
    const values = [
      [0.0, 0.0],
      [300.0, 0.0],
    ];
    for (const index of [0, 1]) {
      const [outTangent, inTangent] = autoSpatialTangents(values, index);
      expect(approx(outTangent, [50.0, 0.0])).toBe(true);
      expect(approx(inTangent, [-50.0, 0.0])).toBe(true);
    }
  });

  test("test_three_dimensional", () => {
    const values = [
      [0.0, 0.0, 0.0],
      [100.0, 50.0, 20.0],
      [600.0, 300.0, 90.0],
    ];
    const [outTangent, inTangent] = autoSpatialTangents(values, 1);
    expect(approx(outTangent, [100.0, 50.0, 15.0])).toBe(true);
    expect(approx(inTangent, [-100.0, -50.0, -15.0])).toBe(true);
  });

  test("test_single_keyframe_has_no_tangents", () => {
    const [outTangent, inTangent] = autoSpatialTangents([[10.0, 20.0]], 0);
    expect(valueEquals(outTangent, [0.0, 0.0])).toBe(true);
    expect(valueEquals(inTangent, [0.0, 0.0])).toBe(true);
  });

  /**
   * The five-key diamond in samples/versions/ae2018. Every tangent AE
   * reports for it is chord/6, including both endpoints.
   */
  test("test_ae2018_diamond", () => {
    const values = [
      [100.0, 540.0, 0.0],
      [960.0, 100.0, 0.0],
      [1820.0, 540.0, 0.0],
      [960.0, 980.0, 0.0],
      [100.0, 540.0, 0.0],
    ];
    const expectedOut = [
      [143.333, -73.333, 0.0],
      [286.667, 0.0, 0.0],
      [0.0, 146.667, 0.0],
      [-286.667, 0.0, 0.0],
      [-143.333, -73.333, 0.0],
    ];
    for (const [index, expected] of expectedOut.entries()) {
      const [outTangent, inTangent] = autoSpatialTangents(values, index);
      expect(approx(outTangent, expected, { abs: 0.001 })).toBe(true);
      expect(
        approx(
          inTangent,
          expected.map((c) => -c),
          { abs: 0.001 },
        ),
      ).toBe(true);
    }
  });
});

/** Speed is the through-slope across the neighbours, per dimension. */
describe("TestAutoTemporalSpeeds", () => {
  /** AE 2018 Rotate Z, 0 -> 180 -> 360 at t = 0 / 2 / 4: speed 90. */
  test("test_interior_through_slope", () => {
    const values = [[0.0], [180.0], [360.0]];
    const times = [0.0, 2.0, 4.0];
    const [inSpeeds, outSpeeds] = autoTemporalSpeeds(values, times, 1);
    expect(approx(inSpeeds, [90.0])).toBe(true);
    expect(approx(outSpeeds, [90.0])).toBe(true);
  });

  test("test_endpoints_zero_on_the_outward_side", () => {
    const values = [[0.0], [180.0], [360.0]];
    const times = [0.0, 2.0, 4.0];
    const [firstIn, firstOut] = autoTemporalSpeeds(values, times, 0);
    expect(approx(firstIn, [0.0])).toBe(true);
    expect(approx(firstOut, [90.0])).toBe(true);

    const [lastIn, lastOut] = autoTemporalSpeeds(values, times, 2);
    expect(approx(lastIn, [90.0])).toBe(true);
    expect(approx(lastOut, [0.0])).toBe(true);
  });

  /**
   * AE 2026, 2-D Scale 100->200->400 and 100->120->150 over 2 s:
   * speeds 150 and 25, NOT one shared scalar.
   */
  test("test_per_dimension_slope", () => {
    const values = [
      [100.0, 100.0],
      [200.0, 120.0],
      [400.0, 150.0],
    ];
    const times = [0.0, 1.0, 2.0];
    const [inSpeeds, outSpeeds] = autoTemporalSpeeds(values, times, 1);
    expect(approx(inSpeeds, [150.0, 25.0])).toBe(true);
    expect(approx(outSpeeds, [150.0, 25.0])).toBe(true);
  });

  test("test_three_dimensional_scale", () => {
    const values = [
      [100.0, 100.0, 100.0],
      [200.0, 120.0, 110.0],
      [400.0, 150.0, 300.0],
    ];
    const times = [0.0, 1.0, 2.0];
    const [inSpeeds, _] = autoTemporalSpeeds(values, times, 1);
    expect(approx(inSpeeds, [150.0, 25.0, 100.0])).toBe(true);
  });

  /** AE 2026, opacity 0 -> 100 over 4 s: slope 25 on the inward side. */
  test("test_two_keyframes", () => {
    const values = [[0.0], [100.0]];
    const times = [0.0, 4.0];
    const [firstIn, firstOut] = autoTemporalSpeeds(values, times, 0);
    expect(approx(firstIn, [0.0])).toBe(true);
    expect(approx(firstOut, [25.0])).toBe(true);
  });

  test("test_single_keyframe_has_no_speed", () => {
    const [inSpeeds, outSpeeds] = autoTemporalSpeeds([[42.0]], [1.0], 0);
    expect(valueEquals(inSpeeds, [0.0])).toBe(true);
    expect(valueEquals(outSpeeds, [0.0])).toBe(true);
  });

  test("test_zero_span_does_not_divide_by_zero", () => {
    const values = [[0.0], [10.0], [20.0]];
    const times = [1.0, 1.0, 1.0];
    const [inSpeeds, outSpeeds] = autoTemporalSpeeds(values, times, 1);
    expect(valueEquals(inSpeeds, [0.0])).toBe(true);
    expect(valueEquals(outSpeeds, [0.0])).toBe(true);
  });

  test("test_default_influence_is_one_sixth", () => {
    expect(approx(_DEFAULT_INFLUENCE, 100.0 / 6.0)).toBe(true);
  });
});
