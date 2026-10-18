/**
 * Tests for CompItem.precompose().
 *
 * Mutation tests parse a fresh (uncached) copy via `parse_aep` and assert
 * results survive a save / re-parse round-trip. AE-side ground truth
 * (AE 2026 fixtures) is documented in .claude/plans/precompose.md.
 */

import "../../src/py_aep/binary/_register.ts";
import { describe, expect, test } from "bun:test";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import { Path, py_eq, StopIteration, TypeError_, ValueError } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { as_instance, get_comp } from "../helpers.ts";
import { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";
import { AVItem } from "../../src/py_aep/models/items/av_item.ts";

const SAMPLES = new Path(import.meta.dir).parent.parent.div("samples", "models");

function _fresh(rel: string) {
  return parse_aep(String(SAMPLES.div(rel)));
}

// NOTE(port): local equivalent of pytest.raises((TypeError, ValueError)); any listed class passes, others propagate, as in Python.
function raises_any(classes: (abstract new (...a: never[]) => Error)[], fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    for (const c of classes) if (e instanceof c) return e;
    throw e;
  }
  throw new Error(`DID NOT RAISE ${classes.map((c) => c.name).join(", ")}`);
}

// NOTE(port): local stand-in for Python `next(genexpr)`; first match or StopIteration, as in CPython.
function _next<T>(items: Iterable<T>, pred: (x: T) => boolean): T {
  for (const x of items) if (pred(x)) return x;
  throw new StopIteration();
}

describe("TestPrecomposeMove", () => {
  /** move_all_attributes=True (default). */

  test("test_two_layers_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = get_comp(app.project, "Comp 1");
    const new_comp = comp.precompose([0, 1], "Pre-comp 1");

    expect(new_comp.name).toBe("Pre-comp 1");
    expect(py_eq(new_comp.layers.map((ly) => ly.name), ["Gray Solid 1", "Gray Solid 2"])).toBe(true);
    expect(comp.layers.length).toBe(1);
    const repl = as_instance(comp.layers[0], AVLayer);
    expect(repl.source).toBe(new_comp);

    const out = tmp_path.div("precomp.aep");
    app.project.save(out);
    const app2 = parse_aep(String(out));
    const comp2 = get_comp(app2.project, "Comp 1");
    const nc2 = get_comp(app2.project, "Pre-comp 1");
    expect(py_eq(nc2.layers.map((ly) => ly.name), ["Gray Solid 1", "Gray Solid 2"])).toBe(true);
    expect(as_instance(comp2.layers[0], AVLayer).source).toBe(nc2);
  });

  test("test_settings_inherited", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = get_comp(app.project, "Comp 1");
    const new_comp = comp.precompose([0], "PC");
    expect(new_comp.width).toBe(comp.width);
    expect(new_comp.height).toBe(comp.height);
    expect(new_comp.duration).toBe(comp.duration);
    expect(new_comp.frameRate).toBe(comp.frameRate);
    expect(py_eq(new_comp.bgColor, comp.bgColor)).toBe(true);
  });

  test("test_replacement_at_topmost_moved_index", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("property/all_animated.aep");
    const comp = get_comp(app.project, "type_camera");
    expect(py_eq(comp.layers.map((ly) => ly.name), ["Hello", "Shape Layer 1", "XF", "CameraLayer"])).toBe(true);
    comp.precompose([1, 2], "PC mid");
    expect(py_eq(comp.layers.map((ly) => ly.name), ["Hello", "PC mid", "CameraLayer"])).toBe(true);

    const out = tmp_path.div("mid.aep");
    app.project.save(out);
    const comp2 = get_comp(parse_aep(String(out)).project, "type_camera");
    expect(py_eq(comp2.layers.map((ly) => ly.name), ["Hello", "PC mid", "CameraLayer"])).toBe(true);
  });

  test("test_new_comp_stored_alphabetically", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = get_comp(app.project, "Comp 1");
    comp.precompose([0], "PC alpha");
    const names = app.project.rootFolder.items.map((item) => item.name);
    // AE stores folder children in display order; the new comp lands
    // between 'Comp 1' and 'Solids'.
    expect(py_eq(names, ["Comp 1", "PC alpha", "Solids"])).toBe(true);
  });

  test("test_indices_deduped_and_sorted", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = get_comp(app.project, "Comp 1");
    const new_comp = comp.precompose([1, 0, 1], "PC dup");
    expect(py_eq(new_comp.layers.map((ly) => ly.name), ["Gray Solid 1", "Gray Solid 2"])).toBe(true);
  });

  test("test_parent_link_inside_set_remapped", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("layer/layer_misc.aep");
    const comp = get_comp(app.project, "parent");
    const new_comp = comp.precompose([0, 1], "PC par");
    const child = _next(new_comp.layers, (ly) => ly.name === "ChildLayer");
    const null_ = _next(new_comp.layers, (ly) => ly.name === "ParentNull");
    expect(child._ldta.parent_id).toBe(null_.id);

    const out = tmp_path.div("par.aep");
    app.project.save(out);
    const nc2 = get_comp(parse_aep(String(out)).project, "PC par");
    const child2 = _next(nc2.layers, (ly) => ly.name === "ChildLayer");
    expect(child2.parent != null).toBe(true);
    if (child2.parent == null) throw new Error("ChildLayer lost its parent");
    expect(child2.parent.name).toBe("ParentNull");
  });

  test("test_parent_stays_child_unparented", () => {
    const app = _fresh("layer/layer_misc.aep");
    const comp = get_comp(app.project, "parent");
    const new_comp = comp.precompose([0], "PC orphan");
    expect(new_comp.layers[0]._ldta.parent_id).toBe(0);
  });

  test("test_parent_moved_stayer_retargets_to_replacement", () => {
    const app = _fresh("layer/layer_misc.aep");
    const comp = get_comp(app.project, "parent");
    comp.precompose([1], "PC repl");
    const child = _next(comp.layers, (ly) => ly.name === "ChildLayer");
    const repl = _next(comp.layers, (ly) => ly.name === "PC repl");
    expect(child._ldta.parent_id).toBe(repl.id);
  });

  test("test_matte_pair_moved_together", () => {
    const app = _fresh("layer/track_matte_yes.aep");
    const comp = get_comp(app.project, "Comp 1");
    const new_comp = comp.precompose([0, 1], "PC matte");
    const user = _next(new_comp.layers, (ly) => ly.name === "Gray Solid 2");
    const matte = _next(new_comp.layers, (ly) => ly.name === "Gray Solid 1");
    expect(user._ldta.matte_layer_id).toBe(matte.id);
  });

  test("test_matte_stays_copied_into_precomp", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("layer/track_matte_yes.aep");
    const comp = get_comp(app.project, "Comp 1");
    const new_comp = comp.precompose([0], "PC copy");
    // AE copies the unmoved matte layer below its user; the original
    // stays untouched in the parent comp.
    expect(py_eq(new_comp.layers.map((ly) => ly.name), ["Gray Solid 2", "Gray Solid 1"])).toBe(true);
    const [user, copy] = new_comp.layers;
    expect(user._ldta.matte_layer_id).toBe(copy.id);
    expect(py_eq(comp.layers.map((ly) => ly.name), ["PC copy", "Gray Solid 1"])).toBe(true);

    const out = tmp_path.div("mattecopy.aep");
    app.project.save(out);
    const nc2 = get_comp(parse_aep(String(out)).project, "PC copy");
    const [user2, copy2] = nc2.layers;
    expect(user2._ldta.matte_layer_id).toBe(copy2.id);
  });

  test("test_matte_moved_user_retargets_to_replacement", () => {
    const app = _fresh("layer/track_matte_yes.aep");
    const comp = get_comp(app.project, "Comp 1");
    comp.precompose([1], "PC target");
    const user = _next(comp.layers, (ly) => ly.name === "Gray Solid 2");
    const repl = _next(comp.layers, (ly) => ly.name === "PC target");
    expect(user._ldta.matte_layer_id).toBe(repl.id);
    // The replacement keeps serving as matte, so it inherits the
    // moved matte layer's video-off state.
    expect(repl.enabled).toBe(false);
  });

  test("test_all_layer_kinds_move", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("property/all_animated.aep");
    const comp = get_comp(app.project, "type_camera");
    const new_comp = comp.precompose([0, 1, 2, 3], "PC all");
    expect(py_eq(new_comp.layers.map((ly) => ly.name), ["Hello", "Shape Layer 1", "XF", "CameraLayer"])).toBe(true);
    expect(py_eq(comp.layers.map((ly) => ly.name), ["PC all"])).toBe(true);

    const out = tmp_path.div("allkinds.aep");
    app.project.save(out);
    const nc2 = get_comp(parse_aep(String(out)).project, "PC all");
    expect(nc2.layers.length).toBe(4);
  });
});

describe("TestPrecomposeLeaveAttributes", () => {
  /** move_all_attributes=False. */

  test("test_source_swap_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = get_comp(app.project, "Comp 1");
    const retained = as_instance(comp.layers[1], AVLayer);
    const original_source = retained.source;
    const new_comp = comp.precompose([1], "PC leave", false);

    // The retained layer object survives with its source swapped.
    expect(comp.layers[1]).toBe(retained);
    expect(retained.source).toBe(new_comp);
    expect(py_eq(new_comp.layers.map((ly) => as_instance(ly, AVLayer).source), [original_source])).toBe(true);

    const out = tmp_path.div("leave.aep");
    app.project.save(out);
    const app2 = parse_aep(String(out));
    const comp2 = get_comp(app2.project, "Comp 1");
    const nc2 = get_comp(app2.project, "PC leave");
    expect(as_instance(comp2.layers[1], AVLayer).source).toBe(nc2);
    expect(as_instance(as_instance(nc2.layers[0], AVLayer).source, AVItem).name).toBe("Gray Solid 2");
  });

  test("test_new_comp_sized_from_source", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = get_comp(app.project, "Comp 1");
    const solid = comp.addSolid([1.0, 0.0, 0.0], "SmallRed", 400, 300);
    const new_comp = comp.precompose([0], "PC small", false);
    expect(py_eq([new_comp.width, new_comp.height], [400, 300])).toBe(true);
    // Duration / frame rate stay inherited from the parent comp.
    expect(new_comp.duration).toBe(comp.duration);
    expect(new_comp.frameRate).toBe(comp.frameRate);
    expect(solid.source).toBe(new_comp);
  });

  test("test_multiple_indices_raise", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = get_comp(app.project, "Comp 1");
    raises(ValueError, () => {
      comp.precompose([0, 1], "PC bad", false);
    });
  });

  test("test_sourceless_layer_raises", () => {
    const app = _fresh("property/all_animated.aep");
    const comp = get_comp(app.project, "type_shape");
    expect(as_instance(comp.layers[0], AVLayer).source == null).toBe(true);
    raises(ValueError, () => {
      comp.precompose([0], "PC bad", false);
    });
  });
});

describe("TestPrecomposeValidation", () => {
  test("test_empty_indices_raise", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = get_comp(app.project, "Comp 1");
    raises(ValueError, () => {
      comp.precompose([], "PC bad");
    });
  });

  test("test_out_of_range_raises", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = get_comp(app.project, "Comp 1");
    raises(ValueError, () => {
      comp.precompose([5], "PC bad");
    });
    raises(ValueError, () => {
      comp.precompose([-1], "PC bad");
    });
  });

  test("test_invalid_name_raises", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = get_comp(app.project, "Comp 1");
    raises_any([TypeError_, ValueError], () =>
      // @ts-expect-error deliberately passes a non-string name to check runtime validation
      comp.precompose([0], 123),
    );
  });
});
