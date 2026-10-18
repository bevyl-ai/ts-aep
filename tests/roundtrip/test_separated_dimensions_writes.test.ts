/**
 * Separating and recombining Position must move the values, not just a bit.
 *
 * `transform_unseparated.aep` and `transform_separated.aep` are the same AE
 * project one setting apart (same comp, geometry, fps, layer name and layer id
 * 15, AE build 25.6x101), so py-aep's separate must reproduce the second from
 * the first. Flipping only the tdsb bit left the followers dead, and AE then
 * ignored the separation entirely.
 */

import { describe, expect, test } from "bun:test";
import { at, enumerate, Path, py_assert, py_bool, py_eq, range, sorted, ValueError, zip } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import { KeyframeInterpolationType } from "../../src/py_aep/enums/index.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { as_instance, parse_project_fresh } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");

function _position(comp: CompItem): Property<number[]> {
  return comp.layers[0].transform.property("ADBE Position");
}

function _state(comp: CompItem): Map<string, unknown> {
  const position = _position(comp);
  return new Map<string, unknown>([
    ["separated", position.dimensions_separated],
    ["leader_stored", position._read_cdat_raw()],
    [
      "followers",
      Array.from(range(3), (dim) => [
        as_instance(position.get_separation_follower(dim), Property).value,
        as_instance(position.get_separation_follower(dim), Property)._is_live(),
      ]),
    ],
  ]);
}

describe("TestSeparate", () => {
  test("test_reproduces_the_ae_authored_separated_file", () => {
    const tmp_path = make_tmp_path();
    const expected = _state(
      parse_aep(SAMPLES_DIR.div("transform_separated.aep")).project.compositions[0],
    );

    const project = parse_project_fresh(SAMPLES_DIR.div("transform_unseparated.aep"));
    _position(project.compositions[0]).dimensions_separated = true;
    const out = tmp_path.div("separated.aep");
    project.save(out);

    expect(py_eq(_state(parse_aep(out).project.compositions[0]), expected)).toBe(true);
  });

  test("test_followers_take_the_leader_components", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("transform_unseparated.aep"));
    const position = _position(project.compositions[0]);
    expect(approx(position.value, [960.0, 540.0, 0.0])).toBe(true);

    position.dimensions_separated = true;

    expect(approx(as_instance(position.get_separation_follower(0), Property).value, 960.0)).toBe(true);
    expect(approx(as_instance(position.get_separation_follower(1), Property).value, 540.0)).toBe(true);
  });

  test("test_z_stays_synthetic_on_a_2d_layer", () => {
    /** AE materializes X and Y but leaves Z alone unless the layer is 3D. */
    const project = parse_project_fresh(SAMPLES_DIR.div("transform_unseparated.aep"));
    const position = _position(project.compositions[0]);

    position.dimensions_separated = true;

    expect(as_instance(position.get_separation_follower(0), Property)._is_live()).toBe(true);
    expect(as_instance(position.get_separation_follower(1), Property)._is_live()).toBe(true);
    expect(!as_instance(position.get_separation_follower(2), Property)._is_live()).toBe(true);
  });

  test("test_leader_is_parked_on_its_default", () => {
    /**
     * While separated the leader is dead, and AE stores the default
     * there rather than the old position.
     */
    const project = parse_project_fresh(SAMPLES_DIR.div("transform_unseparated.aep"));
    const comp = project.compositions[0];
    const position = _position(comp);
    position.get_separation_follower(0); // force follower creation
    position.value = [111.0, 222.0, 0.0];

    position.dimensions_separated = true;

    expect(approx(position._read_cdat_raw(), [comp.width / 2, comp.height / 2, 0.0])).toBe(true);
    // ...while the reported value still tracks the followers.
    expect(approx(position.value, [111.0, 222.0, 0.0])).toBe(true);
  });
});

describe("TestRecombine", () => {
  test("test_folds_the_followers_back_into_the_leader", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("transform_separated.aep"));
    const position = _position(project.compositions[0]);
    as_instance(position.get_separation_follower(0), Property).value = 111.0;
    as_instance(position.get_separation_follower(1), Property).value = 222.0;

    position.dimensions_separated = false;

    const out = tmp_path.div("recombined.aep");
    project.save(out);
    const reloaded = _position(parse_aep(out).project.compositions[0]);
    expect(reloaded.dimensions_separated).toBe(false);
    expect(approx(reloaded.value, [111.0, 222.0, 0.0])).toBe(true);
  });

  test("test_followers_revert_to_dead", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("transform_separated.aep"));
    const position = _position(project.compositions[0]);
    expect(as_instance(position.get_separation_follower(0), Property)._is_live()).toBe(true);

    position.dimensions_separated = false;

    const out = tmp_path.div("recombined.aep");
    project.save(out);
    const reloaded = _position(parse_aep(out).project.compositions[0]);
    for (const dimension of range(3)) {
      expect(!as_instance(reloaded.get_separation_follower(dimension), Property)._is_live()).toBe(true);
    }
  });
});

describe("TestGuards", () => {
  test("test_is_idempotent", () => {
    /**
     * AE's dimensionsSeparated is idempotent. Re-running the transfer
     * would re-seed the followers from a leader the first call already
     * reset, destroying the separated values.
     */
    const project = parse_project_fresh(SAMPLES_DIR.div("transform_separated.aep"));
    const position = _position(project.compositions[0]);
    as_instance(position.get_separation_follower(0), Property).value = 777.0;

    position.dimensions_separated = true;

    expect(approx(as_instance(position.get_separation_follower(0), Property).value, 777.0)).toBe(true);
  });

  test("test_non_leader_is_rejected", () => {
    /** AE silently ignores this; py-aep raises. */
    const project = parse_project_fresh(SAMPLES_DIR.div("transform_separated.aep"));
    const follower = as_instance(_position(project.compositions[0]).get_separation_follower(0), Property);
    raises(
      ValueError,
      () => {
        follower.dimensions_separated = true;
      },
      "separation leader",
    );
  });

  test("test_animated_recombine_keeps_the_keyframes", () => {
    /**
     * The old flag-only write orphaned the follower keyframes and left
     * the leader on a stale static value - the animation vanished.
     *
     * The leader lands on the UNION of the followers' times. X and Y do
     * not share a timeline in this fixture (X keys at 0/5/9, Y at 0/3/9) -
     * that is the point of separating them - so folding the two lists
     * together positionally would put X's t=5 value beside Y's t=3 one
     * and drop a key.
     */
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("keyframe_separated_dimensions.aep"));
    const position = _position(project.compositions[0]);
    const followers = Array.from(range(3), (dim) => as_instance(position.get_separation_follower(dim), Property));
    const x_times = followers[0].keyframes.map((k) => k.time);
    const y_times = followers[1].keyframes.map((k) => k.time);
    expect(py_eq(x_times, y_times)).toBe(false);
    const expected_times = sorted([...new Set([...x_times, ...y_times])]);
    const expected = expected_times.map((time) =>
      followers.map((follower) => follower.value_at_time(time)),
    );

    position.dimensions_separated = false;

    const out = tmp_path.div("recombined.aep");
    project.save(out);
    const reloaded = _position(parse_aep(out).project.compositions[0]);
    expect(reloaded.dimensions_separated).toBe(false);
    expect(approx(reloaded.keyframes.map((k) => k.time), expected_times)).toBe(true);
    for (const [index, keyframe] of enumerate(reloaded.keyframes)) {
      const composed = keyframe.value;
      expect(approx(composed.slice(0, 2), expected[index].slice(0, 2))).toBe(true);
    }
  });
});

describe("TestAnimatedSeparation", () => {
  /**
   * The keyframe transfer AE performs, measured on AE 2026.
   *
   * AE turns each spatial tangent into a per-dimension ease with
   * `speed = |tangent| * 100` and `influence = 1/dt` percent. The numbers
   * below come from a probe over segment durations of 0.5, 2.5, 5 and 12 s -
   * the last needing influence 0.0833, below AE's own dialog minimum.
   */

  const TIMES = [0.0, 0.5, 3.0, 8.0, 20.0];
  const VALUES = [
    [50.0, 50.0, 0.0],
    [150.0, 90.0, 0.0],
    [300.0, 60.0, 0.0],
    [420.0, 180.0, 0.0],
    [560.0, 100.0, 0.0],
  ];
  const TANGENTS: [number[], number[]][] = [
    [[0.0, 0.0, 0.0], [12.0, 5.0, 0.0]],
    [[-30.0, -8.0, 0.0], [44.0, 16.0, 0.0]],
    [[-21.0, -9.0, 0.0], [33.0, 27.0, 0.0]],
    [[-18.0, -24.0, 0.0], [60.0, 12.0, 0.0]],
    [[-15.0, -7.0, 0.0], [0.0, 0.0, 0.0]],
  ];

  function _authored_leader(): Property {
    const project = parse_project_fresh(SAMPLES_DIR.div("effect_point_speed.aep"));
    const position = _position(project.compositions[0]);
    while (py_bool(position.keyframes)) {
      position.remove_key(0);
    }
    for (const [time, value] of zip(TIMES, VALUES)) {
      position.add_key(time);
      at(position.keyframes, -1).value = [...value];
    }
    for (const keyframe of position.keyframes) {
      keyframe.in_interpolation_type = KeyframeInterpolationType.BEZIER;
      keyframe.out_interpolation_type = KeyframeInterpolationType.BEZIER;
    }
    for (const [keyframe, [incoming, outgoing]] of zip(position.keyframes, TANGENTS)) {
      keyframe.in_spatial_tangent = [...incoming];
      keyframe.out_spatial_tangent = [...outgoing];
    }
    return position;
  }

  test("test_follower_ease_matches_after_effects", () => {
    const position = _authored_leader();

    position.dimensions_separated = true;

    const follower = as_instance(position.get_separation_follower(0), Property);
    // (in speed, in influence, out speed, out influence) per keyframe.
    const expected = [
      [0.0, 100.0 / 6.0, 1200.0, 2.0],
      [3000.0, 2.0, 4400.0, 0.4],
      [2100.0, 0.4, 3300.0, 0.2],
      [1800.0, 0.2, 6000.0, 1.0 / 12.0],
      [1500.0, 1.0 / 12.0, 0.0, 100.0 / 6.0],
    ];
    for (const [keyframe, wanted] of zip(follower.keyframes, expected)) {
      expect(approx(keyframe.in_temporal_ease[0].speed, wanted[0])).toBe(true);
      expect(approx(keyframe.in_temporal_ease[0].influence, wanted[1])).toBe(true);
      expect(approx(keyframe.out_temporal_ease[0].speed, wanted[2])).toBe(true);
      expect(approx(keyframe.out_temporal_ease[0].influence, wanted[3])).toBe(true);
      expect(keyframe.temporal_continuous).toBe(true);
    }
  });

  test("test_leader_keyframes_move_to_the_followers", () => {
    const position = _authored_leader();

    position.dimensions_separated = true;

    expect(py_eq(position.keyframes, [])).toBe(true);
    for (const dimension of range(2)) {
      const follower = as_instance(position.get_separation_follower(dimension), Property);
      expect(follower.keyframes.length).toBe(TIMES.length);
      expect(approx(follower.keyframes.map((k) => k.time), TIMES)).toBe(true);
    }
  });

  test("test_round_trip_is_lossless", () => {
    /** Values and tangents come back exactly, which is also what AE does. */
    const position = _authored_leader();

    position.dimensions_separated = true;
    position.dimensions_separated = false;

    expect(position.keyframes.length).toBe(TIMES.length);
    for (const [index, keyframe] of enumerate(position.keyframes)) {
      expect(approx(keyframe.time, TIMES[index])).toBe(true);
      expect(approx(keyframe.value, VALUES[index])).toBe(true);
      expect(approx(keyframe.in_spatial_tangent, TANGENTS[index][0])).toBe(true);
      expect(approx(keyframe.out_spatial_tangent, TANGENTS[index][1])).toBe(true);
    }
  });
});

describe("TestLeaderIsNotWritable", () => {
  /**
   * A separated leader refuses writes, as After Effects does.
   *
   * Probed on AE 2026: `setValue` and `setValueAtTime` on a separated
   * Position both raise ("Can not 'set value' with this property, because
   * the property or a parent property is hidden"), while the X / Y / Z
   * followers accept writes. py-aep used to accept the write silently and
   * park it in the leader's dead `cdat`, where nothing ever read it back.
   */

  test("test_value_write_is_rejected", () => {
    const position = _position(
      parse_project_fresh(SAMPLES_DIR.div("transform_separated.aep")).compositions[0],
    );
    expect(position.dimensions_separated).toBe(true);
    raises(
      ValueError,
      () => {
        position.value = [11.0, 22.0, 0.0];
      },
      "dimensions are separated",
    );
  });

  test("test_set_value_at_time_is_rejected", () => {
    const position = _position(
      parse_project_fresh(SAMPLES_DIR.div("transform_separated.aep")).compositions[0],
    );
    raises(
      ValueError,
      () => {
        position.set_value_at_time(1.0, [11.0, 22.0, 0.0]);
      },
      "dimensions are separated",
    );
  });

  test("test_rejected_write_changes_nothing", () => {
    const comp = parse_project_fresh(SAMPLES_DIR.div("transform_separated.aep")).compositions[0];
    const before = _state(comp);
    raises(ValueError, () => {
      _position(comp).value = [11.0, 22.0, 0.0];
    });
    expect(py_eq(_state(comp), before)).toBe(true);
  });

  test("test_unseparated_leader_is_still_writable", () => {
    /** The guard must not leak to an ordinary Position. */
    const position = _position(
      parse_project_fresh(SAMPLES_DIR.div("transform_unseparated.aep")).compositions[0],
    );
    expect(position.dimensions_separated).toBe(false);
    position.value = [11.0, 22.0, 0.0];
    expect(approx(position.value, [11.0, 22.0, 0.0])).toBe(true);
  });

  test("test_followers_take_the_write_instead", () => {
    const tmp_path = make_tmp_path();
    /** What AE tells you to do instead, and it round-trips. */
    const project = parse_project_fresh(SAMPLES_DIR.div("transform_separated.aep"));
    const position = _position(project.compositions[0]);
    as_instance(position.get_separation_follower(0), Property).value = 11.0;
    as_instance(position.get_separation_follower(1), Property).value = 22.0;

    expect(approx(position.value, [11.0, 22.0, 0.0])).toBe(true);
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const reparsed = _position(parse_aep(out).project.compositions[0]);
    expect(reparsed.dimensions_separated).toBe(true);
    expect(approx(reparsed.value, [11.0, 22.0, 0.0])).toBe(true);
  });
});

describe("TestSeparatedCompensation", () => {
  /**
   * `Layer.parent` compensates a separated Position through the followers.
   *
   * AE refuses the scripting write but does exactly this itself on a
   * reparent, so the private path stays even though the public setter does
   * not (`Property._set_separated_value`).
   */

  test("test_internal_write_reaches_the_followers", () => {
    const comp = parse_project_fresh(SAMPLES_DIR.div("transform_separated.aep")).compositions[0];
    const position = _position(comp);
    const parked = position._read_cdat_raw();

    const followers = position._separation_followers();
    py_assert(followers != null);
    position._set_separated_value([11.0, 22.0, 0.0], followers);

    expect(approx(position.value, [11.0, 22.0, 0.0])).toBe(true);
    // The dead leader stays on the default AE parks it on.
    expect(approx(position._read_cdat_raw(), parked)).toBe(true);
  });

  test("test_untouched_z_stays_synthetic_on_a_2d_layer", () => {
    /**
     * Only changed components are written, so a Z that does not move is
     * not materialized - matching what AE writes for a 2D layer.
     */
    const comp = parse_project_fresh(SAMPLES_DIR.div("transform_separated.aep")).compositions[0];
    const position = _position(comp);
    expect(as_instance(position.get_separation_follower(2), Property)._is_live()).toBe(false);

    const followers = position._separation_followers();
    py_assert(followers != null);
    position._set_separated_value([11.0, 22.0, 0.0], followers);

    expect(as_instance(position.get_separation_follower(2), Property)._is_live()).toBe(false);
  });
});
