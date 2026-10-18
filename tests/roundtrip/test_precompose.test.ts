/**
 * Tests for CompItem.precompose().
 *
 * Mutation tests parse a fresh (uncached) copy via `parse_aep` and assert
 * results survive a save / re-parse round-trip. AE-side ground truth
 * (AE 2026 fixtures) is documented in .claude/plans/precompose.md.
 */

import "../../src/py_aep/binary/_register.ts";
import { describe, expect, test } from "bun:test";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import { Path, pyEq, StopIteration, ValueError } from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import { asInstance, getComp } from "../helpers.ts";
import { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";
import { AVItem } from "../../src/py_aep/models/items/av_item.ts";

const SAMPLES = new Path(import.meta.dir).parent.parent.div("samples", "models");

function _fresh(rel: string) {
  return parseAep(String(SAMPLES.div(rel)));
}

// NOTE(port): local equivalent of pytest.raises((TypeError, ValueError)); any listed class passes, others propagate, as in Python.
function raisesAny(classes: (abstract new (...a: never[]) => Error)[], fn: () => unknown): Error {
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
    const tmpPath = makeTmpPath();
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = getComp(app.project, "Comp 1");
    const newComp = comp.precompose([0, 1], "Pre-comp 1");

    expect(newComp.name).toBe("Pre-comp 1");
    expect(pyEq(newComp.layers.map((ly) => ly.name), ["Gray Solid 1", "Gray Solid 2"])).toBe(true);
    expect(comp.layers.length).toBe(1);
    const repl = asInstance(comp.layers[0], AVLayer);
    expect(repl.source).toBe(newComp);

    const out = tmpPath.div("precomp.aep");
    app.project.save(out);
    const app2 = parseAep(String(out));
    const comp2 = getComp(app2.project, "Comp 1");
    const nc2 = getComp(app2.project, "Pre-comp 1");
    expect(pyEq(nc2.layers.map((ly) => ly.name), ["Gray Solid 1", "Gray Solid 2"])).toBe(true);
    expect(asInstance(comp2.layers[0], AVLayer).source).toBe(nc2);
  });

  test("test_settings_inherited", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = getComp(app.project, "Comp 1");
    const newComp = comp.precompose([0], "PC");
    expect(newComp.width).toBe(comp.width);
    expect(newComp.height).toBe(comp.height);
    expect(newComp.duration).toBe(comp.duration);
    expect(newComp.frameRate).toBe(comp.frameRate);
    expect(pyEq(newComp.bgColor, comp.bgColor)).toBe(true);
  });

  test("test_replacement_at_topmost_moved_index", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("property/all_animated.aep");
    const comp = getComp(app.project, "type_camera");
    expect(pyEq(comp.layers.map((ly) => ly.name), ["Hello", "Shape Layer 1", "XF", "CameraLayer"])).toBe(true);
    comp.precompose([1, 2], "PC mid");
    expect(pyEq(comp.layers.map((ly) => ly.name), ["Hello", "PC mid", "CameraLayer"])).toBe(true);

    const out = tmpPath.div("mid.aep");
    app.project.save(out);
    const comp2 = getComp(parseAep(String(out)).project, "type_camera");
    expect(pyEq(comp2.layers.map((ly) => ly.name), ["Hello", "PC mid", "CameraLayer"])).toBe(true);
  });

  test("test_new_comp_stored_alphabetically", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = getComp(app.project, "Comp 1");
    comp.precompose([0], "PC alpha");
    const names = app.project.rootFolder.items.map((item) => item.name);
    // AE stores folder children in display order; the new comp lands
    // between 'Comp 1' and 'Solids'.
    expect(pyEq(names, ["Comp 1", "PC alpha", "Solids"])).toBe(true);
  });

  test("test_indices_deduped_and_sorted", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = getComp(app.project, "Comp 1");
    const newComp = comp.precompose([1, 0, 1], "PC dup");
    expect(pyEq(newComp.layers.map((ly) => ly.name), ["Gray Solid 1", "Gray Solid 2"])).toBe(true);
  });

  test("test_parent_link_inside_set_remapped", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("layer/layer_misc.aep");
    const comp = getComp(app.project, "parent");
    const newComp = comp.precompose([0, 1], "PC par");
    const child = _next(newComp.layers, (ly) => ly.name === "ChildLayer");
    const null_ = _next(newComp.layers, (ly) => ly.name === "ParentNull");
    expect(child._ldta.parentId).toBe(null_.id);

    const out = tmpPath.div("par.aep");
    app.project.save(out);
    const nc2 = getComp(parseAep(String(out)).project, "PC par");
    const child2 = _next(nc2.layers, (ly) => ly.name === "ChildLayer");
    expect(child2.parent != null).toBe(true);
    if (child2.parent == null) throw new Error("ChildLayer lost its parent");
    expect(child2.parent.name).toBe("ParentNull");
  });

  test("test_parent_stays_child_unparented", () => {
    const app = _fresh("layer/layer_misc.aep");
    const comp = getComp(app.project, "parent");
    const newComp = comp.precompose([0], "PC orphan");
    expect(newComp.layers[0]._ldta.parentId).toBe(0);
  });

  test("test_parent_moved_stayer_retargets_to_replacement", () => {
    const app = _fresh("layer/layer_misc.aep");
    const comp = getComp(app.project, "parent");
    comp.precompose([1], "PC repl");
    const child = _next(comp.layers, (ly) => ly.name === "ChildLayer");
    const repl = _next(comp.layers, (ly) => ly.name === "PC repl");
    expect(child._ldta.parentId).toBe(repl.id);
  });

  test("test_matte_pair_moved_together", () => {
    const app = _fresh("layer/track_matte_yes.aep");
    const comp = getComp(app.project, "Comp 1");
    const newComp = comp.precompose([0, 1], "PC matte");
    const user = _next(newComp.layers, (ly) => ly.name === "Gray Solid 2");
    const matte = _next(newComp.layers, (ly) => ly.name === "Gray Solid 1");
    expect(user._ldta.matteLayerId).toBe(matte.id);
  });

  test("test_matte_stays_copied_into_precomp", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("layer/track_matte_yes.aep");
    const comp = getComp(app.project, "Comp 1");
    const newComp = comp.precompose([0], "PC copy");
    // AE copies the unmoved matte layer below its user; the original
    // stays untouched in the parent comp.
    expect(pyEq(newComp.layers.map((ly) => ly.name), ["Gray Solid 2", "Gray Solid 1"])).toBe(true);
    const [user, copy] = newComp.layers;
    expect(user._ldta.matteLayerId).toBe(copy.id);
    expect(pyEq(comp.layers.map((ly) => ly.name), ["PC copy", "Gray Solid 1"])).toBe(true);

    const out = tmpPath.div("mattecopy.aep");
    app.project.save(out);
    const nc2 = getComp(parseAep(String(out)).project, "PC copy");
    const [user2, copy2] = nc2.layers;
    expect(user2._ldta.matteLayerId).toBe(copy2.id);
  });

  test("test_matte_moved_user_retargets_to_replacement", () => {
    const app = _fresh("layer/track_matte_yes.aep");
    const comp = getComp(app.project, "Comp 1");
    comp.precompose([1], "PC target");
    const user = _next(comp.layers, (ly) => ly.name === "Gray Solid 2");
    const repl = _next(comp.layers, (ly) => ly.name === "PC target");
    expect(user._ldta.matteLayerId).toBe(repl.id);
    // The replacement keeps serving as matte, so it inherits the
    // moved matte layer's video-off state.
    expect(repl.enabled).toBe(false);
  });

  test("test_all_layer_kinds_move", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("property/all_animated.aep");
    const comp = getComp(app.project, "type_camera");
    const newComp = comp.precompose([0, 1, 2, 3], "PC all");
    expect(pyEq(newComp.layers.map((ly) => ly.name), ["Hello", "Shape Layer 1", "XF", "CameraLayer"])).toBe(true);
    expect(pyEq(comp.layers.map((ly) => ly.name), ["PC all"])).toBe(true);

    const out = tmpPath.div("allkinds.aep");
    app.project.save(out);
    const nc2 = getComp(parseAep(String(out)).project, "PC all");
    expect(nc2.layers.length).toBe(4);
  });
});

describe("TestPrecomposeLeaveAttributes", () => {
  /** move_all_attributes=False. */

  test("test_source_swap_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = getComp(app.project, "Comp 1");
    const retained = asInstance(comp.layers[1], AVLayer);
    const originalSource = retained.source;
    const newComp = comp.precompose([1], "PC leave", false);

    // The retained layer object survives with its source swapped.
    expect(comp.layers[1]).toBe(retained);
    expect(retained.source).toBe(newComp);
    expect(pyEq(newComp.layers.map((ly) => asInstance(ly, AVLayer).source), [originalSource])).toBe(true);

    const out = tmpPath.div("leave.aep");
    app.project.save(out);
    const app2 = parseAep(String(out));
    const comp2 = getComp(app2.project, "Comp 1");
    const nc2 = getComp(app2.project, "PC leave");
    expect(asInstance(comp2.layers[1], AVLayer).source).toBe(nc2);
    expect(asInstance(asInstance(nc2.layers[0], AVLayer).source, AVItem).name).toBe("Gray Solid 2");
  });

  test("test_new_comp_sized_from_source", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = getComp(app.project, "Comp 1");
    const solid = comp.addSolid([1.0, 0.0, 0.0], "SmallRed", 400, 300);
    const newComp = comp.precompose([0], "PC small", false);
    expect(pyEq([newComp.width, newComp.height], [400, 300])).toBe(true);
    // Duration / frame rate stay inherited from the parent comp.
    expect(newComp.duration).toBe(comp.duration);
    expect(newComp.frameRate).toBe(comp.frameRate);
    expect(solid.source).toBe(newComp);
  });

  test("test_multiple_indices_raise", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = getComp(app.project, "Comp 1");
    raises(ValueError, () => {
      comp.precompose([0, 1], "PC bad", false);
    });
  });

  test("test_sourceless_layer_raises", () => {
    const app = _fresh("property/all_animated.aep");
    const comp = getComp(app.project, "type_shape");
    expect(asInstance(comp.layers[0], AVLayer).source == null).toBe(true);
    raises(ValueError, () => {
      comp.precompose([0], "PC bad", false);
    });
  });
});

describe("TestPrecomposeValidation", () => {
  test("test_empty_indices_raise", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = getComp(app.project, "Comp 1");
    raises(ValueError, () => {
      comp.precompose([], "PC bad");
    });
  });

  test("test_out_of_range_raises", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = getComp(app.project, "Comp 1");
    raises(ValueError, () => {
      comp.precompose([5], "PC bad");
    });
    raises(ValueError, () => {
      comp.precompose([-1], "PC bad");
    });
  });

  test("test_invalid_name_raises", () => {
    const app = _fresh("layer/gray_solid_1_above.aep");
    const comp = getComp(app.project, "Comp 1");
    raisesAny([TypeError, ValueError], () =>
      // @ts-expect-error deliberately passes a non-string name to check runtime validation
      comp.precompose([0], 123),
    );
  });
});
