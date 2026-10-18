/**
 * state the model must refresh when a switch is written.
 *
 * Measured in After Effects 2026
 */

import { describe, expect, test } from "bun:test";
import * as py_aep from "../../src/py_aep/index.ts";
import { TdsbChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { StopIteration, getattr, hasattr, len, pyBool, range, str } from "../../src/pyrt/index.ts";
import type { Path } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath } from "../../src/pyrt/pytest.ts";
import { SAMPLES_DIR, asInstance, parseAppFresh } from "../helpers.ts";

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
      yield* _walk(asInstance(child, py_aep.PropertyGroup), depth + 1);
    }
  }
}

describe("TestThreeDLayerRefreshesTransform", () => {
  /**
   * AE 2026 renames `ADBE Rotate Z` the moment the 3-D switch is toggled -
   * "Rotation" on a 2-D layer, "Z Rotation" on a 3-D one, in both directions.
   */

  test("test_toggling_on_renames_rotation", () => {
    const app = parseAppFresh(PROPERTY_DIR.div("keyframe_1D.aep"));
    const layer = asInstance(app.project.compositions[0].layers[0], py_aep.AVLayer);
    const rotateZ = asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("ADBE Rotate Z");
    expect(pyBool(layer.threeDLayer)).toBe(false);
    expect(str(rotateZ.name)).toBe("Rotation");

    layer.threeDLayer = true;

    expect(str(rotateZ.name)).toBe("Z Rotation");
  });

  test("test_toggling_off_restores_the_name", () => {
    const app = parseAppFresh(PROPERTY_DIR.div("keyframe_1D.aep"));
    const layer = asInstance(app.project.compositions[0].layers[0], py_aep.AVLayer);
    const rotateZ = asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("ADBE Rotate Z");

    layer.threeDLayer = true;
    layer.threeDLayer = false;

    expect(str(rotateZ.name)).toBe("Rotation");
  });

  /**
   * The in-memory name must be the one a fresh parse reports.
   */
  test("test_name_matches_a_reparse", () => {
    const tmpPath: Path = makeTmpPath();
    const app = parseAppFresh(PROPERTY_DIR.div("keyframe_1D.aep"));
    const layer = asInstance(app.project.compositions[0].layers[0], py_aep.AVLayer);
    layer.threeDLayer = true;
    const inMemory = str(asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("ADBE Rotate Z").name);

    const out = tmpPath.div("three_d.aep");
    app.project.save(out);

    const app2 = parseAppFresh(out);
    const reparsed = asInstance(app2.project.compositions[0].layers[0].property("Transform"), py_aep.PropertyGroup).property(
      "ADBE Rotate Z",
    );
    const reparsedName = str(reparsed.name);
    expect(inMemory).toBe(reparsedName);
    expect(reparsedName).toBe("Z Rotation");
  });
});

describe("TestScaleZFollowsTheThreeDSwitch", () => {
  /**
   * AE 2026: a Z of 40 set while 3-D reads 40; dropping the layer
   * to 2-D reads 100; going back to 3-D still reads 100. The stored Z is
   * DISCARDED on the way out of 3-D, not masked.
   */

  const _layer = () => {
    const app = py_aep.newProject();
    const comp = app.project.rootFolder.addComp("Z", 320, 240, 1.0, 10.0, 24.0);
    const layer = comp.addSolid([1, 0, 0], "ScaleZ", 320, 240, 1.0);
    return [app, layer, asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("ADBE Scale")] as const;
  };

  test("test_three_d_shows_the_z", () => {
    const [_app, layer, scale] = _layer();
    layer.threeDLayer = true;
    scale.value = [60.0, 70.0, 40.0];
    expect(approx(scale.value, [60.0, 70.0, 40.0])).toBe(true);
  });

  test("test_leaving_three_d_discards_the_z", () => {
    const [_app, layer, scale] = _layer();
    layer.threeDLayer = true;
    scale.value = [60.0, 70.0, 40.0];

    layer.threeDLayer = false;
    expect(approx(scale.value, [60.0, 70.0, 100.0])).toBe(true);

    layer.threeDLayer = true;
    expect(approx(scale.value, [60.0, 70.0, 100.0])).toBe(true);
  });

  test("test_the_discard_reaches_the_file", () => {
    const tmpPath: Path = makeTmpPath();
    const [app, layer, scale] = _layer();
    layer.threeDLayer = true;
    scale.value = [60.0, 70.0, 40.0];
    layer.threeDLayer = false;
    layer.threeDLayer = true;

    const out = tmpPath.div("scale_z.aep");
    app.project.save(out);

    const reparsed = asInstance(
      parseAppFresh(out).project.compositions[0].layers[0].property("Transform"),
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
    layer.threeDLayer = true;
    scale.setValueAtTime(0.0, [10.0, 20.0, 30.0]);
    scale.setValueAtTime(1.0, [40.0, 50.0, 60.0]);

    layer.threeDLayer = false;

    expect(len(scale.keyframes)).toBe(2);
  });
});

describe("TestCameraAndLightSeparate", () => {
  /**
   * AE 2026 accepts `dimensionsSeparated` on a camera AND a light position,
   * reads it back true and keeps the position. py forced the
   * getter to False, so the write never persisted - and the leader's Z was
   * destroyed on the way (`_separateStatic` parks the leader on its default).
   */

  test.each([
    ["layer/type.aep", "type_camera"],
    ["layer/lightType.aep", "lightType_SPOT"],
  ])("test_separation_persists[%#]", (sample: string, compName: string | null) => {
    const tmpPath: Path = makeTmpPath();
    const app = parseAppFresh(SAMPLES_DIR.div("models", sample));
    const comp = pyBool(compName)
      ? next(app.project.compositions, (c) => c.name === compName)
      : app.project.compositions[0];
    const layer = comp.layers[0];
    const pos = asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("ADBE Position");
    const before = [...pos.value];
    expect(pyBool(pos.dimensionsSeparated)).toBe(false);

    pos.dimensionsSeparated = true;

    expect(pyBool(pos.dimensionsSeparated)).toBe(true);
    const out = tmpPath.div("separated.aep");
    app.project.save(out);

    const app2 = parseAppFresh(out);
    const comp2 = pyBool(compName)
      ? next(app2.project.compositions, (c) => c.name === compName)
      : app2.project.compositions[0];
    const pos2 = asInstance(comp2.layers[0].property("Transform"), py_aep.PropertyGroup).property("ADBE Position");
    expect(pyBool(pos2.dimensionsSeparated)).toBe(true);
    // The Z the camera/light is positioned at must survive.
    expect(approx(pos2.value, before)).toBe(true);
    expect(approx(asInstance(pos2.getSeparationFollower(2), py_aep.Property).value, before[2])).toBe(true);
  });

  /**
   * `lightType.aep`'s ambient light has the enable byte's hidden bit
   * set (an ambient light has no position to show) and AE reports
   * `dimensionsSeparated` false - separation lives in the lock byte.
   * Checked against every AE export in the corpus: the lock bit agrees
   * 288/288, the enable bit 285/288.
   */
  test("test_a_hidden_leader_is_not_a_separated_one", () => {
    const app = parseAppFresh(LAYER_DIR.div("lightType.aep"));
    const comp = next(app.project.compositions, (c) => c.name === "lightType_AMBIENT");
    const pos = asInstance(comp.layers[0].property("Transform"), py_aep.PropertyGroup).property("ADBE Position");

    expect(asInstance(pos._tdsb, TdsbChunk).hidden).toBe(true);
    expect(pos.dimensionsSeparated).toBe(false);
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
    const tmpPath: Path = makeTmpPath();
    const app = parseAppFresh(PROPERTY_DIR.div("transform_separated.aep"));
    const pos = next(
      (function* () {
        for (const comp of app.project.compositions)
          for (const layer of comp.layers)
            for (const p of _walk(layer))
              if (getattr(p, "matchName", null) === "ADBE Position" && pyBool(asInstance(p, py_aep.Property).dimensionsSeparated))
                yield asInstance(p, py_aep.Property);
      })(),
    );
    const leaderBefore = [...pos.value];

    pos.dimensionsSeparated = false;

    const inMemory = Array.from(range(3), (d) => asInstance(pos.getSeparationFollower(d), py_aep.Property).value);
    expect(approx(inMemory, [0.0, 0.0, 0.0])).toBe(true);
    expect(approx(pos.value, leaderBefore)).toBe(true);

    const out = tmpPath.div("recombined.aep");
    app.project.save(out);
    const app2 = parseAppFresh(out);
    const pos2 = next(
      (function* () {
        for (const comp of app2.project.compositions)
          for (const layer of comp.layers)
            for (const p of _walk(layer))
              if (getattr(p, "matchName", null) === "ADBE Position") yield asInstance(p, py_aep.Property);
      })(),
    );
    const onDisk = Array.from(range(3), (d) => asInstance(pos2.getSeparationFollower(d), py_aep.Property).value);
    expect(approx(inMemory, onDisk)).toBe(true);
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
    const app = parseAppFresh(PROPERTY_DIR.div("effects.aep"));
    const comp = next(app.project.compositions, (c) => c.name === "effect_2dPoint");
    const point = asInstance(
      next(_walk(comp.layers[0]), (p) => getattr(p, "matchName", null) === "ADBE Lens Flare-0001"),
      py_aep.Property,
    );
    const before = [...point.value];

    const newComp = comp.precompose([0], "PreFX");

    const moved = asInstance(
      next(_walk(newComp.layers[0]), (p) => getattr(p, "matchName", null) === "ADBE Lens Flare-0001"),
      py_aep.Property,
    );
    expect(approx(moved.value, before)).toBe(true);
  });

  /**
   * The sibling case: a synthesized LAYER cdat holds user units, so it
   * must NOT be resolved again.
   */
  test("test_anchor_point_still_survives_precompose", () => {
    const app = parseAppFresh(PROPERTY_DIR.div("keyframe_1D.aep"));
    const comp = app.project.compositions[0];
    const before = [...asInstance(comp.layers[0].property("Transform"), py_aep.PropertyGroup).property("ADBE Anchor Point").value];

    const newComp = comp.precompose([0], "Pre");

    const after = asInstance(newComp.layers[0].property("Transform"), py_aep.PropertyGroup).property("ADBE Anchor Point").value;
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
    const app = py_aep.newProject();
    const comp = app.project.rootFolder.addComp("C", 320, 240, 1.0, 40.0, 24.0);
    const layer = comp.addSolid([1, 1, 1], "L", 320, 240, 1.0);
    layer.stretch = stretch;
    const op = asInstance(asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("Opacity"), py_aep.Property);
    op.setValueAtTime(1.0, 0.0);
    op.setValueAtTime(5.0, 100.0);
    for (const kf of op.keyframes) {
      kf.inInterpolationType = py_aep.KeyframeInterpolationType.BEZIER;
      kf.outInterpolationType = py_aep.KeyframeInterpolationType.BEZIER;
    }
    op.keyframes[0].outTemporalEase = [new py_aep.KeyframeEase(30.0, 40.0)];

    expect(approx(op.keyframes[0].outTemporalEase[0].speed, 30.0)).toBe(true);
    expect(approx(op.keyframes[0].outTemporalEase[0].influence, 40.0)).toBe(true);
  });
});
