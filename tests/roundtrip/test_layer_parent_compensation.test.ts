/**
 * `Layer.parent` must compensate the transform so nothing visibly moves.
 *
 * That is the setter's whole contract - `set_parent_with_jump` exists for the
 * other case - and it had three holes: an oriented child, a child whose Position
 * is dimension-separated, and cameras / lights. Expectations below are AE 2026
 * measurements except where noted.
 */

import { describe, expect, test } from "bun:test";
import { at, float, getOrThrow, Path, valueEquals, StopIteration, zip, AssertionError } from "../../src/pyrt/index.ts";

import { parse as parseAep, type Project } from "../../src/py_aep/index.ts";
import { buildWorldMatrix, type Mat4 } from "../../src/py_aep/resolvers/transform.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { asInstance, getComp, parseProjectFresh } from "../helpers.ts";
import { AVLayer } from "../../src/py_aep/models/layers/index.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { approx, makeTmpPath } from "../support/pytest.ts";
import { max, range, round } from "../support/python.ts";

const LAYER_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const PROPERTY_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");

function _worldDelta(before: Mat4, after: Mat4): number {
  const deltas: number[] = [];
  for (const row of range(4)) {
    for (const col of range(4)) {
      deltas.push(Math.abs(before.row(row)[col] - after.row(row)[col]));
    }
  }
  return max(deltas);
}

describe("TestParentOrientation", () => {
  /**
   * A 3D layer is compensated through Orientation, a 2D one through
   * Rotate Z.
   *
   * AE's rule for a 3D layer is `O_new = parent_rotation^-1 . O_old`, with
   * Rotate X/Y/Z untouched - measured over ten AE 2026 cases. Under a
   * pure-translation parent that delta is the identity, so Orientation comes
   * out unchanged and only Position moves.
   */

  test("test_oriented_child_does_not_move", () => {
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = comp.layers[0];
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Anchor Point").value = [0.0, 0.0, 0.0];
    const parent = comp.addNull();
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    const before = buildWorldMatrix(child);

    child.parent = parent;

    expect(_worldDelta(before, buildWorldMatrix(child))).toBeLessThan(1e-9);
  });

  test("test_orientation_and_rotations_are_untouched", () => {
    /** AE rewrote only Position for this case: `[-150, 120, 0]`. */
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = comp.layers[0];
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Anchor Point").value = [0.0, 0.0, 0.0];
    const parent = comp.addNull();
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];

    child.parent = parent;

    expect(approx(child.transform.property("ADBE Position").value, [-150.0, 120.0, 0.0])).toBe(true);
    expect(approx(child.transform.property("ADBE Orientation").value, [0.0, 279.0, 0.0])).toBe(true);
    expect(approx(child.transform.property("ADBE Rotate Y").value, 0.0)).toBe(true);
    expect(approx(child.transform.property("ADBE Rotate Z").value, 0.0)).toBe(true);
  });

  test("test_zero_orientation_child_still_compensates", () => {
    /** The regression that the orientation fix must not break. */
    const project = parseProjectFresh(PROPERTY_DIR.div("property_2D_position.aep"));
    const comp = project.compositions[0];
    const child = comp.layers[0];
    expect(approx(child.transform.property("ADBE Orientation").value, [0.0, 0.0, 0.0])).toBe(true);
    const parent = comp.addNull();
    parent.transform.property("ADBE Rotate Z").value = 30.0;
    parent.transform.property("ADBE Position").value = [500.0, 400.0, 0.0];
    const before = buildWorldMatrix(child);

    child.parent = parent;

    expect(_worldDelta(before, buildWorldMatrix(child))).toBeLessThan(1e-9);
  });
});

describe("TestParentSeparatedPosition", () => {
  /**
   * A separated Position is driven by its followers, so that is where the
   * compensation has to land - the leader's own value is dead.
   */

  test("test_followers_receive_the_compensation", () => {
    /**
     * AE: a separated child at (150, 160) under a parent at (300, 40)
     * becomes X = -150, Y = 120.
     */
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(PROPERTY_DIR.div("transform_separated.aep"));
    const comp = project.compositions[0];
    const child = comp.layers[0];
    child.transform.property("ADBE Anchor Point").value = [0.0, 0.0, 0.0];
    child.transform.property("ADBE Position_0").value = 150.0;
    child.transform.property("ADBE Position_1").value = 160.0;
    const parent = comp.addNull();
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];

    child.parent = parent;

    expect(approx(child.transform.property("ADBE Position_0").value, -150.0)).toBe(true);
    expect(approx(child.transform.property("ADBE Position_1").value, 120.0)).toBe(true);
    expect(child.transform.property("ADBE Position").dimensionsSeparated).toBe(true);

    const out = tmpPath.div("modified.aep");
    project.save(out);
    // add_null() inserts at index 0, so select the child by name.
    const reloaded = parseAep(out).project.compositions[0].layers.find((layer) => layer.name === child.name);
    if (reloaded == null) throw new StopIteration();
    expect(approx(reloaded.transform.property("ADBE Position_0").value, -150.0)).toBe(true);
    expect(approx(reloaded.transform.property("ADBE Position_1").value, 120.0)).toBe(true);
  });
});

describe("TestParentCameraIsAlwaysThreeD", () => {
  /**
   * Cameras and lights have no `three_d_layer` attribute because they are
   * always 3D; reading it with a False default skipped their X / Y rotation
   * compensation entirely.
   *
   * No AE ground truth here - `layers.addCamera` fails in a headless session -
   * so this asserts world-matrix invariance rather than AE's exact tuple.
   */

  test("test_camera_compensates_under_a_rotated_parent", () => {
    const project = parseProjectFresh(LAYER_DIR.div("camera_rigs.aep"));
    const comp = getComp(project, "CAM_ONE");
    const camera = comp.layers[0];
    const target = comp.layers[1];
    expect("threeDLayer" in camera).toBe(false);
    target.transform.property("ADBE Rotate X").value = 20.0;
    target.transform.property("ADBE Rotate Z").value = 30.0;
    // A camera's world is its rig (position + rotations): its point of
    // interest sits in the Anchor Point slot and AE 2026 remaps it into
    // the new parent's space too, so it is no anchor to subtract.
    const before = buildWorldMatrix(camera, null, false, { asParent: true });

    camera.parent = target;

    expect(_worldDelta(before, buildWorldMatrix(camera, null, false, { asParent: true }))).toBeLessThan(1e-9);
  });

  test("test_camera_compensates_through_orientation", () => {
    /**
     * A camera is 3D, so it takes the 3D path: the compensation lands in
     * Orientation and Rotate X/Y/Z are left exactly as they were.
     */
    const project = parseProjectFresh(LAYER_DIR.div("camera_rigs.aep"));
    const comp = getComp(project, "CAM_ONE");
    const camera = comp.layers[0];
    const target = comp.layers[1];
    const rotationsBefore = ["ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z"].map(
      (name) => asInstance(camera.transform.property(name), Property).value,
    );
    const orientationBefore = [...camera.transform.property("ADBE Orientation").value];
    target.transform.property("ADBE Rotate X").value = 20.0;

    camera.parent = target;

    expect(
      valueEquals(
        ["ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z"].map((name) => asInstance(camera.transform.property(name), Property).value),
        rotationsBefore,
      ),
    ).toBe(true);
    expect(valueEquals(camera.transform.property("ADBE Orientation").value, orientationBefore)).toBe(false);
  });
});

describe("TestParentCompensationConvention", () => {
  /**
   * AE folds a 3D reparent into Orientation, a 2D one into Rotate Z.
   *
   * Every tuple below is what AE 2026 stored for the same setup: child at
   * (150, 160, 0) on a 100x100 solid, parent null at (300, 40, 0).
   */

  function _setup(orientation: number[], rotations: number[]): [AVLayer, AVLayer] {
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = true;
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Orientation").value = [...orientation];
    for (const [name, value] of zip(["ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z"], rotations)) {
      asInstance(child.transform.property(name), Property).value = float(value);
    }
    const parent = comp.addNull();
    parent.threeDLayer = true;
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    parent.transform.property("ADBE Rotate X").value = 20.0;
    parent.transform.property("ADBE Rotate Y").value = -35.0;
    parent.transform.property("ADBE Rotate Z").value = 30.0;
    return [child, parent];
  }

  test("test_three_d_child_matches_the_ae_tuple", () => {
    const [child, parent] = _setup([0.0, 279.0, 0.0], [0.0, 0.0, 0.0]);

    child.parent = parent;

    expect(approx(child.transform.property("ADBE Position").value, [-70.416, 170.863, 52.416], { abs: 0.001 })).toBe(true);
    expect(approx(child.transform.property("ADBE Orientation").value, [329.248, 323.066, 337.96], { abs: 0.001 })).toBe(true);
    for (const name of ["ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z"] as const) {
      expect(approx(child.transform.property(name).value, 0.0)).toBe(true);
    }
  });

  test("test_the_childs_own_rotations_are_preserved", () => {
    /**
     * They cancel out of `O_new = parent^-1 . O_old`, so AE gets the
     * same orientation whether or not the child carries rotations.
     */
    const [child, parent] = _setup([17.0, 279.0, 43.0], [11.0, -23.0, 47.0]);

    child.parent = parent;

    expect(approx(child.transform.property("ADBE Orientation").value, [332.157, 321.758, 5.941], { abs: 0.001 })).toBe(true);
    expect(approx(child.transform.property("ADBE Rotate X").value, 11.0)).toBe(true);
    expect(approx(child.transform.property("ADBE Rotate Y").value, -23.0)).toBe(true);
    expect(approx(child.transform.property("ADBE Rotate Z").value, 47.0)).toBe(true);
  });

  test("test_a_keyframed_rotation_no_longer_jumps", () => {
    /**
     * Compensating through the rotations collided with the rule that
     * keyframed properties are left alone: the layer kept its animated
     * Rotate Z but lost the compensation, and jumped 362 px. AE never
     * touches the rotations, so the animation and the compensation coexist.
     */
    const [child, parent] = _setup([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]);
    const rotation = child.transform.property("ADBE Rotate Z");
    rotation.addKey(0.0);
    at(rotation.keyframes, -1).value = 15.0;
    rotation.addKey(2.0);
    at(rotation.keyframes, -1).value = 75.0;
    const before = buildWorldMatrix(child);

    child.parent = parent;

    expect(_worldDelta(before, buildWorldMatrix(child))).toBeLessThan(1e-9);
    expect(valueEquals([...rotation.keyframes].map((k) => [k.time, k.value]), [[0.0, 15.0], [2.0, 75.0]])).toBe(true);
    expect(approx(child.transform.property("ADBE Orientation").value, [358.013, 39.627, 337.08], { abs: 0.001 })).toBe(true);
  });

  test("test_keyframed_orientation_is_remapped_per_key", () => {
    /** AE rewrites every orientation keyframe, as it does for position. */
    const [child, parent] = _setup([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]);
    const orientation = child.transform.property("ADBE Orientation");
    orientation.addKey(0.0);
    at(orientation.keyframes, -1).value = [0.0, 30.0, 0.0];
    orientation.addKey(2.0);
    at(orientation.keyframes, -1).value = [0.0, 120.0, 0.0];

    child.parent = parent;

    expect(approx(orientation.keyframes[0].value, [25.56, 65.1, 314.569], { abs: 0.001 })).toBe(true);
    expect(approx(orientation.keyframes[1].value, [157.34, 17.186, 198.299], { abs: 0.001 })).toBe(true);
  });

  test("test_two_d_child_uses_rotate_z", () => {
    /** A 2D layer has no Orientation to use, so AE puts it in Rotate Z. */
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = false;
    child.transform.property("ADBE Orientation").value = [0.0, 0.0, 0.0];
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    const parent = comp.addNull();
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    parent.transform.property("ADBE Rotate Z").value = 30.0;

    child.parent = parent;

    expect(approx(child.transform.property("ADBE Rotate Z").value, -30.0)).toBe(true);
    expect(approx(child.transform.property("ADBE Orientation").value, [0.0, 0.0, 0.0])).toBe(true);
  });
});

describe("TestParentNonUniformParentScaleJumps", () => {
  /**
   * A non-uniformly scaled parent shears the child's required local
   * matrix, and `T . O . R . S . T(-anchor)` cannot represent shear.
   *
   * AE jumps here too - 68 to 95 px on the same setups - so mirroring the
   * jump is the correct behaviour, not a defect. This test pins that down so
   * nobody "fixes" it into a divergence from AE.
   */

  test("test_jump_is_expected_and_matches_ae_in_kind", () => {
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = true;
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Orientation").value = [0.0, 0.0, 0.0];
    const parent = comp.addNull();
    parent.threeDLayer = true;
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    parent.transform.property("ADBE Rotate Z").value = 30.0;
    parent.transform.property("ADBE Scale").value = [200.0, 50.0, 100.0];
    const before = buildWorldMatrix(child);

    child.parent = parent;

    // AE's own result for this setup is off by 68 px; ours is the same
    // order of magnitude. Asserting only that it does not silently claim
    // to be exact.
    expect(_worldDelta(before, buildWorldMatrix(child))).toBeGreaterThan(1.0);
  });
});

describe("TestParentScaledParentEdgeCases", () => {
  /**
   * A non-uniformly scaled parent does not automatically mean a jump.
   *
   * The child's required local 3x3 is `S_parent^-1 . Q . D`, which only
   * shears when `Q` - the combined rotation - is not axis-aligned. AE
   * compensates the representable cases exactly, and so must we. All values
   * are AE 2026 measurements.
   */

  function _pair(childRotation = 0.0): [AVLayer, AVLayer] {
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = true;
    child.transform.property("ADBE Orientation").value = [0.0, 0.0, 0.0];
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Anchor Point").value = [50.0, 50.0, 0.0];
    child.transform.property("ADBE Scale").value = [100.0, 100.0, 100.0];
    child.transform.property("ADBE Rotate Z").value = childRotation;
    const parent = comp.addNull();
    parent.threeDLayer = true;
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    return [child, parent];
  }

  test("test_non_uniform_scale_without_rotation_is_exact", () => {
    /** No rotation means no shear: AE inverts the scale per axis. */
    const [child, parent] = _pair();
    parent.transform.property("ADBE Scale").value = [200.0, 50.0, 100.0];
    const before = buildWorldMatrix(child);

    child.parent = parent;

    expect(_worldDelta(before, buildWorldMatrix(child))).toBeLessThan(1e-9);
    expect(approx(child.transform.property("ADBE Scale").value, [50.0, 200.0, 100.0])).toBe(true);
  });

  test("test_non_uniform_scale_with_axis_aligned_rotation_is_exact", () => {
    /** A 90-degree parent only permutes the axes, so it stays exact. */
    const [child, parent] = _pair();
    parent.transform.property("ADBE Scale").value = [200.0, 50.0, 100.0];
    parent.transform.property("ADBE Rotate Z").value = 90.0;
    const before = buildWorldMatrix(child);

    child.parent = parent;

    expect(_worldDelta(before, buildWorldMatrix(child))).toBeLessThan(1e-9);
    expect(approx(child.transform.property("ADBE Scale").value, [200.0, 50.0, 100.0])).toBe(true);
    expect(approx(child.transform.property("ADBE Orientation").value, [0.0, 0.0, 270.0])).toBe(true);
  });

  test("test_negative_uniform_scale_is_exact", () => {
    const [child, parent] = _pair();
    parent.transform.property("ADBE Scale").value = [-100.0, -100.0, -100.0];
    parent.transform.property("ADBE Rotate Z").value = 30.0;
    const before = buildWorldMatrix(child);

    child.parent = parent;

    expect(_worldDelta(before, buildWorldMatrix(child))).toBeLessThan(1e-9);
    expect(approx(child.transform.property("ADBE Scale").value, [-100.0, -100.0, -100.0])).toBe(true);
    expect(approx(child.transform.property("ADBE Orientation").value, [0.0, 0.0, 330.0])).toBe(true);
  });

  test("test_mirrored_parent_flips_all_three_scales", () => {
    /**
     * AE keeps the rotation proper and spreads a mirror across all three
     * scale axes: a parent at [-100, 100, 100] leaves the child at
     * [-100, -100, -100] with Orientation [180, 0, 0], not at a mirrored
     * rotation.
     */
    const [child, parent] = _pair();
    parent.transform.property("ADBE Scale").value = [-100.0, 100.0, 100.0];
    const before = buildWorldMatrix(child);

    child.parent = parent;

    expect(_worldDelta(before, buildWorldMatrix(child))).toBeLessThan(1e-9);
    expect(approx(child.transform.property("ADBE Scale").value, [-100.0, -100.0, -100.0])).toBe(true);
    expect(approx(child.transform.property("ADBE Orientation").value, [180.0, 0.0, 0.0])).toBe(true);
  });

  test("test_genuine_shear_still_jumps", () => {
    /**
     * A rotated child under a non-uniformly scaled parent needs a
     * sheared local matrix, which `T . O . R . S . T(-anchor)` cannot hold.
     * AE is off by 34.8 px here and we are off by 16.8 - neither is exact,
     * so this pins the jump rather than pretending it can be removed.
     */
    const [child, parent] = _pair(30.0);
    parent.transform.property("ADBE Scale").value = [200.0, 50.0, 100.0];
    const before = buildWorldMatrix(child);

    child.parent = parent;

    expect(_worldDelta(before, buildWorldMatrix(child))).toBeGreaterThan(1.0);
  });
});

describe("TestParentKeyframedChild", () => {
  /**
   * AE compensates once, using the parent at the current time, and rewrites
   * the child's animated properties rather than skipping them.
   */

  test("test_two_d_keyframed_rotation_is_offset_per_key", () => {
    /**
     * Keys of 15 and 75 under a 30-degree parent became -15 and 45.
     * Skipping them - which is what `write_compensation` does for a
     * keyframed property - left the layer 35 px out of place.
     */
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = false;
    child.transform.property("ADBE Orientation").value = [0.0, 0.0, 0.0];
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Anchor Point").value = [50.0, 50.0, 0.0];
    const rotation = child.transform.property("ADBE Rotate Z");
    rotation.addKey(0.0);
    at(rotation.keyframes, -1).value = 15.0;
    rotation.addKey(2.0);
    at(rotation.keyframes, -1).value = 75.0;
    const parent = comp.addNull();
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    parent.transform.property("ADBE Rotate Z").value = 30.0;
    const before = buildWorldMatrix(child);

    child.parent = parent;

    expect(_worldDelta(before, buildWorldMatrix(child))).toBeLessThan(1e-9);
    expect(valueEquals([...rotation.keyframes].map((k) => [k.time, k.value]), [[0.0, -15.0], [2.0, 45.0]])).toBe(true);
  });

  test("test_keyframed_scale_is_left_alone", () => {
    /**
     * The parent carries no scale, so the child's animated Scale needs
     * no compensation and AE leaves both keys untouched.
     */
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = true;
    child.transform.property("ADBE Orientation").value = [0.0, 0.0, 0.0];
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Anchor Point").value = [50.0, 50.0, 0.0];
    const scale = child.transform.property("ADBE Scale");
    scale.addKey(0.0);
    at(scale.keyframes, -1).value = [100.0, 100.0, 100.0];
    scale.addKey(2.0);
    at(scale.keyframes, -1).value = [250.0, 60.0, 100.0];
    const parent = comp.addNull();
    parent.threeDLayer = true;
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    parent.transform.property("ADBE Rotate Z").value = 30.0;
    const before = new Map<number, Mat4>();
    for (const t of [0.0, 2.0]) before.set(t, buildWorldMatrix(child, t));

    child.parent = parent;

    for (const time of [0.0, 2.0]) {
      expect(_worldDelta(getOrThrow(before, time), buildWorldMatrix(child, time))).toBeLessThan(1e-9);
    }
    expect(valueEquals([...scale.keyframes].map((k) => k.value), [[100.0, 100.0, 100.0], [250.0, 60.0, 100.0]])).toBe(true);
  });

  test("test_animated_parent_is_compensated_at_time_zero_only", () => {
    /**
     * The layer holds still at the moment of parenting; afterwards it
     * follows the parent, which is the point of parenting rather than a
     * jump. AE behaves the same - it writes one static compensation and
     * adds no keyframes.
     */
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = true;
    child.transform.property("ADBE Orientation").value = [0.0, 0.0, 0.0];
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Anchor Point").value = [50.0, 50.0, 0.0];
    const parent = comp.addNull();
    parent.threeDLayer = true;
    const position = parent.transform.property("ADBE Position");
    position.addKey(0.0);
    at(position.keyframes, -1).value = [300.0, 40.0, 0.0];
    position.addKey(2.0);
    at(position.keyframes, -1).value = [700.0, 300.0, 0.0];
    const before = buildWorldMatrix(child, 0.0);

    child.parent = parent;

    expect(_worldDelta(before, buildWorldMatrix(child, 0.0))).toBeLessThan(1e-9);
    expect(approx(child.transform.property("ADBE Position").value, [-150.0, 120.0, 0.0])).toBe(true);
    expect(valueEquals(child.transform.property("ADBE Position").keyframes, [])).toBe(true);
  });
});

describe("TestParentScaledParentKeyframes", () => {
  /**
   * A scaled parent must move the child's animated Scale.
   *
   * The earlier test had an unscaled parent, so no scale compensation was
   * needed and "AE leaves the keys alone" proved nothing. With a scaled
   * parent AE divides every key per axis; skipping them left the layer 25 px
   * out at one time and 62 px at another.
   */

  function _setup(parentScale: number[]): [AVLayer, AVLayer, Property<number[]>] {
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = true;
    child.transform.property("ADBE Orientation").value = [0.0, 0.0, 0.0];
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Anchor Point").value = [50.0, 50.0, 0.0];
    const scale = child.transform.property("ADBE Scale");
    scale.addKey(0.0);
    at(scale.keyframes, -1).value = [100.0, 100.0, 100.0];
    scale.addKey(2.0);
    at(scale.keyframes, -1).value = [250.0, 60.0, 100.0];
    const parent = comp.addNull();
    parent.threeDLayer = true;
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    parent.transform.property("ADBE Scale").value = [...parentScale];
    return [child, parent, scale];
  }

  test("test_uniform_scale_doubles_every_key", () => {
    const [child, parent, scale] = _setup([50.0, 50.0, 50.0]);
    const before = new Map<number, Mat4>();
    for (const t of [0.0, 2.0]) before.set(t, buildWorldMatrix(child, t));

    child.parent = parent;

    expect(valueEquals([...scale.keyframes].map((k) => k.value), [[200.0, 200.0, 200.0], [500.0, 120.0, 200.0]])).toBe(true);
    for (const time of [0.0, 2.0]) {
      expect(_worldDelta(getOrThrow(before, time), buildWorldMatrix(child, time))).toBeLessThan(1e-9);
    }
  });

  test("test_non_uniform_scale_divides_per_axis", () => {
    const [, parent, scale] = _setup([200.0, 50.0, 100.0]);
    const child = scale._containingLayer;

    child.parent = parent;

    expect(valueEquals([...scale.keyframes].map((k) => k.value), [[50.0, 200.0, 100.0], [125.0, 120.0, 100.0]])).toBe(true);
  });

  test("test_keyframed_position_remap_includes_the_parent_scale", () => {
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = true;
    child.transform.property("ADBE Orientation").value = [0.0, 0.0, 0.0];
    child.transform.property("ADBE Anchor Point").value = [50.0, 50.0, 0.0];
    const position = child.transform.property("ADBE Position");
    position.addKey(0.0);
    at(position.keyframes, -1).value = [150.0, 160.0, 0.0];
    position.addKey(2.0);
    at(position.keyframes, -1).value = [400.0, 500.0, 0.0];
    const parent = comp.addNull();
    parent.threeDLayer = true;
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    parent.transform.property("ADBE Scale").value = [50.0, 50.0, 50.0];

    child.parent = parent;

    expect(valueEquals([...position.keyframes].map((k) => k.value), [[-300.0, 240.0, 0.0], [200.0, 920.0, 0.0]])).toBe(true);
  });
});

describe("TestParentAcrossTheTwoDThreeDBoundary", () => {
  /**
   * A 2D layer cannot store an out-of-plane rotation, and AE does not try:
   * it compensates as though every ancestor were 2D.
   */

  test("test_two_d_child_ignores_a_three_d_parents_xy_rotation", () => {
    /**
     * AE gives exactly the answer it would for a parent rotated 0/0/30,
     * discarding the 20 and -35. Using the full 3D matrix put the layer
     * 8 px out and wrote a Z position onto a 2D layer.
     */
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = false;
    child.transform.property("ADBE Orientation").value = [0.0, 0.0, 0.0];
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Anchor Point").value = [50.0, 50.0, 0.0];
    const parent = comp.addNull();
    parent.threeDLayer = true;
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    parent.transform.property("ADBE Rotate X").value = 20.0;
    parent.transform.property("ADBE Rotate Y").value = -35.0;
    parent.transform.property("ADBE Rotate Z").value = 30.0;

    child.parent = parent;

    expect(approx(child.transform.property("ADBE Position").value, [-69.9038, 178.923, 0.0], { abs: 0.001 })).toBe(true);
    expect(approx(child.transform.property("ADBE Rotate Z").value, -30.0)).toBe(true);
  });

  test("test_three_d_child_under_a_two_d_parent", () => {
    const project = parseProjectFresh(LAYER_DIR.div("orientation_0_279_0.aep"));
    const comp = project.compositions[0];
    const child = asInstance(comp.layers[0], AVLayer);
    child.threeDLayer = true;
    child.transform.property("ADBE Orientation").value = [0.0, 279.0, 0.0];
    child.transform.property("ADBE Position").value = [150.0, 160.0, 0.0];
    child.transform.property("ADBE Anchor Point").value = [50.0, 50.0, 0.0];
    const parent = comp.addNull();
    parent.transform.property("ADBE Position").value = [300.0, 40.0, 0.0];
    parent.transform.property("ADBE Rotate Z").value = 30.0;

    child.parent = parent;

    expect(approx(child.transform.property("ADBE Position").value, [-69.9038, 178.923, 0.0], { abs: 0.001 })).toBe(true);
    expect(approx(child.transform.property("ADBE Orientation").value, [287.5766, 301.2001, 285.1604], { abs: 0.001 })).toBe(true);
  });
});

const TRANSFORM_FIXTURES = new Path(import.meta.path).parent.parent.parent.div("samples", "unused", "transforms");

// Skipped unless samples/unused is present: "samples/unused is not committed".
describe.skipIf(!TRANSFORM_FIXTURES.isDir())("TestUnparentAgainstAeFixtures", () => {
  /**
   * Replay AE 25.6's own un-parenting pairs.
   *
   * These fixtures were authored by a different AE build (25.6x101) than the
   * 2026 probes the compensation was measured against, so they double as a
   * version check - and they cover removing a parent, which the probes did
   * not. Each `_before` has ChildSolid parented; each `_after` has it free
   * with its transform baked to hold it in place.
   */

  const FIELDS = [
    "ADBE Anchor Point",
    "ADBE Position",
    "ADBE Scale",
    "ADBE Orientation",
    "ADBE Rotate X",
    "ADBE Rotate Y",
    "ADBE Rotate Z",
  ] as const;

  function _child(project: Project): Layer {
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        if (layer.name === "ChildSolid") return layer;
      }
    }
    throw new AssertionError("no ChildSolid in the fixture");
  }

  function _snapshot(layer: Layer): Map<string, number | number[]> {
    const out = new Map<string, number | number[]>();
    for (const name of FIELDS) {
      const value = layer.transform.property(name).value;
      out.set(
        name,
        Array.isArray(value) ? value.map((v) => round(v, 3)) : round(value, 3),
      );
    }
    return out;
  }

  test.each([
    ["parent_test_3d"],
    ["parent_test_anchor"],
    ["parent_test_child_anchor"],
    ["parent_test_combined"],
    ["parent_test_position"],
    ["parent_test_rotation"],
    ["parent_test_scale"],
  ])("test_unparent_matches_after_effects[%#]", (stem: string) => {
    const expected = _snapshot(_child(parseAep(TRANSFORM_FIXTURES.div(`${stem}_after.aep`)).project));
    const project = parseProjectFresh(TRANSFORM_FIXTURES.div(`${stem}_before.aep`));
    const child = _child(project);

    child.parent = null;

    expect(valueEquals(_snapshot(child), expected)).toBe(true);
  });
});
