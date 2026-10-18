/**
 * Issue #225 item 4: keyframe ticks are in LAYER time, and the `tdb4`
 * timebase that counts them is a full 32-bit field.
 *
 * Measured on After Effects 2026: keys authored at layer-seconds 1 / 4 / 7
 * on a 24 fps comp, then stretched, come back at these composition times -
 *
 *     stretch   50 %   ->  0.5  / 2     / 3.5      tdb4 24576
 *     stretch  101 %   ->  1.01 / 4.04  / 7.07     tdb4 24821
 *     stretch  150 %   ->  1.5  / 6     / 10.5     tdb4 36864
 *     stretch  300 %   ->  3    / 12    / 21       tdb4 73728   (0x00012000)
 *     stretch -150 %   -> -1.5  / -6    / -10.5    tdb4 36864
 *
 * 73728 needs 17 bits, so the field cannot be the `u2` py_aep used to read -
 * the overflow landed in the two bytes it labelled padding.
 */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { SAMPLES_DIR, asInstance, parseAppFresh } from "../helpers.ts";
import { AssertionError_, ValueError, float, getattr, getitem, max, pyEq } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";

const LAYER_DIR = SAMPLES_DIR.div("models", "layer");

function _opacityWithKeys(comp: py_aep.CompItem, stretch: number): [py_aep.AVLayer, py_aep.Property<number>] {
  const layer = comp.addSolid([1, 0, 0], "L", 320, 240, 1.0);
  layer.stretch = stretch;
  const op = asInstance(asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("Opacity"), py_aep.Property);
  for (const [t, v] of [
    [1.0, 10.0],
    [4.0, 50.0],
    [7.0, 90.0],
  ]) {
    op.setValueAtTime(t, v);
  }
  return [layer, op];
}

describe("TestStretchedLayerTimebase", () => {
  test.each([[50.0], [101.0], [150.0], [300.0]])("test_timebase_scales_with_stretch[%#]", (stretch: number) => {
    const app = py_aep.new();
    const comp = app.project.rootFolder.addComp("C", 320, 240, 1.0, 40.0, 24.0);
    const [_layer, op] = _opacityWithKeys(comp, stretch);

    const want = Math.floor(comp._cdta.internalTimebase * max([1.0, stretch / 100.0]));
    expect(op._tdb4._timeBase).toBe(want);
  });

  test("test_three_hundred_percent_needs_more_than_sixteen_bits", () => {
    const app = py_aep.new();
    const comp = app.project.rootFolder.addComp("C", 320, 240, 1.0, 40.0, 24.0);
    const [_layer, op] = _opacityWithKeys(comp, 300.0);

    expect(op._tdb4._timeBase).toBe(73728);
    expect(op._tdb4._timeBase > 0xffff).toBe(true);
  });

  test.each([[50.0], [150.0], [300.0]])("test_key_times_survive_a_roundtrip[%#]", (stretch: number) => {
    /** Keys written at composition time must read back at the same time. */
    const tmpPath = makeTmpPath();
    const app = py_aep.new();
    const comp = app.project.rootFolder.addComp("C", 320, 240, 1.0, 40.0, 24.0);
    const [_layer, op] = _opacityWithKeys(comp, stretch);
    expect(approx(op.keyframes.map((kf) => kf.time), [1.0, 4.0, 7.0])).toBe(true);

    const out = tmpPath.div("stretched.aep");
    app.project.save(out);

    const app2 = parseAppFresh(out);
    const op2 = asInstance(asInstance(app2.project.compositions[0].layers[0].property("Transform"), py_aep.PropertyGroup).property("Opacity"), py_aep.Property);
    expect(approx(op2.keyframes.map((kf) => kf.time), [1.0, 4.0, 7.0])).toBe(true);
  });

  test("test_ticks_are_layer_time", () => {
    /** A 150 % layer stores half as many ticks per composition second. */
    const app = py_aep.new();
    const comp = app.project.rootFolder.addComp("C", 320, 240, 1.0, 40.0, 24.0);
    const [_layer, op] = _opacityWithKeys(comp, 150.0);

    // comp second 1 -> layer second 1/1.5, at 36864 units per layer second
    expect(op.keyframes[0]._ldatItem.timeUnits).toBe(24576);
  });

  test("test_ae_authored_stretched_layer_reads_back", () => {
    /** `layer_timing.aep` is AE-authored and carries a 200 % layer. */
    const app = parseAppFresh(LAYER_DIR.div("layer_timing.aep"));
    const comp = app.project.compositions.find((c) => c.name === "stretch_200");
    if (comp === undefined) throw new AssertionError_("no composition named stretch_200");
    const layer = comp.layers[0];
    expect(layer.stretch).toBe(200.0);

    const want = comp._cdta.internalTimebase * 2;
    const bases = new Set<number>();
    for (const prop of layer) {
      if (
        prop instanceof py_aep.Property &&
        getattr(prop, "_tdb4", null) != null &&
        !prop._tdbs.synthetic &&
        prop._tdb4._timeBase
      ) {
        bases.add(prop._tdb4._timeBase);
      }
    }
    expect(pyEq(bases, new Set([want]))).toBe(true);
  });
});

describe("TestStretchRetimesKeyframes", () => {
  /**
   * AE holds a keyframe at the same LAYER time across a stretch change and
   * rescales the stored counts: keys at layer-seconds 1 and 5 on a 24 fps comp
   * hold 24576 / 122880 ticks, and 49152 / 245760 against a tdb4 of 49152 once
   * the layer is stretched to 200 % - composition seconds 2 and 10.
   */

  function _animated(fps = 24.0): [py_aep.Application, py_aep.AVLayer, py_aep.Property<number>] {
    const app = py_aep.new();
    const comp = app.project.rootFolder.addComp("C", 320, 240, 1.0, 40.0, fps);
    const layer = comp.addSolid([1, 1, 1], "L", 320, 240, 1.0);
    const op = asInstance(asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("Opacity"), py_aep.Property);
    op.setValueAtTime(1.0, 0.0);
    op.setValueAtTime(5.0, 100.0);
    return [app, layer, op];
  }

  test("test_ticks_and_timebase_match_after_effects", () => {
    const [_app, layer, op] = _animated();
    expect(pyEq(op.keyframes.map((kf) => kf._ldatItem.timeUnits), [24576, 122880])).toBe(true);

    layer.stretch = 200.0;

    expect(op._tdb4._timeBase).toBe(49152);
    expect(pyEq(op.keyframes.map((kf) => kf._ldatItem.timeUnits), [49152, 245760])).toBe(true);
    expect(approx(op.keyframes.map((kf) => kf.time), [2.0, 10.0])).toBe(true);
  });

  test("test_stretching_back_restores_the_times", () => {
    const [_app, layer, op] = _animated();
    layer.stretch = 200.0;
    layer.stretch = 100.0;

    expect(approx(op.keyframes.map((kf) => kf.time), [1.0, 5.0])).toBe(true);
  });

  test("test_survives_a_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const [app, layer, op] = _animated();
    layer.stretch = 200.0;

    const out = tmpPath.div("stretched.aep");
    app.project.save(out);

    const op2 = asInstance(asInstance(parseAppFresh(out).project.compositions[0].layers[0].property("Transform"), py_aep.PropertyGroup).property("Opacity"), py_aep.Property);
    expect(approx(op2.keyframes.map((kf) => kf.time), [2.0, 10.0])).toBe(true);
    expect(pyEq(op2.keyframes.map((kf) => kf._ldatItem.timeUnits), [49152, 245760])).toBe(true);
  });
});

describe("TestNegativeStretchOffset", () => {
  /**
   * A reversed layer starts a hair before its nominal start. AE 2026 offsets
   * it by `|stretch| / 100 / 3000` seconds - measured at -50 / -100 / -150 /
   * -200 % and 24 / 25 / 30 fps, twelve readings, all matching and frame-rate
   * independent. Keys authored at layer-seconds 1 and 4, startTime 0:
   *
   *     -50 %  -> -0.5001667 / -2.0001667
   *     -100 % -> -1.0003333 / -4.0003333
   *     -150 % -> -1.5005000 / -6.0005000
   *     -200 % -> -2.0006667 / -8.0006667
   */

  const AE = new Map<number, number[]>([
    [-50.0, [-0.5001667, -2.0001667]],
    [-100.0, [-1.0003333, -4.0003333]],
    [-150.0, [-1.5005, -6.0005]],
    [-200.0, [-2.0006667, -8.0006667]],
  ]);

  const rows: [number, number][] = [24.0, 25.0, 30.0].flatMap((fps) =>
    [-50.0, -100.0, -150.0, -200.0].map((stretch): [number, number] => [stretch, fps]),
  );

  test.each(rows)("test_key_times_match_after_effects[%#]", (stretch: number, fps: number) => {
    const app = py_aep.new();
    const comp = app.project.rootFolder.addComp("C", 320, 240, 1.0, 60.0, fps);
    const layer = comp.addSolid([1, 1, 1], "L", 320, 240, 1.0);
    const op = asInstance(asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("Opacity"), py_aep.Property);
    // Author while unstretched so the ticks land on layer-seconds 1 and 4,
    // then reverse - the order AE's probe used.
    op.setValueAtTime(1.0, 10.0);
    op.setValueAtTime(4.0, 90.0);
    layer.stretch = stretch;

    const got = op.keyframes.map((kf) => kf.time);
    expect(approx(got, getitem(AE, stretch), { abs: 1e-6 })).toBe(true);
  });

  test("test_positive_stretch_has_no_offset", () => {
    const app = py_aep.new();
    const comp = app.project.rootFolder.addComp("C", 320, 240, 1.0, 60.0, 24.0);
    const layer = comp.addSolid([1, 1, 1], "L", 320, 240, 1.0);
    const op = asInstance(asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("Opacity"), py_aep.Property);
    op.setValueAtTime(1.0, 10.0);
    op.setValueAtTime(4.0, 90.0);
    layer.stretch = 150.0;

    expect(approx(op.keyframes.map((kf) => kf.time), [1.5, 6.0])).toBe(true);
  });
});

describe("TestValueAtTimeRejectsNaN", () => {
  /**
   * AE 2026: `valueAtTime(NaN)` throws "NaN is not a number"; infinity is
   * accepted and evaluates to the last keyframe.
   */

  function _animated(): py_aep.Property<number> {
    const app = py_aep.new();
    const comp = app.project.rootFolder.addComp("C", 200, 200, 1.0, 10.0, 24.0);
    const layer = comp.addSolid([1, 0, 0], "L", 100, 100, 1.0);
    const op = asInstance(asInstance(layer.property("Transform"), py_aep.PropertyGroup).property("Opacity"), py_aep.Property);
    op.setValueAtTime(0.0, 0.0);
    op.setValueAtTime(2.0, 100.0);
    return op;
  }

  test("test_nan_raises", () => {
    const op = _animated();
    raises(ValueError, () => op.valueAtTime(float("nan")), "NaN");
  });

  test("test_infinity_still_evaluates", () => {
    const op = _animated();
    expect(approx(op.valueAtTime(float("inf")), 100.0)).toBe(true);
  });
});
