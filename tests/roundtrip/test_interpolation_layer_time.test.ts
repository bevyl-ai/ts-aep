/**
 * Issue #225 review findings: keyframe evaluation in the layer's own time.
 *
 * After Effects evaluates a temporal bezier in LAYER time - its ease speeds are
 * per layer second, and a negatively stretched layer's keyframes only ascend on
 * that axis. Evaluating in composition time instead put every stretched layer's
 * curve off by the stretch factor and stopped a reversed layer interpolating at
 * all.
 *
 * Every expected number was measured in After Effects 2026 through `valueAtTime`
 * (or, for the roving times, AE's own placement of the same geometry). AE's
 * sampling is quoted in the docstrings so a future change can be judged against
 * it rather than against py's current output. The probes that produced them are
 * `scripts/jsx/stretch_ease_probe*.jsx`.
 */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { KeyframeEase, KeyframeInterpolationType } from "../../src/py_aep/index.ts";
import { as_instance, parse_app_fresh } from "../helpers.ts";
import type { Application } from "../../src/py_aep/index.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { max, min, py_eq, range, sorted } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path } from "../../src/pyrt/pytest.ts";

function _new_comp(width = 200, height = 200, fps = 24.0): [Application, CompItem] {
  const app = py_aep.new();
  const comp = app.project.root_folder.add_comp("C", width, height, 1.0, 10.0, fps);
  return [app, comp];
}

function _bezier_both_sides(prop: Property): void {
  for (const kf of prop.keyframes) {
    kf.in_interpolation_type = KeyframeInterpolationType.BEZIER;
    kf.out_interpolation_type = KeyframeInterpolationType.BEZIER;
  }
}

function _shape_fill_colour(comp: CompItem): Property {
  const layer = comp.add_shape();
  const contents = as_instance(layer.property("Contents"), PropertyGroup).add_property("ADBE Vector Group");
  const inner = as_instance(contents.property("Contents"), PropertyGroup);
  inner.add_property("ADBE Vector Shape - Ellipse");
  return as_instance(inner.add_property("ADBE Vector Graphic - Fill").property("Color"), Property);
}

/**
 * The ease maths ran in composition time while the stored speeds are per
 * layer second, so a stretched layer's curve was off by the stretch factor
 * even though both endpoints landed exactly.
 *
 * AE 2026, Opacity 0 -> 100 authored at comp 0/2 with out ease 60/50 and in
 * ease 20/75, then stretched: the same animation played slower or faster, so
 * normalized to the key span the curve is identical at every stretch.
 */
class TestStretchedLayerEaseTimeBase {
  /** AE 2026 at 200 % - the keys move to comp 0 and 4. */
  static AE_200 = new Map<number, number>([
    [0.0, 0.0],
    [1.0, 34.766915],
    [2.0, 72.382043],
    [3.0, 88.941757],
    [4.0, 100.0],
  ]);
  /** AE 2026 at 50 % - the keys move to comp 0 and 1. */
  static AE_050 = new Map<number, number>([
    [0.0, 0.0],
    [0.25, 34.766915],
    [0.5, 72.382043],
    [0.75, 88.941757],
    [1.0, 100.0],
  ]);

  _build(stretch: number): [Application, Property] {
    const [app, comp] = _new_comp();
    const layer = comp.add_solid([1, 0, 0], "L", 100, 100, 1.0);
    const opacity = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Opacity"), Property);
    opacity.set_value_at_time(0.0, 0.0);
    opacity.set_value_at_time(2.0, 100.0);
    _bezier_both_sides(opacity);
    opacity.keyframes[0].out_temporal_ease = [
      new KeyframeEase(60.0, 50.0),
    ];
    opacity.keyframes[1].in_temporal_ease = [
      new KeyframeEase(20.0, 75.0),
    ];
    layer.stretch = stretch;
    return [app, opacity];
  }
}

/**
 * A reversed layer's keyframes descend in composition time, so both
 * boundary guards fired and the segment search was never reached: the layer
 * held one value, jumped, and held the other.
 *
 * AE 2026, three LINEAR Opacity keys authored at comp 1/4/7 with values
 * 0/50/100 on a -150 % layer. AE indexes them in layer order, so
 * `keyValue(1)` is the value-100 key sitting at comp 7.
 */
class TestNegativeStretchInterpolates {
  static AE = new Map<number, number>([
    [0.0, 0.0],
    [1.0, 0.0],
    [2.5, 25.0],
    [4.0, 50.0],
    [5.5, 75.0],
    [7.0, 100.0],
    [8.0, 100.0],
  ]);

  _build(): [Application, Property] {
    const [app, comp] = _new_comp();
    const layer = comp.add_solid([1, 0, 0], "L", 100, 100, 1.0);
    layer.stretch = -150.0;
    const opacity = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Opacity"), Property);
    opacity.set_value_at_time(1.0, 0.0);
    opacity.set_value_at_time(4.0, 50.0);
    opacity.set_value_at_time(7.0, 100.0);
    return [app, opacity];
  }
}

/**
 * A LINEAR out side on a non-spatial property fell through to a straight
 * lerp, discarding the NEXT key's in-side ease.
 *
 * AE stores a LINEAR side as a diagonal handle - speed equal to the chord
 * slope, influence 100/6 - so the ordinary bezier path reproduces it.
 *
 * AE 2026, Opacity 0 -> 100 over comp 0..2 with key 1 LINEAR out and key 2
 * BEZIER in at speed 0, influence 90.
 */
class TestLinearOutSideKeepsTheNextEase {
  static AE = new Map<number, number>([
    [0.0, 0.0],
    [0.5, 60.869573],
    [1.0, 87.520715],
    [1.5, 97.481984],
    [2.0, 100.0],
  ]);
}

/**
 * A LINEAR side's synthesized speed was the chord slope per COMPOSITION
 * second, where AE stores it per layer second.
 *
 * AE 2026 reads 25 %/s back from three keys at comp 1/4/7 (values 0/50/100)
 * on a 150 % layer - the span is 2 layer seconds, not 3 composition ones -
 * and -25 %/s on a -150 % layer, where layer time runs backwards.
 */
class TestLinearEaseSpeedIsLayerTime {}

/**
 * Roving times are derived in layer time but were written through a
 * composition-time conversion, scaling the run by the stretch factor: on a
 * 200 % layer a roving key was written PAST its own end anchor, which
 * re-sorted the property and stranded the roving flags.
 *
 * AE 2026 authoring the same geometry - four Position keys at comp 0/2/4/6
 * on a 200 % layer, anchors eased 120/40 and 80/65, middle two roving -
 * places the roving keys at 1.982869 and 2.956299.
 */
class TestRovingRedistributionUnderStretch {
  static AE_ROVING_TIMES = [1.982869, 2.956299];

  _build(stretch: number): [Application, Property] {
    const [app, comp] = _new_comp(400, 400);
    const layer = comp.add_solid([1, 0, 0], "L", 100, 100, 1.0);
    layer.stretch = stretch;
    const position = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Position"), Property);
    const keys: [number, number[]][] = [
      [0.0, [50.0, 50.0, 0.0]],
      [2.0, [120.0, 250.0, 0.0]],
      [4.0, [260.0, 260.0, 0.0]],
      [6.0, [350.0, 60.0, 0.0]],
    ];
    for (const [time, value] of keys) {
      position.set_value_at_time(time, value);
    }
    _bezier_both_sides(position);
    position.keyframes[0].out_temporal_ease = [
      new KeyframeEase(120.0, 40.0),
    ];
    position.keyframes[3].in_temporal_ease = [
      new KeyframeEase(80.0, 65.0),
    ];
    return [app, position];
  }
}

/**
 * The absolute ease handles made a 2-D layer's Scale Z bow, where AE
 * holds it flat. AE will not even STORE a Z other than 100 on a 2-D layer,
 * so both keys always agree there; the third dimension only moves once the
 * layer is 3-D.
 *
 * AE 2026, Scale X 100 -> 200 with Y and Z constant at 100, out ease 60/50
 * and in ease 20/75.
 */
class TestInertScaleDimension {
  /** AE 2026 on a 2-D layer: X and Y bow, Z is pinned. */
  static AE_2D = new Map<number, number[]>([
    [0.5, [134.766915, 120.935113, 100.0]],
    [1.0, [172.382043, 101.423655, 100.0]],
    [1.5, [188.941757, 93.764502, 100.0]],
  ]);

  _build(three_d: boolean): Property {
    const [_app, comp] = _new_comp(400, 400);
    const layer = comp.add_solid([1, 0, 0], "L", 100, 100, 1.0);
    layer.three_d_layer = three_d;
    const scale = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Scale"), Property);
    scale.set_value_at_time(0.0, [100.0, 100.0, 100.0]);
    scale.set_value_at_time(2.0, [200.0, 100.0, 100.0]);
    _bezier_both_sides(scale);
    scale.keyframes[0].out_temporal_ease = Array<KeyframeEase>(3).fill(
      new KeyframeEase(60.0, 50.0),
    );
    scale.keyframes[1].in_temporal_ease = Array<KeyframeEase>(3).fill(
      new KeyframeEase(20.0, 75.0),
    );
    return scale;
  }
}

/**
 * A colour stores ONE ease and AE drives every channel with a single
 * progress taken from the influences alone. Running a bezier per channel
 * bowed the unchanged channels out of gamut - green read -0.0078 on a
 * segment holding green at 0 in both keys.
 *
 * AE 2026, a shape Fill colour red -> blue with out ease 0.5/45 and in ease
 * 0.2/70: green and alpha stay exact, and red + blue always sum to 1.
 */
class TestColourUsesOneSharedProgress {
  static AE = new Map<number, number[]>([
    [0.5, [0.839653, 0.0, 0.160347, 1.0]],
    [1.0, [0.307084, 0.0, 0.692916, 1.0]],
    [1.5, [0.054479, 0.0, 0.945521, 1.0]],
  ]);

  _build(): Property {
    const [_app, comp] = _new_comp(400, 400);
    const colour = _shape_fill_colour(comp);
    colour.set_value_at_time(0.0, [1.0, 0.0, 0.0, 1.0]);
    colour.set_value_at_time(2.0, [0.0, 0.0, 1.0, 1.0]);
    colour.keyframes[0].out_temporal_ease = [
      new KeyframeEase(0.5, 45.0),
    ];
    colour.keyframes[1].in_temporal_ease = [
      new KeyframeEase(0.2, 70.0),
    ];
    _bezier_both_sides(colour);
    return colour;
  }
}

describe("TestStretchedLayerEaseTimeBase", () => {
  const self = new TestStretchedLayerEaseTimeBase();

  // ids: stretch_200, stretch_050
  test.each([
    [200.0, TestStretchedLayerEaseTimeBase.AE_200],
    [50.0, TestStretchedLayerEaseTimeBase.AE_050],
  ])("test_matches_after_effects[%#]", (stretch, expected) => {
    const [_app, opacity] = self._build(stretch);
    for (const [time, value] of expected.entries()) {
      expect(approx(opacity.value_at_time(time), value, { abs: 1e-3 })).toBe(true);
    }
  });

  test("test_unstretched_curve_is_unchanged", () => {
    const [_app, opacity] = self._build(100.0);
    // The 200 % readings, on the half-length span.
    for (const [time, value] of TestStretchedLayerEaseTimeBase.AE_050.entries()) {
      expect(approx(opacity.value_at_time(time * 2.0), value, { abs: 1e-3 })).toBe(true);
    }
  });

  test("test_survives_a_save_and_reparse", () => {
    const tmp_path = make_tmp_path();
    const [app, _opacity] = self._build(200.0);
    const path = tmp_path.div("stretched.aep");
    app.project.save(path);

    const opacity = as_instance(
      as_instance(parse_app_fresh(path).project.compositions[0].layers[0].property("Transform"), PropertyGroup).property("Opacity"),
      Property,
    );
    for (const [time, value] of TestStretchedLayerEaseTimeBase.AE_200.entries()) {
      expect(approx(opacity.value_at_time(time), value, { abs: 1e-3 })).toBe(true);
    }
  });
});

describe("TestNegativeStretchInterpolates", () => {
  const self = new TestNegativeStretchInterpolates();

  test("test_keyframe_index_order_follows_the_layer", () => {
    const [_app, opacity] = self._build();
    expect(
      approx(
        opacity.keyframes.map((kf) => kf.time),
        [7.0, 4.0, 1.0],
        { abs: 1e-4 },
      ),
    ).toBe(true);
    expect(py_eq(opacity.keyframes.map((kf) => kf.value), [100.0, 50.0, 0.0])).toBe(true);
  });

  test("test_interpolates_across_the_reversed_span", () => {
    const [_app, opacity] = self._build();
    for (const [time, value] of TestNegativeStretchInterpolates.AE.entries()) {
      expect(approx(opacity.value_at_time(time), value, { abs: 1e-3 })).toBe(true);
    }
  });
});

describe("TestLinearOutSideKeepsTheNextEase", () => {
  const self = new TestLinearOutSideKeepsTheNextEase();

  test("test_matches_after_effects", () => {
    const [_app, comp] = _new_comp();
    const layer = comp.add_solid([1, 0, 0], "L", 100, 100, 1.0);
    const opacity = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Opacity"), Property);
    opacity.set_value_at_time(0.0, 0.0);
    opacity.set_value_at_time(2.0, 100.0);
    opacity.keyframes[1].in_interpolation_type = KeyframeInterpolationType.BEZIER;
    opacity.keyframes[1].in_temporal_ease = [
      new KeyframeEase(0.0, 90.0),
    ];
    opacity.keyframes[0].out_interpolation_type = KeyframeInterpolationType.LINEAR;

    for (const [time, value] of TestLinearOutSideKeepsTheNextEase.AE.entries()) {
      expect(approx(opacity.value_at_time(time), value, { abs: 1e-3 })).toBe(true);
    }
  });

  /**
   * The case where two defects used to cancel.
   *
   * A LINEAR/LINEAR segment on a stretched layer read correctly only
   * because the lerp shortcut hid the comp-time ease maths. With the
   * shortcut gone the stretch fix has to carry it: AE 2026 reads
   * 0/25/50/75/100 at comp 0..4 for keys authored at comp 0/2 on a
   * layer then stretched to 200 %.
   */
  test("test_linear_on_both_sides_is_still_a_straight_line", () => {
    const [_app, comp] = _new_comp();
    const layer = comp.add_solid([1, 0, 0], "L", 100, 100, 1.0);
    const opacity = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Opacity"), Property);
    opacity.set_value_at_time(0.0, 0.0);
    opacity.set_value_at_time(2.0, 100.0);
    layer.stretch = 200.0;

    expect(approx(opacity.keyframes.map((kf) => kf.time), [0.0, 4.0])).toBe(true);
    for (const seconds of range(5)) {
      expect(approx(opacity.value_at_time(seconds), seconds * 25.0, { abs: 1e-3 })).toBe(true);
    }
  });
});

describe("TestLinearEaseSpeedIsLayerTime", () => {
  /**
   * AE 2026 reads 25 %/s back from three keys at comp 1/4/7 (values 0/50/100)
   * on a 150 % layer - the span is 2 layer seconds, not 3 composition ones -
   * and -25 %/s on a -150 % layer, where layer time runs backwards.
   */
  test.each([
    [100.0, 16.666667],
    [150.0, 25.0],
    [-150.0, -25.0],
  ])("test_speed_is_per_layer_second[%#]", (stretch, expected) => {
    const [_app, comp] = _new_comp();
    const layer = comp.add_solid([1, 0, 0], "L", 100, 100, 1.0);
    layer.stretch = stretch;
    const opacity = as_instance(as_instance(layer.property("Transform"), PropertyGroup).property("Opacity"), Property);
    opacity.set_value_at_time(1.0, 0.0);
    opacity.set_value_at_time(4.0, 50.0);
    opacity.set_value_at_time(7.0, 100.0);

    const middle = opacity.keyframes[1];
    expect(approx(middle.out_temporal_ease[0].speed, expected, { abs: 1e-3 })).toBe(true);
    expect(approx(middle.in_temporal_ease[0].speed, expected, { abs: 1e-3 })).toBe(true);
  });
});

describe("TestRovingRedistributionUnderStretch", () => {
  const self = new TestRovingRedistributionUnderStretch();

  test("test_matches_after_effects_on_a_stretched_layer", () => {
    const [_app, position] = self._build(200.0);
    position.keyframes[1].roving = true;
    position.keyframes[2].roving = true;

    const times = position.keyframes.map((kf) => kf.time);
    expect(approx(times[0], 0.0)).toBe(true);
    expect(approx(times[3], 6.0)).toBe(true);
    expect(approx(times.slice(1, 3), TestRovingRedistributionUnderStretch.AE_ROVING_TIMES, { abs: 1e-4 })).toBe(true);
  });

  // The stretch rows, each run through the same roving assertions.
  test.each([100.0, 200.0, 50.0, -150.0])(
    "test_roving_keys_stay_inside_their_run[%#]",
    (stretch) => {
      const [_app, position] = self._build(stretch);
      const anchors = [position.keyframes[0].time, position.keyframes[3].time];
      position.keyframes[1].roving = true;
      position.keyframes[2].roving = true;

      expect(py_eq(position.keyframes.map((kf) => kf.roving), [false, true, true, false])).toBe(true);
      const low = min(anchors);
      const high = max(anchors);
      expect(
        position.keyframes.slice(1, 3).every((kf) => low <= kf.time && kf.time <= high),
      ).toBe(true);
      const layer_times = position.keyframes.map((kf) => kf._layer_time);
      expect(py_eq(layer_times, sorted(layer_times))).toBe(true);
    },
  );

  test("test_redistribution_persists_through_a_save", () => {
    const tmp_path = make_tmp_path();
    const [app, position] = self._build(200.0);
    position.keyframes[1].roving = true;
    position.keyframes[2].roving = true;
    const path = tmp_path.div("roving.aep");
    app.project.save(path);

    const reparsed = as_instance(
      as_instance(parse_app_fresh(path).project.compositions[0].layers[0].property("Transform"), PropertyGroup).property("Position"),
      Property,
    );
    expect(
      approx(
        reparsed.keyframes.map((kf) => kf.time).slice(1, 3),
        TestRovingRedistributionUnderStretch.AE_ROVING_TIMES,
        { abs: 1e-4 },
      ),
    ).toBe(true);
  });
});

describe("TestInertScaleDimension", () => {
  const self = new TestInertScaleDimension();

  test("test_two_d_layer_holds_z", () => {
    const scale = self._build(false);
    for (const [time, value] of TestInertScaleDimension.AE_2D.entries()) {
      expect(approx(scale.value_at_time(time), value, { abs: 1e-3 })).toBe(true);
    }
  });

  test("test_three_d_layer_bows_z_like_a_live_dimension", () => {
    const scale = self._build(true);
    const value = scale.value_at_time(1.0);
    // AE 2026: with Z live it tracks Y exactly, both keys holding 100.
    expect(approx(value[2], value[1], { abs: 1e-6 })).toBe(true);
    expect(approx(value[2], 101.423655, { abs: 1e-3 })).toBe(true);
  });
});

describe("TestColourUsesOneSharedProgress", () => {
  const self = new TestColourUsesOneSharedProgress();

  test("test_matches_after_effects", () => {
    const colour = self._build();
    for (const [time, value] of TestColourUsesOneSharedProgress.AE.entries()) {
      expect(approx(colour.value_at_time(time), value, { abs: 1e-3 })).toBe(true);
    }
  });

  test("test_constant_channels_stay_in_gamut", () => {
    const colour = self._build();
    for (const frame of range(49)) {
      const channels = colour.value_at_time(frame / 24.0);
      expect(approx(channels[1], 0.0, { abs: 1e-6 })).toBe(true);
      expect(approx(channels[3], 1.0, { abs: 1e-6 })).toBe(true);
      expect(channels.every((channel: number) => 0.0 <= channel && channel <= 1.0)).toBe(true);
    }
  });
});
