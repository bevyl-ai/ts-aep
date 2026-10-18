/**
 * RotoBezier tangent rule (`resolvers.rotoBezier`), against values
 * measured on After Effects 2026.
 */

import { describe, expect, test } from "bun:test";


import { truthy, valueEquals } from "../../src/pyrt/index.ts";
import { DEFAULT_TENSION, keyframeTensions, rotoBezierTangents } from "../../src/py_aep/resolvers/roto_bezier.ts";
import { approx } from "../support/pytest.ts";

function _flat(points: number[][]): number[] {
  return points.flatMap((point) => point);
}

describe("TestRotoBezierTangents", () => {
  test("test_closed_path_in_pixel_space", () => {
    // A 1920x1080 layer's current aspect stamp (width / height) makes
    // the measuring space pixel space: each tangent is k times the
    // distance to its neighbour, along next - prev.
    const vertices = [[100, 100], [900, 120], [800, 700], [150, 600]];
    const [ins, outs] = rotoBezierTangents(
      vertices,
      true,
      new Array(4).fill(DEFAULT_TENSION),
      (1920 / 1080) / 1920,
      1 / 1080,
    );
    expect(approx(_flat(ins).slice(0, 2), [-141.0787, 90.2904], { abs: 1e-3 })).toBe(true);
    expect(approx(_flat(outs).slice(0, 2), [224.6758, -143.7926], { abs: 1e-3 })).toBe(true);
  });

  test("test_stale_aspect_measures_in_normalized_space", () => {
    // An aspect of 1 (older files) measures the default full-layer
    // rectangle as a unit square: AE reports +-452.548 / 254.558 on a
    // 1920x1080 layer (the mask_rotobezier_on sample).
    const vertices = [[0, 0], [0, 1080], [1920, 1080], [1920, 0]];
    const [ins, outs] = rotoBezierTangents(
      vertices,
      true,
      new Array(4).fill(DEFAULT_TENSION),
      1 / 1920,
      1 / 1080,
    );
    expect(approx(ins[0], [452.5483, -254.5584], { abs: 1e-3 })).toBe(true);
    expect(approx(outs[0], [-452.5483, 254.5584], { abs: 1e-3 })).toBe(true);
  });

  test("test_open_path_ends_aim_at_the_neighbouring_handle", () => {
    const [ins, outs] = rotoBezierTangents(
      [[100, 100], [500, 500], [900, 100]],
      false,
      new Array(3).fill(0.0),
      1.0,
      1.0,
    );
    expect(
      approx(_flat(ins), [0, 0, -282.8427, 0, -58.5786, 200], { abs: 1e-3 }),
    ).toBe(true);
    expect(
      approx(_flat(outs), [58.5786, 200, 282.8427, 0, 0, 0], { abs: 1e-3 }),
    ).toBe(true);
  });

  test("test_two_vertex_open_path", () => {
    // The last end is aimed first, while the first end's handle is 0.
    const [ins, outs] = rotoBezierTangents(
      [[100, 100], [500, 300]],
      false,
      [0.0, 0.0],
      1.0,
      1.0,
    );
    expect(approx(_flat(ins), [0, 0, -200, -100])).toBe(true);
    expect(approx(_flat(outs), [100, 50, 0, 0])).toBe(true);
  });

  test.each([[[[100, 100], [500, 300]]], [[[300, 300]]]])(
    "test_degenerate_closed_paths_have_no_tangents[%#]",
    (vertices: number[][]) => {
      const [ins, outs] = rotoBezierTangents(
        vertices,
        true,
        new Array(vertices.length).fill(0.0),
        1.0,
        1.0,
      );
      expect(
        [..._flat(ins), ..._flat(outs)].some((x) => truthy(x)),
      ).toBe(false);
    },
  );
});

describe("TestKeyframeTensions", () => {
  test("test_stored_tensions_are_kept", () => {
    expect(
      valueEquals(
        keyframeTensions([0.5, 0.25], [[0, 0], [1, 2]], [[0, 0], [3, 4]]),
        [0.5, 0.25],
      ),
    ).toBe(true);
  });

  test("test_missing_tensions_follow_the_stored_handles", () => {
    const tensions = keyframeTensions(
      [],
      [[-30, 10], [0, 0], [0, 0]],
      [[40, -20], [0, 0], [0, 5]],
    );
    expect(valueEquals(tensions, [DEFAULT_TENSION, 1.0, DEFAULT_TENSION])).toBe(true);
  });
});
