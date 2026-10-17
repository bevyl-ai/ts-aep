/**
 * regressions: mutation methods.
 *
 * Every expectation here was measured against After Effects 2026
 */

import { describe, expect, test } from "bun:test";
import { getattr, hasattr, len, py_bool, py_eq, ValueError, type Path } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { find_by_type } from "../../src/py_aep/binary/utils.ts";
import { PropertyType } from "../../src/py_aep/enums/index.ts";
import { SAMPLES_DIR, parse_app_fresh } from "../helpers.ts";

const PROPERTY_DIR = SAMPLES_DIR.div("models", "property");
const LAYER_DIR = SAMPLES_DIR.div("models", "layer");
const COMP_DIR = SAMPLES_DIR.div("models", "composition");
const EG_DIR = SAMPLES_DIR.div("models", "essential_graphics");

function* _walk(group: any, depth = 0): Generator<any> {
  if (depth > 10) return;
  for (const child of group) {
    yield child;
    if (!hasattr(child, "keyframes")) {
      yield* _walk(child, depth + 1);
    }
  }
}

/** Every `(comp, layer, property, referenced id, resolves)` layer param. */
function _layer_refs(app: any): [string, string, string, any, boolean][] {
  const out: [string, string, string, any, boolean][] = [];
  for (const comp of app.project.compositions) {
    const ids = new Set(comp.layers.map((lyr: any) => lyr.id));
    for (const lyr of comp.layers) {
      for (const prop of _walk(lyr)) {
        const tdpi = getattr(prop, "_tdpi", null);
        if (tdpi == null || !py_bool(tdpi.value)) {
          continue;
        }
        out.push([comp.name, lyr.name, prop.match_name, tdpi.value, ids.has(tdpi.value)]);
      }
    }
  }
  return out;
}

/**
 * Removing the active item left its id in `fcid`, and the parser then
 * raised `KeyError` on py's own output. AE writes `fcid = 0`.
 */
describe("TestActiveItemRemoval", () => {
  test("test_remove_active_comp_clears_fcid", () => {
    const tmp_path: Path = make_tmp_path();
    const app = parse_app_fresh(PROPERTY_DIR.div("gradient.aep"));
    expect(app.project.active_item).toBe(app.project.compositions[0]);

    app.project.compositions[0].remove();

    const fcid = find_by_type(app.project._rifx.chunks, "fcid");
    expect((fcid as any).value).toBe(0);
    expect(app.project.active_item == null).toBe(true);

    const out = tmp_path.div("removed.aep");
    app.project.save(out);
    // Used to raise KeyError: 1. `fcid = 0` is the root folder, which is
    // what AE's own saves carry once the active item is gone.
    const reparsed = parse_app_fresh(out);
    expect(reparsed.project.active_item).toBe(reparsed.project.root_folder);
  });

  /** A file naming a missing item still parses - AE opens one too. */
  test("test_dangling_fcid_parses", () => {
    const tmp_path: Path = make_tmp_path();
    const app = parse_app_fresh(PROPERTY_DIR.div("gradient.aep"));
    (find_by_type(app.project._rifx.chunks, "fcid") as any).value = 4242;
    const out = tmp_path.div("dangling.aep");
    app.project.save(out);

    expect(parse_app_fresh(out).project.active_item == null).toBe(true);
  });
});

/**
 * An effect group is a NAMED group in AE (`propertyType` 6213), so its
 * parameters cannot be duplicated, removed, moved or renamed. py accepted
 * all four, applied them in memory and dropped them on save.
 */
describe("TestEffectParameterIsNotIndexed", () => {
  function _blur_param(app: any): [any, any] {
    const layer = app.project.compositions[0].layers[0];
    expect(layer.effects != null).toBe(true);
    const effect = layer.effects.properties[0];
    return [effect, effect.properties[0]];
  }

  test("test_effect_group_is_named_group", () => {
    const app = parse_app_fresh(PROPERTY_DIR.div("2_gaussian.aep"));
    const [effect, _param] = _blur_param(app);
    expect(effect.property_type).toBe(PropertyType.NAMED_GROUP);
    expect(effect.parent_property.property_type).toBe(PropertyType.INDEXED_GROUP);
  });

  test.each(["duplicate", "remove", "move_to"])("test_parameter_mutation_rejected[%#]", (op: string) => {
    const app = parse_app_fresh(PROPERTY_DIR.div("2_gaussian.aep"));
    const [_effect, param] = _blur_param(app);
    raises(
      ValueError,
      () => {
        if (op === "move_to") {
          param.move_to(1);
        } else {
          // getattr returns the bare method, so bind it back to the param.
          getattr(param, op).call(param);
        }
      },
      "non-indexed group",
    );
  });

  test("test_parameter_rename_rejected", () => {
    const app = parse_app_fresh(PROPERTY_DIR.div("2_gaussian.aep"));
    const [_effect, param] = _blur_param(app);
    raises(
      ValueError,
      () => {
        param.name = "Amount";
      },
      "not an indexed group",
    );
  });

  test("test_effect_itself_still_mutable", () => {
    const tmp_path: Path = make_tmp_path();
    const app = parse_app_fresh(PROPERTY_DIR.div("2_gaussian.aep"));
    const layer = app.project.compositions[0].layers[0];
    expect(layer.effects != null).toBe(true);
    if (layer.effects == null) throw new Error("layer has no effects group");
    const before = len(layer.effects.properties);

    layer.effects.properties[0].duplicate();
    const out = tmp_path.div("dup.aep");
    app.project.save(out);

    const app2 = parse_app_fresh(out);
    const layer2 = app2.project.compositions[0].layers[0];
    expect(layer2.effects != null).toBe(true);
    if (layer2.effects == null) throw new Error("layer has no effects group");
    expect(len(layer2.effects.properties)).toBe(before + 1);
  });
});

/**
 * A layer-reference effect param (`tdpi`) that names a layer the
 * destination comp does not contain makes AE refuse the whole file:
 * "Can't find layer ID=N in composition X".
 */
describe("TestLayerReferencesFollowTheirLayer", () => {
  test("test_copy_to_comp_clears_the_reference", () => {
    const tmp_path: Path = make_tmp_path();
    const app = parse_app_fresh(PROPERTY_DIR.div("effects.aep"));
    const comps = app.project.compositions;
    const source = comps.find((c: any) => py_bool(c.layers))!;
    const target = comps.find((c: any) => c !== source)!;

    source.layers[0].copy_to_comp(target);

    const out = tmp_path.div("copied.aep");
    app.project.save(out);
    const unresolved = _layer_refs(parse_app_fresh(out)).filter((r) => !r[4]);
    expect(py_eq(unresolved, [])).toBe(true);
  });

  test("test_precompose_keeps_the_reference_resolvable", () => {
    const tmp_path: Path = make_tmp_path();
    const app = parse_app_fresh(PROPERTY_DIR.div("effects.aep"));
    const comp = app.project.compositions.find((c: any) => len(c.layers) >= 1)!;

    comp.precompose([0], "Pre");

    const out = tmp_path.div("pre.aep");
    app.project.save(out);
    const unresolved = _layer_refs(parse_app_fresh(out)).filter((r) => !r[4]);
    expect(py_eq(unresolved, [])).toBe(true);
  });
});

/**
 * AE keeps a copied layer where it was and materializes the chunk to
 * hold it; py re-derived the destination comp's centre instead.
 */
describe("TestCopyToCompTransform", () => {
  test("test_position_survives_a_different_sized_comp", () => {
    const app = parse_app_fresh(COMP_DIR.div("duplicate.aep"));
    const comps = app.project.compositions;
    const source = comps.find((c: any) => py_bool(c.layers))!;
    const target = comps.find(
      (c: any) => c !== source && !py_eq([c.width, c.height], [source.width, source.height]),
    )!;
    const layer = source.layers[0];
    const before = (layer.property("Transform") as any).property("Position").value;

    const copy = layer.copy_to_comp(target);

    expect(py_eq((copy.property("Transform") as any).property("Position").value, before)).toBe(true);
  });

  test("test_timebase_is_restamped_to_the_destination", () => {
    const app = parse_app_fresh(PROPERTY_DIR.div("effect_point_speed.aep"));
    const comps = app.project.compositions;
    const source = comps.find((c: any) => py_bool(c.layers))!;
    const target = comps.find((c: any) => c !== source && c.frame_rate !== source.frame_rate)!;

    const copy = source.layers[0].copy_to_comp(target);

    const want = target._cdta.internal_timebase;
    expect(source.layers[0].stretch).toBe(100.0);
    const bases = new Set(
      [..._walk(copy)]
        .filter(
          (prop) =>
            getattr(prop, "_tdb4", null) != null &&
            !py_bool(prop._tdbs.synthetic) &&
            py_bool(prop._tdb4._time_base),
        )
        .map((prop) => prop._tdb4._time_base),
    );
    expect(py_eq(bases, new Set([want]))).toBe(true);
  });

  /**
   * A stretched layer counts ticks against `comp base * |stretch|`, so
   * the restamp has to carry the stretch across too (issue #225 item 4).
   */
  test("test_a_stretched_copy_keeps_its_own_timebase", () => {
    const app = parse_app_fresh(LAYER_DIR.div("layer_timing.aep"));
    const source = app.project.compositions.find((c: any) => c.name === "stretch_200")!;
    const target = app.project.compositions.find((c: any) => c.name === "startTime_5")!;
    expect(source.layers[0].stretch).toBe(200.0);

    const copy = source.layers[0].copy_to_comp(target);

    const want = target._cdta.internal_timebase * 2;
    const bases = new Set(
      [..._walk(copy)]
        .filter(
          (prop) =>
            getattr(prop, "_tdb4", null) != null &&
            !py_bool(prop._tdbs.synthetic) &&
            py_bool(prop._tdb4._time_base),
        )
        .map((prop) => prop._tdb4._time_base),
    );
    expect(py_eq(bases, new Set([want]))).toBe(true);
  });
});

describe("TestPrecomposeSideEffects", () => {
  /**
   * A synthetic cdat holds user units; re-resolving it scaled the
   * anchor by the layer size a second time (50 read back as 5000).
   */
  test("test_moved_layer_keeps_its_anchor_point", () => {
    const app = parse_app_fresh(PROPERTY_DIR.div("keyframe_1D.aep"));
    const comp = app.project.compositions[0];
    const before = (comp.layers[0].property("Transform") as any).property("ADBE Anchor Point").value;

    const new_comp = comp.precompose([0], "Pre");

    const after = (new_comp.layers[0].property("Transform") as any).property("ADBE Anchor Point").value;
    expect(py_eq(after, before)).toBe(true);
  });

  /** AE drops the overrides (3 -> 0); they point into the old source. */
  test("test_leave_attributes_drops_essential_overrides", () => {
    const tmp_path: Path = make_tmp_path();
    const app = parse_app_fresh(EG_DIR.div("multiple_controllers.aep"));
    const comp = app.project.compositions.find((c: any) => c.name === "main")!;
    const layer = comp.layers[0];
    const overrides = layer.property("ADBE Layer Overrides");
    expect(len((overrides as any).properties)).toBe(3);

    comp.precompose([0], "PreKeep", false);

    expect(len((comp.layers[0].property("ADBE Layer Overrides") as any).properties)).toBe(0);
    const out = tmp_path.div("kept.aep");
    app.project.save(out);
    const app2 = parse_app_fresh(out);
    const comp2 = app2.project.compositions.find((c: any) => c.name === "main")!;
    expect(len((comp2.layers[0].property("ADBE Layer Overrides") as any).properties)).toBe(0);
  });
});
