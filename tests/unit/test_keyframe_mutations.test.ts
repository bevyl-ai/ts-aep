/**
 * Tests for keyframe mutation: add_key, remove_key, set_value(s)_at_time(s),
 * Shape creation from scratch, and numeric keyframe value persistence.
 *
 * Mutation tests parse a fresh (uncached) copy so changes do not leak between
 * tests, and assert results survive a save / re-parse round-trip.
 */

import { describe, expect, test } from "bun:test";
import { len, valueEquals, ValueError, zip } from "../../src/pyrt/index.ts";

// Python's `from py_aep.models.properties.shape import Shape` loads the whole package, which registers every chunk type.
import "../../src/py_aep/binary/_register.ts";
import { Shape } from "../../src/py_aep/models/properties/shape.ts";
import { approx, raises } from "../support/pytest.ts";

/** Compare two lists of [x, y] pairs within tolerance. */
function _approxPoints(actual: number[][], expected: number[][], absTol = 1e-2): boolean {
  if (len(actual) !== len(expected)) return false;
  return zip(actual, expected).every(([a, e]) => approx(a, e, { abs: absTol }));
}

describe("TestShapeFromScratch", () => {
  test("test_closed_triangle_no_tangents", () => {
    const verts = [
      [0, 0],
      [100, 0],
      [50, 80],
    ];
    const s = new Shape(verts);
    expect(s.closed).toBe(true);
    expect(_approxPoints(s.vertices, verts)).toBe(true);
    expect(_approxPoints(s.inTangents, Array(3).fill([0, 0]))).toBe(true);
    expect(_approxPoints(s.outTangents, Array(3).fill([0, 0]))).toBe(true);
  });

  test("test_open_path_with_tangents", () => {
    const verts = [
      [0, 0],
      [200, 100],
    ];
    const ins = [
      [-10, 0],
      [-20, -5],
    ];
    const outs = [
      [10, 0],
      [20, 5],
    ];
    const s = new Shape(verts, ins, outs, { closed: false });
    expect(s.closed).toBe(false);
    expect(_approxPoints(s.vertices, verts)).toBe(true);
    expect(_approxPoints(s.inTangents, ins)).toBe(true);
    expect(_approxPoints(s.outTangents, outs)).toBe(true);
  });

  test("test_empty_shape", () => {
    const s = new Shape();
    expect(valueEquals(s.vertices, [])).toBe(true);
    expect(s.closed).toBe(true);
  });

  test("test_mismatched_tangent_lengths_raise", () => {
    raises(
      ValueError,
      () =>
        new Shape(
          [
            [0, 0],
            [1, 1],
          ],
          [[0, 0]],
        ),
    );
  });

  test("test_post_construction_vertices_edit", () => {
    const s = new Shape([
      [0, 0],
      [100, 0],
      [50, 80],
    ]);
    const new_ = [
      [0, 0],
      [300, 0],
      [150, 240],
    ];
    s.vertices = new_;
    expect(_approxPoints(s.vertices, new_)).toBe(true);
  });
});
