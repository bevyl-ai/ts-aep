/**
 * state the model must refresh when a switch is written.
 *
 * Measured in After Effects 2026
 */

import { describe, expect, test } from "bun:test";
import * as py_aep from "../../src/py_aep/index.ts";
import { TdsbChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { StopIteration, getattr, hasattr, len, py_bool, range, str } from "../../src/pyrt/index.ts";
import type { Path } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path } from "../../src/pyrt/pytest.ts";
import { SAMPLES_DIR, as_instance, parse_app_fresh } from "../helpers.ts";

const PROPERTY_DIR = SAMPLES_DIR.div("models", "property");
const LAYER_DIR = SAMPLES_DIR.div("models", "layer");

// NOTE(port): Python builtin `next(iterator)` / `next(genexpr)` has no pyrt
// shim. Local helper: first element of `xs` satisfying `pred` (any element
// when `pred` is omitted), raising StopIteration when none does.
function next<T>(xs: Iterable<T>, pred: ((x: T) => boolean) | null = null): T {
  const it = xs[Symbol.iterator]();
  for (let r = it.next(); !r.done; r = it.next()) {
    if (pred === null || pred(r.value)) return r.value;
  }
  throw new StopIteration();
}

function* _walk(group: py_aep.PropertyGroup, depth = 0): Generator<py_aep.Property | py_aep.PropertyGroup> {
  if (depth > 10) {
    return;
  }
  for (const child of group) {
    yield child;
    if (!hasattr(child, "keyframes")) {
      yield* _walk(as_instance(child, py_aep.PropertyGroup), depth + 1);
    }
  }
}

describe("TestThreeDLayerRefreshesTransform", () => {
  /**
   * AE 2026 renames `ADBE Rotate Z` the moment the 3-D switch is toggled -
   * "Rotation" on a 2-D layer, "Z Rotation" on a 3-D one, in both directions.
   */

  test("test_toggling_on_renames_rotation", () => {
    const app = parse_app_fresh(PROPERTY_DIR.div("keyframe_1D.aep"));
    const layer = as_instance(app.project.compositions[0].layers[0], py_aep.AVLayer);
    const rotate_z = as_instance(layer.property("Transform"), py_aep.PropertyGroup).property("ADBE Rotate Z");
    expect(py_bool(layer.three_d_layer)).toBe(false);
    expect(str(rotate_z.name)).toBe("Rotation");

    layer.three_d_layer = true;

    expect(str(rotate_z.name)).toBe("Z Rotation");
  });

  test("test_toggling_off_restores_the_name", () => {
    const app = parse_app_fresh(PROPERTY_DIR.div("keyframe_1D.aep"));
    const layer = as_instance(app.project.compositions[0].layers[0], py_aep.AVLayer);
    const rotate_z = as_instance(layer.property("Transform"), py_aep.PropertyGroup).property("ADBE Rotate Z");

    layer.three_d_layer = true;
    layer.three_d_layer = false;

    expect(str(rotate_z.name)).toBe("Rotation");
  });

  /**
   * The in-memory name must be the one a fresh parse reports.
   */
  test("test_name_matches_a_reparse", () => {
    const tmp_path: Path = make_tmp_path();
    const app = parse_app_fresh(PROPERTY_DIR.div("keyframe_1D.aep"));
    const layer = as_instance(app.project.compositions[0].layers[0], py_aep.AVLayer);
    layer.three_d_layer = true;
    const in_memory = str(as_instance(layer.property("Transform"), py_aep.PropertyGroup).property("ADBE Rotate Z").name);

    const out = tmp_path.div("three_d.aep");
    app.project.save(out);

    const app2 = parse_app_fresh(out);
    const reparsed = as_instance(app2.project.compositions[0].layers[0].property("Transform"), py_aep.PropertyGroup).property(
      "ADBE Rotate Z",
    );
    const reparsed_name = str(reparsed.name);
    expect(in_memory).toBe(reparsed_name);
    expect(reparsed_name).toBe("Z Rotation");
  });
});

describe("TestScaleZFollowsTheThreeDSwitch", () => {
  /**
   * AE 2026: a Z of 40 set while 3-D reads 40; dropping the layer
   * to 2-D reads 100; going back to 3-D still reads 100. The stored Z is
   * DISCARDED on the way out of 3-D, not masked.
   */

  const _layer = () => {
    const app = py_aep.new();
    const comp = app.project.root_folder.add_comp("Z", 320, 240, 1.0, 10.0, 24.0);
    const layer = comp.add_solid([1, 0, 0], "ScaleZ", 320, 240, 1.0);
    return [app, layer, as_instance(layer.property("Transform"), py_aep.PropertyGroup).property("ADBE Scale")] as const;
  };

  test("test_three_d_shows_the_z", () => {
    const [_app, layer, scale] = _layer();
    layer.three_d_layer = true;
    scale.value = [60.0, 70.0, 40.0];
    expect(approx(scale.value, [60.0, 70.0, 40.0])).toBe(true);
  });

  test("test_leaving_three_d_discards_the_z", () => {
    const [_app, layer, scale] = _layer();
    layer.three_d_layer = true;
    scale.value = [60.0, 70.0, 40.0];

    layer.three_d_layer = false;
    expect(approx(scale.value, [60.0, 70.0, 100.0])).toBe(true);

    layer.three_d_layer = true;
    expect(approx(scale.value, [60.0, 70.0, 100.0])).toBe(true);
  });

  test("test_the_discard_reaches_the_file", () => {
    const tmp_path: Path = make_tmp_path();
    const [app, layer, scale] = _layer();
    layer.three_d_layer = true;
    scale.value = [60.0, 70.0, 40.0];
    layer.three_d_layer = false;
    layer.three_d_layer = true;

    const out = tmp_path.div("scale_z.aep");
    app.project.save(out);

    const reparsed = as_instance(
      parse_app_fresh(out).project.compositions[0].layers[0].property("Transform"),
      py_aep.PropertyGroup,
    ).property("ADBE Scale");
    expect(approx(reparsed.value, [60.0, 70.0, 100.0])).toBe(true);
  });

  /**
   * AE's behaviour on a keyframed Scale was not measured, so the switch
   * must not flatten an animation on a guess.
   */
  test("test_keyframed_scale_is_left_alone", () => {
    const [_app, layer, scale] = _layer();
    layer.three_d_layer = true;
    scale.set_value_at_time(0.0, [10.0, 20.0, 30.0]);
    scale.set_value_at_time(1.0, [40.0, 50.0, 60.0]);

    layer.three_d_layer = false;

    expect(len(scale.keyframes)).toBe(2);
  });
});

describe("TestCameraAndLightSeparate", () => {
  /**
   * AE 2026 accepts `dimensionsSeparated` on a camera AND a light position,
   * reads it back true and keeps the position. py forced the
   * getter to False, so the write never persisted - and the leader's Z was
   * destroyed on the way (`_separate_static` parks the leader on its default).
   */

  test.each([
    ["layer/type.aep", "type_camera"],
    ["layer/lightType.aep", "lightType_SPOT"],
  ])("test_separation_persists[%#]", (sample: string, comp_name: string | null) => {
    const tmp_path: Path = make_tmp_path();
    const app = parse_app_fresh(SAMPLES_DIR.div("models", sample));
    const comp = py_bool(comp_name)
      ? next(app.project.compositions, (c) => c.name === comp_name)
      : app.project.compositions[0];
    const layer = comp.layers[0];
    const pos = as_instance(layer.property("Transform"), py_aep.PropertyGroup).property("ADBE Position");
    const before = [...pos.value];
    expect(py_bool(pos.dimensions_separated)).toBe(false);

    pos.dimensions_separated = true;

    expect(py_bool(pos.dimensions_separated)).toBe(true);
    const out = tmp_path.div("separated.aep");
    app.project.save(out);

    const app2 = parse_app_fresh(out);
    const comp2 = py_bool(comp_name)
      ? next(app2.project.compositions, (c) => c.name === comp_name)
      : app2.project.compositions[0];
    const pos2 = as_instance(comp2.layers[0].property("Transform"), py_aep.PropertyGroup).property("ADBE Position");
    expect(py_bool(pos2.dimensions_separated)).toBe(true);
    // The Z the camera/light is positioned at must survive.
    expect(approx(pos2.value, before)).toBe(true);
    expect(approx(as_instance(pos2.get_separation_follower(2), py_aep.Property).value, before[2])).toBe(true);
  });

  /**
   * `lightType.aep`'s ambient light has the enable byte's hidden bit
   * set (an ambient light has no position to show) and AE reports
   * `dimensionsSeparated` false - separation lives in the lock byte.
   * Checked against every AE export in the corpus: the lock bit agrees
   * 288/288, the enable bit 285/288.
   */
  test("test_a_hidden_leader_is_not_a_separated_one", () => {
    const app = parse_app_fresh(LAYER_DIR.div("lightType.aep"));
    const comp = next(app.project.compositions, (c) => c.name === "lightType_AMBIENT");
    const pos = as_instance(comp.layers[0].property("Transform"), py_aep.PropertyGroup).property("ADBE Position");

    expect(as_instance(pos._tdsb, TdsbChunk).hidden).toBe(true);
    expect(pos.dimensions_separated).toBe(false);
  });
});

describe("TestRecombineResetsFollowers", () => {
  /**
   * AE leaves a recombined follower unserialized, and its own export of a
   * never-separated layer reports X / Y / Z = 0 even for a position of
   * [960, 540, 0] (`before_separation.json`). The model must say the same as
   * the file it just wrote.
   */

  test("test_followers_read_zero_in_memory", () => {
    const tmp_path: Path = make_tmp_path();
    const app = parse_app_fresh(PROPERTY_DIR.div("transform_separated.aep"));
    const pos = next(
      (function* () {
        for (const comp of app.project.compositions)
          for (const layer of comp.layers)
            for (const p of _walk(layer))
              if (getattr(p, "match_name", null) === "ADBE Position" && py_bool(as_instance(p, py_aep.Property).dimensions_separated))
                yield as_instance(p, py_aep.Property);
      })(),
    );
    const leader_before = [...pos.value];

    pos.dimensions_separated = false;

    const in_memory = Array.from(range(3), (d) => as_instance(pos.get_separation_follower(d), py_aep.Property).value);
    expect(approx(in_memory, [0.0, 0.0, 0.0])).toBe(true);
    expect(approx(pos.value, leader_before)).toBe(true);

    const out = tmp_path.div("recombined.aep");
    app.project.save(out);
    const app2 = parse_app_fresh(out);
    const pos2 = next(
      (function* () {
        for (const comp of app2.project.compositions)
          for (const layer of comp.layers)
            for (const p of _walk(layer))
              if (getattr(p, "match_name", null) === "ADBE Position") yield as_instance(p, py_aep.Property);
      })(),
    );
    const on_disk = Array.from(range(3), (d) => as_instance(pos2.get_separation_follower(d), py_aep.Property).value);
    expect(approx(in_memory, on_disk)).toBe(true);
  });
});

describe("TestPrecomposedEffectPoint", () => {
  /**
   * AE keeps a Ramp start point at [40, 25] through a precompose.
   * py re-resolved the moved layer's synthetic cdat, which for an effect
   * param carries the `parT` default in 0-512 space, not the 0-1 an AE-written
   * cdat holds.
   */

  test("test_effect_point_survives_precompose", () => {
    const app = parse_app_fresh(PROPERTY_DIR.div("effects.aep"));
    const comp = next(app.project.compositions, (c) => c.name === "effect_2dPoint");
    const point = as_instance(
      next(_walk(comp.layers[0]), (p) => getattr(p, "match_name", null) === "ADBE Lens Flare-0001"),
      py_aep.Property,
    );
    const before = [...point.value];

    const new_comp = comp.precompose([0], "PreFX");

    const moved = as_instance(
      next(_walk(new_comp.layers[0]), (p) => getattr(p, "match_name", null) === "ADBE Lens Flare-0001"),
      py_aep.Property,
    );
    expect(approx(moved.value, before)).toBe(true);
  });

  /**
   * The sibling case: a synthesized LAYER cdat holds user units, so it
   * must NOT be resolved again.
   */
  test("test_anchor_point_still_survives_precompose", () => {
    const app = parse_app_fresh(PROPERTY_DIR.div("keyframe_1D.aep"));
    const comp = app.project.compositions[0];
    const before = [...as_instance(comp.layers[0].property("Transform"), py_aep.PropertyGroup).property("ADBE Anchor Point").value];

    const new_comp = comp.precompose([0], "Pre");

    const after = as_instance(new_comp.layers[0].property("Transform"), py_aep.PropertyGroup).property("ADBE Anchor Point").value;
    expect(approx(after, before)).toBe(true);
  });
});

describe("TestEaseSpeedsAreNotLayerTime", () => {
  /**
   * Issue #225 item 4 also claims ease SPEEDS are in layer time. AE 2026
   * reports the same speed for the same ease whatever the stretch (30/40 on
   * a 100 % layer, on one stretched afterwards, and on one eased while
   * already stretched), and py reads the stored value back unconverted. No
   * conversion belongs here.
   */

  test.each([100.0, 200.0, 50.0])("test_speed_is_stretch_invariant[%#]", (stretch: number) => {
    const app = py_aep.new();
    const comp = app.project.root_folder.add_comp("C", 320, 240, 1.0, 40.0, 24.0);
    const layer = comp.add_solid([1, 1, 1], "L", 320, 240, 1.0);
    layer.stretch = stretch;
    const op = as_instance(as_instance(layer.property("Transform"), py_aep.PropertyGroup).property("Opacity"), py_aep.Property);
    op.set_value_at_time(1.0, 0.0);
    op.set_value_at_time(5.0, 100.0);
    for (const kf of op.keyframes) {
      kf.in_interpolation_type = py_aep.KeyframeInterpolationType.BEZIER;
      kf.out_interpolation_type = py_aep.KeyframeInterpolationType.BEZIER;
    }
    op.keyframes[0].out_temporal_ease = [new py_aep.KeyframeEase(30.0, 40.0)];

    expect(approx(op.keyframes[0].out_temporal_ease[0].speed, 30.0)).toBe(true);
    expect(approx(op.keyframes[0].out_temporal_ease[0].influence, 40.0)).toBe(true);
  });
});
