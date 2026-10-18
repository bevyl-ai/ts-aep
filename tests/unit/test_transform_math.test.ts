/**
 * Unit tests for the transform matrix module.
 *
 * Tests matrix composition, decomposition, and round-trip accuracy for
 * a variety of 2D and 3D transform configurations.
 */

import { describe, expect, test } from "bun:test";

import { ValueError, enumerate, float_repr, py_assert, zip } from "../../src/pyrt/index.ts";
import { approx, raises } from "../../src/pyrt/pytest.ts";
import { Mat4, _rotate_x, _rotate_y, _rotate_z, _translation, build_local_matrix, compose_orientation, decompose_transform } from "../../src/py_aep/resolvers/transform.ts";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Assert two values (scalar or nested list) are approximately equal. */
function _approx(a: number | number[], b: number | number[], tol = 1e-6): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    py_assert(a.length === b.length, `length mismatch: ${a.length} vs ${b.length}`);
    for (const [i, [ai, bi]] of enumerate(zip(a, b))) {
      py_assert(approx(ai, bi, { abs: tol }), `index ${i}: ${float_repr(ai)} != ${float_repr(bi)}`);
    }
  } else {
    py_assert(approx(a, b, { abs: tol }));
  }
}

/** Assert two 4x4 matrices are approximately equal. */
function _mat_approx(a: Mat4, b: Mat4, tol = 1e-6): void {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      py_assert(
        approx(a.row(r)[c], b.row(r)[c], { abs: tol }),
        `M[${r}][${c}]: ${float_repr(a.row(r)[c])} != ${float_repr(b.row(r)[c])}`,
      );
    }
  }
}

// ------------------------------------------------------------------
// Identity and basic operations
// ------------------------------------------------------------------

describe("TestMatrixPrimitives", () => {
  test("test_identity", () => {
    const m = Mat4.identity();
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const expected = r === c ? 1.0 : 0.0;
        expect(m.row(r)[c]).toBe(expected);
      }
    }
  });

  test("test_multiply_identity", () => {
    const a = build_local_matrix([10, 20, 0], [0, 0, 0], [100, 100, 100], 45);
    const result = Mat4.identity().__matmul__(a);
    _mat_approx(result, a);
    const result2 = a.__matmul__(Mat4.identity());
    _mat_approx(result2, a);
  });

  test("test_translation_roundtrip", () => {
    const t = _translation(5, 10, 15);
    const t_inv = t.inverse();
    const result = t.__matmul__(t_inv);
    _mat_approx(result, Mat4.identity());
  });

  test("test_inverse_of_identity", () => {
    const m = Mat4.identity();
    const inv = m.inverse();
    _mat_approx(inv, Mat4.identity());
  });

  test("test_inverse_roundtrip", () => {
    const m = build_local_matrix([30, 20, 10], [5, 5, 0], [150, 80, 100], 37, {
      rotate_x: 15,
      rotate_y: 25,
    });
    const inv = m.inverse();
    const result = m.__matmul__(inv);
    _mat_approx(result, Mat4.identity(), 1e-5);
  });

  test("test_singular_raises", () => {
    const m = new Mat4(Array.from({ length: 4 }, () => [0, 0, 0, 0]));
    raises(ValueError, () => m.inverse(), "Singular");
  });
});

// ------------------------------------------------------------------
// Build + decompose round-trip tests
// ------------------------------------------------------------------

describe("TestRoundTrip2D", () => {
  /** 2D layers: only Position, Anchor, Scale, Rotation Z. */

  test("test_identity_transform", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = 0.0;
    const m = build_local_matrix(pos, anchor, scale, rz);
    const [d_pos, d_scale, d_rz, d_rx, d_ry] = decompose_transform(m, anchor);
    _approx(d_pos, pos);
    _approx(d_scale, scale);
    _approx(d_rz, rz);
    _approx(d_rx, 0.0);
    _approx(d_ry, 0.0);
  });

  test("test_position_only", () => {
    const pos = [73.0, 41.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = 0.0;
    const m = build_local_matrix(pos, anchor, scale, rz);
    const [d_pos, d_scale, d_rz, d_rx, d_ry] = decompose_transform(m, anchor);
    _approx(d_pos, pos);
    _approx(d_scale, scale);
    _approx(d_rz, rz);
  });

  test("test_position_with_anchor", () => {
    const pos = [50.0, 50.0, 0.0];
    const anchor = [25.0, 25.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = 0.0;
    const m = build_local_matrix(pos, anchor, scale, rz);
    const [d_pos, d_scale, d_rz] = decompose_transform(m, anchor);
    _approx(d_pos, pos);
    _approx(d_scale, scale);
    _approx(d_rz, rz);
  });

  test("test_rotation_only", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = 45.0;
    const m = build_local_matrix(pos, anchor, scale, rz);
    const [d_pos, d_scale, d_rz] = decompose_transform(m, anchor);
    _approx(d_pos, pos);
    _approx(d_scale, scale);
    _approx(d_rz, rz);
  });

  test("test_scale_only", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [200.0, 50.0, 100.0];
    const rz = 0.0;
    const m = build_local_matrix(pos, anchor, scale, rz);
    const [d_pos, d_scale, d_rz] = decompose_transform(m, anchor);
    _approx(d_pos, pos);
    _approx(d_scale, scale);
    _approx(d_rz, rz);
  });

  test("test_combined_2d", () => {
    const pos = [30.0, 20.0, 0.0];
    const anchor = [10.0, 10.0, 0.0];
    const scale = [150.0, 80.0, 100.0];
    const rz = 30.0;
    const m = build_local_matrix(pos, anchor, scale, rz);
    const [d_pos, d_scale, d_rz] = decompose_transform(m, anchor);
    _approx(d_pos, pos);
    _approx(d_scale, scale);
    _approx(d_rz, rz);
  });

  test("test_negative_rotation", () => {
    const pos = [100.0, 100.0, 0.0];
    const anchor = [50.0, 50.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = -45.0;
    const m = build_local_matrix(pos, anchor, scale, rz);
    const [d_pos, d_scale, d_rz] = decompose_transform(m, anchor);
    _approx(d_pos, pos);
    _approx(d_scale, scale);
    _approx(d_rz, rz);
  });

  /** Rotations > 180 degrees decompose into [-180, 180] range. */
  test("test_large_rotation", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = 270.0;
    const m = build_local_matrix(pos, anchor, scale, rz);
    const [d_pos, d_scale, d_rz] = decompose_transform(m, anchor);
    // 270 degrees decomposes to -90 (same visual rotation)
    _approx(d_rz, -90.0);
  });
});

/** 3D layers: full rotation set. */
describe("TestRoundTrip3D", () => {
  test("test_rotate_x_only", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const m = build_local_matrix(pos, anchor, scale, 0.0, { rotate_x: 45.0 });
    const [d_pos, d_scale, d_rz, d_rx, d_ry] = decompose_transform(m, anchor);
    _approx(d_pos, pos);
    _approx(d_scale, scale);
    _approx(d_rx, 45.0);
    _approx(d_ry, 0.0);
    _approx(d_rz, 0.0);
  });

  test("test_rotate_y_only", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const m = build_local_matrix(pos, anchor, scale, 0.0, { rotate_y: 30.0 });
    const [d_pos, d_scale, d_rz, d_rx, d_ry] = decompose_transform(m, anchor);
    _approx(d_ry, 30.0);
    _approx(d_rx, 0.0);
  });

  test("test_combined_3d_rotations", () => {
    const pos = [10.0, 20.0, 30.0];
    const anchor = [5.0, 5.0, 5.0];
    const scale = [120.0, 80.0, 100.0];
    const rz = 15.0;
    const rx = 25.0;
    const ry = 35.0;
    const m = build_local_matrix(pos, anchor, scale, rz, { rotate_x: rx, rotate_y: ry });
    const [d_pos, d_scale, d_rz, d_rx, d_ry] = decompose_transform(m, anchor);
    _approx(d_pos, pos);
    _approx(d_scale, scale);
    _approx(d_rz, rz);
    _approx(d_rx, rx);
    _approx(d_ry, ry);
  });

  /** Orientation angles compose into the matrix correctly. */
  test("test_orientation_3d", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const orient = [10.0, 20.0, 30.0];
    const m = build_local_matrix(pos, anchor, scale, 0.0, { orientation: orient });
    // The decomposition extracts the combined rotation into
    // per-axis angles (since orientation is assumed zero for
    // decomposition). The key check is round-trip through
    // build -> decompose -> build produces the same matrix.
    const [d_pos, d_scale, d_rz, d_rx, d_ry] = decompose_transform(m, anchor);
    const m2 = build_local_matrix(d_pos, anchor, d_scale, d_rz, { rotate_x: d_rx, rotate_y: d_ry });
    _mat_approx(m, m2, 1e-5);
  });

  /**
   * Orientation + per-axis rotations: decompose -> recompose
   * produces the same matrix (rotation folded into per-axis).
   */
  test("test_combined_orientation_and_per_axis", () => {
    const pos = [50.0, 50.0, 50.0];
    const anchor = [10.0, 10.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const orient = [5.0, 10.0, 15.0];
    const rz = 20.0;
    const rx = 10.0;
    const ry = 5.0;
    const m = build_local_matrix(pos, anchor, scale, rz, {
      orientation: orient,
      rotate_x: rx,
      rotate_y: ry,
    });
    const [d_pos, d_scale, d_rz, d_rx, d_ry] = decompose_transform(m, anchor);
    const m2 = build_local_matrix(d_pos, anchor, d_scale, d_rz, { rotate_x: d_rx, rotate_y: d_ry });
    _mat_approx(m, m2, 1e-5);
  });
});

// ------------------------------------------------------------------
// Parent-child composition tests
// ------------------------------------------------------------------

/** Simulate unparenting: compose parent+child, decompose child. */
describe("TestParentChild", () => {
  /** Child at [0,0,0] with parent at [73,41,0] -> child becomes [73,41,0]. */
  test("test_position_only_parent", () => {
    const parent_pos = [73.0, 41.0, 0.0];
    const child_pos = [0.0, 0.0, 0.0];
    const child_anchor = [50.0, 50.0, 0.0];
    const scale = [100.0, 100.0, 100.0];

    const parent_m = build_local_matrix(parent_pos, [0.0, 0.0, 0.0], scale, 0.0);
    const child_m = build_local_matrix(child_pos, child_anchor, scale, 0.0);

    const world = parent_m.__matmul__(child_m);
    const [d_pos, d_scale, d_rz] = decompose_transform(world, child_anchor);
    _approx(d_pos, [73.0, 41.0, 0.0]);
    _approx(d_scale, scale);
    _approx(d_rz, 0.0);
  });

  /** Child at [100,0,0] with parent rotated 90deg -> child at [0,100,0]. */
  test("test_rotated_parent", () => {
    const parent_m = build_local_matrix(
      [0.0, 0.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      90.0,
    );
    const child_m = build_local_matrix(
      [100.0, 0.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      0.0,
    );
    const world = parent_m.__matmul__(child_m);
    const [d_pos, d_scale, d_rz] = decompose_transform(world, [0.0, 0.0, 0.0]);
    _approx(d_pos, [0.0, 100.0, 0.0]);
    _approx(d_rz, 90.0);
  });

  /** Child at [50,50,0] with parent at 200% -> child at [100,100,0] with 200% scale. */
  test("test_scaled_parent", () => {
    const parent_m = build_local_matrix(
      [0.0, 0.0, 0.0],
      [0.0, 0.0, 0.0],
      [200.0, 200.0, 100.0],
      0.0,
    );
    const child_m = build_local_matrix(
      [50.0, 50.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      0.0,
    );
    const world = parent_m.__matmul__(child_m);
    const [d_pos, d_scale] = decompose_transform(world, [0.0, 0.0, 0.0]);
    _approx(d_pos, [100.0, 100.0, 0.0]);
    _approx(d_scale, [200.0, 200.0, 100.0]);
  });

  /** Combined parent transform: pos + rotation + scale. */
  test("test_complex_parent", () => {
    const parent_m = build_local_matrix(
      [30.0, 20.0, 0.0],
      [0.0, 0.0, 0.0],
      [150.0, 150.0, 100.0],
      30.0,
    );
    const child_m = build_local_matrix(
      [10.0, 5.0, 0.0],
      [0.0, 0.0, 0.0],
      [80.0, 80.0, 100.0],
      15.0,
    );
    const world = parent_m.__matmul__(child_m);
    const [d_pos, d_scale, d_rz] = decompose_transform(world, [0.0, 0.0, 0.0]);
    // Verify round-trip: rebuild from decomposed values matches world
    const m2 = build_local_matrix(d_pos, [0.0, 0.0, 0.0], d_scale, d_rz);
    _mat_approx(world, m2, 1e-5);
  });

  /** Parent with non-zero anchor: rotates around its anchor point. */
  test("test_parent_with_anchor_offset", () => {
    const parent_anchor = [25.0, 25.0, 0.0];
    const parent_m = build_local_matrix(
      [50.0, 50.0, 0.0],
      parent_anchor,
      [100.0, 100.0, 100.0],
      90.0,
    );
    const child_m = build_local_matrix(
      [20.0, 0.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      0.0,
    );
    const world = parent_m.__matmul__(child_m);
    const [d_pos, d_scale, d_rz] = decompose_transform(world, [0.0, 0.0, 0.0]);
    // Rebuild from decomposed values
    const m2 = build_local_matrix(d_pos, [0.0, 0.0, 0.0], d_scale, d_rz);
    _mat_approx(world, m2, 1e-5);
  });

  /** Assigning a new parent: child_new_local = inv(parent) @ child_world. */
  test("test_inverse_parent_gives_identity_child", () => {
    const parent_m = build_local_matrix(
      [50.0, 30.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      0.0,
    );
    const child_world = build_local_matrix(
      [50.0, 30.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      0.0,
    );
    const child_local = parent_m.inverse().__matmul__(child_world);
    const [d_pos, d_scale, d_rz] = decompose_transform(child_local, [0.0, 0.0, 0.0]);
    _approx(d_pos, [0.0, 0.0, 0.0]);
    _approx(d_scale, [100.0, 100.0, 100.0]);
    _approx(d_rz, 0.0);
  });
});

// ------------------------------------------------------------------
// Edge cases
// ------------------------------------------------------------------

describe("TestEdgeCases", () => {
  /** Negative scale (mirror) round-trips correctly. */
  test("test_negative_scale", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [-100.0, 100.0, 100.0];
    const m = build_local_matrix(pos, anchor, scale, 0.0);
    const [d_pos, d_scale, d_rz] = decompose_transform(m, anchor);
    // Scale should come back negative on x
    expect(d_scale[0] < 0).toBe(true);
    // Rebuild should match
    const m2 = build_local_matrix(d_pos, anchor, d_scale, d_rz);
    _mat_approx(m, m2, 1e-5);
  });

  /** Zero scale doesn't crash - clamped to epsilon. */
  test("test_zero_scale_clamped", () => {
    const pos = [10.0, 20.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [0.0, 100.0, 100.0];
    const m = build_local_matrix(pos, anchor, scale, 0.0);
    // Should not raise
    const [d_pos, d_scale, d_rz] = decompose_transform(m, anchor);
    _approx(d_pos, pos);
  });

  test("test_180_rotation", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const m = build_local_matrix(pos, anchor, scale, 180.0);
    const [d_pos, d_scale, d_rz] = decompose_transform(m, anchor);
    _approx(Math.abs(d_rz), 180.0, 0.01);
  });

  /** Near gimbal lock (ry=90) still decomposes to same matrix. */
  test("test_gimbal_lock_3d", () => {
    const pos = [10.0, 20.0, 30.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const m = build_local_matrix(pos, anchor, scale, 0.0, { rotate_x: 45.0, rotate_y: 89.99 });
    const [d_pos, d_scale, d_rz, d_rx, d_ry] = decompose_transform(m, anchor);
    // The exact angle decomposition may differ but the matrix
    // must be equivalent.
    const m2 = build_local_matrix(d_pos, anchor, d_scale, d_rz, { rotate_x: d_rx, rotate_y: d_ry });
    _mat_approx(m, m2, 1e-4);
  });
});

/**
 * Exactly Y = +/-90, where X and Z turn about the same line.
 *
 * Only the combination of X and Z is recoverable there, so the split
 * is a convention. AE's convention was measured on AE 2026 by
 * reparenting a 3D child at orientation `[0, 0, g]` under a parent
 * rotated Y = +/-90 (which drives the composed orientation onto the
 * pole) and reading back what AE wrote: `[0, 270, g]` and `[0, 90, g]`
 * respectively, for `g` across a full turn. All of it on Z, nothing
 * on X.
 */
describe("TestGimbalLock", () => {
  const gamma_rows: number[] = [30.0, 60.0, 90.0, 135.0, 210.0, 330.0];
  const parent_composed_rows: [number, number][] = [
    [90.0, 270.0],
    [-90.0, 90.0],
  ];
  // pytest stacks parametrize decorators with the top one (gamma) varying fastest.
  const match_rows: [number, number, number][] = parent_composed_rows.flatMap(
    ([parent_y, composed_y]) =>
      gamma_rows.map((gamma): [number, number, number] => [gamma, parent_y, composed_y]),
  );

  test.each(match_rows)("test_matches_after_effects[%#]", (gamma, parent_y, composed_y) => {
    const delta = _rotate_y(parent_y).inverse();
    expect(
      approx(compose_orientation([0.0, 0.0, gamma], delta), [0.0, composed_y, gamma], {
        abs: 1e-9,
      }),
    ).toBe(true);
  });

  const reconstruct_rows: [number, number][] = [90.0, -90.0].flatMap(
    (parent_y): [number, number][] =>
      [0.0, 45.0, 137.0, 300.0].map((gamma): [number, number] => [gamma, parent_y]),
  );

  test.each(reconstruct_rows)("test_reconstructs_the_rotation[%#]", (gamma, parent_y) => {
    // The split is a convention, but it must still describe the SAME
    // rotation - solving the pole relation for X instead did not, at
    // Y = -90.
    const delta = _rotate_y(parent_y).inverse();
    const original = _rotate_x(0.0).__matmul__(_rotate_y(0.0)).__matmul__(_rotate_z(gamma));
    const composed = delta.__matmul__(original);
    const angles = compose_orientation([0.0, 0.0, gamma], delta);
    const rebuilt = _rotate_x(angles[0])
      .__matmul__(_rotate_y(angles[1]))
      .__matmul__(_rotate_z(angles[2]));
    _mat_approx(composed, rebuilt, 1e-9);
  });
});
