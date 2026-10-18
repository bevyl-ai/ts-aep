/**
 * Unit tests for the transform matrix module.
 *
 * Tests matrix composition, decomposition, and round-trip accuracy for
 * a variety of 2D and 3D transform configurations.
 */

import { describe, expect, test } from "bun:test";

import { ValueError, floatRepr, assert, zip } from "../../src/pyrt/index.ts";

import { Mat4, _rotateX, _rotateY, _rotateZ, _translation, buildLocalMatrix, composeOrientation, decomposeTransform } from "../../src/py_aep/resolvers/transform.ts";
import { approx, raises } from "../support/pytest.ts";
import { enumerate } from "../support/python.ts";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Assert two values (scalar or nested list) are approximately equal. */
function _approx(a: number | number[], b: number | number[], tol = 1e-6): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    assert(a.length === b.length, `length mismatch: ${a.length} vs ${b.length}`);
    for (const [i, [ai, bi]] of enumerate(zip(a, b))) {
      assert(approx(ai, bi, { abs: tol }), `index ${i}: ${floatRepr(ai)} != ${floatRepr(bi)}`);
    }
  } else {
    assert(approx(a, b, { abs: tol }));
  }
}

/** Assert two 4x4 matrices are approximately equal. */
function _matApprox(a: Mat4, b: Mat4, tol = 1e-6): void {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      assert(
        approx(a.row(r)[c], b.row(r)[c], { abs: tol }),
        `M[${r}][${c}]: ${floatRepr(a.row(r)[c])} != ${floatRepr(b.row(r)[c])}`,
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
    const a = buildLocalMatrix([10, 20, 0], [0, 0, 0], [100, 100, 100], 45);
    const result = Mat4.identity().multiply(a);
    _matApprox(result, a);
    const result2 = a.multiply(Mat4.identity());
    _matApprox(result2, a);
  });

  test("test_translation_roundtrip", () => {
    const t = _translation(5, 10, 15);
    const tInv = t.inverse();
    const result = t.multiply(tInv);
    _matApprox(result, Mat4.identity());
  });

  test("test_inverse_of_identity", () => {
    const m = Mat4.identity();
    const inv = m.inverse();
    _matApprox(inv, Mat4.identity());
  });

  test("test_inverse_roundtrip", () => {
    const m = buildLocalMatrix([30, 20, 10], [5, 5, 0], [150, 80, 100], 37, {
      rotateX: 15,
      rotateY: 25,
    });
    const inv = m.inverse();
    const result = m.multiply(inv);
    _matApprox(result, Mat4.identity(), 1e-5);
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
    const m = buildLocalMatrix(pos, anchor, scale, rz);
    const [dPos, dScale, dRz, dRx, dRy] = decomposeTransform(m, anchor);
    _approx(dPos, pos);
    _approx(dScale, scale);
    _approx(dRz, rz);
    _approx(dRx, 0.0);
    _approx(dRy, 0.0);
  });

  test("test_position_only", () => {
    const pos = [73.0, 41.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = 0.0;
    const m = buildLocalMatrix(pos, anchor, scale, rz);
    const [dPos, dScale, dRz, dRx, dRy] = decomposeTransform(m, anchor);
    _approx(dPos, pos);
    _approx(dScale, scale);
    _approx(dRz, rz);
  });

  test("test_position_with_anchor", () => {
    const pos = [50.0, 50.0, 0.0];
    const anchor = [25.0, 25.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = 0.0;
    const m = buildLocalMatrix(pos, anchor, scale, rz);
    const [dPos, dScale, dRz] = decomposeTransform(m, anchor);
    _approx(dPos, pos);
    _approx(dScale, scale);
    _approx(dRz, rz);
  });

  test("test_rotation_only", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = 45.0;
    const m = buildLocalMatrix(pos, anchor, scale, rz);
    const [dPos, dScale, dRz] = decomposeTransform(m, anchor);
    _approx(dPos, pos);
    _approx(dScale, scale);
    _approx(dRz, rz);
  });

  test("test_scale_only", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [200.0, 50.0, 100.0];
    const rz = 0.0;
    const m = buildLocalMatrix(pos, anchor, scale, rz);
    const [dPos, dScale, dRz] = decomposeTransform(m, anchor);
    _approx(dPos, pos);
    _approx(dScale, scale);
    _approx(dRz, rz);
  });

  test("test_combined_2d", () => {
    const pos = [30.0, 20.0, 0.0];
    const anchor = [10.0, 10.0, 0.0];
    const scale = [150.0, 80.0, 100.0];
    const rz = 30.0;
    const m = buildLocalMatrix(pos, anchor, scale, rz);
    const [dPos, dScale, dRz] = decomposeTransform(m, anchor);
    _approx(dPos, pos);
    _approx(dScale, scale);
    _approx(dRz, rz);
  });

  test("test_negative_rotation", () => {
    const pos = [100.0, 100.0, 0.0];
    const anchor = [50.0, 50.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = -45.0;
    const m = buildLocalMatrix(pos, anchor, scale, rz);
    const [dPos, dScale, dRz] = decomposeTransform(m, anchor);
    _approx(dPos, pos);
    _approx(dScale, scale);
    _approx(dRz, rz);
  });

  /** Rotations > 180 degrees decompose into [-180, 180] range. */
  test("test_large_rotation", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const rz = 270.0;
    const m = buildLocalMatrix(pos, anchor, scale, rz);
    const [dPos, dScale, dRz] = decomposeTransform(m, anchor);
    // 270 degrees decomposes to -90 (same visual rotation)
    _approx(dRz, -90.0);
  });
});

/** 3D layers: full rotation set. */
describe("TestRoundTrip3D", () => {
  test("test_rotate_x_only", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const m = buildLocalMatrix(pos, anchor, scale, 0.0, { rotateX: 45.0 });
    const [dPos, dScale, dRz, dRx, dRy] = decomposeTransform(m, anchor);
    _approx(dPos, pos);
    _approx(dScale, scale);
    _approx(dRx, 45.0);
    _approx(dRy, 0.0);
    _approx(dRz, 0.0);
  });

  test("test_rotate_y_only", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const m = buildLocalMatrix(pos, anchor, scale, 0.0, { rotateY: 30.0 });
    const [dPos, dScale, dRz, dRx, dRy] = decomposeTransform(m, anchor);
    _approx(dRy, 30.0);
    _approx(dRx, 0.0);
  });

  test("test_combined_3d_rotations", () => {
    const pos = [10.0, 20.0, 30.0];
    const anchor = [5.0, 5.0, 5.0];
    const scale = [120.0, 80.0, 100.0];
    const rz = 15.0;
    const rx = 25.0;
    const ry = 35.0;
    const m = buildLocalMatrix(pos, anchor, scale, rz, { rotateX: rx, rotateY: ry });
    const [dPos, dScale, dRz, dRx, dRy] = decomposeTransform(m, anchor);
    _approx(dPos, pos);
    _approx(dScale, scale);
    _approx(dRz, rz);
    _approx(dRx, rx);
    _approx(dRy, ry);
  });

  /** Orientation angles compose into the matrix correctly. */
  test("test_orientation_3d", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const orient = [10.0, 20.0, 30.0];
    const m = buildLocalMatrix(pos, anchor, scale, 0.0, { orientation: orient });
    // The decomposition extracts the combined rotation into
    // per-axis angles (since orientation is assumed zero for
    // decomposition). The key check is round-trip through
    // build -> decompose -> build produces the same matrix.
    const [dPos, dScale, dRz, dRx, dRy] = decomposeTransform(m, anchor);
    const m2 = buildLocalMatrix(dPos, anchor, dScale, dRz, { rotateX: dRx, rotateY: dRy });
    _matApprox(m, m2, 1e-5);
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
    const m = buildLocalMatrix(pos, anchor, scale, rz, {
      orientation: orient,
      rotateX: rx,
      rotateY: ry,
    });
    const [dPos, dScale, dRz, dRx, dRy] = decomposeTransform(m, anchor);
    const m2 = buildLocalMatrix(dPos, anchor, dScale, dRz, { rotateX: dRx, rotateY: dRy });
    _matApprox(m, m2, 1e-5);
  });
});

// ------------------------------------------------------------------
// Parent-child composition tests
// ------------------------------------------------------------------

/** Simulate unparenting: compose parent+child, decompose child. */
describe("TestParentChild", () => {
  /** Child at [0,0,0] with parent at [73,41,0] -> child becomes [73,41,0]. */
  test("test_position_only_parent", () => {
    const parentPos = [73.0, 41.0, 0.0];
    const childPos = [0.0, 0.0, 0.0];
    const childAnchor = [50.0, 50.0, 0.0];
    const scale = [100.0, 100.0, 100.0];

    const parentM = buildLocalMatrix(parentPos, [0.0, 0.0, 0.0], scale, 0.0);
    const childM = buildLocalMatrix(childPos, childAnchor, scale, 0.0);

    const world = parentM.multiply(childM);
    const [dPos, dScale, dRz] = decomposeTransform(world, childAnchor);
    _approx(dPos, [73.0, 41.0, 0.0]);
    _approx(dScale, scale);
    _approx(dRz, 0.0);
  });

  /** Child at [100,0,0] with parent rotated 90deg -> child at [0,100,0]. */
  test("test_rotated_parent", () => {
    const parentM = buildLocalMatrix(
      [0.0, 0.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      90.0,
    );
    const childM = buildLocalMatrix(
      [100.0, 0.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      0.0,
    );
    const world = parentM.multiply(childM);
    const [dPos, dScale, dRz] = decomposeTransform(world, [0.0, 0.0, 0.0]);
    _approx(dPos, [0.0, 100.0, 0.0]);
    _approx(dRz, 90.0);
  });

  /** Child at [50,50,0] with parent at 200% -> child at [100,100,0] with 200% scale. */
  test("test_scaled_parent", () => {
    const parentM = buildLocalMatrix(
      [0.0, 0.0, 0.0],
      [0.0, 0.0, 0.0],
      [200.0, 200.0, 100.0],
      0.0,
    );
    const childM = buildLocalMatrix(
      [50.0, 50.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      0.0,
    );
    const world = parentM.multiply(childM);
    const [dPos, dScale] = decomposeTransform(world, [0.0, 0.0, 0.0]);
    _approx(dPos, [100.0, 100.0, 0.0]);
    _approx(dScale, [200.0, 200.0, 100.0]);
  });

  /** Combined parent transform: pos + rotation + scale. */
  test("test_complex_parent", () => {
    const parentM = buildLocalMatrix(
      [30.0, 20.0, 0.0],
      [0.0, 0.0, 0.0],
      [150.0, 150.0, 100.0],
      30.0,
    );
    const childM = buildLocalMatrix(
      [10.0, 5.0, 0.0],
      [0.0, 0.0, 0.0],
      [80.0, 80.0, 100.0],
      15.0,
    );
    const world = parentM.multiply(childM);
    const [dPos, dScale, dRz] = decomposeTransform(world, [0.0, 0.0, 0.0]);
    // Verify round-trip: rebuild from decomposed values matches world
    const m2 = buildLocalMatrix(dPos, [0.0, 0.0, 0.0], dScale, dRz);
    _matApprox(world, m2, 1e-5);
  });

  /** Parent with non-zero anchor: rotates around its anchor point. */
  test("test_parent_with_anchor_offset", () => {
    const parentAnchor = [25.0, 25.0, 0.0];
    const parentM = buildLocalMatrix(
      [50.0, 50.0, 0.0],
      parentAnchor,
      [100.0, 100.0, 100.0],
      90.0,
    );
    const childM = buildLocalMatrix(
      [20.0, 0.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      0.0,
    );
    const world = parentM.multiply(childM);
    const [dPos, dScale, dRz] = decomposeTransform(world, [0.0, 0.0, 0.0]);
    // Rebuild from decomposed values
    const m2 = buildLocalMatrix(dPos, [0.0, 0.0, 0.0], dScale, dRz);
    _matApprox(world, m2, 1e-5);
  });

  /** Assigning a new parent: child_new_local = inv(parent) @ child_world. */
  test("test_inverse_parent_gives_identity_child", () => {
    const parentM = buildLocalMatrix(
      [50.0, 30.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      0.0,
    );
    const childWorld = buildLocalMatrix(
      [50.0, 30.0, 0.0],
      [0.0, 0.0, 0.0],
      [100.0, 100.0, 100.0],
      0.0,
    );
    const childLocal = parentM.inverse().multiply(childWorld);
    const [dPos, dScale, dRz] = decomposeTransform(childLocal, [0.0, 0.0, 0.0]);
    _approx(dPos, [0.0, 0.0, 0.0]);
    _approx(dScale, [100.0, 100.0, 100.0]);
    _approx(dRz, 0.0);
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
    const m = buildLocalMatrix(pos, anchor, scale, 0.0);
    const [dPos, dScale, dRz] = decomposeTransform(m, anchor);
    // Scale should come back negative on x
    expect(dScale[0] < 0).toBe(true);
    // Rebuild should match
    const m2 = buildLocalMatrix(dPos, anchor, dScale, dRz);
    _matApprox(m, m2, 1e-5);
  });

  /** Zero scale doesn't crash - clamped to epsilon. */
  test("test_zero_scale_clamped", () => {
    const pos = [10.0, 20.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [0.0, 100.0, 100.0];
    const m = buildLocalMatrix(pos, anchor, scale, 0.0);
    // Should not raise
    const [dPos, dScale, dRz] = decomposeTransform(m, anchor);
    _approx(dPos, pos);
  });

  test("test_180_rotation", () => {
    const pos = [0.0, 0.0, 0.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const m = buildLocalMatrix(pos, anchor, scale, 180.0);
    const [dPos, dScale, dRz] = decomposeTransform(m, anchor);
    _approx(Math.abs(dRz), 180.0, 0.01);
  });

  /** Near gimbal lock (ry=90) still decomposes to same matrix. */
  test("test_gimbal_lock_3d", () => {
    const pos = [10.0, 20.0, 30.0];
    const anchor = [0.0, 0.0, 0.0];
    const scale = [100.0, 100.0, 100.0];
    const m = buildLocalMatrix(pos, anchor, scale, 0.0, { rotateX: 45.0, rotateY: 89.99 });
    const [dPos, dScale, dRz, dRx, dRy] = decomposeTransform(m, anchor);
    // The exact angle decomposition may differ but the matrix
    // must be equivalent.
    const m2 = buildLocalMatrix(dPos, anchor, dScale, dRz, { rotateX: dRx, rotateY: dRy });
    _matApprox(m, m2, 1e-4);
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
  const gammaRows: number[] = [30.0, 60.0, 90.0, 135.0, 210.0, 330.0];
  const parentComposedRows: [number, number][] = [
    [90.0, 270.0],
    [-90.0, 90.0],
  ];
  // pytest stacks parametrize decorators with the top one (gamma) varying fastest.
  const matchRows: [number, number, number][] = parentComposedRows.flatMap(
    ([parentY, composedY]) =>
      gammaRows.map((gamma): [number, number, number] => [gamma, parentY, composedY]),
  );

  test.each(matchRows)("test_matches_after_effects[%#]", (gamma, parentY, composedY) => {
    const delta = _rotateY(parentY).inverse();
    expect(
      approx(composeOrientation([0.0, 0.0, gamma], delta), [0.0, composedY, gamma], {
        abs: 1e-9,
      }),
    ).toBe(true);
  });

  const reconstructRows: [number, number][] = [90.0, -90.0].flatMap(
    (parentY): [number, number][] =>
      [0.0, 45.0, 137.0, 300.0].map((gamma): [number, number] => [gamma, parentY]),
  );

  test.each(reconstructRows)("test_reconstructs_the_rotation[%#]", (gamma, parentY) => {
    // The split is a convention, but it must still describe the SAME
    // rotation - solving the pole relation for X instead did not, at
    // Y = -90.
    const delta = _rotateY(parentY).inverse();
    const original = _rotateX(0.0).multiply(_rotateY(0.0)).multiply(_rotateZ(gamma));
    const composed = delta.multiply(original);
    const angles = composeOrientation([0.0, 0.0, gamma], delta);
    const rebuilt = _rotateX(angles[0])
      .multiply(_rotateY(angles[1]))
      .multiply(_rotateZ(angles[2]));
    _matApprox(composed, rebuilt, 1e-9);
  });
});
