/**
 * Tests for keyframe mutation: add_key, remove_key, set_value(s)_at_time(s),
 * Shape creation from scratch, and numeric keyframe value persistence.
 *
 * Mutation tests parse a fresh (uncached) copy so changes do not leak between
 * tests, and assert results survive a save / re-parse round-trip.
 */

import { describe, expect, test } from "bun:test";
import {
  AssertionError_,
  BytesIO,
  at,
  contains,
  getattr,
  getitem,
  hasattr,
  len,
  Path,
  pyBool,
  pyEq,
  pyAssert,
  pySlice,
  sorted,
  StopIteration,
  ValueError,
} from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import type { Application } from "../../src/py_aep/index.ts";
import { writeAep } from "../../src/py_aep/binary/chunk.ts";
import "../../src/py_aep/binary/_register.ts";
import { KeyframeInterpolationType } from "../../src/py_aep/enums/index.ts";
import { KeyframeEase } from "../../src/py_aep/models/properties/keyframe_ease.ts";
import type { PropertyValue } from "../../src/py_aep/models/properties/keyframe.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import type { PropertyBase } from "../../src/py_aep/models/properties/property_base.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { Shape } from "../../src/py_aep/models/properties/shape.ts";
import { MarkerValue } from "../../src/py_aep/models/properties/marker.ts";
import { Gradient } from "../../src/py_aep/models/properties/gradient.ts";
import { TextDocument } from "../../src/py_aep/models/text/text_document.ts";
import { asInstance, getComp, parseProjectFresh } from "../helpers.ts";
import { KfMultiDimensional, KfPosition } from "../../src/py_aep/binary/ldat_chunks.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");
const SAMPLES_ROOT = new Path(import.meta.path).parent.parent.parent.div("samples");

function _fresh(name: string): Application {
  return parseAep(SAMPLES.div(name));
}

function _roundtrip(app: Application, tmpPath: Path): Application {
  const out = tmpPath.div("out.aep");
  // `with out.open("wb") as f:` - serialize to memory, then write the file in one go.
  const f = new BytesIO();
  writeAep(f, app.project._rifx, app.project._xmp);
  out.writeBytes(f.getvalue());
  return parseAep(out);
}

function _prop(app: Application, matchName: string, kw: { comp?: number; layer?: number } = {}): Property {
  const { comp = 0, layer = 0 } = kw;
  const lay = app.project.compositions[comp].layers[layer];
  const found = [...lay.transform].find((p) => p.matchName === matchName);
  if (found === undefined) throw new StopIteration();
  return asInstance(found, Property);
}

/** Compare two lists of [x, y] pairs within tolerance. */
function _approxPoints(actual: number[][], expected: number[][], absTol = 1e-2): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((a, i) => approx(a, expected[i], { abs: absTol }));
}

function _findStatic(app: Application, matchName: string): [Property | null, number | null, number | null] {
  for (const [ci, comp] of app.project.compositions.entries()) {
    for (const [li, lay] of comp.layers.entries()) {
      for (const p of lay.transform) {
        if (p.matchName !== matchName) continue;
        const prop = asInstance(p, Property);
        if (!pyBool(prop.keyframes)) return [prop, ci, li];
      }
    }
  }
  return [null, null, null];
}

function _walk(group: PropertyGroup, matchName: string, out: Property[]): void {
  for (const p of getattr(group, "properties", [])) {
    if (p.matchName === matchName) out.push(asInstance(p, Property));
    if (hasattr(p, "properties")) _walk(asInstance(p, PropertyGroup), matchName, out);
  }
}

function _gradKfProp(app: Application): Property<Gradient> | null {
  for (const comp of app.project.compositions) {
    for (const layer of comp.layers) {
      const out: Property[] = [];
      _walk(layer, "ADBE Vector Grad Colors", out);
      for (const p of out) {
        if (pyBool(p.keyframes)) return p;
      }
    }
  }
  return null;
}

function _orientationKfProp(app: Application): Property<number[]> | null {
  for (const comp of app.project.compositions) {
    for (const layer of comp.layers) {
      const out: Property[] = [];
      _walk(layer, "ADBE Orientation", out);
      for (const p of out) {
        if (pyBool(p.keyframes)) return p;
      }
    }
  }
  return null;
}

function _textStaticProp(app: Application): Property<TextDocument> | null {
  for (const comp of app.project.compositions) {
    for (const layer of comp.layers) {
      const out: Property[] = [];
      _walk(layer, "ADBE Text Document", out);
      for (const p of out) {
        if (!pyBool(p.keyframes)) return p;
      }
    }
  }
  return null;
}

function _gradStaticProp(app: Application): Property<Gradient> | null {
  for (const comp of app.project.compositions) {
    for (const layer of comp.layers) {
      const out: Property[] = [];
      _walk(layer, "ADBE Vector Grad Colors", out);
      for (const p of out) {
        if (!pyBool(p.keyframes)) return p;
      }
    }
  }
  return null;
}

describe("TestKeyframeValuePersistence", () => {
  test("test_1d_value_roundtrips", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("keyframe_HOLD.aep");
    _prop(app, "ADBE Opacity").keyframes[0].value = 42.0;
    const app2 = _roundtrip(app, tmpPath);
    expect(approx(_prop(app2, "ADBE Opacity").keyframes[0].value, 42.0)).toBe(true);
  });

  test("test_multidim_value_roundtrips", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("keyframe_LINEAR.aep");
    const pos = _prop(app, "ADBE Position");
    const posValue = pos.keyframes[0].value;
    if (!Array.isArray(posValue)) throw new AssertionError_("ADBE Position keyframe value is not a list");
    const v = [...posValue];
    v[0] += 7.0;
    pos.keyframes[0].value = v;
    const app2 = _roundtrip(app, tmpPath);
    const pos2Value = _prop(app2, "ADBE Position").keyframes[0].value;
    if (!Array.isArray(pos2Value)) throw new AssertionError_("ADBE Position keyframe value is not a list");
    expect(approx(pos2Value[0], v[0])).toBe(true);
  });
});

describe("TestAddKey", () => {
  test("test_add_key_to_animated", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const n0 = op.keyframes.length;
    const idx = op.addKey(0.5);
    expect(op.keyframes.length).toBe(n0 + 1);
    expect(0 <= idx && idx <= n0).toBe(true);
    const app2 = _roundtrip(app, tmpPath);
    expect(_prop(app2, "ADBE Opacity").keyframes.length).toBe(n0 + 1);
  });

  test("test_out_of_range_time_leaves_the_property_untouched", () => {
    // Issue #228: the tick conversion overflows the 32-bit time field,
    // and animating before converting left the property marked animated
    // with no keyframes and its static value discarded.
    const app = _fresh("2_gaussian.aep");
    const op = _prop(app, "ADBE Opacity");
    expect(pyBool(op.keyframes)).toBe(false);
    const before = op.value;

    raises(ValueError, () => {
      op.addKey(1e9);
    }, "32-bit keyframe time field");

    expect(pyBool(op.keyframes)).toBe(false);
    expect(pyEq(op.value, before)).toBe(true);

    // ... and the property still animates normally afterwards.
    op.addKey(1.0);
    expect(op.keyframes.length).toBe(1);
  });

  test("test_add_key_returns_existing_index_at_same_time", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const n0 = op.keyframes.length;
    const existingTime = op.keyframes[0].time;
    const idx = op.addKey(existingTime);
    expect(idx).toBe(0);
    expect(op.keyframes.length).toBe(n0);
  });

  test("test_first_key_animates_static_property", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("keyframe_HOLD.aep");
    const [prop, _, li] = _findStatic(app, "ADBE Rotate Z");
    expect(prop != null).toBe(true);
    if (prop == null || li == null) throw new AssertionError_("no static ADBE Rotate Z property");
    prop.addKey(0.0);
    prop.addKey(1.0);
    prop.keyframes[1].value = 25.0;
    expect(prop._animated).toBe(true);
    expect(prop.keyframes.length).toBe(2);
    const app2 = _roundtrip(app, tmpPath);
    const prop2 = asInstance([...app2.project.compositions[0].layers[li].transform].find((p) => p.matchName === "ADBE Rotate Z"), Property);
    expect(prop2.keyframes.length).toBe(2);
    expect(approx(prop2.keyframes[1].value, 25.0)).toBe(true);
  });

  /**
   * A synthetic multi-dimensional property (Scale) animates + round-trips.
   *
   * Regression: materializing a synthetic non-spatial vector property
   * must add the tdum/tduM bound chunks and reposition the property
   * into canonical order, or AE rejects the file.
   */
  test("test_synthetic_multidim_property_animates", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("keyframe_HOLD.aep");
    const [scale, _, li] = _findStatic(app, "ADBE Scale");
    expect(scale != null).toBe(true);
    if (scale == null || li == null) throw new AssertionError_("no static ADBE Scale property");
    scale.setValueAtTime(0.0, [50.0, 50.0, 100.0]);
    scale.setValueAtTime(1.0, [120.0, 120.0, 100.0]);
    expect(scale._animated).toBe(true);
    // tdum/tduM bound chunks were added on materialization.
    const kinds = scale._tdbs.chunks.map((c) => getattr(c, "chunk_type", null));
    expect(kinds.includes("tdum") && kinds.includes("tduM")).toBe(true);
    const app2 = _roundtrip(app, tmpPath);
    const scale2 = asInstance([...app2.project.compositions[0].layers[li].transform].find((p) => p.matchName === "ADBE Scale"), Property);
    expect(scale2.keyframes.length).toBe(2);
  });

  test("test_keys_stay_time_sorted", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    op.addKey(0.5);
    op.addKey(0.1);
    const times = op.keyframes.map((kf) => kf.frameTime);
    expect(pyEq(times, sorted(times))).toBe(true);
  });

  test("test_add_key_no_value_property_raises", () => {
    // A numeric property with no value slot cannot be keyframed; building
    // a numeric keyframe item for it would produce a wrong-size ldat item.
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    // `op.__dict__["_noValue"] = True` - instance attribute write.
    op._noValue = true;
    raises(ValueError, () => {
      op.addKey(0.5);
    });
  });
});

describe("TestRemoveKey", () => {
  test("test_remove_middle_key", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const n0 = op.keyframes.length;
    op.removeKey(1);
    expect(op.keyframes.length).toBe(n0 - 1);
    const app2 = _roundtrip(app, tmpPath);
    expect(_prop(app2, "ADBE Opacity").keyframes.length).toBe(n0 - 1);
  });

  test("test_remove_last_key_deanimates", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const lastVal = op.keyframes[0].value;
    while (pyBool(op.keyframes)) {
      op.removeKey(0);
    }
    expect(op._animated).toBe(false);
    const app2 = _roundtrip(app, tmpPath);
    const op2 = _prop(app2, "ADBE Opacity");
    expect(op2.keyframes.length).toBe(0);
    expect(approx(op2.value, lastVal)).toBe(true);
  });

  test("test_remove_key_out_of_range", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    raises(ValueError, () => {
      op.removeKey(99);
    });
  });
});

/** Writing Keyframe.time / frame_time re-sorts keyframes and chunks. */
describe("TestMoveKeyframe", () => {
  test("test_move_past_neighbour_resorts", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    expect(op.keyframes.length >= 2).toBe(true);
    for (const [i, kf] of op.keyframes.entries()) {
      kf.value = 10.0 * (i + 1);
    }
    const first = op.keyframes[0];
    first.time = at(op.keyframes, -1).time + 1.0;
    expect(op.keyframes.at(-1)).toBe(first);
    const times = op.keyframes.map((kf) => kf.frameTime);
    expect(pyEq(times, sorted(times))).toBe(true);
    // prev/next chain follows the new order.
    expect(first._next == null).toBe(true);
    expect(at(op.keyframes, -2)._next).toBe(first);
    const app2 = _roundtrip(app, tmpPath);
    const op2 = _prop(app2, "ADBE Opacity");
    const times2 = op2.keyframes.map((kf) => kf.frameTime);
    expect(pyEq(times2, sorted(times2))).toBe(true);
    // The moved keyframe's value traveled with it through the save.
    expect(approx(at(op2.keyframes, -1).value, 10.0)).toBe(true);
    expect(approx(op2.keyframes[0].value, 20.0)).toBe(true);
  });

  test("test_move_without_crossing_keeps_position", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const kf = op.keyframes[0];
    kf.frameTime = op.keyframes[1].frameTime - 1;
    expect(op.keyframes[0]).toBe(kf);
    const times = op.keyframes.map((k) => k.frameTime);
    expect(pyEq(times, sorted(times))).toBe(true);
  });

  test("test_move_onto_existing_keyframe_raises", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const original = op.keyframes[0].frameTime;
    raises(
      ValueError,
      () => {
        op.keyframes[0].frameTime = op.keyframes[1].frameTime;
      },
      "already exists",
    );
    // The failed move left the keyframe untouched.
    expect(op.keyframes[0].frameTime).toBe(original);
  });

  test("test_move_marker_key_moves_container_value", () => {
    // Markers keep their values in the parallel Nmrd container, paired
    // by position: the container entry must travel with the keyframe.
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "marker", "layer_marker.aep"));
    const comp = getComp(app.project, "layer_multiple_markers");
    const mp = comp.layers[0].property("ADBE Marker");
    expect(mp.keyframes.length >= 2).toBe(true);
    mp.keyframes[0].value = new MarkerValue("moved");
    mp.keyframes[0].time = at(mp.keyframes, -1).time + 1.0;
    const app2 = _roundtrip(app, tmpPath);
    const mp2 = getComp(app2.project, "layer_multiple_markers").layers[0].property("ADBE Marker");
    const times2 = mp2.keyframes.map((kf) => kf.frameTime);
    expect(pyEq(times2, sorted(times2))).toBe(true);
    expect(at(mp2.keyframes, -1).value.comment).toBe("moved");
    expect(pySlice(mp2.keyframes, null, -1).every((kf) => kf.value.comment !== "moved")).toBe(true);
  });
});

/** Collect every descendant property that has keyframes. */
function _keyframedProps(group: PropertyBase): PropertyBase[] {
  const out: PropertyBase[] = [];
  for (const p of getattr(group, "properties", [])) {
    if (pyBool(getattr(p, "keyframes", null))) out.push(p);
    out.push(..._keyframedProps(p));
  }
  return out;
}

describe("TestRemoveAllKeys", () => {
  test("test_property_reverts_to_first_key_value", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const firstVal = op.keyframes[0].value;
    op.removeAllKeys();
    expect(pyEq(op.keyframes, [])).toBe(true);
    const app2 = _roundtrip(app, tmpPath);
    const op2 = _prop(app2, "ADBE Opacity");
    expect(pyEq(op2.keyframes, [])).toBe(true);
    expect(approx(op2.value, firstVal)).toBe(true);
  });

  test("test_noop_when_no_keyframes", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    op.removeAllKeys();
    op.removeAllKeys();
    expect(pyEq(op.keyframes, [])).toBe(true);
  });

  test("test_layer_remove_all_keys_recursive", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));
    expect(
      app.project.compositions.some((comp) => comp.layers.some((lay) => pyBool(_keyframedProps(lay)))),
    ).toBe(true);
    for (const comp of app.project.compositions) {
      for (const lay of comp.layers) {
        lay.removeAllKeys();
        expect(pyEq(_keyframedProps(lay), [])).toBe(true);
      }
    }
    const app2 = _roundtrip(app, tmpPath);
    for (const comp of app2.project.compositions) {
      for (const lay of comp.layers) {
        expect(pyEq(_keyframedProps(lay), [])).toBe(true);
      }
    }
  });
});

describe("TestSetValueAtTime", () => {
  test("test_replace_existing_key", () => {
    const app = _fresh("keyframe_LINEAR.aep");
    const pos = _prop(app, "ADBE Position");
    const n0 = pos.keyframes.length;
    const t0 = pos.keyframes[0].time;
    const target = [11.0, 22.0, 0.0].slice(0, len(pos.keyframes[0].value));
    pos.setValueAtTime(t0, target);
    expect(pos.keyframes.length).toBe(n0);
    expect(approx(pos.keyframes[0].value, target)).toBe(true);
  });

  test("test_add_new_key", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("keyframe_LINEAR.aep");
    const pos = _prop(app, "ADBE Position");
    const n0 = pos.keyframes.length;
    const t = pos.keyframes[0].time + 0.25;
    const target = [99.0, 88.0, 0.0].slice(0, len(pos.keyframes[0].value));
    pos.setValueAtTime(t, target);
    expect(pos.keyframes.length).toBe(n0 + 1);
    const app2 = _roundtrip(app, tmpPath);
    expect(_prop(app2, "ADBE Position").keyframes.length).toBe(n0 + 1);
  });

  test("test_set_values_at_times", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    op.setValuesAtTimes([0.0, 2.0], [10.0, 90.0]);
    // The value set at each requested time is observable via value_at_time.
    expect(approx(op.valueAtTime(0.0), 10.0)).toBe(true);
    expect(approx(op.valueAtTime(2.0), 90.0)).toBe(true);
  });

  test("test_set_values_at_times_length_mismatch", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    raises(ValueError, () => {
      op.setValuesAtTimes([0.0, 1.0], [10.0]);
    });
  });
});

/** add_key / remove_key / set_value_at_time for complex value types. */
describe("TestComplexTypeKeyframes", () => {
  test("test_orientation", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "layer", "orientation_with_keyframes.aep"));
    const o = _prop(app, "ADBE Orientation");
    const n0 = o.keyframes.length;
    o.setValueAtTime(at(o.keyframes, -1).time + 0.3, [12.0, 34.0, 56.0]);
    expect(o.keyframes.length).toBe(n0 + 1);
    const app2 = _roundtrip(app, tmpPath);
    const o2 = _prop(app2, "ADBE Orientation");
    expect(contains(o2.keyframes.map((k) => k.value), [12.0, 34.0, 56.0])).toBe(true);
    o2.removeKey(0);
    expect(o2.keyframes.length).toBe(n0);
  });

  test("test_marker", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "marker", "layer_marker.aep"));
    const comp = getComp(app.project, "layer_multiple_markers");
    const mp = comp.layers[0].property("ADBE Marker");
    const n0 = mp.keyframes.length;
    mp.setValueAtTime(at(mp.keyframes, -1).time + 1.0, new MarkerValue("X"));
    mp.setValueAtTime(at(mp.keyframes, -1).time + 2.0, "str comment");
    const app2 = _roundtrip(app, tmpPath);
    const comp2 = getComp(app2.project, "layer_multiple_markers");
    const mp2 = comp2.layers[0].property("ADBE Marker");
    const comments = mp2.keyframes.map((k) => k.value.comment);
    expect(comments.includes("X") && comments.includes("str comment")).toBe(true);
    expect(mp2.keyframes.length).toBe(n0 + 2);
  });

  test("test_shape", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));

    function getMs(a: Application): Property<Shape> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let mp: PropertyGroup;
          try {
            mp = layer.property("ADBE Mask Parade");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(mp, "ADBE Mask Shape", out);
          for (const p of out) {
            if (pyBool(p.keyframes)) return p;
          }
        }
      }
      return null;
    }

    const ms = getMs(app);
    pyAssert(ms != null);
    const n0 = ms.keyframes.length;
    ms.setValueAtTime(
      at(ms.keyframes, -1).time + 0.5,
      new Shape([
        [10.0, 10.0],
        [80.0, 10.0],
        [80.0, 80.0],
        [10.0, 80.0],
      ]),
    );
    expect(ms.keyframes.length).toBe(n0 + 1);
    const app2 = _roundtrip(app, tmpPath);
    const ms2 = getMs(app2);
    pyAssert(ms2 != null);
    expect(ms2.keyframes.length).toBe(n0 + 1);
    ms2.removeKey(0);
    expect(ms2.keyframes.length).toBe(n0);
  });

  test("test_gradient", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "gradient_animated.aep"));

    function getGrad(a: Application): Property<Gradient> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let root: PropertyGroup;
          try {
            root = layer.property("ADBE Root Vectors Group");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(root, "ADBE Vector Grad Colors", out);
          for (const p of out) {
            if (pyBool(p.keyframes)) return p;
          }
        }
      }
      return null;
    }

    const g = getGrad(app);
    pyAssert(g != null);
    const n0 = g.keyframes.length;
    g.addKey(g.keyframes[0].time + 0.1);
    expect(g.keyframes.length).toBe(n0 + 1);
    const app2 = _roundtrip(app, tmpPath);
    const g2 = getGrad(app2);
    pyAssert(g2 != null);
    expect(g2.keyframes.length).toBe(n0 + 1);
  });

  test("test_text", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));

    function getText(a: Application): Property<TextDocument> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let tp: PropertyGroup;
          try {
            tp = layer.property("ADBE Text Properties");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(tp, "ADBE Text Document", out);
          for (const p of out) {
            if (pyBool(p.keyframes)) return p;
          }
        }
      }
      return null;
    }

    const t = getText(app);
    pyAssert(t != null);
    const n0 = t.keyframes.length;
    t.setValueAtTime(at(t.keyframes, -1).time + 0.5, "NewLine");
    expect(t.keyframes.length).toBe(n0 + 1);
    const app2 = _roundtrip(app, tmpPath);
    const t2 = getText(app2);
    pyAssert(t2 != null);
    const texts = t2.keyframes.map((k) => k.value.text);
    expect(contains(texts, "NewLine")).toBe(true);
    expect(t2.keyframes.length).toBe(n0 + 1);
    t2.removeKey(0);
    expect(t2.keyframes.length).toBe(n0);
  });

  test("test_added_shape_keyframe_backed_by_own_chunk", () => {
    // Regression: a newly added shape keyframe must wrap its own chunk,
    // not alias the donor keyframe's Shape; otherwise editing the new
    // keyframe's value would write through to the donor's chunk.
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));
    let ms: Property<Shape> | null = null;
    for (const comp of app.project.compositions) {
      for (const layer of comp.layers) {
        let mp: PropertyGroup;
        try {
          mp = layer.property("ADBE Mask Parade");
        } catch (e) {
          continue;
        }
        const out: Property[] = [];
        _walk(mp, "ADBE Mask Shape", out);
        ms = out.find((p) => p.keyframes.length >= 1) ?? null;
        if (ms != null) break;
      }
      if (ms != null) break;
    }
    pyAssert(ms != null);
    const t = at(ms.keyframes, -1).time + 0.5;
    ms.addKey(t);
    const idx = ms.nearestKeyIndex(t);
    const newShph = ms.keyframes[idx].value._shph;
    const others = ms.keyframes.filter((_k, j) => j !== idx).map((k) => k.value._shph);
    expect(others.every((o) => newShph !== o)).toBe(true);
  });

  test("test_remove_last_marker_key", () => {
    // Markers have no static value: removing the last one leaves the
    // valid zero-marker state, and a new marker can be added again.
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "marker", "layer_marker.aep"));
    const comp = getComp(app.project, "layer_multiple_markers");
    const mp = comp.layers[0].property("ADBE Marker");
    while (pyBool(mp.keyframes)) {
      mp.removeKey(0);
    }
    const app2 = _roundtrip(app, tmpPath);
    const comp2 = getComp(app2.project, "layer_multiple_markers");
    const mp2 = comp2.layers[0].property("ADBE Marker");
    expect(pyEq(mp2.keyframes, [])).toBe(true);
    mp2.setValueAtTime(1.0, new MarkerValue("back"));
    const app3 = _roundtrip(app2, tmpPath);
    const comp3 = app3.project.compositions.find((c) => c.name === "layer_multiple_markers");
    if (comp3 === undefined) throw new StopIteration();
    const mp3 = comp3.layers[0].property("ADBE Marker");
    expect(pyEq(mp3.keyframes.map((k) => k.value.comment), ["back"])).toBe(true);
  });

  test("test_remove_last_text_key_reverts_to_static", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));

    function getText(a: Application): Property<TextDocument> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let tp: PropertyGroup;
          try {
            tp = layer.property("ADBE Text Properties");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(tp, "ADBE Text Document", out);
          for (const p of out) {
            if (pyBool(p.keyframes) || p.value != null) return p;
          }
        }
      }
      return null;
    }

    const t = getText(app);
    pyAssert(t != null);
    // The last keyframe removed provides the static value.
    const lastText = at(t.keyframes, -1).value.text;
    while (pyBool(t.keyframes)) {
      t.removeKey(0);
    }
    expect(t.value.text).toBe(lastText);
    const app2 = _roundtrip(app, tmpPath);
    const t2 = getText(app2);
    pyAssert(t2 != null);
    expect(pyEq(t2.keyframes, [])).toBe(true);
    expect(t2.value.text).toBe(lastText);
  });

  test("test_remove_last_shape_key_reverts_to_static", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));

    function getMs(a: Application): Property<Shape> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let mp: PropertyGroup;
          try {
            mp = layer.property("ADBE Mask Parade");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(mp, "ADBE Mask Shape", out);
          for (const p of out) {
            if (pyBool(p.keyframes) || p.value != null) return p;
          }
        }
      }
      return null;
    }

    const ms = getMs(app);
    pyAssert(ms != null);
    // The last keyframe removed provides the static value.
    const lastVertices = at(ms.keyframes, -1).value.vertices;
    while (pyBool(ms.keyframes)) {
      ms.removeKey(0);
    }
    const app2 = _roundtrip(app, tmpPath);
    const ms2 = getMs(app2);
    pyAssert(ms2 != null);
    expect(pyEq(ms2.keyframes, [])).toBe(true);
    expect(_approxPoints(ms2.value.vertices, lastVertices)).toBe(true);
  });

  test("test_remove_last_gradient_key_reverts_to_static", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "gradient_animated.aep"));

    function getGrad(a: Application): Property<Gradient> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let root: PropertyGroup;
          try {
            root = layer.property("ADBE Root Vectors Group");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(root, "ADBE Vector Grad Colors", out);
          for (const p of out) {
            if (pyBool(p.keyframes) || p.value != null) return p;
          }
        }
      }
      return null;
    }

    const g = getGrad(app);
    pyAssert(g != null);
    while (pyBool(g.keyframes)) {
      g.removeKey(0);
    }
    const app2 = _roundtrip(app, tmpPath);
    const g2 = getGrad(app2);
    pyAssert(g2 != null);
    expect(pyEq(g2.keyframes, [])).toBe(true);
    expect(g2.value != null).toBe(true);
  });

  test("test_remove_last_orientation_key_reverts_to_static", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "layer", "orientation_with_keyframes.aep"));
    const o = _prop(app, "ADBE Orientation");
    let lastValue: PropertyValue = null;
    while (pyBool(o.keyframes)) {
      lastValue = o.keyframes[0].value;
      o.removeKey(0);
    }
    expect(approx(o.value, lastValue)).toBe(true);
    const app2 = _roundtrip(app, tmpPath);
    const o2 = _prop(app2, "ADBE Orientation");
    expect(pyEq(o2.keyframes, [])).toBe(true);
    expect(approx(o2.value, lastValue)).toBe(true);
  });

  test("test_animate_static_text", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "layer", "type.aep"));

    function getText(a: Application): Property<TextDocument> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let tp: PropertyGroup;
          try {
            tp = layer.property("ADBE Text Properties");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(tp, "ADBE Text Document", out);
          if (pyBool(out)) return out[0];
        }
      }
      return null;
    }

    const t = getText(app);
    pyAssert(t != null);
    expect(pyEq(t.keyframes, [])).toBe(true);
    const original = t.value.text;
    const idx = t.addKey(1.0);
    expect(idx).toBe(0);
    expect(t.keyframes.length).toBe(1);
    expect(t.keyframes[0].value.text).toBe(original);
    const app2 = _roundtrip(app, tmpPath);
    const t2 = getText(app2);
    pyAssert(t2 != null);
    expect(t2.keyframes.length).toBe(1);
    expect(approx(t2.keyframes[0].time, 1.0)).toBe(true);
    expect(t2.keyframes[0].value.text).toBe(original);
    t2.setValueAtTime(2.0, "Second");
    const app3 = _roundtrip(app2, tmpPath);
    const t3 = getText(app3);
    pyAssert(t3 != null);
    expect(pyEq(t3.keyframes.map((k) => k.value.text), [original, "Second"])).toBe(true);
  });

  test("test_animate_static_mask_shape", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "mask.aep"));

    function getMs(a: Application): Property<Shape> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let mp: PropertyGroup;
          try {
            mp = layer.property("ADBE Mask Parade");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(mp, "ADBE Mask Shape", out);
          if (pyBool(out)) return out[0];
        }
      }
      return null;
    }

    const ms = getMs(app);
    pyAssert(ms != null);
    expect(pyEq(ms.keyframes, [])).toBe(true);
    const vertices = ms.value.vertices;
    ms.addKey(1.0);
    expect(ms.keyframes.length).toBe(1);
    const app2 = _roundtrip(app, tmpPath);
    const ms2 = getMs(app2);
    pyAssert(ms2 != null);
    expect(ms2.keyframes.length).toBe(1);
    expect(approx(ms2.keyframes[0].time, 1.0)).toBe(true);
    expect(_approxPoints(ms2.keyframes[0].value.vertices, vertices)).toBe(true);
  });

  test("test_animate_static_gradient", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "gradient.aep"));

    function getGrad(a: Application): Property<Gradient> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let root: PropertyGroup;
          try {
            root = layer.property("ADBE Root Vectors Group");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(root, "ADBE Vector Grad Colors", out);
          if (pyBool(out)) return out[0];
        }
      }
      return null;
    }

    const g = getGrad(app);
    pyAssert(g != null);
    expect(pyEq(g.keyframes, [])).toBe(true);
    expect(g.value != null).toBe(true);
    g.addKey(0.5);
    expect(g.keyframes.length).toBe(1);
    const app2 = _roundtrip(app, tmpPath);
    const g2 = getGrad(app2);
    pyAssert(g2 != null);
    expect(g2.keyframes.length).toBe(1);
    expect(g2.keyframes[0].value != null).toBe(true);
  });

  test("test_animate_static_orientation", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "mask.aep"));
    const o = _prop(app, "ADBE Orientation");
    expect(pyEq(o.keyframes, [])).toBe(true);
    o.setValueAtTime(1.0, [10.0, 20.0, 30.0]);
    expect(o.keyframes.length).toBe(1);
    const app2 = _roundtrip(app, tmpPath);
    const o2 = _prop(app2, "ADBE Orientation");
    expect(o2.keyframes.length).toBe(1);
    expect(approx(o2.keyframes[0].value, [10.0, 20.0, 30.0])).toBe(true);
  });

  test("test_add_first_marker_to_unmarked_layer", () => {
    // A never-marked layer has no mrst subtree at all; adding the first
    // marker materializes it.
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "mask.aep"));
    const mp = app.project.compositions[0].layers[0].property("ADBE Marker");
    expect(pyEq(mp.keyframes, [])).toBe(true);
    expect(mp._kfValueContainer == null).toBe(true);
    mp.setValueAtTime(1.0, new MarkerValue("first"));
    const app2 = _roundtrip(app, tmpPath);
    const mp2 = app2.project.compositions[0].layers[0].property("ADBE Marker");
    expect(pyEq(mp2.keyframes.map((k) => k.value.comment), ["first"])).toBe(true);
    expect(approx(mp2.keyframes[0].time, 1.0)).toBe(true);
    mp2.removeKey(0);
    const app3 = _roundtrip(app2, tmpPath);
    const mp3 = app3.project.compositions[0].layers[0].property("ADBE Marker");
    expect(pyEq(mp3.keyframes, [])).toBe(true);
  });

  test("test_animate_pristine_camera_orientation", () => {
    // A never-modified camera orientation is stored as a bare tdbs (no
    // otst / otky); keying it materializes the wrapper.
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "layer", "type.aep"));

    function getOrient(a: Application): Property | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          if (layer.name !== "CameraLayer") continue;
          const found = [...layer.transform].find((p) => p.matchName === "ADBE Orientation");
          if (found === undefined) throw new StopIteration();
          return asInstance(found, Property);
        }
      }
      return null;
    }

    const o = getOrient(app);
    pyAssert(o != null);
    expect(pyEq(o.keyframes, [])).toBe(true);
    expect(o._kfValueContainer == null).toBe(true);
    o.setValueAtTime(1.0, [10.0, 20.0, 30.0]);
    const app2 = _roundtrip(app, tmpPath);
    const o2 = getOrient(app2);
    pyAssert(o2 != null);
    expect(o2.keyframes.length).toBe(1);
    expect(approx(o2.keyframes[0].value, [10.0, 20.0, 30.0])).toBe(true);
    o2.removeKey(0);
    const app3 = _roundtrip(app2, tmpPath);
    const o3 = getOrient(app3);
    pyAssert(o3 != null);
    expect(pyEq(o3.keyframes, [])).toBe(true);
    expect(approx(o3.value, [10.0, 20.0, 30.0])).toBe(true);
  });

  test("test_animate_never_edited_gradient", () => {
    // A never-edited gradient fill has no GCst data; the first keyframe
    // materializes it with AE's default gradient.
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));

    function getGrad(a: Application): Property<Gradient> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let root: PropertyGroup;
          try {
            root = layer.property("ADBE Root Vectors Group");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(root, "ADBE Vector Grad Colors", out);
          if (pyBool(out)) return out[0];
        }
      }
      return null;
    }

    const g = getGrad(app);
    pyAssert(g != null);
    expect(pyEq(g.keyframes, [])).toBe(true);
    expect(g._kfValueContainer == null).toBe(true);
    g.addKey(0.5);
    expect(g.keyframes.length).toBe(1);
    const app2 = _roundtrip(app, tmpPath);
    const g2 = getGrad(app2);
    pyAssert(g2 != null);
    expect(g2.keyframes.length).toBe(1);
    expect(g2.keyframes[0].value != null).toBe(true);
  });
});

/** Regression tests for the 4 parallel-property value-write bugs. */
describe("TestParallelValueAliasing", () => {
  const GRAD_ANIM = SAMPLES_ROOT.div("models", "property", "gradient_animated.aep");
  const GRAD_STATIC = SAMPLES_ROOT.div("models", "property", "gradient.aep");
  const ORIENT_ANIM = SAMPLES_ROOT.div("models", "property", "all_animated.aep");
  const TEXT_STATIC = SAMPLES_ROOT.div("models", "essential_graphics", "text_source_text.aep");

  test("test_marker_set_at_two_times_is_independent", () => {
    // BUG 1: setting one MarkerValue at two times must not alias a single
    // set of chunks into both Nmrds; editing one keyframe afterwards must
    // leave the other untouched, with consistent nmhd.num_params.
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_ROOT.div("models", "marker", "layer_marker.aep"));
    const comp = getComp(app.project, "layer_multiple_markers");
    const mp = comp.layers[0].property("ADBE Marker");
    while (pyBool(mp.keyframes)) {
      mp.removeKey(0);
    }

    const shared = new MarkerValue("shared");
    mp.setValueAtTime(0.0, shared);
    mp.setValueAtTime(1.0, shared);
    const k0 = mp.keyframes[0];
    const k1 = mp.keyframes[1];
    expect(k0.value !== k1.value).toBe(true);

    // Editing one keyframe must not bleed into the other.
    k0.value.comment = "first_only";
    expect(k1.value.comment).toBe("shared");
    // Param splice on k1 only; k0 stays empty with a consistent header.
    k1.value.params = new Map([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(pyEq(k0.value.params, new Map())).toBe(true);
    expect(k0.value._nmhd.num_params).toBe(0);
    expect(k1.value._nmhd.num_params).toBe(2);

    const app2 = _roundtrip(app, tmpPath);
    const comp2 = getComp(app2.project, "layer_multiple_markers");
    const mp2 = comp2.layers[0].property("ADBE Marker");
    const byComment = new Map(mp2.keyframes.map((k) => [k.value.comment, k.value] as const));
    expect(pyEq(getitem(byComment, "first_only").params, new Map())).toBe(true);
    expect(getitem(byComment, "first_only")._nmhd.num_params).toBe(0);
    expect(
      pyEq(
        getitem(byComment, "shared").params,
        new Map([
          ["a", "1"],
          ["b", "2"],
        ]),
      ),
    ).toBe(true);
    expect(getitem(byComment, "shared")._nmhd.num_params).toBe(2);
  });

  test("test_gradient_set_value_at_time_not_aliased", () => {
    // BUG 2: set_value_at_time(kf1.time, kf0.value) must rebind kf1 to its
    // own chunk; mutating kf1 afterwards must not change kf0.
    const tmpPath = makeTmpPath();
    const app = parseAep(GRAD_ANIM);
    const g = _gradKfProp(app);
    pyAssert(g != null);
    const kf0 = g.keyframes[0];
    const kf1 = g.keyframes[1];
    const kf0XmlBefore = kf0.value._utf8.value;

    g.setValueAtTime(kf1.time, kf0.value);
    expect(kf1.value !== kf0.value).toBe(true);
    kf1.value.addColorStop(0.5, 0.5, [1.0, 0.0, 0.0]);
    expect(kf0.value._utf8.value).toBe(kf0XmlBefore);

    const app2 = _roundtrip(app, tmpPath);
    const g2 = _gradKfProp(app2);
    pyAssert(g2 != null);
    expect(g2.keyframes[0].value.colorStops.length).toBe(kf0.value.colorStops.length);
    expect(g2.keyframes[1].value.colorStops.length).toBe(kf1.value.colorStops.length);
    expect(g2.keyframes[0].value.colorStops.length !== g2.keyframes[1].value.colorStops.length).toBe(true);
  });

  test("test_orientation_keyframe_value_persists", () => {
    // BUG 3: assigning kf.value on an animated orientation must write the
    // parallel otda container, not just the in-memory shadow.
    const tmpPath = makeTmpPath();
    const app = parseAep(ORIENT_ANIM);
    const o = _orientationKfProp(app);
    pyAssert(o != null);
    o.keyframes[0].value = [0.0, 0.0, 90.0];
    expect(pyEq(o.keyframes[0].value, [0.0, 0.0, 90.0])).toBe(true);

    const app2 = _roundtrip(app, tmpPath);
    const o2 = _orientationKfProp(app2);
    pyAssert(o2 != null);
    expect(pyEq(o2.keyframes[0].value, [0.0, 0.0, 90.0])).toBe(true);
  });

  test("test_static_gradient_value_reassign_persists", () => {
    // BUG 4 (implemented kind): assigning a new Gradient to a static
    // gradient property rebuilds its GCky container chunk.
    const tmpPath = makeTmpPath();
    const app = parseAep(GRAD_STATIC);
    const g = _gradStaticProp(app);
    pyAssert(g != null);
    const newGrad = new Gradient();
    newGrad.addColorStop(0.5, 0.5, [1.0, 0.0, 0.0]);
    const nStops = newGrad.colorStops.length;
    g.value = newGrad;

    const app2 = _roundtrip(app, tmpPath);
    const g2 = _gradStaticProp(app2);
    pyAssert(g2 != null);
    expect(g2.value.colorStops.length).toBe(nStops);
  });

  test("test_static_text_value_reassign_raises", () => {
    // BUG 4 (rejected kind): a brand-new TextDocument cannot replace a
    // static text value (the btdk COS blob is byte-format-sensitive);
    // the documented in-place alternative is mutating prop.value.text.
    const app = parseAep(TEXT_STATIC);
    const t = _textStaticProp(app);
    pyAssert(t != null);
    raises(
      ValueError,
      () => {
        t.value = new TextDocument("CHANGED_TEXT");
      },
      "Mutate the existing prop.value",
    );
  });

  test("test_static_text_inplace_mutation_persists", () => {
    // BUG 4 (rejected kind): the documented alternative - mutating the
    // existing value object in place - must still persist (no silent loss).
    const tmpPath = makeTmpPath();
    const app = parseAep(TEXT_STATIC);
    const t = _textStaticProp(app);
    pyAssert(t != null);
    t.value.text = "CHANGED_TEXT";
    const app2 = _roundtrip(app, tmpPath);
    const t2 = _textStaticProp(app2);
    pyAssert(t2 != null);
    expect(t2.value.text).toBe("CHANGED_TEXT");
  });
});

/**
 * Non-spatial keyframes reject spatial-flag writes (ExtendScript's
 * setSpatialAutoBezierAtKey errors regardless of the value written).
 */
describe("TestSpatialFlagGuards", () => {
  test("test_spatial_auto_bezier_on_non_spatial_raises", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const kf = _prop(app, "ADBE Opacity").keyframes[0];
    raises(
      ValueError,
      () => {
        kf.spatialAutoBezier = false;
      },
      "spatial keyframes",
    );
  });

  test("test_spatial_continuous_on_non_spatial_raises", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const kf = _prop(app, "ADBE Opacity").keyframes[0];
    raises(
      ValueError,
      () => {
        kf.spatialContinuous = false;
      },
      "spatial keyframes",
    );
  });
});

/**
 * Keyframe.time is exact, not snapped to whole frames.
 *
 * AE places keyframes off the frame grid freely: `setValueAtTime(1.5)` in a
 * 25 fps comp is stored as 38400 units, i.e. frame 37.5, and every roving
 * keyframe is positioned by arc length. Rounding to frames misreported such
 * a keyframe by up to half a frame and moved it on the next write.
 */
describe("TestRoundtripSubFrameKeyframeTime", () => {
  const SAMPLE = SAMPLES.div("effect_point_speed.aep");

  /** 1.5 s in a 25 fps comp is frame 37.5. Before the fix this read back as 1.52. */
  test("test_off_grid_time_is_exact", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLE);
    const comp = project.compositions[0];
    expect(comp.frameRate).toBe(25.0);
    const prop = comp.layers[0].transform.property("ADBE Opacity");
    prop.addKey(1.5);

    const keyframe = prop.keyframes.find((k) => k.timeUnits === 38400);
    if (keyframe === undefined) throw new StopIteration();
    expect(approx(keyframe.time, 1.5)).toBe(true);

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const comp2 = parseAep(out).project.compositions[0];
    const prop2 = comp2.layers[0].transform.property("ADBE Opacity");
    const keyframe2 = prop2.keyframes.find((k) => k.timeUnits === 38400);
    if (keyframe2 === undefined) throw new StopIteration();
    expect(approx(keyframe2.time, 1.5)).toBe(true);
  });

  /** `kf.time = kf.time` used to snap an off-grid keyframe to the nearest frame. */
  test("test_rewriting_its_own_time_does_not_move_a_keyframe", () => {
    const project = parseProjectFresh(SAMPLE);
    const prop = project.compositions[0].layers[0].transform.property("ADBE Opacity");
    prop.addKey(1.5);
    const keyframe = prop.keyframes.find((k) => k.timeUnits === 38400);
    if (keyframe === undefined) throw new StopIteration();

    keyframe.time = keyframe.time;

    expect(keyframe.timeUnits).toBe(38400);
  });

  /**
   * Sub-frame keyframes inside one frame are distinct, so the
   * duplicate-time guard must compare units and not frame indices.
   */
  test("test_two_keyframes_can_share_a_frame", () => {
    const project = parseProjectFresh(SAMPLE);
    const prop = project.compositions[0].layers[0].transform.property("ADBE Opacity");
    // Both round to frame 37 at 25 fps (37.025 and 37.375) while
    // occupying different timebase units.
    prop.addKey(1.481);
    prop.addKey(1.495);

    const units = sorted(prop.keyframes.map((k) => k.timeUnits));
    expect(new Set(units).size).toBe(units.length);
    const inside = prop.keyframes.filter((k) => k.frameTime === 37);
    expect(inside.length).toBe(2);
  });

  test("test_frame_time_still_rounds", () => {
    const project = parseProjectFresh(SAMPLE);
    const prop = project.compositions[0].layers[0].transform.property("ADBE Opacity");
    prop.addKey(1.5);
    const keyframe = prop.keyframes.find((k) => k.timeUnits === 38400);
    if (keyframe === undefined) throw new StopIteration();
    expect(keyframe.frameTime).toBe(38);
    expect(approx(keyframe.time, 1.5)).toBe(true);
  });

  /**
   * Keyframe times are stored relative to the layer start; an
   * off-grid start must not quantize the keyframe.
   */
  test("test_layer_start_offset_stays_in_seconds", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLE);
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    layer.startTime = 0.29166666666666663; // 7/24 s, off the 25 fps grid
    const prop = layer.transform.property("ADBE Opacity");
    prop.addKey(2.0);

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const comp2 = parseAep(out).project.compositions[0];
    const prop2 = comp2.layers[0].transform.property("ADBE Opacity");
    // Times are an integer count of timebase units, so a request that
    // falls between units lands on the nearest one - AE requantizes
    // identically (it stored 0.99998697916667 for a 1.0 s request on a
    // layer with this start).
    const halfUnit = 0.5 / comp2._cdta.internal_timebase;
    expect(prop2.keyframes.some((k) => Math.abs(k.time - 2.0) <= halfUnit)).toBe(true);
  });
});

/**
 * Roving keyframes are positioned by arc length, not stored freely.
 *
 * AE derives a roving keyframe's time so the speed along the spatial path
 * is constant between the enclosing non-roving anchors, and applies it the
 * moment the flag is set. Both expected times below are AE 2026
 * measurements on a 25 fps comp with the first segment bowed by +/-400 px
 * tangents - a case where chord length would predict 0.667 s.
 */
describe("TestRoundtripRoving", () => {
  const SAMPLE = SAMPLES.div("effect_point_speed.aep");

  function _bowedPath(bow: number): Property<number[]> {
    const project = parseProjectFresh(SAMPLE);
    const comp = project.compositions[0];
    expect(comp.frameRate).toBe(25.0);
    const prop = comp.layers[0].transform.property("ADBE Position");
    while (pyBool(prop.keyframes)) {
      prop.removeKey(0);
    }
    for (const [time, value] of [
      [0.0, 0.0],
      [1.0, 100.0],
      [4.0, 600.0],
    ] as const) {
      prop.addKey(time);
      at(prop.keyframes, -1).value = [value, 200.0, 0.0];
    }
    for (const keyframe of prop.keyframes) {
      keyframe.inInterpolationType = KeyframeInterpolationType.BEZIER;
      keyframe.outInterpolationType = KeyframeInterpolationType.BEZIER;
    }
    prop.keyframes[0].outSpatialTangent = [0.0, bow, 0.0];
    prop.keyframes[1].inSpatialTangent = [0.0, bow, 0.0];
    return prop;
  }

  /**
   * AE put the roving key at 2.2205078125 s (56845 units). The chord
   * between the same keyframes would put it at 0.667 s.
   */
  test("test_roving_uses_arc_length_not_chord", () => {
    const prop = _bowedPath(400.0);
    expect(prop.keyframes[1].time).toBe(1.0);

    prop.keyframes[1].roving = true;

    expect(prop.keyframes[1].timeUnits).toBe(56845);
    expect(approx(prop.keyframes[1].time, 2.2205078125)).toBe(true);
  });

  /**
   * A shallower bow shortens the first segment, so AE pulls the key
   * back to 0.819296875 s (20974 units).
   */
  test("test_flattening_the_path_moves_the_roving_key", () => {
    const prop = _bowedPath(40.0);
    prop.keyframes[1].roving = true;
    expect(prop.keyframes[1].timeUnits).toBe(20974);
    expect(approx(prop.keyframes[1].time, 0.819296875)).toBe(true);
  });

  test("test_roving_survives_a_save", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLE);
    const comp = project.compositions[0];
    const prop = comp.layers[0].transform.property("ADBE Position");
    while (pyBool(prop.keyframes)) {
      prop.removeKey(0);
    }
    for (const [time, value] of [
      [0.0, 0.0],
      [1.0, 100.0],
      [4.0, 600.0],
    ] as const) {
      prop.addKey(time);
      at(prop.keyframes, -1).value = [value, 200.0, 0.0];
    }
    prop.keyframes[1].roving = true;
    const moved = prop.keyframes[1].timeUnits;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const prop2 = parseAep(out).project.compositions[0].layers[0].transform.property("ADBE Position");
    expect(prop2.keyframes[1].roving).toBe(true);
    expect(prop2.keyframes[1].timeUnits).toBe(moved);
  });

  /**
   * AE does not restore the original time: the redistribution already
   * happened, and turning the flag off leaves the key where it moved to.
   */
  test("test_unroving_keeps_the_redistributed_time", () => {
    const prop = _bowedPath(400.0);
    prop.keyframes[1].roving = true;
    const moved = prop.keyframes[1].timeUnits;

    prop.keyframes[1].roving = false;

    expect(prop.keyframes[1].roving).toBe(false);
    expect(prop.keyframes[1].timeUnits).toBe(moved);
  });

  /** AE raises here: "This property does not have a spatial PropertyValueType". */
  test("test_non_spatial_property_is_rejected", () => {
    const project = parseProjectFresh(SAMPLES.div("keyframe_misc.aep"));
    const prop = project.compositions[0].layers[0].transform.property("ADBE Scale");
    expect(pyBool(prop.isSpatial)).toBe(false);
    raises(
      ValueError,
      () => {
        prop.keyframes[1].roving = true;
      },
      "spatial property",
    );
  });

  /** AE silently no-ops these; py-aep raises so the caller sees it. */
  test.each([0, -1])("test_first_and_last_keyframe_are_rejected[%#]", (index) => {
    const prop = _bowedPath(400.0);
    raises(
      ValueError,
      () => {
        at(prop.keyframes, index).roving = true;
      },
      "cannot rove",
    );
  });
});

/**
 * The auto-bezier and continuity flags carry companion state.
 *
 * AE rewrites the derived values and forces companion flags when these are
 * set, and - critically - it TRUSTS the stored bytes if the keyframe is
 * later switched back to BEZIER: a stale 90% influence written under HOLD
 * came back as 90 on the way out. So the bytes have to agree with the
 * reader, not merely the reported values. All expectations are AE 2026
 * measurements.
 */
describe("TestRoundtripAutoBezierWrites", () => {
  /**
   * t = 0 / 1 / 4 with x = 0 / 100 / 600 - uneven in time, so a
   * time-weighted tangent rule would disagree with AE's chord/6.
   */
  function _unevenPosition(): Property<number[]> {
    const project = parseProjectFresh(SAMPLES.div("effect_point_speed.aep"));
    const prop = project.compositions[0].layers[0].transform.property("ADBE Position");
    while (pyBool(prop.keyframes)) {
      prop.removeKey(0);
    }
    for (const [time, x] of [
      [0.0, 0.0],
      [1.0, 100.0],
      [4.0, 600.0],
    ] as const) {
      prop.addKey(time);
      at(prop.keyframes, -1).value = [x, 0.0, 0.0];
    }
    for (const keyframe of prop.keyframes) {
      keyframe.inInterpolationType = KeyframeInterpolationType.BEZIER;
      keyframe.outInterpolationType = KeyframeInterpolationType.BEZIER;
    }
    return prop;
  }

  test("test_spatial_auto_bezier_writes_the_derived_tangents", () => {
    const prop = _unevenPosition();
    const keyframe = prop.keyframes[1];
    keyframe.inSpatialTangent = [-40.0, -10.0, 0.0];
    keyframe.outSpatialTangent = [70.0, 25.0, 0.0];
    const stored = asInstance(keyframe._ldatItem.kf_data, KfPosition);

    keyframe.spatialAutoBezier = true;

    expect(approx([...stored.out_spatial_tangents], [100.0, 0.0, 0.0])).toBe(true);
    expect(approx([...stored.in_spatial_tangents], [-100.0, 0.0, 0.0])).toBe(true);
  });

  test("test_spatial_auto_bezier_forces_continuity", () => {
    const prop = _unevenPosition();
    const keyframe = prop.keyframes[1];
    keyframe.spatialContinuous = false;

    keyframe.spatialAutoBezier = true;

    expect(keyframe.spatialContinuous).toBe(true);
  });

  /** AE does not restore what was there before. */
  test("test_clearing_spatial_auto_bezier_keeps_the_derived_tangents", () => {
    const prop = _unevenPosition();
    const keyframe = prop.keyframes[1];
    keyframe.spatialAutoBezier = true;
    keyframe.spatialAutoBezier = false;
    const stored = asInstance(keyframe._ldatItem.kf_data, KfPosition);
    expect(approx([...stored.out_spatial_tangents], [100.0, 0.0, 0.0])).toBe(true);
  });

  /**
   * 2-D Scale 100->200->400 and 100->120->150 over 2 s gives per
   * dimension speeds 150 and 25, not one shared scalar.
   */
  test("test_temporal_auto_bezier_is_per_dimension", () => {
    const tmpPath = makeTmpPath();
    const project = parseProjectFresh(SAMPLES.div("keyframe_misc.aep"));
    const prop = project.compositions[0].layers[0].transform.property("ADBE Scale");
    while (pyBool(prop.keyframes)) {
      prop.removeKey(0);
    }
    const scaleValues: [number, number[]][] = [
      [0.0, [100.0, 100.0, 100.0]],
      [1.0, [200.0, 120.0, 100.0]],
      [2.0, [400.0, 150.0, 100.0]],
    ];
    for (const [time, value] of scaleValues) {
      prop.addKey(time);
      at(prop.keyframes, -1).value = value;
    }
    for (const keyframe of prop.keyframes) {
      keyframe.inInterpolationType = KeyframeInterpolationType.BEZIER;
      keyframe.outInterpolationType = KeyframeInterpolationType.BEZIER;
    }

    prop.keyframes[1].temporalAutoBezier = true;

    const out = tmpPath.div("modified.aep");
    project.save(out);
    const prop2 = parseAep(out).project.compositions[0].layers[0].transform.property("ADBE Scale");
    const speeds = prop2.keyframes[1].inTemporalEase.map((ease) => ease.speed);
    expect(approx(speeds, [150.0, 25.0, 0.0])).toBe(true);
    const influences = prop2.keyframes[1].inTemporalEase.map((ease) => ease.influence);
    expect(approx(influences, Array(3).fill(100.0 / 6.0))).toBe(true);
  });

  /**
   * Sampling a multi-dimensional auto-bezier property must give each
   * dimension the curve it would have on its own.
   *
   * A single scalar ease applied across every dimension drove them all at
   * dimension 0's speed, so y here read 131.875 at t=1.5 instead of
   * 134.6875 - visible on any Scale/Position whose axes move unequally.
   */
  test("test_temporal_auto_bezier_samples_each_dimension_at_its_own_speed", () => {
    const curves = [
      [100.0, 200.0, 400.0],
      [100.0, 120.0, 150.0],
    ];
    const times = [0.0, 1.0, 2.0];

    const project = parseProjectFresh(SAMPLES.div("keyframe_misc.aep"));
    const transform = project.compositions[0].layers[0].transform;
    const scale = transform.property("ADBE Scale");
    scale.removeAllKeys();
    for (const [index, time] of times.entries()) {
      scale.setValueAtTime(time, [curves[0][index], curves[1][index], 100.0]);
    }

    const references: Property<number>[] = [];
    for (const curve of curves) {
      const reference = parseProjectFresh(SAMPLES.div("keyframe_misc.aep"));
      const rotation = reference.compositions[0].layers[0].transform.property("ADBE Rotate Z");
      rotation.removeAllKeys();
      for (const [index, time] of times.entries()) {
        rotation.setValueAtTime(time, curve[index]);
      }
      references.push(rotation);
    }

    for (const prop of [scale, ...references]) {
      for (const keyframe of prop.keyframes) {
        keyframe.inInterpolationType = KeyframeInterpolationType.BEZIER;
        keyframe.outInterpolationType = KeyframeInterpolationType.BEZIER;
        keyframe.temporalAutoBezier = true;
      }
    }

    for (const sample of [1.25, 1.5, 1.75]) {
      const composed = scale.valueAtTime(sample);
      const expected = references.map((reference) => reference.valueAtTime(sample));
      expect(approx(composed.slice(0, 2), expected)).toBe(true);
    }
  });

  test("test_temporal_auto_bezier_forces_continuity_and_bezier", () => {
    const prop = _unevenPosition();
    const keyframe = prop.keyframes[1];
    keyframe.inInterpolationType = KeyframeInterpolationType.LINEAR;
    keyframe.outInterpolationType = KeyframeInterpolationType.LINEAR;
    keyframe.temporalContinuous = false;

    keyframe.temporalAutoBezier = true;

    expect(keyframe.temporalContinuous).toBe(true);
    expect<KeyframeInterpolationType>(keyframe.inInterpolationType).toBe(KeyframeInterpolationType.BEZIER);
    expect<KeyframeInterpolationType>(keyframe.outInterpolationType).toBe(KeyframeInterpolationType.BEZIER);
  });

  /**
   * AE turns (10, 75) / (90, 25) into (10, 75) / (10, 25): the speeds
   * are tied, both influences survive.
   */
  test("test_temporal_continuous_ties_the_out_speed_to_the_in_speed", () => {
    const project = parseProjectFresh(SAMPLES.div("keyframe_bezier_nonzero_speed.aep"));
    const prop = asInstance(
      project.compositions[0].layers
        .flatMap((layer) => layer.transform.properties)
        .find((g) => pyBool(asInstance(g, Property).keyframes) && g.matchName === "ADBE Opacity"),
      Property,
    );
    const keyframe = prop.keyframes[0];
    const inSpeed = keyframe.inTemporalEase[0].speed;
    const outInfluence = keyframe.outTemporalEase[0].influence;
    expect(keyframe.outTemporalEase[0].speed !== inSpeed).toBe(true);

    keyframe.temporalContinuous = true;

    expect(approx(keyframe.outTemporalEase[0].speed, inSpeed)).toBe(true);
    expect(approx(keyframe.outTemporalEase[0].influence, outInfluence)).toBe(true);
  });

  /**
   * AE 2026 (`scripts/jsx/temporal_continuous_probe.jsx`): setting
   * temporal continuity rewrites BOTH interpolation types to BEZIER
   * first, in all five in/out pairings tried. That is what makes the
   * STORED in speed the one to copy - a LINEAR side reports the segment
   * slope (100 on this ramp) but AE gives back the stored 10.
   */
  test("test_temporal_continuous_forces_bezier_and_uses_the_stored_speed", () => {
    const prop = _unevenPosition();
    const keyframe = prop.keyframes[1];
    keyframe.inTemporalEase = [new KeyframeEase(10.0, 75.0)];
    keyframe.outTemporalEase = [new KeyframeEase(90.0, 25.0)];
    keyframe.inInterpolationType = KeyframeInterpolationType.LINEAR;
    // The LINEAR side reports the segment slope, not the stored 10.
    expect(approx(keyframe.inTemporalEase[0].speed, 100.0)).toBe(true);

    keyframe.temporalContinuous = true;

    expect<KeyframeInterpolationType>(keyframe.inInterpolationType).toBe(KeyframeInterpolationType.BEZIER);
    expect(keyframe.outInterpolationType).toBe(KeyframeInterpolationType.BEZIER);
    expect(approx(keyframe.inTemporalEase[0].speed, 10.0)).toBe(true);
    expect(approx(keyframe.inTemporalEase[0].influence, 75.0)).toBe(true);
    expect(approx(keyframe.outTemporalEase[0].speed, 10.0)).toBe(true);
    expect(approx(keyframe.outTemporalEase[0].influence, 25.0)).toBe(true);
  });

  /**
   * Changing the interpolation type must NOT rewrite the ease bytes.
   *
   * AE 2026 (`scripts/jsx/interpolation_ease_probe.jsx`): a keyframe
   * eased (10, 75) / (90, 25) under BEZIER and then switched to LINEAR
   * or HOLD keeps those bytes on disk - only the REPORTED ease changes,
   * to the segment slope (LINEAR) or zero (HOLD). Switching back to
   * BEZIER hands 10 / 75 and 90 / 25 straight back, and a keyframe that
   * never carried an ease reports the stored `(0, 0)` under BEZIER
   * rather than anything derived. Normalizing the bytes here wrote
   * numbers AE never writes and destroyed the ease it gives back.
   */
  test.each([KeyframeInterpolationType.HOLD, KeyframeInterpolationType.LINEAR])(
    "test_interpolation_change_preserves_the_stored_ease[%#]",
    (interpolation) => {
      const tmpPath = makeTmpPath();
      const project = parseProjectFresh(SAMPLES.div("keyframe_bezier_asymmetric_ease_1D.aep"));
      const prop = asInstance(
        project.compositions[0].layers
          .flatMap((layer) => layer.transform.properties)
          .find((g) => pyBool(asInstance(g, Property).keyframes)),
        Property,
      );
      const keyframe = prop.keyframes[0];
      const stored = asInstance(keyframe._ldatItem.kf_data, KfMultiDimensional);
      const before = [[...stored.in_influence], [...stored.out_influence]];
      expect(approx(before[1], [0.9])).toBe(true);

      keyframe.inInterpolationType = interpolation;
      keyframe.outInterpolationType = interpolation;

      expect(approx([...stored.in_influence], before[0])).toBe(true);
      expect(approx([...stored.out_influence], before[1])).toBe(true);

      keyframe.inInterpolationType = KeyframeInterpolationType.BEZIER;
      keyframe.outInterpolationType = KeyframeInterpolationType.BEZIER;
      expect(approx(keyframe.outTemporalEase[0].influence, 90.0)).toBe(true);

      const out = tmpPath.div("modified.aep");
      project.save(out);
      const prop2 = asInstance(
        parseAep(out).project.compositions[0].layers
          .flatMap((layer) => layer.transform.properties)
          .find((g) => pyBool(asInstance(g, Property).keyframes)),
        Property,
      );
      const reloaded = asInstance(prop2.keyframes[0]._ldatItem.kf_data, KfMultiDimensional);
      expect(approx([...reloaded.out_influence], before[1])).toBe(true);
    },
  );
});
