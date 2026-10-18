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
import { at, enumerate, Path, pyAssert, pyBool, pyEq, range, sorted, ValueError, zip } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import { KeyframeInterpolationType } from "../../src/py_aep/enums/index.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { asInstance, parseProjectFresh } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");

function _position(comp: CompItem): Property<number[]> {
  return comp.layers[0].transform.property("ADBE Position");
}

function _state(comp: CompItem): Map<string, unknown> {
  const position = _position(comp);
  return new Map<string, unknown>([
    ["separated", position.dimensionsSeparated],
    ["leader_stored", position._read_cdat_raw()],
    [
      "followers",
      Array.from(range(3), (dim) => [
        asInstance(position.getSeparationFollower(dim), Property).value,
        asInstance(position.getSeparationFollower(dim), Property)._is_live(),
      ]),
    ],
  ]);
}

describe("TestSeparate", () => {
  test("test_reproduces_the_ae_authored_separated_file", () => {
    const tmpPath = makeTmpPath();
    const expected = _state(
      parseAep(SAMPLES_DIR.div("transform_separated.aep")).project.compositions[0],
    );

    const project = parseProjectFresh(SAMPLES_DIR.div("transform_unseparated.aep"));
    _position(project.compositions[0]).dimensionsSeparated = true;
    const out = tmpPath.div("separated.aep");
    project.save(out);

    expect(pyEq(_state(parseAep(out).project.compositions[0]), expected)).toBe(true);
  });

  test("test_followers_take_the_leader_components", () => {
    const project = parseProjectFresh(SAMPLES_DIR.div("transform_unseparated.aep"));
    const position = _position(project.compositions[0]);
    expect(approx(position.value, [960.0, 540.0, 0.0])).toBe(true);

    position.dimensionsSeparated = true;

    expect(approx(asInstance(position.getSeparationFollower(0), Property).value, 960.0)).toBe(true);
    expect(approx(asInstance(position.getSeparationFollower(1), Property).value, 540.0)).toBe(true);
  });

  test("test_z_stays_synthetic_on_a_2d_layer", () => {
    /** AE materializes X and Y but leaves Z alone unless the layer is 3D. */
    const project = parseProjectFresh(SAMPLES_DIR.div("transform_unseparated.aep"));
    const position = _position(project.compositions[0]);

    position.dimensionsSeparated = true;

    expect(asInstance(position.getSeparationFollower(0), Property)._is_live()).toBe(true);
    expect(asInstance(position.getSeparationFollower(1), Property)._is_live()).toBe(true);
    expect(!asInstance(position.getSeparationFollower(2), Property)._is_live()).toBe(true);
  });

  test("test_leader_is_parked_on_its_default", () => {
    /**
     * While separated the leader is dead, and AE stores the default
     * there rather than the old position.
     */
    const project = parseProjectFresh(SAMPLES_DIR.div("transform_unseparated.aep"));
    const comp = project.compositions[0];
    const position = _position(comp);
    position.getSeparationFollower(0); // force follower creation
    position.value = [111.0, 222.0, 0.0];

    position.dimensionsSeparated = true;

    expect(approx(position._read_cdat_raw(), [comp.width / 2, comp.height / 2, 0.0])).toBe(true);
    // ...while the reported value still tracks the followers.
    expect(approx(position.value, [111.0, 222.0, 0.0])).toBe(true);
  });
});

describe("TestRecombine", () => {
  test("test_folds_the_followers_back_into_the_leader", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("transform_separated.aep"));
    const position = _position(project.compositions[0]);
    asInstance(position.getSeparationFollower(0), Property).value = 111.0;
    asInstance(position.getSeparationFollower(1), Property).value = 222.0;

    position.dimensionsSeparated = false;

    const out = tmpPath.div("recombined.aep");
    project.save(out);
    const reloaded = _position(parseAep(out).project.compositions[0]);
    expect(reloaded.dimensionsSeparated).toBe(false);
    expect(approx(reloaded.value, [111.0, 222.0, 0.0])).toBe(true);
  });

  test("test_followers_revert_to_dead", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("transform_separated.aep"));
    const position = _position(project.compositions[0]);
    expect(asInstance(position.getSeparationFollower(0), Property)._is_live()).toBe(true);

    position.dimensionsSeparated = false;

    const out = tmpPath.div("recombined.aep");
    project.save(out);
    const reloaded = _position(parseAep(out).project.compositions[0]);
    for (const dimension of range(3)) {
      expect(!asInstance(reloaded.getSeparationFollower(dimension), Property)._is_live()).toBe(true);
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
    const project = parseProjectFresh(SAMPLES_DIR.div("transform_separated.aep"));
    const position = _position(project.compositions[0]);
    asInstance(position.getSeparationFollower(0), Property).value = 777.0;

    position.dimensionsSeparated = true;

    expect(approx(asInstance(position.getSeparationFollower(0), Property).value, 777.0)).toBe(true);
  });

  test("test_non_leader_is_rejected", () => {
    /** AE silently ignores this; py-aep raises. */
    const project = parseProjectFresh(SAMPLES_DIR.div("transform_separated.aep"));
    const follower = asInstance(_position(project.compositions[0]).getSeparationFollower(0), Property);
    raises(
      ValueError,
      () => {
        follower.dimensionsSeparated = true;
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
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES_DIR.div("keyframe_separated_dimensions.aep"));
    const position = _position(project.compositions[0]);
    const followers = Array.from(range(3), (dim) => asInstance(position.getSeparationFollower(dim), Property));
    const xTimes = followers[0].keyframes.map((k) => k.time);
    const yTimes = followers[1].keyframes.map((k) => k.time);
    expect(pyEq(xTimes, yTimes)).toBe(false);
    const expectedTimes = sorted([...new Set([...xTimes, ...yTimes])]);
    const expected = expectedTimes.map((time) =>
      followers.map((follower) => follower.valueAtTime(time)),
    );

    position.dimensionsSeparated = false;

    const out = tmpPath.div("recombined.aep");
    project.save(out);
    const reloaded = _position(parseAep(out).project.compositions[0]);
    expect(reloaded.dimensionsSeparated).toBe(false);
    expect(approx(reloaded.keyframes.map((k) => k.time), expectedTimes)).toBe(true);
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

  function _authoredLeader(): Property {
    const project = parseProjectFresh(SAMPLES_DIR.div("effect_point_speed.aep"));
    const position = _position(project.compositions[0]);
    while (pyBool(position.keyframes)) {
      position.removeKey(0);
    }
    for (const [time, value] of zip(TIMES, VALUES)) {
      position.addKey(time);
      at(position.keyframes, -1).value = [...value];
    }
    for (const keyframe of position.keyframes) {
      keyframe.inInterpolationType = KeyframeInterpolationType.BEZIER;
      keyframe.outInterpolationType = KeyframeInterpolationType.BEZIER;
    }
    for (const [keyframe, [incoming, outgoing]] of zip(position.keyframes, TANGENTS)) {
      keyframe.inSpatialTangent = [...incoming];
      keyframe.outSpatialTangent = [...outgoing];
    }
    return position;
  }

  test("test_follower_ease_matches_after_effects", () => {
    const position = _authoredLeader();

    position.dimensionsSeparated = true;

    const follower = asInstance(position.getSeparationFollower(0), Property);
    // (in speed, in influence, out speed, out influence) per keyframe.
    const expected = [
      [0.0, 100.0 / 6.0, 1200.0, 2.0],
      [3000.0, 2.0, 4400.0, 0.4],
      [2100.0, 0.4, 3300.0, 0.2],
      [1800.0, 0.2, 6000.0, 1.0 / 12.0],
      [1500.0, 1.0 / 12.0, 0.0, 100.0 / 6.0],
    ];
    for (const [keyframe, wanted] of zip(follower.keyframes, expected)) {
      expect(approx(keyframe.inTemporalEase[0].speed, wanted[0])).toBe(true);
      expect(approx(keyframe.inTemporalEase[0].influence, wanted[1])).toBe(true);
      expect(approx(keyframe.outTemporalEase[0].speed, wanted[2])).toBe(true);
      expect(approx(keyframe.outTemporalEase[0].influence, wanted[3])).toBe(true);
      expect(keyframe.temporalContinuous).toBe(true);
    }
  });

  test("test_leader_keyframes_move_to_the_followers", () => {
    const position = _authoredLeader();

    position.dimensionsSeparated = true;

    expect(pyEq(position.keyframes, [])).toBe(true);
    for (const dimension of range(2)) {
      const follower = asInstance(position.getSeparationFollower(dimension), Property);
      expect(follower.keyframes.length).toBe(TIMES.length);
      expect(approx(follower.keyframes.map((k) => k.time), TIMES)).toBe(true);
    }
  });

  test("test_round_trip_is_lossless", () => {
    /** Values and tangents come back exactly, which is also what AE does. */
    const position = _authoredLeader();

    position.dimensionsSeparated = true;
    position.dimensionsSeparated = false;

    expect(position.keyframes.length).toBe(TIMES.length);
    for (const [index, keyframe] of enumerate(position.keyframes)) {
      expect(approx(keyframe.time, TIMES[index])).toBe(true);
      expect(approx(keyframe.value, VALUES[index])).toBe(true);
      expect(approx(keyframe.inSpatialTangent, TANGENTS[index][0])).toBe(true);
      expect(approx(keyframe.outSpatialTangent, TANGENTS[index][1])).toBe(true);
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
      parseProjectFresh(SAMPLES_DIR.div("transform_separated.aep")).compositions[0],
    );
    expect(position.dimensionsSeparated).toBe(true);
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
      parseProjectFresh(SAMPLES_DIR.div("transform_separated.aep")).compositions[0],
    );
    raises(
      ValueError,
      () => {
        position.setValueAtTime(1.0, [11.0, 22.0, 0.0]);
      },
      "dimensions are separated",
    );
  });

  test("test_rejected_write_changes_nothing", () => {
    const comp = parseProjectFresh(SAMPLES_DIR.div("transform_separated.aep")).compositions[0];
    const before = _state(comp);
    raises(ValueError, () => {
      _position(comp).value = [11.0, 22.0, 0.0];
    });
    expect(pyEq(_state(comp), before)).toBe(true);
  });

  test("test_unseparated_leader_is_still_writable", () => {
    /** The guard must not leak to an ordinary Position. */
    const position = _position(
      parseProjectFresh(SAMPLES_DIR.div("transform_unseparated.aep")).compositions[0],
    );
    expect(position.dimensionsSeparated).toBe(false);
    position.value = [11.0, 22.0, 0.0];
    expect(approx(position.value, [11.0, 22.0, 0.0])).toBe(true);
  });

  test("test_followers_take_the_write_instead", () => {
    const tmpPath = makeTmpPath();
    /** What AE tells you to do instead, and it round-trips. */
    const project = parseProjectFresh(SAMPLES_DIR.div("transform_separated.aep"));
    const position = _position(project.compositions[0]);
    asInstance(position.getSeparationFollower(0), Property).value = 11.0;
    asInstance(position.getSeparationFollower(1), Property).value = 22.0;

    expect(approx(position.value, [11.0, 22.0, 0.0])).toBe(true);
    const out = tmpPath.div("modified.aep");
    project.save(out);

    const reparsed = _position(parseAep(out).project.compositions[0]);
    expect(reparsed.dimensionsSeparated).toBe(true);
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
    const comp = parseProjectFresh(SAMPLES_DIR.div("transform_separated.aep")).compositions[0];
    const position = _position(comp);
    const parked = position._read_cdat_raw();

    const followers = position._separation_followers();
    pyAssert(followers != null);
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
    const comp = parseProjectFresh(SAMPLES_DIR.div("transform_separated.aep")).compositions[0];
    const position = _position(comp);
    expect(asInstance(position.getSeparationFollower(2), Property)._is_live()).toBe(false);

    const followers = position._separation_followers();
    pyAssert(followers != null);
    position._set_separated_value([11.0, 22.0, 0.0], followers);

    expect(asInstance(position.getSeparationFollower(2), Property)._is_live()).toBe(false);
  });
});
