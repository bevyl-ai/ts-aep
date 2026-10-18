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
  py_bool,
  py_eq,
  py_assert,
  py_slice,
  sorted,
  StopIteration,
  ValueError,
} from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import type { Application } from "../../src/py_aep/index.ts";
import { write_aep } from "../../src/py_aep/binary/chunk.ts";
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
import { as_instance, get_comp, parse_project_fresh } from "../helpers.ts";
import { KfMultiDimensional, KfPosition } from "../../src/py_aep/binary/ldat_chunks.ts";

const SAMPLES = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");
const SAMPLES_ROOT = new Path(import.meta.path).parent.parent.parent.div("samples");

function _fresh(name: string): Application {
  return parse_aep(SAMPLES.div(name));
}

function _roundtrip(app: Application, tmp_path: Path): Application {
  const out = tmp_path.div("out.aep");
  // `with out.open("wb") as f:` - serialize to memory, then write the file in one go.
  const f = new BytesIO();
  write_aep(f, app.project._rifx, app.project._xmp);
  out.write_bytes(f.getvalue());
  return parse_aep(out);
}

function _prop(app: Application, match_name: string, kw: { comp?: number; layer?: number } = {}): Property {
  const { comp = 0, layer = 0 } = kw;
  const lay = app.project.compositions[comp].layers[layer];
  const found = [...lay.transform].find((p) => p.match_name === match_name);
  if (found === undefined) throw new StopIteration();
  return as_instance(found, Property);
}

/** Compare two lists of [x, y] pairs within tolerance. */
function _approx_points(actual: number[][], expected: number[][], abs_tol = 1e-2): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((a, i) => approx(a, expected[i], { abs: abs_tol }));
}

function _find_static(app: Application, match_name: string): [Property | null, number | null, number | null] {
  for (const [ci, comp] of app.project.compositions.entries()) {
    for (const [li, lay] of comp.layers.entries()) {
      for (const p of lay.transform) {
        if (p.match_name !== match_name) continue;
        const prop = as_instance(p, Property);
        if (!py_bool(prop.keyframes)) return [prop, ci, li];
      }
    }
  }
  return [null, null, null];
}

function _walk(group: PropertyGroup, match_name: string, out: Property[]): void {
  for (const p of getattr(group, "properties", [])) {
    if (p.match_name === match_name) out.push(as_instance(p, Property));
    if (hasattr(p, "properties")) _walk(as_instance(p, PropertyGroup), match_name, out);
  }
}

function _grad_kf_prop(app: Application): Property<Gradient> | null {
  for (const comp of app.project.compositions) {
    for (const layer of comp.layers) {
      const out: Property[] = [];
      _walk(layer, "ADBE Vector Grad Colors", out);
      for (const p of out) {
        if (py_bool(p.keyframes)) return p;
      }
    }
  }
  return null;
}

function _orientation_kf_prop(app: Application): Property<number[]> | null {
  for (const comp of app.project.compositions) {
    for (const layer of comp.layers) {
      const out: Property[] = [];
      _walk(layer, "ADBE Orientation", out);
      for (const p of out) {
        if (py_bool(p.keyframes)) return p;
      }
    }
  }
  return null;
}

function _text_static_prop(app: Application): Property<TextDocument> | null {
  for (const comp of app.project.compositions) {
    for (const layer of comp.layers) {
      const out: Property[] = [];
      _walk(layer, "ADBE Text Document", out);
      for (const p of out) {
        if (!py_bool(p.keyframes)) return p;
      }
    }
  }
  return null;
}

function _grad_static_prop(app: Application): Property<Gradient> | null {
  for (const comp of app.project.compositions) {
    for (const layer of comp.layers) {
      const out: Property[] = [];
      _walk(layer, "ADBE Vector Grad Colors", out);
      for (const p of out) {
        if (!py_bool(p.keyframes)) return p;
      }
    }
  }
  return null;
}

describe("TestKeyframeValuePersistence", () => {
  test("test_1d_value_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("keyframe_HOLD.aep");
    _prop(app, "ADBE Opacity").keyframes[0].value = 42.0;
    const app2 = _roundtrip(app, tmp_path);
    expect(approx(_prop(app2, "ADBE Opacity").keyframes[0].value, 42.0)).toBe(true);
  });

  test("test_multidim_value_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("keyframe_LINEAR.aep");
    const pos = _prop(app, "ADBE Position");
    const pos_value = pos.keyframes[0].value;
    if (!Array.isArray(pos_value)) throw new AssertionError_("ADBE Position keyframe value is not a list");
    const v = [...pos_value];
    v[0] += 7.0;
    pos.keyframes[0].value = v;
    const app2 = _roundtrip(app, tmp_path);
    const pos2_value = _prop(app2, "ADBE Position").keyframes[0].value;
    if (!Array.isArray(pos2_value)) throw new AssertionError_("ADBE Position keyframe value is not a list");
    expect(approx(pos2_value[0], v[0])).toBe(true);
  });
});

describe("TestAddKey", () => {
  test("test_add_key_to_animated", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const n0 = op.keyframes.length;
    const idx = op.add_key(0.5);
    expect(op.keyframes.length).toBe(n0 + 1);
    expect(0 <= idx && idx <= n0).toBe(true);
    const app2 = _roundtrip(app, tmp_path);
    expect(_prop(app2, "ADBE Opacity").keyframes.length).toBe(n0 + 1);
  });

  test("test_out_of_range_time_leaves_the_property_untouched", () => {
    // Issue #228: the tick conversion overflows the 32-bit time field,
    // and animating before converting left the property marked animated
    // with no keyframes and its static value discarded.
    const app = _fresh("2_gaussian.aep");
    const op = _prop(app, "ADBE Opacity");
    expect(py_bool(op.keyframes)).toBe(false);
    const before = op.value;

    raises(ValueError, () => {
      op.add_key(1e9);
    }, "32-bit keyframe time field");

    expect(py_bool(op.keyframes)).toBe(false);
    expect(py_eq(op.value, before)).toBe(true);

    // ... and the property still animates normally afterwards.
    op.add_key(1.0);
    expect(op.keyframes.length).toBe(1);
  });

  test("test_add_key_returns_existing_index_at_same_time", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const n0 = op.keyframes.length;
    const existing_time = op.keyframes[0].time;
    const idx = op.add_key(existing_time);
    expect(idx).toBe(0);
    expect(op.keyframes.length).toBe(n0);
  });

  test("test_first_key_animates_static_property", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("keyframe_HOLD.aep");
    const [prop, _, li] = _find_static(app, "ADBE Rotate Z");
    expect(prop != null).toBe(true);
    if (prop == null || li == null) throw new AssertionError_("no static ADBE Rotate Z property");
    prop.add_key(0.0);
    prop.add_key(1.0);
    prop.keyframes[1].value = 25.0;
    expect(prop._animated).toBe(true);
    expect(prop.keyframes.length).toBe(2);
    const app2 = _roundtrip(app, tmp_path);
    const prop2 = as_instance([...app2.project.compositions[0].layers[li].transform].find((p) => p.match_name === "ADBE Rotate Z"), Property);
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
    const tmp_path = make_tmp_path();
    const app = _fresh("keyframe_HOLD.aep");
    const [scale, _, li] = _find_static(app, "ADBE Scale");
    expect(scale != null).toBe(true);
    if (scale == null || li == null) throw new AssertionError_("no static ADBE Scale property");
    scale.set_value_at_time(0.0, [50.0, 50.0, 100.0]);
    scale.set_value_at_time(1.0, [120.0, 120.0, 100.0]);
    expect(scale._animated).toBe(true);
    // tdum/tduM bound chunks were added on materialization.
    const kinds = scale._tdbs.chunks.map((c) => getattr(c, "chunk_type", null));
    expect(kinds.includes("tdum") && kinds.includes("tduM")).toBe(true);
    const app2 = _roundtrip(app, tmp_path);
    const scale2 = as_instance([...app2.project.compositions[0].layers[li].transform].find((p) => p.match_name === "ADBE Scale"), Property);
    expect(scale2.keyframes.length).toBe(2);
  });

  test("test_keys_stay_time_sorted", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    op.add_key(0.5);
    op.add_key(0.1);
    const times = op.keyframes.map((kf) => kf.frame_time);
    expect(py_eq(times, sorted(times))).toBe(true);
  });

  test("test_add_key_no_value_property_raises", () => {
    // A numeric property with no value slot cannot be keyframed; building
    // a numeric keyframe item for it would produce a wrong-size ldat item.
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    // `op.__dict__["_no_value"] = True` - instance attribute write.
    op._no_value = true;
    raises(ValueError, () => {
      op.add_key(0.5);
    });
  });
});

describe("TestRemoveKey", () => {
  test("test_remove_middle_key", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const n0 = op.keyframes.length;
    op.remove_key(1);
    expect(op.keyframes.length).toBe(n0 - 1);
    const app2 = _roundtrip(app, tmp_path);
    expect(_prop(app2, "ADBE Opacity").keyframes.length).toBe(n0 - 1);
  });

  test("test_remove_last_key_deanimates", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const last_val = op.keyframes[0].value;
    while (py_bool(op.keyframes)) {
      op.remove_key(0);
    }
    expect(op._animated).toBe(false);
    const app2 = _roundtrip(app, tmp_path);
    const op2 = _prop(app2, "ADBE Opacity");
    expect(op2.keyframes.length).toBe(0);
    expect(approx(op2.value, last_val)).toBe(true);
  });

  test("test_remove_key_out_of_range", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    raises(ValueError, () => {
      op.remove_key(99);
    });
  });
});

/** Writing Keyframe.time / frame_time re-sorts keyframes and chunks. */
describe("TestMoveKeyframe", () => {
  test("test_move_past_neighbour_resorts", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    expect(op.keyframes.length >= 2).toBe(true);
    for (const [i, kf] of op.keyframes.entries()) {
      kf.value = 10.0 * (i + 1);
    }
    const first = op.keyframes[0];
    first.time = at(op.keyframes, -1).time + 1.0;
    expect(op.keyframes.at(-1)).toBe(first);
    const times = op.keyframes.map((kf) => kf.frame_time);
    expect(py_eq(times, sorted(times))).toBe(true);
    // prev/next chain follows the new order.
    expect(first._next == null).toBe(true);
    expect(at(op.keyframes, -2)._next).toBe(first);
    const app2 = _roundtrip(app, tmp_path);
    const op2 = _prop(app2, "ADBE Opacity");
    const times2 = op2.keyframes.map((kf) => kf.frame_time);
    expect(py_eq(times2, sorted(times2))).toBe(true);
    // The moved keyframe's value traveled with it through the save.
    expect(approx(at(op2.keyframes, -1).value, 10.0)).toBe(true);
    expect(approx(op2.keyframes[0].value, 20.0)).toBe(true);
  });

  test("test_move_without_crossing_keeps_position", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const kf = op.keyframes[0];
    kf.frame_time = op.keyframes[1].frame_time - 1;
    expect(op.keyframes[0]).toBe(kf);
    const times = op.keyframes.map((k) => k.frame_time);
    expect(py_eq(times, sorted(times))).toBe(true);
  });

  test("test_move_onto_existing_keyframe_raises", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const original = op.keyframes[0].frame_time;
    raises(
      ValueError,
      () => {
        op.keyframes[0].frame_time = op.keyframes[1].frame_time;
      },
      "already exists",
    );
    // The failed move left the keyframe untouched.
    expect(op.keyframes[0].frame_time).toBe(original);
  });

  test("test_move_marker_key_moves_container_value", () => {
    // Markers keep their values in the parallel Nmrd container, paired
    // by position: the container entry must travel with the keyframe.
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "marker", "layer_marker.aep"));
    const comp = get_comp(app.project, "layer_multiple_markers");
    const mp = comp.layers[0].__getitem__("ADBE Marker");
    expect(mp.keyframes.length >= 2).toBe(true);
    mp.keyframes[0].value = new MarkerValue("moved");
    mp.keyframes[0].time = at(mp.keyframes, -1).time + 1.0;
    const app2 = _roundtrip(app, tmp_path);
    const mp2 = get_comp(app2.project, "layer_multiple_markers").layers[0].__getitem__("ADBE Marker");
    const times2 = mp2.keyframes.map((kf) => kf.frame_time);
    expect(py_eq(times2, sorted(times2))).toBe(true);
    expect(at(mp2.keyframes, -1).value.comment).toBe("moved");
    expect(py_slice(mp2.keyframes, null, -1).every((kf) => kf.value.comment !== "moved")).toBe(true);
  });
});

/** Collect every descendant property that has keyframes. */
function _keyframed_props(group: PropertyBase): PropertyBase[] {
  const out: PropertyBase[] = [];
  for (const p of getattr(group, "properties", [])) {
    if (py_bool(getattr(p, "keyframes", null))) out.push(p);
    out.push(..._keyframed_props(p));
  }
  return out;
}

describe("TestRemoveAllKeys", () => {
  test("test_property_reverts_to_first_key_value", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    const first_val = op.keyframes[0].value;
    op.remove_all_keys();
    expect(py_eq(op.keyframes, [])).toBe(true);
    const app2 = _roundtrip(app, tmp_path);
    const op2 = _prop(app2, "ADBE Opacity");
    expect(py_eq(op2.keyframes, [])).toBe(true);
    expect(approx(op2.value, first_val)).toBe(true);
  });

  test("test_noop_when_no_keyframes", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    op.remove_all_keys();
    op.remove_all_keys();
    expect(py_eq(op.keyframes, [])).toBe(true);
  });

  test("test_layer_remove_all_keys_recursive", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));
    expect(
      app.project.compositions.some((comp) => comp.layers.some((lay) => py_bool(_keyframed_props(lay)))),
    ).toBe(true);
    for (const comp of app.project.compositions) {
      for (const lay of comp.layers) {
        lay.remove_all_keys();
        expect(py_eq(_keyframed_props(lay), [])).toBe(true);
      }
    }
    const app2 = _roundtrip(app, tmp_path);
    for (const comp of app2.project.compositions) {
      for (const lay of comp.layers) {
        expect(py_eq(_keyframed_props(lay), [])).toBe(true);
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
    pos.set_value_at_time(t0, target);
    expect(pos.keyframes.length).toBe(n0);
    expect(approx(pos.keyframes[0].value, target)).toBe(true);
  });

  test("test_add_new_key", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("keyframe_LINEAR.aep");
    const pos = _prop(app, "ADBE Position");
    const n0 = pos.keyframes.length;
    const t = pos.keyframes[0].time + 0.25;
    const target = [99.0, 88.0, 0.0].slice(0, len(pos.keyframes[0].value));
    pos.set_value_at_time(t, target);
    expect(pos.keyframes.length).toBe(n0 + 1);
    const app2 = _roundtrip(app, tmp_path);
    expect(_prop(app2, "ADBE Position").keyframes.length).toBe(n0 + 1);
  });

  test("test_set_values_at_times", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    op.set_values_at_times([0.0, 2.0], [10.0, 90.0]);
    // The value set at each requested time is observable via value_at_time.
    expect(approx(op.value_at_time(0.0), 10.0)).toBe(true);
    expect(approx(op.value_at_time(2.0), 90.0)).toBe(true);
  });

  test("test_set_values_at_times_length_mismatch", () => {
    const app = _fresh("keyframe_HOLD.aep");
    const op = _prop(app, "ADBE Opacity");
    raises(ValueError, () => {
      op.set_values_at_times([0.0, 1.0], [10.0]);
    });
  });
});

/** add_key / remove_key / set_value_at_time for complex value types. */
describe("TestComplexTypeKeyframes", () => {
  test("test_orientation", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "layer", "orientation_with_keyframes.aep"));
    const o = _prop(app, "ADBE Orientation");
    const n0 = o.keyframes.length;
    o.set_value_at_time(at(o.keyframes, -1).time + 0.3, [12.0, 34.0, 56.0]);
    expect(o.keyframes.length).toBe(n0 + 1);
    const app2 = _roundtrip(app, tmp_path);
    const o2 = _prop(app2, "ADBE Orientation");
    expect(contains(o2.keyframes.map((k) => k.value), [12.0, 34.0, 56.0])).toBe(true);
    o2.remove_key(0);
    expect(o2.keyframes.length).toBe(n0);
  });

  test("test_marker", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "marker", "layer_marker.aep"));
    const comp = get_comp(app.project, "layer_multiple_markers");
    const mp = comp.layers[0].__getitem__("ADBE Marker");
    const n0 = mp.keyframes.length;
    mp.set_value_at_time(at(mp.keyframes, -1).time + 1.0, new MarkerValue("X"));
    mp.set_value_at_time(at(mp.keyframes, -1).time + 2.0, "str comment");
    const app2 = _roundtrip(app, tmp_path);
    const comp2 = get_comp(app2.project, "layer_multiple_markers");
    const mp2 = comp2.layers[0].__getitem__("ADBE Marker");
    const comments = mp2.keyframes.map((k) => k.value.comment);
    expect(comments.includes("X") && comments.includes("str comment")).toBe(true);
    expect(mp2.keyframes.length).toBe(n0 + 2);
  });

  test("test_shape", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));

    function get_ms(a: Application): Property<Shape> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let mp: PropertyGroup;
          try {
            mp = layer.__getitem__("ADBE Mask Parade");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(mp, "ADBE Mask Shape", out);
          for (const p of out) {
            if (py_bool(p.keyframes)) return p;
          }
        }
      }
      return null;
    }

    const ms = get_ms(app);
    py_assert(ms != null);
    const n0 = ms.keyframes.length;
    ms.set_value_at_time(
      at(ms.keyframes, -1).time + 0.5,
      new Shape([
        [10.0, 10.0],
        [80.0, 10.0],
        [80.0, 80.0],
        [10.0, 80.0],
      ]),
    );
    expect(ms.keyframes.length).toBe(n0 + 1);
    const app2 = _roundtrip(app, tmp_path);
    const ms2 = get_ms(app2);
    py_assert(ms2 != null);
    expect(ms2.keyframes.length).toBe(n0 + 1);
    ms2.remove_key(0);
    expect(ms2.keyframes.length).toBe(n0);
  });

  test("test_gradient", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "gradient_animated.aep"));

    function get_grad(a: Application): Property<Gradient> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let root: PropertyGroup;
          try {
            root = layer.__getitem__("ADBE Root Vectors Group");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(root, "ADBE Vector Grad Colors", out);
          for (const p of out) {
            if (py_bool(p.keyframes)) return p;
          }
        }
      }
      return null;
    }

    const g = get_grad(app);
    py_assert(g != null);
    const n0 = g.keyframes.length;
    g.add_key(g.keyframes[0].time + 0.1);
    expect(g.keyframes.length).toBe(n0 + 1);
    const app2 = _roundtrip(app, tmp_path);
    const g2 = get_grad(app2);
    py_assert(g2 != null);
    expect(g2.keyframes.length).toBe(n0 + 1);
  });

  test("test_text", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));

    function get_text(a: Application): Property<TextDocument> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let tp: PropertyGroup;
          try {
            tp = layer.__getitem__("ADBE Text Properties");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(tp, "ADBE Text Document", out);
          for (const p of out) {
            if (py_bool(p.keyframes)) return p;
          }
        }
      }
      return null;
    }

    const t = get_text(app);
    py_assert(t != null);
    const n0 = t.keyframes.length;
    t.set_value_at_time(at(t.keyframes, -1).time + 0.5, "NewLine");
    expect(t.keyframes.length).toBe(n0 + 1);
    const app2 = _roundtrip(app, tmp_path);
    const t2 = get_text(app2);
    py_assert(t2 != null);
    const texts = t2.keyframes.map((k) => k.value.text);
    expect(contains(texts, "NewLine")).toBe(true);
    expect(t2.keyframes.length).toBe(n0 + 1);
    t2.remove_key(0);
    expect(t2.keyframes.length).toBe(n0);
  });

  test("test_added_shape_keyframe_backed_by_own_chunk", () => {
    // Regression: a newly added shape keyframe must wrap its own chunk,
    // not alias the donor keyframe's Shape; otherwise editing the new
    // keyframe's value would write through to the donor's chunk.
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));
    let ms: Property<Shape> | null = null;
    for (const comp of app.project.compositions) {
      for (const layer of comp.layers) {
        let mp: PropertyGroup;
        try {
          mp = layer.__getitem__("ADBE Mask Parade");
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
    py_assert(ms != null);
    const t = at(ms.keyframes, -1).time + 0.5;
    ms.add_key(t);
    const idx = ms.nearest_key_index(t);
    const new_shph = ms.keyframes[idx].value._shph;
    const others = ms.keyframes.filter((_k, j) => j !== idx).map((k) => k.value._shph);
    expect(others.every((o) => new_shph !== o)).toBe(true);
  });

  test("test_remove_last_marker_key", () => {
    // Markers have no static value: removing the last one leaves the
    // valid zero-marker state, and a new marker can be added again.
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "marker", "layer_marker.aep"));
    const comp = get_comp(app.project, "layer_multiple_markers");
    const mp = comp.layers[0].__getitem__("ADBE Marker");
    while (py_bool(mp.keyframes)) {
      mp.remove_key(0);
    }
    const app2 = _roundtrip(app, tmp_path);
    const comp2 = get_comp(app2.project, "layer_multiple_markers");
    const mp2 = comp2.layers[0].__getitem__("ADBE Marker");
    expect(py_eq(mp2.keyframes, [])).toBe(true);
    mp2.set_value_at_time(1.0, new MarkerValue("back"));
    const app3 = _roundtrip(app2, tmp_path);
    const comp3 = app3.project.compositions.find((c) => c.name === "layer_multiple_markers");
    if (comp3 === undefined) throw new StopIteration();
    const mp3 = comp3.layers[0].__getitem__("ADBE Marker");
    expect(py_eq(mp3.keyframes.map((k) => k.value.comment), ["back"])).toBe(true);
  });

  test("test_remove_last_text_key_reverts_to_static", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));

    function get_text(a: Application): Property<TextDocument> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let tp: PropertyGroup;
          try {
            tp = layer.__getitem__("ADBE Text Properties");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(tp, "ADBE Text Document", out);
          for (const p of out) {
            if (py_bool(p.keyframes) || p.value != null) return p;
          }
        }
      }
      return null;
    }

    const t = get_text(app);
    py_assert(t != null);
    // The last keyframe removed provides the static value.
    const last_text = at(t.keyframes, -1).value.text;
    while (py_bool(t.keyframes)) {
      t.remove_key(0);
    }
    expect(t.value.text).toBe(last_text);
    const app2 = _roundtrip(app, tmp_path);
    const t2 = get_text(app2);
    py_assert(t2 != null);
    expect(py_eq(t2.keyframes, [])).toBe(true);
    expect(t2.value.text).toBe(last_text);
  });

  test("test_remove_last_shape_key_reverts_to_static", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));

    function get_ms(a: Application): Property<Shape> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let mp: PropertyGroup;
          try {
            mp = layer.__getitem__("ADBE Mask Parade");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(mp, "ADBE Mask Shape", out);
          for (const p of out) {
            if (py_bool(p.keyframes) || p.value != null) return p;
          }
        }
      }
      return null;
    }

    const ms = get_ms(app);
    py_assert(ms != null);
    // The last keyframe removed provides the static value.
    const last_vertices = at(ms.keyframes, -1).value.vertices;
    while (py_bool(ms.keyframes)) {
      ms.remove_key(0);
    }
    const app2 = _roundtrip(app, tmp_path);
    const ms2 = get_ms(app2);
    py_assert(ms2 != null);
    expect(py_eq(ms2.keyframes, [])).toBe(true);
    expect(_approx_points(ms2.value.vertices, last_vertices)).toBe(true);
  });

  test("test_remove_last_gradient_key_reverts_to_static", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "gradient_animated.aep"));

    function get_grad(a: Application): Property<Gradient> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let root: PropertyGroup;
          try {
            root = layer.__getitem__("ADBE Root Vectors Group");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(root, "ADBE Vector Grad Colors", out);
          for (const p of out) {
            if (py_bool(p.keyframes) || p.value != null) return p;
          }
        }
      }
      return null;
    }

    const g = get_grad(app);
    py_assert(g != null);
    while (py_bool(g.keyframes)) {
      g.remove_key(0);
    }
    const app2 = _roundtrip(app, tmp_path);
    const g2 = get_grad(app2);
    py_assert(g2 != null);
    expect(py_eq(g2.keyframes, [])).toBe(true);
    expect(g2.value != null).toBe(true);
  });

  test("test_remove_last_orientation_key_reverts_to_static", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "layer", "orientation_with_keyframes.aep"));
    const o = _prop(app, "ADBE Orientation");
    let last_value: PropertyValue = null;
    while (py_bool(o.keyframes)) {
      last_value = o.keyframes[0].value;
      o.remove_key(0);
    }
    expect(approx(o.value, last_value)).toBe(true);
    const app2 = _roundtrip(app, tmp_path);
    const o2 = _prop(app2, "ADBE Orientation");
    expect(py_eq(o2.keyframes, [])).toBe(true);
    expect(approx(o2.value, last_value)).toBe(true);
  });

  test("test_animate_static_text", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "layer", "type.aep"));

    function get_text(a: Application): Property<TextDocument> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let tp: PropertyGroup;
          try {
            tp = layer.__getitem__("ADBE Text Properties");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(tp, "ADBE Text Document", out);
          if (py_bool(out)) return out[0];
        }
      }
      return null;
    }

    const t = get_text(app);
    py_assert(t != null);
    expect(py_eq(t.keyframes, [])).toBe(true);
    const original = t.value.text;
    const idx = t.add_key(1.0);
    expect(idx).toBe(0);
    expect(t.keyframes.length).toBe(1);
    expect(t.keyframes[0].value.text).toBe(original);
    const app2 = _roundtrip(app, tmp_path);
    const t2 = get_text(app2);
    py_assert(t2 != null);
    expect(t2.keyframes.length).toBe(1);
    expect(approx(t2.keyframes[0].time, 1.0)).toBe(true);
    expect(t2.keyframes[0].value.text).toBe(original);
    t2.set_value_at_time(2.0, "Second");
    const app3 = _roundtrip(app2, tmp_path);
    const t3 = get_text(app3);
    py_assert(t3 != null);
    expect(py_eq(t3.keyframes.map((k) => k.value.text), [original, "Second"])).toBe(true);
  });

  test("test_animate_static_mask_shape", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "mask.aep"));

    function get_ms(a: Application): Property<Shape> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let mp: PropertyGroup;
          try {
            mp = layer.__getitem__("ADBE Mask Parade");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(mp, "ADBE Mask Shape", out);
          if (py_bool(out)) return out[0];
        }
      }
      return null;
    }

    const ms = get_ms(app);
    py_assert(ms != null);
    expect(py_eq(ms.keyframes, [])).toBe(true);
    const vertices = ms.value.vertices;
    ms.add_key(1.0);
    expect(ms.keyframes.length).toBe(1);
    const app2 = _roundtrip(app, tmp_path);
    const ms2 = get_ms(app2);
    py_assert(ms2 != null);
    expect(ms2.keyframes.length).toBe(1);
    expect(approx(ms2.keyframes[0].time, 1.0)).toBe(true);
    expect(_approx_points(ms2.keyframes[0].value.vertices, vertices)).toBe(true);
  });

  test("test_animate_static_gradient", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "gradient.aep"));

    function get_grad(a: Application): Property<Gradient> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let root: PropertyGroup;
          try {
            root = layer.__getitem__("ADBE Root Vectors Group");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(root, "ADBE Vector Grad Colors", out);
          if (py_bool(out)) return out[0];
        }
      }
      return null;
    }

    const g = get_grad(app);
    py_assert(g != null);
    expect(py_eq(g.keyframes, [])).toBe(true);
    expect(g.value != null).toBe(true);
    g.add_key(0.5);
    expect(g.keyframes.length).toBe(1);
    const app2 = _roundtrip(app, tmp_path);
    const g2 = get_grad(app2);
    py_assert(g2 != null);
    expect(g2.keyframes.length).toBe(1);
    expect(g2.keyframes[0].value != null).toBe(true);
  });

  test("test_animate_static_orientation", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "mask.aep"));
    const o = _prop(app, "ADBE Orientation");
    expect(py_eq(o.keyframes, [])).toBe(true);
    o.set_value_at_time(1.0, [10.0, 20.0, 30.0]);
    expect(o.keyframes.length).toBe(1);
    const app2 = _roundtrip(app, tmp_path);
    const o2 = _prop(app2, "ADBE Orientation");
    expect(o2.keyframes.length).toBe(1);
    expect(approx(o2.keyframes[0].value, [10.0, 20.0, 30.0])).toBe(true);
  });

  test("test_add_first_marker_to_unmarked_layer", () => {
    // A never-marked layer has no mrst subtree at all; adding the first
    // marker materializes it.
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "mask.aep"));
    const mp = app.project.compositions[0].layers[0].__getitem__("ADBE Marker");
    expect(py_eq(mp.keyframes, [])).toBe(true);
    expect(mp._kf_value_container == null).toBe(true);
    mp.set_value_at_time(1.0, new MarkerValue("first"));
    const app2 = _roundtrip(app, tmp_path);
    const mp2 = app2.project.compositions[0].layers[0].__getitem__("ADBE Marker");
    expect(py_eq(mp2.keyframes.map((k) => k.value.comment), ["first"])).toBe(true);
    expect(approx(mp2.keyframes[0].time, 1.0)).toBe(true);
    mp2.remove_key(0);
    const app3 = _roundtrip(app2, tmp_path);
    const mp3 = app3.project.compositions[0].layers[0].__getitem__("ADBE Marker");
    expect(py_eq(mp3.keyframes, [])).toBe(true);
  });

  test("test_animate_pristine_camera_orientation", () => {
    // A never-modified camera orientation is stored as a bare tdbs (no
    // otst / otky); keying it materializes the wrapper.
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "layer", "type.aep"));

    function get_orient(a: Application): Property | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          if (layer.name !== "CameraLayer") continue;
          const found = [...layer.transform].find((p) => p.match_name === "ADBE Orientation");
          if (found === undefined) throw new StopIteration();
          return as_instance(found, Property);
        }
      }
      return null;
    }

    const o = get_orient(app);
    py_assert(o != null);
    expect(py_eq(o.keyframes, [])).toBe(true);
    expect(o._kf_value_container == null).toBe(true);
    o.set_value_at_time(1.0, [10.0, 20.0, 30.0]);
    const app2 = _roundtrip(app, tmp_path);
    const o2 = get_orient(app2);
    py_assert(o2 != null);
    expect(o2.keyframes.length).toBe(1);
    expect(approx(o2.keyframes[0].value, [10.0, 20.0, 30.0])).toBe(true);
    o2.remove_key(0);
    const app3 = _roundtrip(app2, tmp_path);
    const o3 = get_orient(app3);
    py_assert(o3 != null);
    expect(py_eq(o3.keyframes, [])).toBe(true);
    expect(approx(o3.value, [10.0, 20.0, 30.0])).toBe(true);
  });

  test("test_animate_never_edited_gradient", () => {
    // A never-edited gradient fill has no GCst data; the first keyframe
    // materializes it with AE's default gradient.
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "property", "all_animated.aep"));

    function get_grad(a: Application): Property<Gradient> | null {
      for (const comp of a.project.compositions) {
        for (const layer of comp.layers) {
          let root: PropertyGroup;
          try {
            root = layer.__getitem__("ADBE Root Vectors Group");
          } catch (e) {
            continue;
          }
          const out: Property[] = [];
          _walk(root, "ADBE Vector Grad Colors", out);
          if (py_bool(out)) return out[0];
        }
      }
      return null;
    }

    const g = get_grad(app);
    py_assert(g != null);
    expect(py_eq(g.keyframes, [])).toBe(true);
    expect(g._kf_value_container == null).toBe(true);
    g.add_key(0.5);
    expect(g.keyframes.length).toBe(1);
    const app2 = _roundtrip(app, tmp_path);
    const g2 = get_grad(app2);
    py_assert(g2 != null);
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
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_ROOT.div("models", "marker", "layer_marker.aep"));
    const comp = get_comp(app.project, "layer_multiple_markers");
    const mp = comp.layers[0].__getitem__("ADBE Marker");
    while (py_bool(mp.keyframes)) {
      mp.remove_key(0);
    }

    const shared = new MarkerValue("shared");
    mp.set_value_at_time(0.0, shared);
    mp.set_value_at_time(1.0, shared);
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
    expect(py_eq(k0.value.params, new Map())).toBe(true);
    expect(k0.value._nmhd.num_params).toBe(0);
    expect(k1.value._nmhd.num_params).toBe(2);

    const app2 = _roundtrip(app, tmp_path);
    const comp2 = get_comp(app2.project, "layer_multiple_markers");
    const mp2 = comp2.layers[0].__getitem__("ADBE Marker");
    const by_comment = new Map(mp2.keyframes.map((k) => [k.value.comment, k.value] as const));
    expect(py_eq(getitem(by_comment, "first_only").params, new Map())).toBe(true);
    expect(getitem(by_comment, "first_only")._nmhd.num_params).toBe(0);
    expect(
      py_eq(
        getitem(by_comment, "shared").params,
        new Map([
          ["a", "1"],
          ["b", "2"],
        ]),
      ),
    ).toBe(true);
    expect(getitem(by_comment, "shared")._nmhd.num_params).toBe(2);
  });

  test("test_gradient_set_value_at_time_not_aliased", () => {
    // BUG 2: set_value_at_time(kf1.time, kf0.value) must rebind kf1 to its
    // own chunk; mutating kf1 afterwards must not change kf0.
    const tmp_path = make_tmp_path();
    const app = parse_aep(GRAD_ANIM);
    const g = _grad_kf_prop(app);
    py_assert(g != null);
    const kf0 = g.keyframes[0];
    const kf1 = g.keyframes[1];
    const kf0_xml_before = kf0.value._utf8.value;

    g.set_value_at_time(kf1.time, kf0.value);
    expect(kf1.value !== kf0.value).toBe(true);
    kf1.value.add_color_stop(0.5, 0.5, [1.0, 0.0, 0.0]);
    expect(kf0.value._utf8.value).toBe(kf0_xml_before);

    const app2 = _roundtrip(app, tmp_path);
    const g2 = _grad_kf_prop(app2);
    py_assert(g2 != null);
    expect(g2.keyframes[0].value.color_stops.length).toBe(kf0.value.color_stops.length);
    expect(g2.keyframes[1].value.color_stops.length).toBe(kf1.value.color_stops.length);
    expect(g2.keyframes[0].value.color_stops.length !== g2.keyframes[1].value.color_stops.length).toBe(true);
  });

  test("test_orientation_keyframe_value_persists", () => {
    // BUG 3: assigning kf.value on an animated orientation must write the
    // parallel otda container, not just the in-memory shadow.
    const tmp_path = make_tmp_path();
    const app = parse_aep(ORIENT_ANIM);
    const o = _orientation_kf_prop(app);
    py_assert(o != null);
    o.keyframes[0].value = [0.0, 0.0, 90.0];
    expect(py_eq(o.keyframes[0].value, [0.0, 0.0, 90.0])).toBe(true);

    const app2 = _roundtrip(app, tmp_path);
    const o2 = _orientation_kf_prop(app2);
    py_assert(o2 != null);
    expect(py_eq(o2.keyframes[0].value, [0.0, 0.0, 90.0])).toBe(true);
  });

  test("test_static_gradient_value_reassign_persists", () => {
    // BUG 4 (implemented kind): assigning a new Gradient to a static
    // gradient property rebuilds its GCky container chunk.
    const tmp_path = make_tmp_path();
    const app = parse_aep(GRAD_STATIC);
    const g = _grad_static_prop(app);
    py_assert(g != null);
    const new_grad = new Gradient();
    new_grad.add_color_stop(0.5, 0.5, [1.0, 0.0, 0.0]);
    const n_stops = new_grad.color_stops.length;
    g.value = new_grad;

    const app2 = _roundtrip(app, tmp_path);
    const g2 = _grad_static_prop(app2);
    py_assert(g2 != null);
    expect(g2.value.color_stops.length).toBe(n_stops);
  });

  test("test_static_text_value_reassign_raises", () => {
    // BUG 4 (rejected kind): a brand-new TextDocument cannot replace a
    // static text value (the btdk COS blob is byte-format-sensitive);
    // the documented in-place alternative is mutating prop.value.text.
    const app = parse_aep(TEXT_STATIC);
    const t = _text_static_prop(app);
    py_assert(t != null);
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
    const tmp_path = make_tmp_path();
    const app = parse_aep(TEXT_STATIC);
    const t = _text_static_prop(app);
    py_assert(t != null);
    t.value.text = "CHANGED_TEXT";
    const app2 = _roundtrip(app, tmp_path);
    const t2 = _text_static_prop(app2);
    py_assert(t2 != null);
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
        kf.spatial_auto_bezier = false;
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
        kf.spatial_continuous = false;
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
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const comp = project.compositions[0];
    expect(comp.frame_rate).toBe(25.0);
    const prop = comp.layers[0].transform.__getitem__("ADBE Opacity");
    prop.add_key(1.5);

    const keyframe = prop.keyframes.find((k) => k.time_units === 38400);
    if (keyframe === undefined) throw new StopIteration();
    expect(approx(keyframe.time, 1.5)).toBe(true);

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = parse_aep(out).project.compositions[0];
    const prop2 = comp2.layers[0].transform.__getitem__("ADBE Opacity");
    const keyframe2 = prop2.keyframes.find((k) => k.time_units === 38400);
    if (keyframe2 === undefined) throw new StopIteration();
    expect(approx(keyframe2.time, 1.5)).toBe(true);
  });

  /** `kf.time = kf.time` used to snap an off-grid keyframe to the nearest frame. */
  test("test_rewriting_its_own_time_does_not_move_a_keyframe", () => {
    const project = parse_project_fresh(SAMPLE);
    const prop = project.compositions[0].layers[0].transform.__getitem__("ADBE Opacity");
    prop.add_key(1.5);
    const keyframe = prop.keyframes.find((k) => k.time_units === 38400);
    if (keyframe === undefined) throw new StopIteration();

    keyframe.time = keyframe.time;

    expect(keyframe.time_units).toBe(38400);
  });

  /**
   * Sub-frame keyframes inside one frame are distinct, so the
   * duplicate-time guard must compare units and not frame indices.
   */
  test("test_two_keyframes_can_share_a_frame", () => {
    const project = parse_project_fresh(SAMPLE);
    const prop = project.compositions[0].layers[0].transform.__getitem__("ADBE Opacity");
    // Both round to frame 37 at 25 fps (37.025 and 37.375) while
    // occupying different timebase units.
    prop.add_key(1.481);
    prop.add_key(1.495);

    const units = sorted(prop.keyframes.map((k) => k.time_units));
    expect(new Set(units).size).toBe(units.length);
    const inside = prop.keyframes.filter((k) => k.frame_time === 37);
    expect(inside.length).toBe(2);
  });

  test("test_frame_time_still_rounds", () => {
    const project = parse_project_fresh(SAMPLE);
    const prop = project.compositions[0].layers[0].transform.__getitem__("ADBE Opacity");
    prop.add_key(1.5);
    const keyframe = prop.keyframes.find((k) => k.time_units === 38400);
    if (keyframe === undefined) throw new StopIteration();
    expect(keyframe.frame_time).toBe(38);
    expect(approx(keyframe.time, 1.5)).toBe(true);
  });

  /**
   * Keyframe times are stored relative to the layer start; an
   * off-grid start must not quantize the keyframe.
   */
  test("test_layer_start_offset_stays_in_seconds", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    layer.start_time = 0.29166666666666663; // 7/24 s, off the 25 fps grid
    const prop = layer.transform.__getitem__("ADBE Opacity");
    prop.add_key(2.0);

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const comp2 = parse_aep(out).project.compositions[0];
    const prop2 = comp2.layers[0].transform.__getitem__("ADBE Opacity");
    // Times are an integer count of timebase units, so a request that
    // falls between units lands on the nearest one - AE requantizes
    // identically (it stored 0.99998697916667 for a 1.0 s request on a
    // layer with this start).
    const half_unit = 0.5 / comp2._cdta.internal_timebase;
    expect(prop2.keyframes.some((k) => Math.abs(k.time - 2.0) <= half_unit)).toBe(true);
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

  function _bowed_path(bow: number): Property<number[]> {
    const project = parse_project_fresh(SAMPLE);
    const comp = project.compositions[0];
    expect(comp.frame_rate).toBe(25.0);
    const prop = comp.layers[0].transform.__getitem__("ADBE Position");
    while (py_bool(prop.keyframes)) {
      prop.remove_key(0);
    }
    for (const [time, value] of [
      [0.0, 0.0],
      [1.0, 100.0],
      [4.0, 600.0],
    ] as const) {
      prop.add_key(time);
      at(prop.keyframes, -1).value = [value, 200.0, 0.0];
    }
    for (const keyframe of prop.keyframes) {
      keyframe.in_interpolation_type = KeyframeInterpolationType.BEZIER;
      keyframe.out_interpolation_type = KeyframeInterpolationType.BEZIER;
    }
    prop.keyframes[0].out_spatial_tangent = [0.0, bow, 0.0];
    prop.keyframes[1].in_spatial_tangent = [0.0, bow, 0.0];
    return prop;
  }

  /**
   * AE put the roving key at 2.2205078125 s (56845 units). The chord
   * between the same keyframes would put it at 0.667 s.
   */
  test("test_roving_uses_arc_length_not_chord", () => {
    const prop = _bowed_path(400.0);
    expect(prop.keyframes[1].time).toBe(1.0);

    prop.keyframes[1].roving = true;

    expect(prop.keyframes[1].time_units).toBe(56845);
    expect(approx(prop.keyframes[1].time, 2.2205078125)).toBe(true);
  });

  /**
   * A shallower bow shortens the first segment, so AE pulls the key
   * back to 0.819296875 s (20974 units).
   */
  test("test_flattening_the_path_moves_the_roving_key", () => {
    const prop = _bowed_path(40.0);
    prop.keyframes[1].roving = true;
    expect(prop.keyframes[1].time_units).toBe(20974);
    expect(approx(prop.keyframes[1].time, 0.819296875)).toBe(true);
  });

  test("test_roving_survives_a_save", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const comp = project.compositions[0];
    const prop = comp.layers[0].transform.__getitem__("ADBE Position");
    while (py_bool(prop.keyframes)) {
      prop.remove_key(0);
    }
    for (const [time, value] of [
      [0.0, 0.0],
      [1.0, 100.0],
      [4.0, 600.0],
    ] as const) {
      prop.add_key(time);
      at(prop.keyframes, -1).value = [value, 200.0, 0.0];
    }
    prop.keyframes[1].roving = true;
    const moved = prop.keyframes[1].time_units;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const prop2 = parse_aep(out).project.compositions[0].layers[0].transform.__getitem__("ADBE Position");
    expect(prop2.keyframes[1].roving).toBe(true);
    expect(prop2.keyframes[1].time_units).toBe(moved);
  });

  /**
   * AE does not restore the original time: the redistribution already
   * happened, and turning the flag off leaves the key where it moved to.
   */
  test("test_unroving_keeps_the_redistributed_time", () => {
    const prop = _bowed_path(400.0);
    prop.keyframes[1].roving = true;
    const moved = prop.keyframes[1].time_units;

    prop.keyframes[1].roving = false;

    expect(prop.keyframes[1].roving).toBe(false);
    expect(prop.keyframes[1].time_units).toBe(moved);
  });

  /** AE raises here: "This property does not have a spatial PropertyValueType". */
  test("test_non_spatial_property_is_rejected", () => {
    const project = parse_project_fresh(SAMPLES.div("keyframe_misc.aep"));
    const prop = project.compositions[0].layers[0].transform.__getitem__("ADBE Scale");
    expect(py_bool(prop.is_spatial)).toBe(false);
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
    const prop = _bowed_path(400.0);
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
  function _uneven_position(): Property<number[]> {
    const project = parse_project_fresh(SAMPLES.div("effect_point_speed.aep"));
    const prop = project.compositions[0].layers[0].transform.__getitem__("ADBE Position");
    while (py_bool(prop.keyframes)) {
      prop.remove_key(0);
    }
    for (const [time, x] of [
      [0.0, 0.0],
      [1.0, 100.0],
      [4.0, 600.0],
    ] as const) {
      prop.add_key(time);
      at(prop.keyframes, -1).value = [x, 0.0, 0.0];
    }
    for (const keyframe of prop.keyframes) {
      keyframe.in_interpolation_type = KeyframeInterpolationType.BEZIER;
      keyframe.out_interpolation_type = KeyframeInterpolationType.BEZIER;
    }
    return prop;
  }

  test("test_spatial_auto_bezier_writes_the_derived_tangents", () => {
    const prop = _uneven_position();
    const keyframe = prop.keyframes[1];
    keyframe.in_spatial_tangent = [-40.0, -10.0, 0.0];
    keyframe.out_spatial_tangent = [70.0, 25.0, 0.0];
    const stored = as_instance(keyframe._ldat_item.kf_data, KfPosition);

    keyframe.spatial_auto_bezier = true;

    expect(approx([...stored.out_spatial_tangents], [100.0, 0.0, 0.0])).toBe(true);
    expect(approx([...stored.in_spatial_tangents], [-100.0, 0.0, 0.0])).toBe(true);
  });

  test("test_spatial_auto_bezier_forces_continuity", () => {
    const prop = _uneven_position();
    const keyframe = prop.keyframes[1];
    keyframe.spatial_continuous = false;

    keyframe.spatial_auto_bezier = true;

    expect(keyframe.spatial_continuous).toBe(true);
  });

  /** AE does not restore what was there before. */
  test("test_clearing_spatial_auto_bezier_keeps_the_derived_tangents", () => {
    const prop = _uneven_position();
    const keyframe = prop.keyframes[1];
    keyframe.spatial_auto_bezier = true;
    keyframe.spatial_auto_bezier = false;
    const stored = as_instance(keyframe._ldat_item.kf_data, KfPosition);
    expect(approx([...stored.out_spatial_tangents], [100.0, 0.0, 0.0])).toBe(true);
  });

  /**
   * 2-D Scale 100->200->400 and 100->120->150 over 2 s gives per
   * dimension speeds 150 and 25, not one shared scalar.
   */
  test("test_temporal_auto_bezier_is_per_dimension", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES.div("keyframe_misc.aep"));
    const prop = project.compositions[0].layers[0].transform.__getitem__("ADBE Scale");
    while (py_bool(prop.keyframes)) {
      prop.remove_key(0);
    }
    const scale_values: [number, number[]][] = [
      [0.0, [100.0, 100.0, 100.0]],
      [1.0, [200.0, 120.0, 100.0]],
      [2.0, [400.0, 150.0, 100.0]],
    ];
    for (const [time, value] of scale_values) {
      prop.add_key(time);
      at(prop.keyframes, -1).value = value;
    }
    for (const keyframe of prop.keyframes) {
      keyframe.in_interpolation_type = KeyframeInterpolationType.BEZIER;
      keyframe.out_interpolation_type = KeyframeInterpolationType.BEZIER;
    }

    prop.keyframes[1].temporal_auto_bezier = true;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const prop2 = parse_aep(out).project.compositions[0].layers[0].transform.__getitem__("ADBE Scale");
    const speeds = prop2.keyframes[1].in_temporal_ease.map((ease) => ease.speed);
    expect(approx(speeds, [150.0, 25.0, 0.0])).toBe(true);
    const influences = prop2.keyframes[1].in_temporal_ease.map((ease) => ease.influence);
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

    const project = parse_project_fresh(SAMPLES.div("keyframe_misc.aep"));
    const transform = project.compositions[0].layers[0].transform;
    const scale = transform.__getitem__("ADBE Scale");
    scale.remove_all_keys();
    for (const [index, time] of times.entries()) {
      scale.set_value_at_time(time, [curves[0][index], curves[1][index], 100.0]);
    }

    const references: Property<number>[] = [];
    for (const curve of curves) {
      const reference = parse_project_fresh(SAMPLES.div("keyframe_misc.aep"));
      const rotation = reference.compositions[0].layers[0].transform.__getitem__("ADBE Rotate Z");
      rotation.remove_all_keys();
      for (const [index, time] of times.entries()) {
        rotation.set_value_at_time(time, curve[index]);
      }
      references.push(rotation);
    }

    for (const prop of [scale, ...references]) {
      for (const keyframe of prop.keyframes) {
        keyframe.in_interpolation_type = KeyframeInterpolationType.BEZIER;
        keyframe.out_interpolation_type = KeyframeInterpolationType.BEZIER;
        keyframe.temporal_auto_bezier = true;
      }
    }

    for (const sample of [1.25, 1.5, 1.75]) {
      const composed = scale.value_at_time(sample);
      const expected = references.map((reference) => reference.value_at_time(sample));
      expect(approx(composed.slice(0, 2), expected)).toBe(true);
    }
  });

  test("test_temporal_auto_bezier_forces_continuity_and_bezier", () => {
    const prop = _uneven_position();
    const keyframe = prop.keyframes[1];
    keyframe.in_interpolation_type = KeyframeInterpolationType.LINEAR;
    keyframe.out_interpolation_type = KeyframeInterpolationType.LINEAR;
    keyframe.temporal_continuous = false;

    keyframe.temporal_auto_bezier = true;

    expect(keyframe.temporal_continuous).toBe(true);
    expect<KeyframeInterpolationType>(keyframe.in_interpolation_type).toBe(KeyframeInterpolationType.BEZIER);
    expect<KeyframeInterpolationType>(keyframe.out_interpolation_type).toBe(KeyframeInterpolationType.BEZIER);
  });

  /**
   * AE turns (10, 75) / (90, 25) into (10, 75) / (10, 25): the speeds
   * are tied, both influences survive.
   */
  test("test_temporal_continuous_ties_the_out_speed_to_the_in_speed", () => {
    const project = parse_project_fresh(SAMPLES.div("keyframe_bezier_nonzero_speed.aep"));
    const prop = as_instance(
      project.compositions[0].layers
        .flatMap((layer) => layer.transform.properties)
        .find((g) => py_bool(as_instance(g, Property).keyframes) && g.match_name === "ADBE Opacity"),
      Property,
    );
    const keyframe = prop.keyframes[0];
    const in_speed = keyframe.in_temporal_ease[0].speed;
    const out_influence = keyframe.out_temporal_ease[0].influence;
    expect(keyframe.out_temporal_ease[0].speed !== in_speed).toBe(true);

    keyframe.temporal_continuous = true;

    expect(approx(keyframe.out_temporal_ease[0].speed, in_speed)).toBe(true);
    expect(approx(keyframe.out_temporal_ease[0].influence, out_influence)).toBe(true);
  });

  /**
   * AE 2026 (`scripts/jsx/temporal_continuous_probe.jsx`): setting
   * temporal continuity rewrites BOTH interpolation types to BEZIER
   * first, in all five in/out pairings tried. That is what makes the
   * STORED in speed the one to copy - a LINEAR side reports the segment
   * slope (100 on this ramp) but AE gives back the stored 10.
   */
  test("test_temporal_continuous_forces_bezier_and_uses_the_stored_speed", () => {
    const prop = _uneven_position();
    const keyframe = prop.keyframes[1];
    keyframe.in_temporal_ease = [new KeyframeEase(10.0, 75.0)];
    keyframe.out_temporal_ease = [new KeyframeEase(90.0, 25.0)];
    keyframe.in_interpolation_type = KeyframeInterpolationType.LINEAR;
    // The LINEAR side reports the segment slope, not the stored 10.
    expect(approx(keyframe.in_temporal_ease[0].speed, 100.0)).toBe(true);

    keyframe.temporal_continuous = true;

    expect<KeyframeInterpolationType>(keyframe.in_interpolation_type).toBe(KeyframeInterpolationType.BEZIER);
    expect(keyframe.out_interpolation_type).toBe(KeyframeInterpolationType.BEZIER);
    expect(approx(keyframe.in_temporal_ease[0].speed, 10.0)).toBe(true);
    expect(approx(keyframe.in_temporal_ease[0].influence, 75.0)).toBe(true);
    expect(approx(keyframe.out_temporal_ease[0].speed, 10.0)).toBe(true);
    expect(approx(keyframe.out_temporal_ease[0].influence, 25.0)).toBe(true);
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
      const tmp_path = make_tmp_path();
      const project = parse_project_fresh(SAMPLES.div("keyframe_bezier_asymmetric_ease_1D.aep"));
      const prop = as_instance(
        project.compositions[0].layers
          .flatMap((layer) => layer.transform.properties)
          .find((g) => py_bool(as_instance(g, Property).keyframes)),
        Property,
      );
      const keyframe = prop.keyframes[0];
      const stored = as_instance(keyframe._ldat_item.kf_data, KfMultiDimensional);
      const before = [[...stored.in_influence], [...stored.out_influence]];
      expect(approx(before[1], [0.9])).toBe(true);

      keyframe.in_interpolation_type = interpolation;
      keyframe.out_interpolation_type = interpolation;

      expect(approx([...stored.in_influence], before[0])).toBe(true);
      expect(approx([...stored.out_influence], before[1])).toBe(true);

      keyframe.in_interpolation_type = KeyframeInterpolationType.BEZIER;
      keyframe.out_interpolation_type = KeyframeInterpolationType.BEZIER;
      expect(approx(keyframe.out_temporal_ease[0].influence, 90.0)).toBe(true);

      const out = tmp_path.div("modified.aep");
      project.save(out);
      const prop2 = as_instance(
        parse_aep(out).project.compositions[0].layers
          .flatMap((layer) => layer.transform.properties)
          .find((g) => py_bool(as_instance(g, Property).keyframes)),
        Property,
      );
      const reloaded = as_instance(prop2.keyframes[0]._ldat_item.kf_data, KfMultiDimensional);
      expect(approx([...reloaded.out_influence], before[1])).toBe(true);
    },
  );
});
