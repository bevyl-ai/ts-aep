import { describe, expect, test } from "bun:test";

import { parse as parse_aep, type Application } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { KeyframeInterpolationType } from "../../src/py_aep/enums/property.ts";
import { KeyframeEase } from "../../src/py_aep/models/properties/keyframe_ease.ts";
import {
  AttributeError,
  Path,
  ValueError,
  len,
  py_assert,
  py_bool,
  py_or,
  range,
} from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { as_instance } from "../helpers.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import type { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";

// `Path(__file__)` → `import.meta.dir` (Bun); three `.parent` hops → `tests/roundtrip/../../`.
const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models");

/** Every leaf property in `app` satisfying `predicate`. */
function _leaves(app: Application, predicate: (p: Property) => boolean): Property[] {
  const found: Property[] = [];
  for (const comp of app.project.compositions) {
    for (const layer of comp.layers) {
      const stack: PropertyGroup[] = [layer];
      while (py_bool(stack)) {
        const group = stack.pop();
        py_assert(group != null);
        for (const child of group) {
          if ("keyframes" in child) {
            if (predicate(child)) found.push(child);
          } else if (Symbol.iterator in child) {
            // hasattr(child, "__iter__") → Symbol.iterator probe (dunder rule §6)
            stack.push(child);
          }
        }
      }
    }
  }
  return found;
}

function _first_leaf(app: Application, predicate: (p: Property) => boolean): Property {
  const hits = _leaves(app, predicate);
  py_assert(py_bool(hits), "no property matched");
  return hits[0];
}

/**
 * Renaming is only legal for a child of an indexed group.
 *
 * A rename on any other property materialized it, and for synthetic
 * MARKER / NO_VALUE properties that wrote a `LIST:tdbs` carrying no
 * `cdat` and no `tdum`/`tduM`, which AE 2026 rejects outright ("file is
 * damaged"). AE refuses the same write: "Can not set name this property,
 * because parent is not an INDEXED_GROUP".
 */
describe("TestPropertyNameGuard", () => {
  const PT = SAMPLES_DIR.div("property", "property_types.aep");

  test("test_marker_property_rename_rejected", () => {
    const app = parse_aep(PT);
    const marker = _first_leaf(app, (p) => p.match_name === "ADBE Marker");
    raises(ValueError, () => {
      marker.name = "my markers";
    }, "indexed group");
  });

  test("test_layer_style_no_value_rename_rejected", () => {
    const app = parse_aep(PT);
    const gradient = _first_leaf(app, (p) => p.match_name.endsWith("outerGlow/gradient"));
    raises(ValueError, () => {
      gradient.name = "grad";
    }, "indexed group");
  });

  test("test_transform_group_rename_rejected", () => {
    const app = parse_aep(PT);
    const group = app.project.compositions[0].layers[0].property("ADBE Transform Group");
    raises(ValueError, () => {
      group.name = "Xform";
    }, "indexed group");
  });

  test("test_transform_leaf_rename_rejected", () => {
    const app = parse_aep(PT);
    const prop = _first_leaf(app, (p) => p.match_name === "ADBE Opacity");
    raises(ValueError, () => {
      prop.name = "Alpha";
    }, "indexed group");
  });

  test("test_mask_rename_still_round_trips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("property", "mask.aep"));
    let renamed = 0;
    for (const comp of app.project.compositions) {
      for (const layer of comp.layers) {
        for (const mask of py_or(layer.masks, [])) {
          mask.name = "Kept Mask";
          renamed += 1;
        }
      }
    }
    expect(py_bool(renamed)).toBe(true);
    const out = tmp_path.div("mask_rename.aep");
    app.project.save(out);
    const names = parse_aep(out).project.compositions.flatMap((comp) =>
      comp.layers.flatMap((layer) => [...py_or(layer.masks, [])].map((mask) => mask.name)),
    );
    expect(py_bool(names) && names.every((name) => name === "Kept Mask")).toBe(true);
  });

  test("test_effect_rename_still_round_trips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("property", "effects.aep"));
    let effect: Property | PropertyGroup | null = null;
    for (const comp of app.project.compositions) {
      for (const layer of comp.layers) {
        for (const candidate of py_or(layer.effects, [])) {
          effect = candidate;
          break;
        }
        if (effect != null) break;
      }
      if (effect != null) break;
    }
    py_assert(effect != null);
    effect.name = "Renamed Effect";
    const out = tmp_path.div("effect_rename.aep");
    app.project.save(out);
    const names = parse_aep(out).project.compositions.flatMap((comp) =>
      comp.layers.flatMap((layer) => [...py_or(layer.effects, [])]),
    ).map((fx) => fx.name);
    expect(names.includes("Renamed Effect")).toBe(true);
  });

  /** A Layer is a PropertyBase but its name is a layer attribute. */
  test("test_layer_rename_unaffected", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(PT);
    app.project.compositions[0].layers[0].name = "Still Renameable";
    const out = tmp_path.div("layer_rename.aep");
    app.project.save(out);
    const renamed = parse_aep(out).project.compositions[0].layers[0].name;
    expect(renamed).toBe("Still Renameable");
  });
});

/**
 * `dimensions` drives how the value block is decoded.
 *
 * Writing it left py_aep misreading its own file: a 4-component colour
 * saved with `dimensions = 5` read back as
 * `[255.0, 255.0, 255.0, 255.0, 0.0]` while AE read the correct
 * `[1, 1, 1, 1]`.
 */
describe("TestDimensionsReadOnly", () => {
  test("test_dimensions_rejects_write", () => {
    const app = parse_aep(SAMPLES_DIR.div("property", "property_2D_position.aep"));
    const pos = _first_leaf(app, (p) => p.match_name === "ADBE Position");
    const before = pos.dimensions;
    raises(AttributeError, () => {
      pos.dimensions = 5;
    }, "read-only");
    expect(pos.dimensions).toBe(before);
  });
});

/**
 * `expression_enabled` must honour `can_set_expression`.
 *
 * AE throws for a hidden / non-expressible property ("Can not set
 * expression with this property, because the property or a parent
 * property is hidden"); py_aep accepted the write and materialized the
 * property.
 */
describe("TestExpressionEnabledGuard", () => {
  const PT = SAMPLES_DIR.div("property", "property_types.aep");

  test("test_rejected_when_expressions_impossible", () => {
    const app = parse_aep(PT);
    const target = _first_leaf(app, (p) => !p.can_set_expression);
    raises(ValueError, () => {
      target.expression_enabled = true;
    }, "cannot take an expression");
  });

  test("test_allowed_when_expressions_possible", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("property", "all_animated.aep"));
    const comp = app.project.compositions[0];
    // NOTE(port): next(gen) → Array.find; on a miss Python raises StopIteration, TS fails at the next line - the test errors either way
    const rot = as_instance(Array.from(comp.av_layers[0].transform).find((p) => p.match_name === "ADBE Rotate Z"), Property);
    expect(rot.can_set_expression).toBe(true);
    rot.expression = "time * 2";
    rot.expression_enabled = true;
    const out = tmp_path.div("expr_enabled.aep");
    app.project.save(out);
    const comp2 = parse_aep(out).project.compositions[0];
    const rot2 = as_instance(Array.from(comp2.av_layers[0].transform).find((p) => p.match_name === "ADBE Rotate Z"), Property);
    expect(rot2.expression_enabled).toBe(true);
  });

  /** Turning it off is legal whatever the property. */
  test("test_disabling_never_raises", () => {
    const app = parse_aep(PT);
    for (const comp of app.project.compositions) {
      for (const layer of comp.layers) {
        for (const prop of layer.transform) {
          as_instance(prop, Property).expression_enabled = false;
        }
      }
    }
  });
});

/**
 * Assigning `in_temporal_ease` / `out_temporal_ease` must persist.
 *
 * A user-built `KeyframeEase` is detached from any chunk, so the setter
 * used to stash the list on the Python object and lose it on save -
 * leaving no working way to set keyframe ease (ExtendScript's
 * `setTemporalEaseAtKey` does persist).
 */
describe("TestTemporalEaseSetterWritesThrough", () => {
  const BEZ = SAMPLES_DIR.div("property", "keyframe_bezier_multi_ease_1D.aep");

  function _animated(app: Application): Property {
    return _first_leaf(app, (p) => py_bool(p.keyframes));
  }

  test("test_middle_keyframe_round_trips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(BEZ);
    const prop = _animated(app);
    const keyframe = prop.keyframes[1];
    const count = len(keyframe.in_temporal_ease);
    keyframe.in_temporal_ease = Array.from(range(count), () => new KeyframeEase(0.0, 66.0));
    keyframe.out_temporal_ease = Array.from(range(count), () => new KeyframeEase(0.0, 12.0));

    const out = tmp_path.div("ease_middle.aep");
    app.project.save(out);
    const reparsed = _animated(parse_aep(out)).keyframes[1];
    expect(approx(reparsed.in_temporal_ease[0].influence, 66.0)).toBe(true);
    expect(approx(reparsed.out_temporal_ease[0].influence, 12.0)).toBe(true);
  });

  /** The getter returns computed copies here; the write must not. */
  test("test_boundary_keyframe_round_trips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(BEZ);
    const prop = _animated(app);
    const first = prop.keyframes[0];
    first.in_interpolation_type = KeyframeInterpolationType.BEZIER;
    first.out_interpolation_type = KeyframeInterpolationType.BEZIER;
    const count = len(first.out_temporal_ease);
    first.out_temporal_ease = Array.from(range(count), () => new KeyframeEase(0.0, 44.0));

    const out = tmp_path.div("ease_boundary.aep");
    app.project.save(out);
    const reparsed = _animated(parse_aep(out)).keyframes[0];
    expect(approx(reparsed.out_temporal_ease[0].influence, 44.0)).toBe(true);
  });

  test("test_speed_round_trips", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(BEZ);
    const prop = _animated(app);
    const keyframe = prop.keyframes[1];
    const count = len(keyframe.in_temporal_ease);
    keyframe.in_temporal_ease = Array.from(range(count), () => new KeyframeEase(25.0, 50.0));

    const out = tmp_path.div("ease_speed.aep");
    app.project.save(out);
    const reparsed = _animated(parse_aep(out)).keyframes[1];
    expect(approx(reparsed.in_temporal_ease[0].speed, 25.0)).toBe(true);
  });

  test("test_wrong_length_rejected", () => {
    const app = parse_aep(BEZ);
    const keyframe = _animated(app).keyframes[1];
    raises(ValueError, () => {
      keyframe.in_temporal_ease = new Array(99).fill(new KeyframeEase(0.0, 5.0));
    }, "expects");
  });

  test("test_non_ease_value_rejected", () => {
    const app = parse_aep(BEZ);
    const keyframe = _animated(app).keyframes[1];
    raises(ValueError, () => {
      // @ts-expect-error deliberately wrong-typed element (Python `# type: ignore[list-item]`)
      keyframe.in_temporal_ease = [0.5];
    }, "KeyframeEase");
  });
});

/**
 * `can_add_to_motion_graphics_template` must predict the builder.
 *
 * `ADBE Layer Source Alternate` reports a Slider control with
 * `value is None`, so the predicate said `True` and the builder raised
 * `TypeError: float() argument must be ... not 'NoneType'`.
 */
describe("TestMotionGraphicsPredicateAgreesWithBuilder", () => {
  const EG = SAMPLES_DIR.div("essential_graphics", "base.aep");

  test("test_every_addable_property_actually_adds", () => {
    const app = parse_aep(EG);
    let checked = 0;
    for (const comp of app.project.compositions) {
      for (const prop of _leaves(app, (p) => true)) {
        if (prop.can_add_to_motion_graphics_template(comp)) {
          prop.add_to_motion_graphics_template(comp);
          checked += 1;
        }
      }
    }
    expect(py_bool(checked)).toBe(true);
  });

  test("test_value_less_slider_is_not_addable", () => {
    const app = parse_aep(EG);
    const targets = _leaves(app, (p) => p.match_name === "ADBE Layer Source Alternate");
    expect(py_bool(targets)).toBe(true);
    const comp = app.project.compositions[0];
    for (const prop of targets) {
      expect(prop.value == null).toBe(true);
      expect(!prop.can_add_to_motion_graphics_template(comp)).toBe(true);
    }
  });
});
