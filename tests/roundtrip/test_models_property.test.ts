/** Tests for Property model parsing with strengthened assertions. */

import { describe, expect, test } from "bun:test";
import {
  AssertionError_,
  AttributeError,
  IndexError,
  StopIteration,
  Path,
  TypeError_,
  ValueError,
  and,
  b,
  bytes_,
  contains,
  copy,
  deepcopy,
  getattr,
  getitem,
  len,
  py_assert,
  py_bool,
  py_eq,
  py_or,
  repr,
  setattr,
  setdefault,
  tkey,
  zip,
} from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises, skip } from "../../src/pyrt/pytest.ts";
import { as_instance, get_comp, get_first_layer, get_layer, parse_project_fresh } from "../helpers.ts";

import { parse as parse_aep, new as py_aep_new, Project } from "../../src/py_aep/index.ts";
import { KeyframeInterpolationType, Label, MaskFeatherFalloff, MaskMode, MaskMotionBlur, PropertyControlType, PropertyType, PropertyValueType } from "../../src/py_aep/enums/index.ts";
import { AVLayer, Application, CompItem, FootageItem, Keyframe, Layer, MaskPropertyGroup, Property, PropertyBase, PropertyGroup, Shape } from "../../src/py_aep/models/index.ts";
import { ShapeLayer, TextLayer } from "../../src/py_aep/models/layers/index.ts";
import { _baked_effect_def } from "../../src/py_aep/models/properties/property_group.ts";
import { build_expression_control } from "../../src/py_aep/binary/mutations.ts";
import { EXPRESSION_CONTROLS } from "../../src/py_aep/data/effect_controls.ts";
import { PguiChunk } from "../../src/py_aep/binary/misc_chunks.ts";
import { find_by_type, recursive_find } from "../../src/py_aep/binary/utils.ts";
import { ListChunk, type Chunk } from "../../src/py_aep/binary/chunk.ts";
import { NORMALIZED_ARC_ACCURACY } from "../../src/py_aep/resolvers/interpolation.ts";

// `Path(__file__).parent.parent.parent / ...` in the Python source.
const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "property");
const BUGS_DIR = new Path(import.meta.dir, "..", "..", "samples", "bugs");
const LAYER_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "layer");
// NOTE(port): upstream assigns LAYER_SAMPLES_DIR twice with the same value; a TS const cannot be redeclared, so the duplicate is dropped.
const VERSIONS_DIR = new Path(import.meta.dir, "..", "..", "samples", "versions");
const PROPERTY_SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models", "property");

/** Python `next(x for x in items if pred(x))`: raises StopIteration when nothing matches. */
function _next<T>(items: Iterable<T>, pred: (item: T) => boolean): T {
  for (const item of items) {
    if (pred(item)) return item;
  }
  throw new StopIteration();
}

/** Find a property in the layer's transform by match_name. */
function _find_property(layer: Layer, match_name: string): Property | null {
  for (const prop of layer.transform) {
    if (prop.match_name === match_name) return as_instance(prop, Property);
  }
  return null;
}

/**
 * Remove all keyframes so the static `.value` setter is usable
 * (setting a value on a keyframed property raises, as in ExtendScript).
 */
function _deanimate(prop: Property): void {
  while (py_bool(prop.keyframes)) {
    prop.remove_key(0);
  }
}

describe("TestRoundtripPropertyEnabled", () => {
  /** Roundtrip: toggle Layer.enabled and verify save/reload. */

  test("test_disable_layer", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("is_modified_false.aep")).project;
    const layer = project.compositions[0].layers[0];
    expect(layer.enabled).toBe(true);

    layer.enabled = false;
    const out = tmp_path.div("disabled_layer.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const layer2 = project2.compositions[0].layers[0];
    expect(layer2.enabled).toBe(false);
  });

  test("test_reenable_layer", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("is_modified_false.aep")).project;
    const layer = project.compositions[0].layers[0];

    layer.enabled = false;
    const out = tmp_path.div("step1.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const layer2 = project2.compositions[0].layers[0];
    layer2.enabled = true;
    const out2 = tmp_path.div("step2.aep");
    project2.save(out2);

    const project3 = parse_aep(out2).project;
    const layer3 = project3.compositions[0].layers[0];
    expect(layer3.enabled).toBe(true);
  });
});

describe("TestRoundtripMaskMode", () => {
  /** Roundtrip: change MaskPropertyGroup.mask_mode. */

  test("test_change_mask_mode", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("mask_add.aep")).project;
    const layer = project.compositions[0].layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask instanceof MaskPropertyGroup);
    expect(mask.mask_mode).toBe(MaskMode.ADD);

    mask.mask_mode = MaskMode.SUBTRACT;
    const out = tmp_path.div("mask_subtract.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const mask2 = as_instance(as_instance(project2.compositions[0].layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask2 instanceof MaskPropertyGroup);
    expect(mask2.mask_mode).toBe(MaskMode.SUBTRACT);
  });
});

describe("TestRoundtripMaskInverted", () => {
  /** Roundtrip: toggle MaskPropertyGroup.inverted. */

  test("test_invert_mask", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("mask_add.aep")).project;
    const layer = project.compositions[0].layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask instanceof MaskPropertyGroup);
    expect(mask.inverted).toBe(false);

    mask.inverted = true;
    const out = tmp_path.div("mask_inverted.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const mask2 = as_instance(as_instance(project2.compositions[0].layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask2 instanceof MaskPropertyGroup);
    expect(mask2.inverted).toBe(true);
  });
});

describe("TestRoundtripMaskLocked", () => {
  /** Roundtrip: toggle MaskPropertyGroup.locked. */

  test("test_lock_mask", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("mask_add.aep")).project;
    const layer = project.compositions[0].layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask instanceof MaskPropertyGroup);
    expect(mask.locked).toBe(false);

    mask.locked = true;
    const out = tmp_path.div("mask_locked.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const mask2 = as_instance(as_instance(project2.compositions[0].layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask2 instanceof MaskPropertyGroup);
    expect(mask2.locked).toBe(true);
  });
});

describe("TestRoundtripMaskMotionBlur", () => {
  /** Roundtrip: change MaskPropertyGroup.mask_motion_blur. */

  test("test_change_motion_blur", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("mask_motion_blur_same_as_layer.aep")).project;
    const layer = project.compositions[0].layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask instanceof MaskPropertyGroup);
    expect(mask.mask_motion_blur).toBe(MaskMotionBlur.SAME_AS_LAYER);

    mask.mask_motion_blur = MaskMotionBlur.ON;
    const out = tmp_path.div("mask_motion_blur_on.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const mask2 = as_instance(as_instance(project2.compositions[0].layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask2 instanceof MaskPropertyGroup);
    expect(mask2.mask_motion_blur).toBe(MaskMotionBlur.ON);
  });
});

describe("TestRoundtripMaskColor", () => {
  /** Roundtrip: change MaskPropertyGroup.color. */

  test("test_change_color", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("mask_add.aep")).project;
    const layer = project.compositions[0].layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask instanceof MaskPropertyGroup);

    mask.color = [0.5, 0.25, 0.75];
    const out = tmp_path.div("mask_color.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const mask2 = as_instance(as_instance(project2.compositions[0].layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask2 instanceof MaskPropertyGroup);
    // Colors are stored as uint8, so precision is 1/255
    expect(Math.abs(mask2.color[0] - 0.5) < 0.005).toBe(true);
    expect(Math.abs(mask2.color[1] - 0.25) < 0.005).toBe(true);
    expect(Math.abs(mask2.color[2] - 0.75) < 0.005).toBe(true);
  });
});

describe("TestRoundtripMaskFeatherFalloff", () => {
  /** Roundtrip: change MaskPropertyGroup.mask_feather_falloff. */

  test("test_change_feather_falloff", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("mask_feather_falloff_smooth.aep")).project;
    const layer = project.compositions[0].layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask instanceof MaskPropertyGroup);
    expect(mask.mask_feather_falloff).toBe(MaskFeatherFalloff.FFO_SMOOTH);

    mask.mask_feather_falloff = MaskFeatherFalloff.FFO_LINEAR;
    const out = tmp_path.div("mask_feather_falloff_linear.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const mask2 = as_instance(as_instance(project2.compositions[0].layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask2 instanceof MaskPropertyGroup);
    expect(mask2.mask_feather_falloff).toBe(MaskFeatherFalloff.FFO_LINEAR);
  });
});

describe("TestRoundtripFeatherPointRadius", () => {
  /** Roundtrip: modify FeatherPoint.radius and verify save/reload. */

  test("test_modify_feather_radius", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("shape_feather.aep")).project;
    const comp = get_comp(project, "shape_feather_points");
    const layer = comp.layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    const shape = as_instance(mask.properties[0], Property).value;
    expect(shape.feather_points.length).toBe(2);
    expect(shape.feather_points[0].radius).toBe(30.0);

    shape.feather_points[0].radius = 55.0;
    const out = tmp_path.div("modified_feather_radius.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const comp2 = get_comp(project2, "shape_feather_points");
    const shape2 = as_instance(as_instance(as_instance(comp2.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    expect(shape2.feather_points[0].radius).toBe(55.0);
    // Second feather point unchanged
    expect(shape2.feather_points[1].radius).toBe(100.0);
  });

  test("test_modify_feather_seg_loc", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("shape_feather.aep")).project;
    const comp = get_comp(project, "shape_feather_points");
    const layer = comp.layers[0];
    const shape = as_instance(as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    expect(shape.feather_points[0].seg_loc).toBe(1);

    shape.feather_points[0].seg_loc = 3;
    const out = tmp_path.div("modified_feather_seg_loc.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const comp2 = get_comp(project2, "shape_feather_points");
    const shape2 = as_instance(as_instance(as_instance(comp2.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    expect(shape2.feather_points[0].seg_loc).toBe(3);
  });

  test("test_modify_feather_tension", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("shape_feather.aep")).project;
    const comp = get_comp(project, "shape_feather_inner_hold");
    const layer = comp.layers[0];
    const shape = as_instance(as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    expect(shape.feather_points[1].tension).toBe(0.5);

    shape.feather_points[1].tension = 0.75;
    const out = tmp_path.div("modified_feather_tension.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const comp2 = get_comp(project2, "shape_feather_inner_hold");
    const shape2 = as_instance(as_instance(as_instance(comp2.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    expect(shape2.feather_points[1].tension).toBe(0.75);
  });

  test("test_feather_type_follows_radius_sign", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("shape_feather.aep")).project;
    const comp = get_comp(project, "shape_feather_points");
    const layer = comp.layers[0];
    const shape = as_instance(as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    // Both are outer (positive radius)
    expect(shape.feather_points[0].type).toBe(0);

    // Make it inner by setting negative radius
    shape.feather_points[0].radius = -30.0;
    const out = tmp_path.div("modified_feather_type.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const comp2 = get_comp(project2, "shape_feather_points");
    const shape2 = as_instance(as_instance(as_instance(comp2.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    expect(shape2.feather_points[0].type).toBe(1);
    expect(shape2.feather_points[0].radius).toBe(-30.0);
  });
});

describe("TestValidateFeatherPoint", () => {
  /** Validation tests for FeatherPoint field constraints. */

  test("test_seg_loc_rejects_negative", () => {
    const project = parse_aep(SAMPLES_DIR.div("shape_feather.aep")).project;
    const comp = get_comp(project, "shape_feather_points");
    const fp = as_instance(as_instance(as_instance(comp.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    raises(ValueError, () => {
      fp.feather_points[0].seg_loc = -1;
    }, "must be >= 0");
  });

  test("test_seg_loc_rejects_float", () => {
    const project = parse_aep(SAMPLES_DIR.div("shape_feather.aep")).project;
    const comp = get_comp(project, "shape_feather_points");
    const fp = as_instance(as_instance(as_instance(comp.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    raises(TypeError_, () => {
      fp.feather_points[0].seg_loc = 1.5;
    }, "expected an integer");
  });

  test("test_rel_seg_loc_rejects_negative", () => {
    const project = parse_aep(SAMPLES_DIR.div("shape_feather.aep")).project;
    const comp = get_comp(project, "shape_feather_points");
    const fp = as_instance(as_instance(as_instance(comp.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    raises(ValueError, () => {
      fp.feather_points[0].rel_seg_loc = -0.1;
    }, "must be >= 0");
  });

  test("test_rel_seg_loc_rejects_above_one", () => {
    const project = parse_aep(SAMPLES_DIR.div("shape_feather.aep")).project;
    const comp = get_comp(project, "shape_feather_points");
    const fp = as_instance(as_instance(as_instance(comp.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    raises(ValueError, () => {
      fp.feather_points[0].rel_seg_loc = 1.1;
    }, "must be <= 1");
  });

  test("test_tension_rejects_negative", () => {
    const project = parse_aep(SAMPLES_DIR.div("shape_feather.aep")).project;
    const comp = get_comp(project, "shape_feather_inner_hold");
    const fp = as_instance(as_instance(as_instance(comp.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    raises(ValueError, () => {
      fp.feather_points[1].tension = -0.1;
    }, "must be >= 0");
  });

  test("test_tension_rejects_above_one", () => {
    const project = parse_aep(SAMPLES_DIR.div("shape_feather.aep")).project;
    const comp = get_comp(project, "shape_feather_inner_hold");
    const fp = as_instance(as_instance(as_instance(comp.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup).properties[0], Property).value;
    raises(ValueError, () => {
      fp.feather_points[1].tension = 1.1;
    }, "must be <= 1");
  });
});

describe("TestRoundtripKeyframeLabel", () => {
  /** Roundtrip: modify Keyframe.label and verify save/reload. */

  test("test_modify_keyframe_label", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("keyframe_1D.aep")).project;
    const comp = get_comp(project, "keyframe_bezier_ease_in_out_1D");
    const layer = comp.layers[0];
    // Find the animated opacity property
    const prop = as_instance(_find_property(layer, "ADBE Opacity"), Property);
    expect(prop.keyframes.length >= 2).toBe(true);
    const original_label = prop.keyframes[0].label;
    expect(original_label).not.toBe(Label.RED);

    prop.keyframes[0].label = Label.RED;
    const out = tmp_path.div("modified_kf_label.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const comp2 = get_comp(project2, "keyframe_bezier_ease_in_out_1D");
    const layer2 = comp2.layers[0];
    const prop2 = as_instance(_find_property(layer2, "ADBE Opacity"), Property);
    expect(prop2.keyframes[0].label).toBe(Label.RED);
  });

  test("test_label_bytes_match_after_effects", () => {
    /**
     * Labels written by py_aep store the same key-flag bytes as AE's
     * `setLabelAtKey` on the same project (keyframe_labels.aep).
     */
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("keyframe_bezier_multi_ease_1D.aep")).project;
    const opacity = as_instance(_find_property(
      get_comp(project, "TestComp").layers[0],
      "ADBE Opacity",
    ), Property);
    for (const [kf, label] of zip(opacity.keyframes, [Label.of(1), Label.of(5), Label.of(16)])) {
      kf.label = label;
    }
    const out = tmp_path.div("labels.aep");
    project.save(out);

    const key_flag_bytes = (path: Path): Uint8Array[] => {
      const proj = parse_aep(path).project;
      const prop = as_instance(_find_property(get_comp(proj, "TestComp").layers[0], "ADBE Opacity"), Property);
      return prop.keyframes.map((kf) => bytes_.slice(kf._ldat_item.tobytes(), 6, 8));
    };

    expect(py_eq(key_flag_bytes(out), key_flag_bytes(SAMPLES_DIR.div("keyframe_labels.aep")))).toBe(true);
  });

  test("test_modify_keyframe_roving", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("keyframe_1D.aep")).project;
    const comp = get_comp(project, "keyframe_bezier_ease_in_out_1D");
    const layer = comp.layers[0];
    const prop = as_instance(_find_property(layer, "ADBE Opacity"), Property);
    expect(prop.keyframes.length >= 2).toBe(true);
    // Roving can only meaningfully be set on middle keyframes
    if (prop.keyframes.length >= 3) {
      prop.keyframes[1].roving = true;
      const out = tmp_path.div("modified_kf_roving.aep");
      project.save(out);

      const project2 = parse_aep(out).project;
      const comp2 = get_comp(project2, "keyframe_bezier_ease_in_out_1D");
      const prop2 = as_instance(_find_property(comp2.layers[0], "ADBE Opacity"), Property);
      expect(prop2.keyframes[1].roving).toBe(true);
    }
  });
});

describe("TestRoundtripKeyframeInterpolationType", () => {
  /** Roundtrip: modify Keyframe interpolation type. */

  test("test_change_interpolation_to_hold", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("keyframe_interpolation.aep")).project;
    const comp = get_comp(project, "keyframe_LINEAR");
    const layer = comp.layers[0];
    const prop = as_instance(_find_property(layer, "ADBE Position"), Property);
    expect(prop.keyframes.length >= 2).toBe(true);
    expect(prop.keyframes[0].out_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);

    prop.keyframes[0].out_interpolation_type = KeyframeInterpolationType.HOLD;
    const out = tmp_path.div("modified_kf_interp.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = as_instance(_find_property(
      get_comp(project2, "keyframe_LINEAR").layers[0],
      "ADBE Position",
    ), Property);
    expect(prop2.keyframes[0].out_interpolation_type).toBe(KeyframeInterpolationType.HOLD);
  });

  test("test_change_in_interpolation", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("keyframe_interpolation.aep")).project;
    const comp = get_comp(project, "keyframe_BEZIER");
    const layer = comp.layers[0];
    const prop = as_instance(_find_property(layer, "ADBE Position"), Property);
    expect(prop.keyframes.length >= 2).toBe(true);

    prop.keyframes[1].in_interpolation_type = KeyframeInterpolationType.LINEAR;
    const out = tmp_path.div("modified_kf_in_interp.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = as_instance(_find_property(
      get_comp(project2, "keyframe_BEZIER").layers[0],
      "ADBE Position",
    ), Property);
    expect(prop2.keyframes[1].in_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
  });
});

describe("TestRoundtripExpression", () => {
  /** Roundtrip: modify Property.expression and verify save/reload. */

  test("test_change_expression", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("expression.aep")).project;
    const comp = get_comp(project, "expression_enabled");
    const layer = comp.layers[0];
    // Find any property with a non-empty expression
    let prop: Property | null = null;
    for (const p of layer.transform) {
      if (py_bool(as_instance(p, Property).expression)) {
        prop = as_instance(p, Property);
        break;
      }
    }
    py_assert(prop != null, "No property with expression found");
    const match_name = prop.match_name;

    prop.expression = "wiggle(5, 50)";
    const out = tmp_path.div("modified_expr.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = as_instance(_find_property(
      get_comp(project2, "expression_enabled").layers[0],
      match_name,
    ), Property);
    expect(prop2.expression).toBe("wiggle(5, 50)");
  });
});

describe("TestRoundtripShapeClosed", () => {
  /** Roundtrip: toggle Shape.closed and verify save/reload. */

  test("test_open_closed_mask", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("mask.aep")).project;
    const comp = get_comp(project, "is_mask_true");
    const layer = comp.layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask instanceof MaskPropertyGroup);
    const mask_path = mask.property("ADBE Mask Shape");
    const shape = mask_path.value;
    expect(shape.closed).toBe(true);

    shape.closed = false;
    const out = tmp_path.div("mask_opened.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const comp2 = get_comp(project2, "is_mask_true");
    const mask2 = as_instance(as_instance(comp2.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup);
    const mask_path2 = mask2.property("ADBE Mask Shape");
    expect(mask_path2.value.closed).toBe(false);
  });

  test("test_close_open_mask", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("mask.aep")).project;
    const comp = get_comp(project, "is_mask_true");
    const layer = comp.layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    const mask_path = mask.property("ADBE Mask Shape");
    const shape = mask_path.value;

    // Open the mask
    shape.closed = false;
    const out = tmp_path.div("step1.aep");
    project.save(out);

    // Re-close it
    const project2 = parse_aep(out).project;
    const comp2 = get_comp(project2, "is_mask_true");
    const mask2 = as_instance(as_instance(comp2.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup);
    const mask_path2 = mask2.property("ADBE Mask Shape");
    mask_path2.value.closed = true;
    const out2 = tmp_path.div("step2.aep");
    project2.save(out2);

    const project3 = parse_aep(out2).project;
    const comp3 = get_comp(project3, "is_mask_true");
    const mask3 = as_instance(as_instance(comp3.layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup);
    const mask_path3 = mask3.property("ADBE Mask Shape");
    expect(mask_path3.value.closed).toBe(true);
  });
});

describe("TestRoundtripMaskShapeOnEachLayerKind", () => {
  /**
   * A mask shape written on a source-less layer stays in pixels.
   *
   * `mask_shape_and_text_layers.aep` holds a solid, a shape layer and a text
   * layer with a mask each. AE 2026 opens py-aep's save with the written
   * vertices on all three; dividing a source-less layer's shape by the size
   * AE reports for it (the comp's) read back as [-0.0156, -0.0278].
   */

  test.each(["solid", "shape", "text"])("test_written_vertices_read_back[%#]", (layer_name) => {
      const tmp_path = make_tmp_path();
      const vertices = [[-10.0, -10.0], [30.0, -10.0], [30.0, 20.0], [-10.0, 20.0]];
      const project = parse_project_fresh(SAMPLES_DIR.div("mask_shape_and_text_layers.aep"));
      const layer = as_instance(
        project.compositions.flatMap((c: CompItem) => c.layers).find((ly: Layer) => ly.name === layer_name),
        Layer,
      );
      py_assert(layer.masks != null);
      as_instance(as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup), MaskPropertyGroup).property("ADBE Mask Shape").value = new Shape(vertices);
      const out = tmp_path.div("masks.aep");
      project.save(out);

      const reopened = as_instance(
        parse_aep(out).project.compositions.flatMap((c: CompItem) => c.layers).find((ly: Layer) => ly.name === layer_name),
        Layer,
      );
      py_assert(reopened.masks != null);
      const shape = as_instance(as_instance(as_instance(reopened.masks, PropertyGroup).property(0), MaskPropertyGroup), MaskPropertyGroup).property("ADBE Mask Shape").value;
      for (const [vertex, want] of zip(shape.vertices, vertices)) {
        expect(approx(vertex, want, { abs: 1e-4 })).toBe(true);
      }
  });
});

describe("TestRoundtripKeyframeEase", () => {
  /** Roundtrip: modify KeyframeEase speed/influence. */

  test("test_change_bezier_ease", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("keyframe_interpolation.aep")).project;
    const comp = get_comp(project, "keyframe_BEZIER");
    const layer = comp.layers[0];
    const prop = _find_property(layer, "ADBE Position");
    py_assert(prop != null);
    expect(prop.keyframes.length >= 2).toBe(true);

    const kf = prop.keyframes[0];
    expect(kf.out_temporal_ease.length >= 1).toBe(true);
    kf.out_temporal_ease[0].speed = 42.0;
    kf.out_temporal_ease[0].influence = 75.0;

    const out = tmp_path.div("modified_ease.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = _find_property(
      get_comp(project2, "keyframe_BEZIER").layers[0],
      "ADBE Position",
    );
    py_assert(prop2 != null);
    expect(Math.abs(prop2.keyframes[0].out_temporal_ease[0].speed - 42.0) < 0.01).toBe(true);
    expect(Math.abs(prop2.keyframes[0].out_temporal_ease[0].influence - 75.0) < 0.01).toBe(true);
  });
});

describe("TestValidateKeyframeEaseInfluence", () => {
  /**
   * Validation tests for KeyframeEase.influence bounds (0.0-100.0).
   *
   * The old lower bound of 0.1 was AE's *dialog* minimum, not the field's
   * range. AE itself writes below it: separating a dimension-separated
   * Position stores `1/dt` percent per side, which is 0.0833 for a 12 s
   * segment (measured on AE 2026), and AE's files carry a plain 0.0 on the
   * inert outer side of an endpoint keyframe. Bounding by the UI limit
   * rejected values AE stores.
   */

  test("test_influence_rejects_below_min", () => {
    const project = parse_aep(SAMPLES_DIR.div("keyframe_interpolation.aep")).project;
    const comp = get_comp(project, "keyframe_BEZIER");
    const layer = comp.layers[0];
    const prop = _find_property(layer, "ADBE Position");
    py_assert(prop != null);
    const kf = prop.keyframes[0];
    raises(ValueError, () => {
      kf.out_temporal_ease[0].influence = -0.1;
    }, "must be");
  });

  test("test_influence_accepts_what_ae_writes_for_a_long_segment", () => {
    /** AE stores 1/12 percent when separating across a 12 s segment. */
    const project = parse_aep(SAMPLES_DIR.div("keyframe_interpolation.aep")).project;
    const comp = get_comp(project, "keyframe_BEZIER");
    const prop = _find_property(comp.layers[0], "ADBE Position");
    py_assert(prop != null);
    prop.keyframes[0].out_temporal_ease[0].influence = 1.0 / 12.0;
    expect(approx(prop.keyframes[0].out_temporal_ease[0].influence, 1.0 / 12.0)).toBe(true);
  });

  test("test_influence_rejects_above_max", () => {
    const project = parse_aep(SAMPLES_DIR.div("keyframe_interpolation.aep")).project;
    const comp = get_comp(project, "keyframe_BEZIER");
    const layer = comp.layers[0];
    const prop = _find_property(layer, "ADBE Position");
    py_assert(prop != null);
    const kf = prop.keyframes[0];
    raises(ValueError, () => {
      kf.out_temporal_ease[0].influence = 100.1;
    }, "must be");
  });
});

describe("TestRoundtripPropertyValue", () => {
  /** Roundtrip: modify Property.value and verify save/reload. */

  test("test_change_scalar_value", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("is_modified_false.aep")).project;
    const layer = project.compositions[0].layers[0];
    const prop = _find_property(layer, "ADBE Rotate X");
    py_assert(prop != null);
    py_assert(prop._cdat != null);

    prop.value = 45.0;
    const out = tmp_path.div("modified_rotate.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = as_instance(_find_property(project2.compositions[0].layers[0], "ADBE Rotate X"), Property);
    expect(Math.abs(prop2.value - 45.0) < 0.01).toBe(true);
  });

  test("test_change_multidim_value", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("is_modified_false.aep")).project;
    const layer = project.compositions[0].layers[0];
    const prop = _find_property(layer, "ADBE Orientation");
    py_assert(prop != null);
    py_assert(prop._cdat != null);

    prop.value = [10.0, 20.0, 30.0];
    const out = tmp_path.div("modified_orientation.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = as_instance(_find_property(project2.compositions[0].layers[0], "ADBE Orientation"), Property);
    expect(Math.abs(prop2.value[0] - 10.0) < 0.01).toBe(true);
    expect(Math.abs(prop2.value[1] - 20.0) < 0.01).toBe(true);
    expect(Math.abs(prop2.value[2] - 30.0) < 0.01).toBe(true);
  });
});

describe("TestRoundtripExpressionCreate", () => {
  /** Roundtrip: add an expression to a property that had none. */

  test("test_create_expression_on_empty", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("is_modified_false.aep")).project;
    const layer = project.compositions[0].layers[0];
    const prop = _find_property(layer, "ADBE Rotate Z");
    py_assert(prop != null);
    expect(prop.expression).toBe("");
    expect(prop._expression_utf8 == null).toBe(true);

    prop.expression = "time * 90";
    py_assert(prop._expression_utf8 != null);
    const out = tmp_path.div("new_expression.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = as_instance(_find_property(project2.compositions[0].layers[0], "ADBE Rotate Z"), Property);
    expect(prop2.expression).toBe("time * 90");
  });

  test("test_create_expression_sets_tdb4_marker", () => {
    /**
     * Setting an expression must set AE's tdb4 expression-present
     * marker. Without it AE silently DROPS the expression on open
     * (verified against AE 2026); the py-only round-trip cannot catch
     * that because py reads the Utf8 regardless of the marker.
     */
    const project = parse_aep(SAMPLES_DIR.div("is_modified_false.aep")).project;
    const prop = _find_property(project.compositions[0].layers[0], "ADBE Rotate Z");
    py_assert(prop != null);
    expect(prop._tdb4.has_expression).toBe(false);

    prop.expression = "time * 90";
    expect(prop._tdb4.has_expression).toBe(true);

    // Clearing removes the chunk and the marker again.
    prop.expression = "";
    expect(prop._expression_utf8 == null).toBe(true);
    expect(prop._tdb4.has_expression).toBe(false);
  });
});

describe("TestRoundtripExpressionEnabled", () => {
  /** Roundtrip: toggle Property.expression_enabled. */

  test("test_disable_expression", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("expression.aep")).project;
    const comp = get_comp(project, "expression_enabled");
    const layer = comp.layers[0];
    let prop: Property | null = null;
    for (const p of layer.transform) {
      const leaf = as_instance(p, Property);
      if (py_bool(leaf.expression) && py_bool(leaf.expression_enabled)) {
        prop = leaf;
        break;
      }
    }
    py_assert(prop != null);
    const match_name = prop.match_name;

    prop.expression_enabled = false;
    const out = tmp_path.div("disabled_expr.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = as_instance(_find_property(
      get_comp(project2, "expression_enabled").layers[0],
      match_name,
    ), Property);
    expect(prop2.expression_enabled).toBe(false);
    expect(prop2.expression !== "").toBe(true);
  });

  test("test_enable_expression", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("expression.aep")).project;
    const comp = get_comp(project, "expression_disabled");
    const layer = comp.layers[0];
    let prop: Property | null = null;
    for (const p of layer.transform) {
      const leaf = as_instance(p, Property);
      if (py_bool(leaf.expression) && !py_bool(leaf.expression_enabled)) {
        prop = leaf;
        break;
      }
    }
    py_assert(prop != null);
    const match_name = prop.match_name;

    prop.expression_enabled = true;
    const out = tmp_path.div("enabled_expr.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = as_instance(_find_property(
      get_comp(project2, "expression_disabled").layers[0],
      match_name,
    ), Property);
    expect(prop2.expression_enabled).toBe(true);
  });

  test("test_set_expression_enables_disabled", () => {
    const tmp_path = make_tmp_path();
    // Assigning an expression to a property whose expression was DISABLED
    // must enable it (AE semantics) and clear the tdb4 disabled bit, so it
    // never persists the contradictory "has expression + disabled" state.
    const project = parse_aep(SAMPLES_DIR.div("expression.aep")).project;
    const comp = get_comp(project, "expression_disabled");
    const layer = comp.layers[0];
    let prop: Property | null = null;
    for (const p of layer.transform) {
      const leaf = as_instance(p, Property);
      if (py_bool(leaf.expression) && !py_bool(leaf.expression_enabled)) {
        prop = leaf;
        break;
      }
    }
    py_assert(prop != null);
    const match_name = prop.match_name;

    prop.expression = "100";
    expect(prop.expression_enabled).toBe(true);
    expect(prop._tdb4._expr_flags).toBe(0);

    const out = tmp_path.div("reenabled_expr.aep");
    project.save(out);
    const prop2 = as_instance(_find_property(
      get_comp(parse_aep(out).project, "expression_disabled").layers[0],
      match_name,
    ), Property);
    expect(prop2.expression).toBe("100");
    expect(prop2.expression_enabled).toBe(true);
  });
});

describe("TestRoundtripRotoBezier", () => {
  /** Roundtrip: toggle MaskPropertyGroup.roto_bezier. */

  test("test_disable_roto_bezier", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("mask_rotobezier_on.aep")).project;
    const layer = project.compositions[0].layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask instanceof MaskPropertyGroup);
    expect(mask.roto_bezier).toBe(true);

    mask.roto_bezier = false;
    const out = tmp_path.div("modified_roto.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const mask2 = as_instance(as_instance(project2.compositions[0].layers[0].masks, PropertyGroup).property(0), MaskPropertyGroup);
    py_assert(mask2 instanceof MaskPropertyGroup);
    expect(mask2.roto_bezier).toBe(false);
  });
});

describe("TestKeyedEffectPointArcMetric", () => {
  /**
   * Keying a point stored normalized to its layer stamps how AE measures
   * its motion path - the layer's display aspect and the normalized-point
   * accuracy - and AE plays the stored values, so a path keyed by py_aep has
   * to equal AE's own keying (AE 2026: Gradient Ramp and Point Control on a
   * 3000x200 solid, effect_point_static.aep holding the never-keyed Ramp).
   */

  const AEP = SAMPLES_DIR.div("effect_point_static.aep");
  const KEYS: [number, number[]][] = [
    [0.0, [100.0, 50.0]],
    [1.0, [2900.0, 150.0]],
    [2.0, [1500.0, 20.0]],
  ];
  // AE 2026 valueAtTime after setting the same three keys.
  const AE_VALUES = new Map<number, number[]>([
    [0.125, [450.000162621298, 62.5000058079035]],
    [0.375, [1149.99974230726, 87.4999907966879]],
    [1.25, [2549.99949578272, 117.499953179824]],
    [1.625, [2024.99987115363, 68.7499880356941]],
  ]);

  /** Static method `_effects` in the Python class. */
  function _effects(project: Project): PropertyGroup {
    const comp = _next(project.compositions, (c) => c.name === "MASK_LAYER_SPACE");
    const layer = _next(comp.layers, (lyr) => lyr.name === "solid_3000x200");
    return layer.property("ADBE Effect Parade");
  }

  test.each(["ADBE Ramp", "ADBE Point Control"])("test_keyed_point_plays_like_ae[%#]", (match_name) => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(AEP);
    const effects = _effects(app.project);
    if (match_name === "ADBE Point Control") {
      effects.add_property(match_name);
    }
    let point = as_instance(as_instance(effects.properties.at(-1), PropertyGroup).property(`${match_name}-0001`), Property);
    expect(point._tdb4.pixel_aspect).toBe(1.0); // never keyed
    for (const [time, value] of KEYS) {
      point.set_value_at_time(time, value);
    }
    expect(point._tdb4.pixel_aspect).toBe(15.0);
    expect(point._tdb4._arc_accuracy).toBe(NORMALIZED_ARC_ACCURACY);
    const out = tmp_path.div("keyed.aep");
    app.project.save(out);
    point = as_instance(
      as_instance(_effects(parse_aep(out).project).properties.at(-1), PropertyGroup).property(`${match_name}-0001`),
      Property,
    );
    for (const [time, expected] of AE_VALUES) {
      expect(approx(point.value_at_time(time), expected, { abs: 1e-9 })).toBe(true);
    }
  });
});

describe("TestRoundtripDimensionsSeparated", () => {
  /** Roundtrip: toggle Property.dimensions_separated and verify save/reload. */

  test("test_separate_dimensions", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("transform_separated.aep")).project;
    const layer = project.compositions[0].layers[0];
    const prop = _find_property(layer, "ADBE Position");
    py_assert(prop != null);
    expect(prop.dimensions_separated).toBe(true);

    prop.dimensions_separated = false;
    const out = tmp_path.div("unseparated.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = as_instance(_find_property(project2.compositions[0].layers[0], "ADBE Position"), Property);
    expect(prop2.dimensions_separated).toBe(false);
  });

  test("test_unseparate_dimensions", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("transform_separated.aep")).project;
    const layer = project.compositions[0].layers[0];
    const prop = _find_property(layer, "ADBE Position");
    py_assert(prop != null);
    expect(prop.dimensions_separated).toBe(true);

    prop.dimensions_separated = false;
    const out = tmp_path.div("unseparated.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const prop2 = as_instance(_find_property(project2.compositions[0].layers[0], "ADBE Position"), Property);
    expect(prop2.dimensions_separated).toBe(false);
  });
});

describe("TestPropertyRemove", () => {
  /** Tests for PropertyBase.remove(). */

  const AEP = SAMPLES_DIR.div("2_gaussian.aep");

  test("test_remove_effect", () => {
    /** Remove an effect and verify the model updates. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    expect(as_instance(layer.effects, PropertyGroup).properties.length).toBe(2);
    const first_name = as_instance(layer.effects, PropertyGroup).properties[0].name;
    as_instance(layer.effects, PropertyGroup).properties[1].remove();
    expect(as_instance(layer.effects, PropertyGroup).properties.length).toBe(1);
    expect(as_instance(layer.effects, PropertyGroup).properties[0].name).toBe(first_name);
  });

  test("test_remove_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Remove an effect, save, reload and verify. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    as_instance(layer.effects, PropertyGroup).properties[0].remove();
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const layer2 = app2.project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    expect(as_instance(layer2.effects, PropertyGroup).properties.length).toBe(1);
    expect(as_instance(layer2.effects, PropertyGroup).properties[0].name).toBe("Gaussian Blur 2");
  });

  test("test_remove_non_indexed_raises", () => {
    /** Removing from a non-indexed group raises ValueError. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    const transform = [...layer.properties].filter(
      (p) => p.match_name === "ADBE Transform Group",
    )[0];
    const position = [...as_instance(transform, PropertyGroup).properties].filter((p) => p.match_name === "ADBE Position")[0];
    raises(ValueError, () => {
      position.remove();
    }, "non-indexed");
  });

  test("test_remove_all_effects", () => {
    /** Remove all effects leaves an empty parade. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    const effects = layer.effects;
    py_assert(effects != null);
    effects.properties[1].remove();
    effects.properties[0].remove();
    expect(effects.properties.length).toBe(0);
    // The parade stays reachable but empty (and falsy)
    expect(layer.effects).toBe(effects);
    // `not layer.effects` is `len(...) == 0`: py_bool() would probe `__bool__` through the PropertyGroup __getattr__ proxy and raise.
    expect(len(layer.effects) > 0).toBe(false);
  });

  test("test_remove_all_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Remove all effects, save, reload and verify. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    const effects = layer.effects;
    py_assert(effects != null);
    effects.properties[1].remove();
    effects.properties[0].remove();
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const layer2 = app2.project.compositions[0].layers[0];
    // After removing all, the parade is still reachable but empty
    py_assert(layer2.effects != null);
    expect(len(layer2.effects)).toBe(0);
  });
});

describe("TestPropertyMoveTo", () => {
  /** Tests for PropertyBase.move_to(). */

  const AEP = SAMPLES_DIR.div("2_gaussian.aep");

  test("test_move_to_basic", () => {
    /** Swap the order of two effects. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const first_name = as_instance(layer.effects, PropertyGroup).properties[0].name;
    const second_name = as_instance(layer.effects, PropertyGroup).properties[1].name;
    // Move second to position 0
    as_instance(layer.effects, PropertyGroup).properties[1].move_to(0);
    expect(as_instance(layer.effects, PropertyGroup).properties[0].name).toBe(second_name);
    expect(as_instance(layer.effects, PropertyGroup).properties[1].name).toBe(first_name);
  });

  test("test_move_to_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Move effects around, save and reload. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const second_name = as_instance(layer.effects, PropertyGroup).properties[1].name;
    as_instance(layer.effects, PropertyGroup).properties[1].move_to(0);
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const layer2 = app2.project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    expect(as_instance(layer2.effects, PropertyGroup).properties[0].name).toBe(second_name);
  });

  test("test_move_to_same_index", () => {
    /** Moving to current position is a no-op. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const first_name = as_instance(layer.effects, PropertyGroup).properties[0].name;
    as_instance(layer.effects, PropertyGroup).properties[0].move_to(0);
    expect(as_instance(layer.effects, PropertyGroup).properties[0].name).toBe(first_name);
  });

  test("test_move_to_invalid_raises", () => {
    /** Invalid index raises IndexError. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    raises(IndexError, () => {
      as_instance(layer.effects, PropertyGroup).properties[0].move_to(5);
    });
  });
});

describe("TestPropertyDuplicate", () => {
  /** Tests for PropertyBase.duplicate(). */

  const AEP = SAMPLES_DIR.div("2_gaussian.aep");

  test("test_duplicate_effect", () => {
    /** Duplicate creates a new effect after the original. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const original = as_instance(layer.effects, PropertyGroup).properties[0];
    const new_prop = original.duplicate();
    expect(as_instance(layer.effects, PropertyGroup).properties.length).toBe(3);
    expect<PropertyBase>(as_instance(layer.effects, PropertyGroup).properties[1]).toBe(new_prop);
    expect(new_prop.match_name).toBe(original.match_name);
  });

  test("test_duplicate_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Duplicate, save and reload. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    as_instance(layer.effects, PropertyGroup).properties[0].duplicate();
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const layer2 = app2.project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    expect(as_instance(layer2.effects, PropertyGroup).properties.length).toBe(3);
    // First and second should have same match name
    expect(as_instance(layer2.effects, PropertyGroup).properties[0].match_name).toBe(as_instance(layer2.effects, PropertyGroup).properties[1].match_name);
  });

  test("test_duplicate_non_indexed_raises", () => {
    /** Duplicating a non-indexed property raises ValueError. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    const transform = [...layer.properties].filter(
      (p) => p.match_name === "ADBE Transform Group",
    )[0];
    const position = [...as_instance(transform, PropertyGroup).properties].filter((p) => p.match_name === "ADBE Position")[0];
    raises(ValueError, () => {
      position.duplicate();
    }, "non-indexed");
  });

  test("test_duplicate_preserves_values", () => {
    /** Duplicated effect has the same param values. */
    const app = parse_aep(SAMPLES_DIR.div("2_gaussian_20_30.aep"));
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const original = as_instance(layer.effects, PropertyGroup).properties[0];
    const new_prop = original.duplicate();
    // Both should be PropertyGroups (effects)
    py_assert(new_prop instanceof PropertyGroup);
    py_assert(original instanceof PropertyGroup);
    // Check blurriness value matches
    const orig_blur = [...original.properties].filter(
      (p) => p.match_name === "ADBE Gaussian Blur-0001",
    );
    const new_blur = [...new_prop.properties].filter(
      (p) => p.match_name === "ADBE Gaussian Blur-0001",
    );
    if (py_bool(orig_blur) && py_bool(new_blur)) {
      expect(py_eq(as_instance(orig_blur[0], Property).value, as_instance(new_blur[0], Property).value)).toBe(true);
    }
  });

  test("test_remove_then_duplicate", () => {
    const tmp_path = make_tmp_path();
    /** Remove all, duplicate last remaining, verify clean state. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    // Remove second
    as_instance(layer.effects, PropertyGroup).properties[1].remove();
    expect(as_instance(layer.effects, PropertyGroup).properties.length).toBe(1);
    // Duplicate remaining
    as_instance(layer.effects, PropertyGroup).properties[0].duplicate();
    expect(as_instance(layer.effects, PropertyGroup).properties.length).toBe(2);
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const app2 = parse_aep(out);
    const layer2 = app2.project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    expect(as_instance(layer2.effects, PropertyGroup).properties.length).toBe(2);
  });
});

describe("TestMaskMutations", () => {
  /**
   * Mutations on mask atoms, which span three chunks in the parade
   * (`tdmn` + `mkif` + `tdgp`) instead of the usual `(tdmn, body)` pair.
   */

  const AEP = SAMPLES_DIR.div("mask.aep");

  /** Static method `_parade_chunk_types` in the Python class. */
  function _parade_chunk_types(parade: PropertyGroup): string[] {
    py_assert(parade._tdgp != null);
    return parade._tdgp.chunks.map((c) => py_or(getattr(c, "list_type", null), c.chunk_type));
  }

  test("test_remove_mask_deletes_full_span", () => {
    /** remove() deletes tdmn, mkif and tdgp - no orphaned chunks. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    const masks = layer.masks;
    py_assert(masks != null);
    expect(masks.properties.length).toBe(2);
    masks.properties[0].remove();
    expect(masks.properties.length).toBe(1);
    expect(py_eq(_parade_chunk_types(masks), [
      "tdsb",
      "tdsn",
      "tdmn",
      "mkif",
      "tdgp",
      "tdmn",
    ])).toBe(true);
  });

  test("test_remove_mask_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Remove a mask, save, reload and verify. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    as_instance(layer.masks, PropertyGroup).properties[0].remove();
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.masks != null);
    expect(as_instance(layer2.masks, PropertyGroup).properties.length).toBe(1);
    expect(as_instance(layer2.masks, PropertyGroup).properties[0].name).toBe("Mask 2");
  });

  test("test_duplicate_mask", () => {
    /** Duplicate clones the mkif and rebuilds a MaskPropertyGroup. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    const masks = layer.masks;
    py_assert(masks != null);
    const original = masks.properties[0];
    py_assert(original instanceof MaskPropertyGroup);
    const new_prop = masks.properties[0].duplicate();
    expect(masks.properties.length).toBe(3);
    expect<PropertyBase>(masks.properties[1]).toBe(new_prop);
    py_assert(new_prop instanceof MaskPropertyGroup);
    expect(new_prop.is_mask).toBe(true);
    expect(new_prop.mask_mode).toBe(original.mask_mode);
    expect(new_prop.inverted).toBe(original.inverted);
    // AE assigns the duplicate a fresh per-layer mask id (max+1) and the
    // matching "<base> <new_id>" name, not the source's id/name (verified
    // in AE 2026: duplicating "Mask 1" of ["Mask 1","Mask 2"] -> "Mask 3").
    expect(original._mkif.mask_id).toBe(1);
    expect(new_prop._mkif.mask_id).toBe(3);
    expect(new_prop.name).toBe("Mask 3");
    // The clone's mkif is an independent chunk.
    new_prop.inverted = !original.inverted;
    expect(new_prop.inverted !== original.inverted).toBe(true);
  });

  test("test_duplicate_mask_synthesizes_children", () => {
    /** The duplicate re-fills synthesized children like a fresh parse. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    const new_prop = as_instance(layer.masks, PropertyGroup).properties[0].duplicate();
    py_assert(new_prop instanceof MaskPropertyGroup);
    expect(py_eq(new_prop.properties.map((c: Property | PropertyGroup) => c.name), [
      "Mask Path",
      "Mask Feather",
      "Mask Opacity",
      "Mask Expansion",
    ])).toBe(true);
  });

  test("test_duplicate_mask_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Duplicate a mask, save, reload and verify. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    as_instance(layer.masks, PropertyGroup).properties[0].duplicate();
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.masks != null);
    expect(as_instance(layer2.masks, PropertyGroup).properties.length).toBe(3);
    expect(as_instance(layer2.masks, PropertyGroup).properties.every((m: Property | PropertyGroup) => m instanceof MaskPropertyGroup)).toBe(true);
    // AE inserts the copy after the source and names it "Mask 3" (max id
    // + 1), with a matching unique mask id - not a duplicate "Mask 1"/id 1.
    expect(py_eq(as_instance(layer2.masks, PropertyGroup).properties.map((m: Property | PropertyGroup) => m.name), [
      "Mask 1",
      "Mask 3",
      "Mask 2",
    ])).toBe(true);
    const ids = as_instance(layer2.masks, PropertyGroup).properties.map((m: Property | PropertyGroup) => as_instance(m, MaskPropertyGroup)._mkif.mask_id);
    expect(py_eq(ids, [1, 3, 2])).toBe(true);
    expect(new Set(ids).size === ids.length).toBe(true);
  });

  test("test_duplicate_renamed_mask", () => {
    /**
     * A renamed mask's duplicate keeps the base name + a fresh number.
     *
     * AE 2026: duplicating "Eyes" (when ids [1, 2] exist) yields "Eyes 3"
     * with mask id 3 - the source's base name plus the new max+1 id.
     */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    as_instance(layer.masks, PropertyGroup).properties[0].name = "Eyes";
    const new_prop = as_instance(layer.masks, PropertyGroup).properties[0].duplicate();
    py_assert(new_prop instanceof MaskPropertyGroup);
    expect(new_prop.name).toBe("Eyes 3");
    expect(new_prop._mkif.mask_id).toBe(3);
  });

  test("test_move_mask_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Move a mask, save, reload and verify the order. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    as_instance(layer.masks, PropertyGroup).properties[1].move_to(0);
    expect(py_eq(as_instance(layer.masks, PropertyGroup).properties.map((m: Property | PropertyGroup) => m.name), ["Mask 2", "Mask 1"])).toBe(true);
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.masks != null);
    expect(py_eq(as_instance(layer2.masks, PropertyGroup).properties.map((m: Property | PropertyGroup) => m.name), ["Mask 2", "Mask 1"])).toBe(true);
  });
});

describe("TestAddProperty", () => {
  /** Tests for PropertyGroup.add_property() (mask atoms). */

  const AEP = SAMPLES_DIR.div("mask.aep");
  const NO_MASK_AEP = LAYER_SAMPLES_DIR.div("gray_solid_1_above.aep");

  test("test_add_mask_to_existing_parade", () => {
    /** Adding a mask appends a default atom to the parade. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    const masks = layer.masks;
    py_assert(masks != null);
    const new_mask = masks.add_property("ADBE Mask Atom");
    py_assert(new_mask instanceof MaskPropertyGroup);
    expect(masks.properties.length).toBe(3);
    expect(masks.properties[2]).toBe(new_mask);
    expect(new_mask.name).toBe("Mask 3");
    expect(new_mask.is_mask).toBe(true);
    expect(new_mask.mask_mode).toBe(MaskMode.ADD);
    expect(new_mask.inverted).toBe(false);
    expect(new_mask._mkif.mask_id).toBe(3);
  });

  test("test_add_mask_names_past_the_highest_mask_number", () => {
    /**
     * AE numbers a new mask's name past the highest "Mask N" name, not
     * by its id (AE 2026).
     */
    const app = parse_aep(AEP);
    const masks = app.project.compositions[0].layers[0].masks;
    py_assert(masks != null);
    masks.properties[1].name = "stored";
    const new_mask = masks.add_property("ADBE Mask Atom");
    py_assert(new_mask instanceof MaskPropertyGroup);
    expect(py_eq([new_mask.name, new_mask._mkif.mask_id], ["Mask 2", 3])).toBe(true);

    const app2 = parse_aep(AEP);
    const masks2 = app2.project.compositions[0].layers[0].masks;
    py_assert(masks2 != null);
    masks2.properties[1].name = "Mask 3";
    const new_mask2 = masks2.add_property("ADBE Mask Atom");
    py_assert(new_mask2 instanceof MaskPropertyGroup);
    expect(py_eq([new_mask2.name, new_mask2._mkif.mask_id], ["Mask 4", 3])).toBe(true);
  });

  test("test_expression_on_path_less_mask_writes_default_path", () => {
    const tmp_path = make_tmp_path();
    /**
     * An expression on a fresh mask's path makes AE write the default
     * full-frame path (`om-s` with its `omks`); a bare `tdbs` placeholder
     * is "file is damaged" (AE 2026).
     */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    const mask = as_instance(layer.masks, PropertyGroup).add_property("ADBE Mask Atom");
    mask.property("ADBE Mask Shape").expression = "value";
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.masks != null);
    const mask2 = as_instance(as_instance(layer2.masks, PropertyGroup).properties.at(-1), MaskPropertyGroup);
    py_assert(mask2._tdgp != null);
    const oms = mask2._tdgp.chunks.find((c: Chunk) => getattr(c, "list_type", null) === "om-s");
    if (!(oms instanceof ListChunk)) throw new StopIteration();
    expect(py_eq(oms.chunks.map((c: Chunk) => getattr(c, "list_type", null)), ["tdbs", "omks"])).toBe(true);
    const path = mask2.property("ADBE Mask Shape");
    expect(path.expression).toBe("value");
    const [w, h] = as_instance(layer2, AVLayer)._mask_scale;
    expect(py_eq(path.value.vertices, [[0.0, 0.0], [0.0, h], [w, h], [w, 0.0]])).toBe(true);
  });

  test("test_add_mask_by_display_name", () => {
    /** The display name `Mask` resolves to the mask atom match name. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    const new_mask = as_instance(layer.masks, PropertyGroup).add_property("Mask");
    expect(new_mask.match_name).toBe("ADBE Mask Atom");
  });

  test("test_add_mask_synthesizes_children", () => {
    /** A new mask exposes the four canonical children, like AE. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    const new_mask = as_instance(layer.masks, PropertyGroup).add_property("ADBE Mask Atom");
    py_assert(new_mask instanceof MaskPropertyGroup);
    expect(py_eq(new_mask.properties.map((c: Property | PropertyGroup) => c.name), [
      "Mask Path",
      "Mask Feather",
      "Mask Opacity",
      "Mask Expansion",
    ])).toBe(true);
  });

  test("test_add_mask_writes_minimal_chunks", () => {
    /**
     * AE writes no Mask Shape subtree for a fresh mask - just
     * `tdmn + mkif + tdgp[tdsb, tdsn, group end]`.
     */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    const new_mask = as_instance(layer.masks, PropertyGroup).add_property("ADBE Mask Atom");
    py_assert(new_mask instanceof MaskPropertyGroup);
    py_assert(new_mask._tdgp != null);
    expect(py_eq(new_mask._tdgp.chunks.map((c: Chunk) => py_or(getattr(c, "list_type", null), c.chunk_type)), [
      "tdsb",
      "tdsn",
      "tdmn",
    ])).toBe(true);
    expect(py_bool(new_mask._tdgp.synthetic)).toBe(false);
  });

  test("test_add_mask_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Add a mask, save, reload and verify. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    as_instance(layer.masks, PropertyGroup).add_property("ADBE Mask Atom");
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.masks != null);
    expect(py_eq(as_instance(layer2.masks, PropertyGroup).properties.map((m: Property | PropertyGroup) => m.name), [
      "Mask 1",
      "Mask 2",
      "Mask 3",
    ])).toBe(true);
    const mask3 = as_instance(layer2.masks, PropertyGroup).properties[2];
    py_assert(mask3 instanceof MaskPropertyGroup);
    expect(mask3.mask_mode).toBe(MaskMode.ADD);
    expect(mask3._mkif.mask_id).toBe(3);
    expect(py_eq(mask3.properties.map((c: Property | PropertyGroup) => c.name), [
      "Mask Path",
      "Mask Feather",
      "Mask Opacity",
      "Mask Expansion",
    ])).toBe(true);
  });

  test("test_add_first_mask_materializes_parade", () => {
    const tmp_path = make_tmp_path();
    /**
     * Adding to a layer with no masks materializes the synthetic
     * parade at the canonical position (before Transform Group).
     */
    const app = parse_aep(NO_MASK_AEP);
    const layer = app.project.compositions[0].layers[0];
    // `not layer.masks` is `len(...) == 0` (py_bool would probe `__bool__` through the group proxy and raise).
    expect(len(layer.masks) > 0).toBe(false);
    const parade = layer.property("ADBE Mask Parade");
    py_assert(parade instanceof PropertyGroup);
    expect(parade._is_live()).toBe(false);
    const new_mask = parade.add_property("ADBE Mask Atom");
    expect(parade._is_live()).toBe(true);
    expect(new_mask.name).toBe("Mask 1");
    expect(layer.masks).toBe(parade);
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.masks != null);
    expect(py_eq(as_instance(layer2.masks, PropertyGroup).properties.map((m: Property | PropertyGroup) => m.name), ["Mask 1"])).toBe(true);
    // Parade must be written before the Transform Group, as AE does.
    py_assert(layer2._tdgp != null);
    const chunks = layer2._tdgp.chunks;
    const parade_idx = chunks.findIndex(
      (c: Chunk, i: number) =>
        c.chunk_type === "tdmn" &&
        getattr(c, "value", null) === "ADBE Mask Parade" &&
        !c.synthetic,
    );
    const transform_idx = chunks.findIndex(
      (c: Chunk, i: number) => c.chunk_type === "tdmn" && getattr(c, "value", null) === "ADBE Transform Group",
    );
    expect(parade_idx >= 0).toBe(true); // `next(...)` raises StopIteration when nothing matches
    expect(transform_idx >= 0).toBe(true);
    expect(parade_idx < transform_idx).toBe(true);
  });

  test("test_add_mask_then_mutate", () => {
    const tmp_path = make_tmp_path();
    /** A new mask accepts attribute writes that survive a reload. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    const new_mask = as_instance(layer.masks, PropertyGroup).add_property("ADBE Mask Atom");
    py_assert(new_mask instanceof MaskPropertyGroup);
    new_mask.inverted = true;
    new_mask.mask_mode = MaskMode.SUBTRACT;
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.masks != null);
    const mask3 = as_instance(layer2.masks, PropertyGroup).properties[2];
    py_assert(mask3 instanceof MaskPropertyGroup);
    expect(mask3.inverted).toBe(true);
    expect(mask3.mask_mode).toBe(MaskMode.SUBTRACT);
  });

  test("test_add_mask_color_cycles", () => {
    /** Outline colors cycle deterministically by creation index. */
    const app = parse_aep(NO_MASK_AEP);
    const layer = app.project.compositions[0].layers[0];
    const parade = layer.property("ADBE Mask Parade");
    py_assert(parade instanceof PropertyGroup);
    const colors = new Set<string>();
    for (let _ = 0; _ < 3; _++) {
      const mask = parade.add_property("ADBE Mask Atom");
      py_assert(mask instanceof MaskPropertyGroup);
      colors.add(tkey(...mask.color));
    }
    expect(colors.size).toBe(3);
  });

  test("test_add_mask_id_no_collision_after_remove", () => {
    /**
     * A mask added after a mid-parade removal gets a fresh id and name
     * (highest existing + 1), never colliding with a surviving mask.
     */
    const app = parse_aep(AEP); // mask.aep: Mask 1 (id 1), Mask 2 (id 2)
    const masks = app.project.compositions[0].layers[0].masks;
    py_assert(masks != null);
    const m3 = masks.add_property("ADBE Mask Atom");
    py_assert(m3 instanceof MaskPropertyGroup);
    expect(m3._mkif.mask_id).toBe(3);
    // Remove the middle mask, then add another: count+1 would reuse id 3.
    masks.properties[1].remove();
    const m_new = masks.add_property("ADBE Mask Atom");
    py_assert(m_new instanceof MaskPropertyGroup);
    const ids = masks.properties
      .filter((m: Property | PropertyGroup) => m instanceof MaskPropertyGroup)
      .map((m: Property | PropertyGroup) => as_instance(m, MaskPropertyGroup)._mkif.mask_id);
    const names = masks.properties.map((m: Property | PropertyGroup) => m.name);
    py_assert(new Set(ids).size === ids.length, `duplicate mask ids: ${repr(ids)}`);
    py_assert(new Set(names).size === names.length, `duplicate mask names: ${repr(names)}`);
    expect(m_new._mkif.mask_id).toBe(4); // max(1, 3) + 1, not count(2) + 1
    expect(m_new.name).toBe("Mask 4");
  });

  test("test_add_mask_roto_bezier_materializes", () => {
    const tmp_path = make_tmp_path();
    /**
     * Enabling rotoBezier on a freshly added mask materializes the
     * default full-frame Mask Shape AE writes (mirroring AE, which has
     * no Mask Shape subtree until rotoBezier/path is set) and round-trips.
     */
    const app = parse_aep(NO_MASK_AEP);
    const parade = app.project.compositions[0].layers[0].property("ADBE Mask Parade");
    py_assert(parade instanceof PropertyGroup);
    const mask = parade.add_property("ADBE Mask Atom");
    py_assert(mask instanceof MaskPropertyGroup);
    expect(mask.roto_bezier).toBe(false);
    mask.roto_bezier = true;
    expect(mask.roto_bezier).toBe(true);
    // The Mask Path now exposes the default full-frame rectangle (4
    // bezier vertices), not None, and exactly one Mask Shape is written.
    const mask_path = mask.properties.find((p: Property | PropertyGroup) => p.match_name === "ADBE Mask Shape");
    py_assert(mask_path instanceof Property);
    expect(mask_path.value instanceof Shape).toBe(true);
    expect(mask_path.value.vertices.length).toBe(4);
    py_assert(mask._tdgp != null);
    expect(
      mask._tdgp.chunks.filter((c: Chunk) => getattr(c, "value", null) === "ADBE Mask Shape").length,
    ).toBe(1);
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const m2 = as_instance(parse_aep(out).project.compositions[0].layers[0].masks, PropertyGroup).properties.at(-1);
    py_assert(m2 instanceof MaskPropertyGroup);
    expect(m2.roto_bezier).toBe(true);
    const mp2 = m2.properties.find((p: Property | PropertyGroup) => p.match_name === "ADBE Mask Shape");
    py_assert(mp2 instanceof Property);
    expect(mp2.value instanceof Shape).toBe(true);
    expect(mp2.value.vertices.length).toBe(4);
  });

  test("test_set_mask_path_keeps_roto_bezier_off", () => {
    const tmp_path = make_tmp_path();
    /**
     * A plain bezier path write must NOT enable RotoBezier: the
     * materialization template originates from an enable-rotoBezier
     * capture, but AE writes the roto tdsb byte 0 for ordinary paths
     * (psd_vector_mask fixtures). Validated through a disk round-trip -
     * the flag lives in the written mask-shape tdsb.
     */
    const app = parse_aep(NO_MASK_AEP);
    const parade = app.project.compositions[0].layers[0].property("ADBE Mask Parade");
    py_assert(parade instanceof PropertyGroup);
    const mask = parade.add_property("ADBE Mask Atom");
    py_assert(mask instanceof MaskPropertyGroup);
    const mask_path = mask.property("ADBE Mask Shape");
    py_assert(mask_path instanceof Property);
    mask_path.value = new Shape([[10.0, 10.0], [50.0, 10.0], [50.0, 50.0], [10.0, 50.0]], null, null, { closed: true });
    expect(mask.roto_bezier).toBe(false);
    const out = tmp_path.div("plain_path.aep");
    app.project.save(out);
    const m2 = as_instance(parse_aep(out).project.compositions[0].layers[0].masks, PropertyGroup).properties.at(-1);
    py_assert(m2 instanceof MaskPropertyGroup);
    expect(m2.roto_bezier).toBe(false);
    py_assert(m2._mask_shape_tdsb != null);
    expect(m2._mask_shape_tdsb.roto_bezier).toBe(false);
  });

  test("test_materialize_mask_shape_preserves_handle", () => {
    /**
     * Materializing the Mask Shape keeps the existing child object.
     *
     * A handle fetched before enabling rotoBezier must stay valid (and
     * keep writing to the live chunks) rather than being orphaned by a
     * fresh-object swap.
     */
    const app = parse_aep(NO_MASK_AEP);
    const parade = app.project.compositions[0].layers[0].property("ADBE Mask Parade");
    py_assert(parade instanceof PropertyGroup);
    const mask = parade.add_property("ADBE Mask Atom");
    py_assert(mask instanceof MaskPropertyGroup);
    const handle = mask.property("ADBE Mask Shape");
    mask.roto_bezier = true;
    // The pre-fetched handle is still the live child (identity preserved).
    expect(handle).toBe(mask.property("ADBE Mask Shape"));
    expect(mask.properties.includes(handle)).toBe(true);
    py_assert(handle instanceof Property);
    expect(handle.value instanceof Shape).toBe(true);
    expect(handle.value.vertices.length).toBe(4);
  });

  test("test_add_mask_roto_bezier_false_is_noop", () => {
    /**
     * Setting rotoBezier=False on a mask with no Mask Shape writes
     * nothing (AE leaves a default mask without a Mask Shape subtree).
     */
    const app = parse_aep(NO_MASK_AEP);
    const parade = app.project.compositions[0].layers[0].property("ADBE Mask Parade");
    py_assert(parade instanceof PropertyGroup);
    const mask = parade.add_property("ADBE Mask Atom");
    py_assert(mask instanceof MaskPropertyGroup);
    mask.roto_bezier = false;
    expect(mask.roto_bezier).toBe(false);
    py_assert(mask._tdgp != null);
    expect(
      mask._tdgp.chunks.some((c: Chunk) => getattr(c, "value", null) === "ADBE Mask Shape"),
    ).toBe(false);
  });

  test("test_add_property_invalid_name_raises", () => {
    /** An unknown name raises ValueError. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.masks != null);
    raises(ValueError, () => {
      as_instance(layer.masks, PropertyGroup).add_property("Not A Property");
    }, "Cannot add property");
  });

  test("test_add_property_non_indexed_raises", () => {
    /** Adding to a non-indexed group raises ValueError. */
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    const transform = layer.property("ADBE Transform Group");
    py_assert(transform instanceof PropertyGroup);
    raises(ValueError, () => {
      transform.add_property("ADBE Mask Atom");
    }, "Cannot add property");
  });

  test("test_add_dropdown_control", () => {
    /**
     * The Dropdown Menu Control adds with a generated pseudo match
     * name and a Menu enum param carrying the default items.
     */
    const app = parse_aep(SAMPLES_DIR.div("2_gaussian.aep"));
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const fx = as_instance(layer.effects, PropertyGroup).add_property("ADBE Dropdown Control");
    py_assert(fx instanceof PropertyGroup);
    expect(fx.is_effect).toBe(true);
    expect(fx.name).toBe("Dropdown Menu Control");
    expect(fx.match_name.startsWith("Pseudo/@@")).toBe(true);
    expect(fx.match_name.length).toBe("Pseudo/@@".length + 22);
    expect(py_eq(fx.properties.map((c: Property | PropertyGroup) => c.name), ["Menu", "Compositing Options"])).toBe(true);
    const menu = fx.properties[0];
    py_assert(menu instanceof Property);
    expect(menu.value).toBe(1);
    expect(py_eq(menu.property_parameters, ["Item 1", "Item 2", "Item 3"])).toBe(true);
  });

  test("test_add_dropdown_by_display_name", () => {
    const app = parse_aep(SAMPLES_DIR.div("2_gaussian.aep"));
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const fx = as_instance(layer.effects, PropertyGroup).add_property("Dropdown Menu Control");
    expect(fx.match_name.startsWith("Pseudo/@@")).toBe(true);
  });

  test("test_add_dropdowns_distinct_names", () => {
    /**
     * Each dropdown gets a fresh per-instance match name; AE-style
     * numbering counts dropdowns by the Pseudo namespace.
     */
    const app = parse_aep(NO_MASK_AEP);
    const parade = app.project.compositions[0].layers[0].property("ADBE Effect Parade");
    py_assert(parade instanceof PropertyGroup);
    const d1 = parade.add_property("ADBE Dropdown Control");
    const d2 = parade.add_property("ADBE Dropdown Control");
    expect(d1.match_name !== d2.match_name).toBe(true);
    expect(d1.name).toBe("Dropdown Menu Control");
    expect(d2.name).toBe("Dropdown Menu Control 2");
  });

  test("test_add_dropdown_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** A dropdown survives save/reload with its menu intact. */
    const app = parse_aep(NO_MASK_AEP);
    const parade = app.project.compositions[0].layers[0].property("ADBE Effect Parade");
    py_assert(parade instanceof PropertyGroup);
    const fx = parade.add_property("ADBE Dropdown Control");
    const mn = fx.match_name;
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    const fx2 = as_instance(layer2.effects, PropertyGroup).properties[0];
    py_assert(fx2 instanceof PropertyGroup);
    expect(fx2.match_name).toBe(mn);
    expect(fx2.name).toBe("Dropdown Menu Control");
    const menu2 = fx2.properties[0];
    py_assert(menu2 instanceof Property);
    expect(py_eq(menu2.property_parameters, ["Item 1", "Item 2", "Item 3"])).toBe(true);
  });
});

describe("TestSetPropertyParameters", () => {
  /** Tests for the writable Property.property_parameters. */

  const AEP = PROPERTY_SAMPLES_DIR.div("2_gaussian.aep");
  const ITEMS = ["First Item", "Second Item", "(-", "Another Item", "Last Item"];

  /** Method `_menu` in the Python class. */
  function _menu(app: Application): [PropertyGroup, Property] {
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const fx = as_instance(layer.effects.add_property("ADBE Dropdown Control"), PropertyGroup);
    const menu = fx.properties[0];
    py_assert(menu instanceof Property);
    return [fx, menu];
  }

  test("test_set_items_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(AEP);
    const [fx, menu] = _menu(app);
    menu.property_parameters = ITEMS;
    expect(py_eq(menu.property_parameters, ITEMS)).toBe(true);
    expect(menu.nb_options).toBe(5);
    expect(menu.max_value).toBe(5);
    expect(menu.value_text).toBe("First Item");

    const out = tmp_path.div("dropdown_items.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    const fx2 = as_instance(_next(layer2.effects.properties, (e) => e.match_name === fx.match_name), PropertyGroup);
    const menu2 = as_instance(fx2.properties[0], Property);
    expect(py_eq(menu2.property_parameters, ITEMS)).toBe(true);
    expect(menu2.nb_options).toBe(5);
    expect(menu2.max_value).toBe(5);
    expect(menu2.value_text).toBe("First Item");
  });

  test("test_builtin_effect_dropdown_raises", () => {
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const blur = as_instance(layer.effects.properties[0], PropertyGroup);
    const blur_dims = as_instance(_next(blur.properties, (p) => p.name === "Blur Dimensions"), Property);
    py_assert(blur_dims.property_parameters != null);
    raises(ValueError, () => {
      blur_dims.property_parameters = ["A", "B"];
    }, "Dropdown Menu Control");
  });

  test("test_regular_property_raises", () => {
    const app = parse_aep(AEP);
    const layer = app.project.compositions[0].layers[0];
    const opacity = layer.transform.property("ADBE Opacity");
    raises(ValueError, () => {
      opacity.property_parameters = ["A", "B"];
    }, "Dropdown Menu Control");
  });

  test("test_invalid_items_raise", () => {
    const app = parse_aep(AEP);
    const [, menu] = _menu(app);
    const bads: (string[] | string)[] = [
      [],
      ["ok", ""],
      ["dup", "dup"],
      ["back\\slash"],
      ["pi|pe"],
      "not a list",
    ];
    for (const bad of bads) {
      raises(ValueError, () => {
        // @ts-expect-error "not a list" is a string, not string[]; the setter must raise ValueError at runtime
        menu.property_parameters = bad;
      });
    }
  });

  test("test_separator_may_repeat", () => {
    const app = parse_aep(AEP);
    const [, menu] = _menu(app);
    menu.property_parameters = ["A", "(-", "B", "(-", "C"];
    expect(menu.nb_options).toBe(5);
  });
});

describe("TestAddEffect", () => {
  /** Tests for PropertyGroup.add_property() (expression controls). */

  const NO_FX_AEP = LAYER_SAMPLES_DIR.div("gray_solid_1_above.aep");

  test("test_add_slider_to_existing_parade", () => {
    /** Adding a control appends a default effect to the parade. */
    const app = parse_aep(SAMPLES_DIR.div("2_gaussian.aep"));
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const fx = as_instance(layer.effects, PropertyGroup).add_property("ADBE Slider Control");
    py_assert(fx instanceof PropertyGroup);
    expect(fx.is_effect).toBe(true);
    expect(fx.name).toBe("Slider Control");
    expect(fx.match_name).toBe("ADBE Slider Control");
    // An effect is a NAMED group in AE (its parameter list is fixed); the
    // Effect Parade that holds it is the indexed one.
    expect(fx.property_type).toBe(PropertyType.NAMED_GROUP);
    expect(as_instance(layer.effects, PropertyGroup).properties.length).toBe(3);
    expect(as_instance(layer.effects, PropertyGroup).properties[2]).toBe(fx);
  });

  test("test_add_slider_param_defaults", () => {
    /** The control's parameter carries the baked parT definition. */
    const app = parse_aep(SAMPLES_DIR.div("2_gaussian.aep"));
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const fx = as_instance(layer.effects, PropertyGroup).add_property("Slider Control");
    py_assert(fx instanceof PropertyGroup);
    expect(py_eq(fx.properties.map((c: Property | PropertyGroup) => c.name), ["Slider", "Compositing Options"])).toBe(true);
    const slider = fx.properties[0];
    py_assert(slider instanceof Property);
    expect(slider.value).toBe(0.0);
    expect(slider.min_value).toBe(-1000000);
    expect(slider.max_value).toBe(1000000);
  });

  test("test_add_all_controls", () => {
    /** Every baked control adds with its AE default name and param. */
    const app = parse_aep(NO_FX_AEP);
    const layer = app.project.compositions[0].layers[0];
    const parade = layer.property("ADBE Effect Parade");
    py_assert(parade instanceof PropertyGroup);
    const expected = new Map<string, [string, string]>([
      ["ADBE Slider Control", ["Slider Control", "Slider"]],
      ["ADBE Color Control", ["Color Control", "Color"]],
      ["ADBE Checkbox Control", ["Checkbox Control", "Checkbox"]],
      ["ADBE Point Control", ["Point Control", "Point"]],
      ["ADBE Point3D Control", ["3D Point Control", "3D Point"]],
      ["ADBE Angle Control", ["Angle Control", "Angle"]],
      ["ADBE Layer Control", ["Layer Control", "Layer"]],
    ]);
    for (const [match_name, [fx_name, param_name]] of expected) {
      const fx = parade.add_property(match_name);
      py_assert(fx instanceof PropertyGroup);
      expect(fx.name).toBe(fx_name);
      expect(fx.properties[0].name).toBe(param_name);
    }
  });

  test("test_add_first_effect_materializes_parade", () => {
    const tmp_path = make_tmp_path();
    /** The synthetic parade materializes at the canonical position. */
    const app = parse_aep(NO_FX_AEP);
    const layer = app.project.compositions[0].layers[0];
    expect(len(layer.effects) > 0).toBe(false); // `not layer.effects` (py_bool would raise through the group proxy)
    const parade = layer.property("ADBE Effect Parade");
    py_assert(parade instanceof PropertyGroup);
    expect(parade._is_live()).toBe(false);
    parade.add_property("ADBE Slider Control");
    expect(parade._is_live()).toBe(true);
    expect(layer.effects).toBe(parade);
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    expect(py_eq(as_instance(layer2.effects, PropertyGroup).properties.map((e: Property | PropertyGroup) => e.name), ["Slider Control"])).toBe(true);
    py_assert(layer2._tdgp != null);
    const chunks = layer2._tdgp.chunks;
    const parade_idx = chunks.findIndex(
      (c: Chunk, i: number) =>
        c.chunk_type === "tdmn" &&
        getattr(c, "value", null) === "ADBE Effect Parade" &&
        !c.synthetic,
    );
    const transform_idx = chunks.findIndex(
      (c: Chunk, i: number) => c.chunk_type === "tdmn" && getattr(c, "value", null) === "ADBE Transform Group",
    );
    expect(parade_idx >= 0).toBe(true); // `next(...)` raises StopIteration when nothing matches
    expect(transform_idx >= 0).toBe(true);
    expect(parade_idx < transform_idx).toBe(true);
  });

  test("test_add_second_instance_naming", () => {
    /** A second instance of the same control gets a numbered name. */
    const app = parse_aep(NO_FX_AEP);
    const layer = app.project.compositions[0].layers[0];
    const parade = layer.property("ADBE Effect Parade");
    py_assert(parade instanceof PropertyGroup);
    const first = parade.add_property("ADBE Slider Control");
    const second = parade.add_property("ADBE Slider Control");
    expect(first.name).toBe("Slider Control");
    expect(second.name).toBe("Slider Control 2");
    expect(second.is_name_set).toBe(true);
  });

  test("test_add_effect_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** Add controls, save, reload and verify values survive. */
    const app = parse_aep(NO_FX_AEP);
    const layer = app.project.compositions[0].layers[0];
    const parade = layer.property("ADBE Effect Parade");
    py_assert(parade instanceof PropertyGroup);
    parade.add_property("ADBE Slider Control");
    parade.add_property("ADBE Color Control");
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    expect(py_eq(as_instance(layer2.effects, PropertyGroup).properties.map((e: Property | PropertyGroup) => e.name), [
      "Slider Control",
      "Color Control",
    ])).toBe(true);
    const slider = as_instance(layer2.effects.properties[0], PropertyGroup).properties[0];
    py_assert(slider instanceof Property);
    expect(slider.value).toBe(0.0);
    const color = as_instance(layer2.effects.properties[1], PropertyGroup).properties[0];
    py_assert(color instanceof Property);
    expect(py_eq(color.value, [1.0, 0.0, 0.0, 1.0])).toBe(true);
  });

  test("test_non_adjacent_same_type_order", () => {
    const tmp_path = make_tmp_path();
    /**
     * Same-type effects separated by another effect keep their
     * file order on reparse (match-name runs, not dict grouping).
     */
    const app = parse_aep(NO_FX_AEP);
    const layer = app.project.compositions[0].layers[0];
    const parade = layer.property("ADBE Effect Parade");
    py_assert(parade instanceof PropertyGroup);
    parade.add_property("ADBE Slider Control");
    parade.add_property("ADBE Color Control");
    parade.add_property("ADBE Slider Control");
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    expect(py_eq(as_instance(layer2.effects, PropertyGroup).properties.map((e: Property | PropertyGroup) => e.name), [
      "Slider Control",
      "Color Control",
      "Slider Control 2",
    ])).toBe(true);
  });

  test("test_add_effect_then_set_value", () => {
    const tmp_path = make_tmp_path();
    /** A new control's parameter accepts writes that survive reload. */
    const app = parse_aep(NO_FX_AEP);
    const layer = app.project.compositions[0].layers[0];
    const parade = layer.property("ADBE Effect Parade");
    py_assert(parade instanceof PropertyGroup);
    const fx = parade.add_property("ADBE Slider Control");
    py_assert(fx instanceof PropertyGroup);
    const slider = fx.properties[0];
    py_assert(slider instanceof Property);
    slider.value = 42.5;
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    const slider2 = as_instance(layer2.effects.properties[0], PropertyGroup).properties[0];
    py_assert(slider2 instanceof Property);
    expect(slider2.value).toBe(42.5);
  });

  test("test_add_effect_name_no_collision_after_remove", () => {
    /**
     * An effect added after a mid-parade removal gets a non-colliding
     * name; count+1 alone would reuse a surviving instance's number.
     */
    const app = parse_aep(NO_FX_AEP);
    const parade = app.project.compositions[0].layers[0].property("ADBE Effect Parade");
    py_assert(parade instanceof PropertyGroup);
    parade.add_property("ADBE Slider Control"); // Slider Control
    parade.add_property("ADBE Slider Control"); // Slider Control 2
    const s3 = parade.add_property("ADBE Slider Control"); // Slider Control 3
    expect(s3.name).toBe("Slider Control 3");
    parade.properties[1].remove(); // remove Slider Control 2
    const s_new = parade.add_property("ADBE Slider Control");
    const names = parade.properties.map((p: Property | PropertyGroup) => p.name);
    py_assert(new Set(names).size === names.length, `duplicate effect names: ${repr(names)}`);
    expect(s_new.name !== "Slider Control 3").toBe(true);
  });

  test("test_expression_control_pgui_is_zero", () => {
    /**
     * AE writes an all-zero pgui GUID for expression controls; the
     * builder must match deterministically, not emit a random GUID.
     */
    const skeleton = getitem(EXPRESSION_CONTROLS, "ADBE Slider Control");
    const guids: Uint8Array[] = [];
    for (let _ = 0; _ < 2; _++) {
      const [, sspc] = build_expression_control(
        "ADBE Slider Control",
        skeleton["name"],
        bytes_.fromhex(skeleton["part"]),
        { tdsn_name: "-_0_/-", time_base: 24576, layer_id: 1 },
      );
      const pgui = as_instance(_next(sspc.chunks, (c) => c.chunk_type === "pgui"), PguiChunk);
      guids.push(pgui.guid);
    }
    expect(py_eq(guids[0], b("\x00".repeat(16)))).toBe(true);
    expect(py_eq(guids[0], guids[1])).toBe(true); // deterministic, not a random GUID
  });
});

describe("TestBakedBuiltinEffects", () => {
  /**
   * `add_property` of a built-in effect the project has never used,
   * cloned from `data/builtin_effects.py` instead of the project's EfdG
   * (issue #215).
   */

  test("test_add_to_project_with_no_effect_definitions", () => {
    const tmp_path = make_tmp_path();
    const app = py_aep_new();
    expect(py_eq(app.project._effect_param_defs, new Map())).toBe(true);
    const comp = app.project.root_folder.add_comp("c", 1920, 1080, 1.0, 10.0, 24.0);
    const layer = comp.add_null();
    const parade = layer.property("ADBE Effect Parade");

    expect(parade.can_add_property("ADBE Geometry2")).toBe(true);
    expect(parade.can_add_property("Transform")).toBe(true); // display name
    expect(parade.can_add_property("ADBE Gaussian Blur 2")).toBe(false);

    const effect = parade.add_property("ADBE Geometry2");
    py_assert(effect instanceof PropertyGroup);
    expect(effect.match_name).toBe("ADBE Geometry2");
    expect(effect.name).toBe("Transform");
    const names = effect.properties.map((child: Property | PropertyGroup) => child.name);
    expect(names.includes("Position")).toBe(true);
    expect(names.includes("Anchor Point")).toBe(true);
    expect(as_instance(effect.property("Scale Height"), Property).value).toBe(100.0);
    expect(as_instance(effect.property("Rotation"), Property).value).toBe(0.0);

    // A second instance gets AE's numbered name.
    expect(parade.add_property("Transform").name).toBe("Transform 2");

    as_instance(effect.property("Position"), Property).set_values_at_times([0.0, 1.0], [[0.0, 0.0], [10.0, 5.0]]);
    as_instance(effect.property("Anchor Point"), Property).value = [0.0, 0.0];

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const reparsed = parse_aep(out).project.compositions[0].layers[0];
    const written = as_instance(as_instance(reparsed.effects, PropertyGroup).properties[0], PropertyGroup);
    expect(written.match_name).toBe("ADBE Geometry2");
    expect(as_instance(written.property("Position"), Property).keyframes.length).toBe(2);
    expect(py_eq(as_instance(written.property("Anchor Point"), Property).value, [0.0, 0.0])).toBe(true);
  });

  test("test_project_definition_wins_over_baked", () => {
    /**
     * A project that already defines the effect keeps using its own
     * template, so an existing file's instances stay self-consistent.
     */
    const app = parse_aep(SAMPLES_DIR.div("effects.aep"));
    const layer = get_layer(app.project, "effect_2dPoint");
    const parade = layer.property("ADBE Effect Parade");
    const resolved = parade._installed_effect_def("ADBE Lens Flare");
    py_assert(resolved != null);
    expect(_baked_effect_def("ADBE Lens Flare") == null).toBe(true);
    expect(resolved[2] != null).toBe(true);
  });
});

describe("TestSynthesizedEffectParamWrites", () => {
  /**
   * A synthesized effect parameter (one AE omits from binary because it
   * sits at its default) must become a parameter AE actually reads once a
   * value is written to it.
   *
   * AE gates that on `tdb4._spatial_static_flags` bit 1: without it the
   * written `tdbs` is ignored and AE falls back to the `parT` default,
   * silently discarding the value. Bisected one bit at a time against AE
   * 2026; the flag values per control type were measured by setting one
   * parameter of each type in AE and decoding the result.
   */

  const AEP = SAMPLES_DIR.div("effects.aep");

  test("test_synthesized_flags_match_ae", () => {
    /** Multi-dimensional effect params carry AE's flags; 1-D keep 1. */
    const app = parse_aep(AEP);
    const seen = new Map<PropertyControlType, Set<number>>();
    for (const comp of app.project.compositions) {
      for (const layer of comp.layers) {
        if (layer.effects == null || len(layer.effects) === 0) {
          continue;
        }
        for (const effect of as_instance(layer.effects, PropertyGroup).properties) {
          for (const prop of as_instance(effect, PropertyGroup).properties) {
            const tdb4 = getattr(prop, "_tdb4", null);
            const control = getattr(prop, "_property_control_type", null);
            if (tdb4 == null || control == null) {
              continue;
            }
            setdefault(seen, control, new Set<number>()).add(tdb4._spatial_static_flags);
          }
        }
      }
    }
    expect(py_eq(getitem(seen, PropertyControlType.TWO_D), new Set([0x0f]))).toBe(true);
    expect(py_eq(getitem(seen, PropertyControlType.COLOR), new Set([0x07]))).toBe(true);
    for (const [control, flags] of seen) {
      if (
        contains([PropertyControlType.TWO_D, PropertyControlType.THREE_D, PropertyControlType.COLOR], control)
      ) {
        continue;
      }
      py_assert([...flags].every((f) => [0x00, 0x01].includes(f)), `${String([control, flags])}`);
    }
  });

  test("test_point_write_survives_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(AEP);
    const layer = get_layer(app.project, "effect_2dPoint");
    const prop = as_instance(as_instance(as_instance(layer.effects, PropertyGroup).properties[0], PropertyGroup).property("Flare Center"), Property);
    expect(prop._is_live()).toBe(false);
    prop.value = [10.0, 20.0];

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const reloaded = get_layer(parse_aep(out).project, "effect_2dPoint");
    const written = as_instance(as_instance(as_instance(reloaded.effects, PropertyGroup).properties[0], PropertyGroup).property("Flare Center"), Property);
    expect(written._is_live()).toBe(true);
    expect(py_eq(written.value, [10.0, 20.0])).toBe(true);
    // Bit 1 is what makes AE read the value instead of the parT default.
    expect(py_bool(and(written._tdb4._spatial_static_flags, 0x02))).toBe(true);
  });

  test("test_color_write_survives_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(AEP);
    const layer = get_layer(app.project, "effect_3dPoint");
    const effect = as_instance(_next(as_instance(layer.effects, PropertyGroup).properties, (e) => e.name === "CC Sphere"), PropertyGroup);
    const prop = as_instance(effect.property("Light Color"), Property);
    expect(prop._is_live()).toBe(false);
    prop.value = [1.0, 0.0, 0.0, 1.0];

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const reloaded = get_layer(parse_aep(out).project, "effect_3dPoint");
    const written = as_instance(
      as_instance(_next(as_instance(reloaded.effects, PropertyGroup).properties, (e) => e.name === "CC Sphere"), PropertyGroup).property("Light Color"),
      Property,
    );
    expect(written._is_live()).toBe(true);
    expect(py_eq(written.value, [1.0, 0.0, 0.0, 1.0])).toBe(true);
    expect(py_bool(and(written._tdb4._spatial_static_flags, 0x02))).toBe(true);
  });

  test("test_color_reports_spatial_like_extendscript", () => {
    /**
     * AE leaves the tdb4 spatial bit clear on colors (flags 0x07) but
     * ExtendScript reports them as spatial.
     */
    const app = parse_aep(AEP);
    const layer = get_layer(app.project, "effect_3dPoint");
    const effect = as_instance(_next(as_instance(layer.effects, PropertyGroup).properties, (e) => e.name === "CC Sphere"), PropertyGroup);
    const prop = as_instance(effect.property("Light Color"), Property);
    expect(prop._tdb4._spatial_static_flags).toBe(0x07);
    expect(prop.is_spatial).toBe(true);
  });

  test("test_deanimating_a_color_effect_param_writes_aes_static_byte", () => {
    const tmp_path = make_tmp_path();
    /**
     * Clearing a colour effect param's keyframes must land on 0x07.
     *
     * Verified against AE 2026: opening `all_animated.aep`, removing the
     * Fill colour's keys and saving gives `_spatial_static_flags` 0x07.
     * The generic static template writes the layer-property byte (6),
     * leaving bit 0 (`static`) clear.
     */
    const project = parse_project_fresh(SAMPLES_DIR.div("all_animated.aep"));
    // `next(...)` over a lazy generator: stop at the first match without walking later layers.
    let prop: Property | null = null;
    find_prop: for (const layer of project.compositions[0].layers) {
      for (const p of layer._leaf_properties()) {
        if (
          p._is_in_effect() &&
          p._property_control_type === PropertyControlType.COLOR &&
          py_bool(p.keyframes)
        ) {
          prop = p;
          break find_prop;
        }
      }
    }
    py_assert(prop != null, "StopIteration");
    prop.remove_all_keys();
    expect(prop._tdb4._spatial_static_flags).toBe(0x07);

    const out = tmp_path.div("deanimated.aep");
    project.save(out);
    let written: Property | null = null;
    find_written: for (const layer of parse_aep(out).project.compositions[0].layers) {
      for (const p of layer._leaf_properties()) {
        if (p._is_in_effect() && p._property_control_type === PropertyControlType.COLOR) {
          written = p;
          break find_written;
        }
      }
    }
    py_assert(written != null, "StopIteration");
    expect(written._tdb4._spatial_static_flags).toBe(0x07);
  });
});

describe("TestAddInstalledEffect", () => {
  /**
   * Tests for add_property() of effects already defined in the
   * project's EfdG (cloned from the stored definition).
   */

  test("test_can_add_installed_effect", () => {
    /**
     * The Effect Parade accepts effects present in the project's
     * EfdG by match name or display name, and rejects absent ones.
     */
    const app = parse_aep(SAMPLES_DIR.div("effects.aep"));
    const layer = get_layer(app.project, "effect_2dPoint");
    const fx = layer.effects;
    py_assert(fx != null);
    // effects.aep defines ADBE Lens Flare / CC Sphere / ADBE FreePin3.
    expect(fx.can_add_property("ADBE Lens Flare")).toBe(true);
    expect(fx.can_add_property("Lens Flare")).toBe(true); // display name
    expect(fx.can_add_property("CC Sphere")).toBe(true);
    // Absent from this project, and pure nonsense: both rejected.
    expect(fx.can_add_property("ADBE Gaussian Blur 2")).toBe(false);
    expect(fx.can_add_property("Some Custom Effect")).toBe(false);
    // Expression controls are unaffected.
    expect(fx.can_add_property("ADBE Slider Control")).toBe(true);
  });

  test("test_clone_resets_point_params_to_default", () => {
    /**
     * A cloned effect's 2D/3D points reset like every other value type.
     *
     * A point `pard` has no `default` field; its plugin default is the
     * `last_value` AE stamps into the `parT`, in a 0-512 range relative
     * to the LAYER. Before that was resolved, a cloned point silently
     * inherited the source instance's edited coordinates.
     */
    const app = parse_aep(SAMPLES_DIR.div("effects.aep"));
    const source = get_layer(app.project, "effect_2dPoint");
    const flare = as_instance(as_instance(source.effects, PropertyGroup).properties[0], PropertyGroup);
    const origin = as_instance(flare.property("Flare Center"), Property);
    py_assert(origin.default_value != null);
    origin.value = [1.0, 2.0];

    const comp = source.containing_comp;
    const target = comp.add_solid([0.5, 0.5, 0.5], "target");
    const clone = target.property("ADBE Effect Parade").add_property("ADBE Lens Flare");
    py_assert(clone instanceof PropertyGroup);
    const point = as_instance(clone.property("Flare Center"), Property);
    py_assert(point.default_value != null);
    expect(py_eq(point.value, point.default_value)).toBe(true);
    expect(py_eq(point.value, [1.0, 2.0])).toBe(false);
  });

  test("test_clone_restamps_timebase_of_target_comp", () => {
    const tmp_path = make_tmp_path();
    /**
     * An EfdG definition mirrors the timebase of the comp its first
     * instance lived in. Cloning it into a comp with a different frame
     * rate must restamp every stamped tdb4, or the parameter's keyframe
     * times are read against the source comp's base.
     */
    const app = parse_aep(SAMPLES_DIR.div("2_gaussian_20_30.aep"));
    const source_comp = app.project.compositions[0];
    expect(source_comp.frame_rate).toBe(24.0);

    const target = app.project.root_folder.add_comp("60fps", 640, 480, 1.0, 5.0, 60.0);
    const target_base = target._cdta.internal_timebase;
    expect(py_eq(target_base, source_comp._cdta.internal_timebase)).toBe(false);
    const layer = target.add_solid([0.5, 0.5, 0.5], "s");

    const effect = layer.property("ADBE Effect Parade").add_property("ADBE Gaussian Blur 2");
    py_assert(effect instanceof PropertyGroup);
    const stamped = [...effect.properties].filter(
      (child): child is Property => child instanceof Property && getattr(child, "_tdb4", null) != null && py_bool(child._tdb4._time_base),
    );
    py_assert(py_bool(stamped), "expected at least one stamped tdb4 in the clone");
    for (const child of stamped) {
      expect(py_eq(child._tdb4._time_base, target_base)).toBe(true);
    }

    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const reparsed = parse_aep(out);
    const comp2 = _next(reparsed.project.compositions, (c) => c.name === "60fps");
    const effect2 = as_instance(as_instance(comp2.layers[0].effects, PropertyGroup).properties[0], PropertyGroup);
    for (const child of effect2.properties) {
      const tdb4 = getattr(child, "_tdb4", null);
      if (tdb4 != null && py_bool(tdb4._time_base)) {
        expect(py_eq(tdb4._time_base, target_base)).toBe(true);
      }
    }
  });

  test("test_can_add_installed_effect_only_on_effect_parade", () => {
    /** A non-Effect-Parade group never reports installed effects. */
    const app = parse_aep(SAMPLES_DIR.div("effects.aep"));
    const layer = get_layer(app.project, "effect_2dPoint");
    expect(layer.transform.can_add_property("ADBE Lens Flare")).toBe(false);
  });

  test("test_add_installed_effect_appends_default_instance", () => {
    /** Adding clones the EfdG definition and appends it. */
    const app = parse_aep(SAMPLES_DIR.div("effects.aep"));
    const layer = get_layer(app.project, "effect_2dPoint");
    const fx = layer.effects;
    py_assert(fx != null);
    const before = fx.properties.length;
    const added = fx.add_property("ADBE Lens Flare");
    py_assert(added instanceof PropertyGroup);
    expect(added.is_effect).toBe(true);
    expect(added.match_name).toBe("ADBE Lens Flare");
    expect(added.property_type).toBe(PropertyType.NAMED_GROUP);
    expect(fx.properties.length).toBe(before + 1);
    expect(fx.properties.at(-1)).toBe(added);
    // Second instance of an existing effect is numbered.
    expect(added.name).toBe("Lens Flare 2");
  });

  test("test_add_installed_effect_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** A cloned effect survives save + reparse intact. */
    const app = parse_aep(SAMPLES_DIR.div("effects.aep"));
    const layer = get_layer(app.project, "effect_2dPoint");
    py_assert(layer.effects != null);
    as_instance(layer.effects, PropertyGroup).add_property("ADBE Lens Flare");
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = get_layer(parse_aep(out).project, "effect_2dPoint");
    py_assert(layer2.effects != null);
    expect(py_eq([...layer2.effects].map((e) => e.match_name), [
      "ADBE Lens Flare",
      "ADBE Lens Flare",
    ])).toBe(true);
  });

  /** The Effect Parade's direct chunks, `engv` with its value. */
  function _parade_layout(layer: Layer): string[] {
    py_assert(layer.effects != null);
    [...as_instance(layer.effects, PropertyGroup).properties];
    const tdgp = as_instance(layer.effects, PropertyGroup)._tdgp;
    py_assert(tdgp != null);
    return tdgp.chunks
      .filter((c) => c.chunk_type === "tdmn" || c.chunk_type === "engv")
      .map((c) =>
        c.chunk_type === "engv"
          ? `engv ${bytes_.int_from_bytes(c.data, "big")}`
          : py_or(getattr(c, "value", null), c.chunk_type),
      );
  }

  test("test_added_puppet_stores_its_engine_version", () => {
    const tmp_path = make_tmp_path();
    /**
     * AE 2026 stores `engv` 2 between every Puppet's `tdmn` and its
     * `sspc`; without it, AE loads the instance with the Legacy engine
     * (Puppet Engine reads 1 and its Advanced parameters are hidden).
     */
    const app = parse_aep(SAMPLES_DIR.div("effects.aep"));
    const layer = get_layer(app.project, "effect_puppet");
    py_assert(layer.effects != null);
    as_instance(layer.effects, PropertyGroup).add_property("ADBE FreePin3");
    const out = tmp_path.div("out.aep");
    app.project.save(out);

    const layer2 = get_layer(parse_aep(out).project, "effect_puppet");
    expect(py_eq(_parade_layout(layer2), [
      "ADBE FreePin3",
      "engv 2",
      "ADBE FreePin3",
      "engv 2",
      "ADBE Group End",
    ])).toBe(true);
  });

  test("test_removed_puppet_takes_its_engine_version", () => {
    const app = parse_aep(SAMPLES_DIR.div("effects.aep"));
    const layer = get_layer(app.project, "effect_puppet");
    py_assert(layer.effects != null);
    as_instance(layer.effects, PropertyGroup).add_property("ADBE FreePin3").remove();
    expect(py_eq(_parade_layout(layer), [
      "ADBE FreePin3",
      "engv 2",
      "ADBE Group End",
    ])).toBe(true);
  });

  test("test_add_installed_effect_uses_pard_defaults_not_def_values", () => {
    /**
     * AE's EfdG entry mirrors the first applied instance, but a
     * freshly added instance is default-valued (value params dropped
     * and re-synthesized).
     *
     * `2_gaussian_20_30.aep` has two Gaussian Blur 2 instances
     * (Blurriness 20 and 30); the shared EfdG def carries the first
     * (20), yet the added instance must use the pard default 25.
     */
    const app = parse_aep(SAMPLES_DIR.div("2_gaussian_20_30.aep"));
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const added = as_instance(as_instance(layer.effects, PropertyGroup).add_property("ADBE Gaussian Blur 2"), PropertyGroup);
    const blur = as_instance(_next(added.properties, (p) => p.match_name === "ADBE Gaussian Blur 2-0001"), Property);
    expect(blur.value).toBe(blur.default_value);
    expect(blur.default_value).toBe(25.0);
  });

  test("test_add_installed_effect_drops_source_animation", () => {
    /**
     * A cloned effect must be STATIC even when the EfdG definition
     * mirrors an animated first instance.
     *
     * In `2_gaussian_animated.aep` the Gaussian Blur 2 Blurriness is
     * keyframed, so the EfdG def carries keyframes; the added instance
     * must come out static at the pard default (no keyframes).
     */
    const app = parse_aep(SAMPLES_DIR.div("2_gaussian_animated.aep"));
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const added = as_instance(as_instance(layer.effects, PropertyGroup).add_property("ADBE Gaussian Blur 2"), PropertyGroup);
    const blur = as_instance(_next(added.properties, (p) => p.match_name === "ADBE Gaussian Blur 2-0001"), Property);
    expect(blur.keyframes.length).toBe(0);
    expect(blur.value).toBe(blur.default_value);
    expect(blur.default_value).toBe(25.0);
  });

  test("test_add_installed_effect_drops_source_expression", () => {
    /**
     * A cloned effect must carry no expression even when the EfdG
     * definition mirrors an expression.
     *
     * In `2_gaussian_expr.aep` the first Gaussian Blur 2 Blurriness has
     * the expression `42`, so the EfdG def carries it; the added
     * instance must come out static at the default with no expression
     * (and must leave the existing instance's expression intact).
     */
    const app = parse_aep(SAMPLES_DIR.div("2_gaussian_expr.aep"));
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    const existing = [...layer.effects].filter((e) => e.match_name === "ADBE Gaussian Blur 2");
    const added = as_instance(as_instance(layer.effects, PropertyGroup).add_property("ADBE Gaussian Blur 2"), PropertyGroup);
    const blur = as_instance(_next(added.properties, (p) => p.match_name === "ADBE Gaussian Blur 2-0001"), Property);
    expect(blur.expression).toBe("");
    expect(blur.expression_enabled).toBe(false);
    expect(blur.keyframes.length).toBe(0);
    expect(blur.value).toBe(blur.default_value);
    expect(blur.default_value).toBe(25.0);
    // The pre-existing expression-bearing instance is untouched.
    const first_blur = as_instance(
      _next(as_instance(existing[0], PropertyGroup).properties, (p) => p.match_name === "ADBE Gaussian Blur 2-0001"),
      Property,
    );
    expect(first_blur.expression).toBe("42");
  });

  test("test_add_installed_effect_defaults_survive_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /** The default value persists through save + reparse. */
    const app = parse_aep(SAMPLES_DIR.div("2_gaussian_20_30.aep"));
    const layer = app.project.compositions[0].layers[0];
    py_assert(layer.effects != null);
    as_instance(layer.effects, PropertyGroup).add_property("ADBE Gaussian Blur 2");
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = parse_aep(out).project.compositions[0].layers[0];
    py_assert(layer2.effects != null);
    const added = as_instance([...layer2.effects].filter((e) => e.match_name === "ADBE Gaussian Blur 2").at(-1), PropertyGroup);
    const blur = as_instance(_next(added.properties, (p) => p.match_name === "ADBE Gaussian Blur 2-0001"), Property);
    expect(blur.value).toBe(25.0);
  });
});

describe("TestAddTextSelector", () => {
  /** Tests for PropertyGroup.add_property() (text animator selectors). */

  const AEP = SAMPLES_DIR.div("text_animator.aep");

  /** Method `_selectors` in the Python class. */
  function _selectors(app: Application): PropertyGroup {
    const comp = app.project.compositions[0];
    const layer = _next(comp.layers, (lyr) => lyr.name === "Animate Me");
    const animator = as_instance(
      layer.property("ADBE Text Properties").property("ADBE Text Animators").properties[0],
      PropertyGroup,
    );
    const sel = animator.property("ADBE Text Selectors");
    py_assert(sel instanceof PropertyGroup);
    return sel;
  }

  test("test_selectors_group_is_indexed", () => {
    const sel = _selectors(parse_aep(AEP));
    expect(sel.property_type).toBe(PropertyType.INDEXED_GROUP);
    expect(py_bool(sel.can_add_property("ADBE Text Wiggly Selector"))).toBe(true);
    expect(py_bool(sel.can_add_property("Range Selector"))).toBe(true); // display name
  });

  test("test_add_each_selector_type", () => {
    const sel = _selectors(parse_aep(AEP));
    const expected = new Map<string, string>([
      ["ADBE Text Selector", "Range Selector 2"], // sample already has 1
      ["ADBE Text Wiggly Selector", "Wiggly Selector 1"],
      ["ADBE Text Expressible Selector", "Expression Selector 1"],
    ]);
    for (const [match_name, name] of expected) {
      const s = sel.add_property(match_name);
      py_assert(s instanceof PropertyGroup);
      expect(s.match_name).toBe(match_name);
      expect(s.name).toBe(name);
      expect(s.can_set_enabled).toBe(true);
    }
  });

  test("test_range_selector_children", () => {
    const sel = _selectors(parse_aep(AEP));
    const rng = sel.add_property("ADBE Text Selector");
    py_assert(rng instanceof PropertyGroup);
    expect(py_eq(rng.properties.map((c: Property | PropertyGroup) => c.name), [
      "Start",
      "End",
      "Offset",
      "Start",
      "End",
      "Offset",
      "Advanced",
    ])).toBe(true);
    const advanced = rng.property("ADBE Text Range Advanced");
    py_assert(advanced instanceof PropertyGroup);
    expect(py_eq(advanced.properties.map((c: Property | PropertyGroup) => c.name), [
      "Units",
      "Based On",
      "Mode",
      "Amount",
      "Shape",
      "Smoothness",
      "Ease High",
      "Ease Low",
      "Randomize Order",
      "Random Seed",
    ])).toBe(true);
  });


  test("test_wiggly_and_expression_children", () => {
    const sel = _selectors(parse_aep(AEP));
    const wiggly = sel.add_property("ADBE Text Wiggly Selector");
    py_assert(wiggly instanceof PropertyGroup);
    expect(py_eq(wiggly.properties.map((c: Property | PropertyGroup) => c.name), [
      "Mode",
      "Max Amount",
      "Min Amount",
      "Based On",
      "Wiggles/Second",
      "Correlation",
      "Temporal Phase",
      "Spatial Phase",
      "Lock Dimensions",
      "Random Seed",
    ])).toBe(true);
    const expr = sel.add_property("ADBE Text Expressible Selector");
    py_assert(expr instanceof PropertyGroup);
    expect(py_eq(expr.properties.map((c: Property | PropertyGroup) => c.name), ["Based On", "Amount"])).toBe(true);
    const amount = expr.properties[1];
    py_assert(amount instanceof Property);
    expect(py_eq(amount.value, [100.0, 100.0, 100.0])).toBe(true);
  });

  test("test_selector_child_bounds_and_units", () => {
    const sel = _selectors(parse_aep(AEP));
    const rng = sel.add_property("ADBE Text Selector");
    py_assert(rng instanceof PropertyGroup);
    const start = rng.properties[0]; // ADBE Text Percent Start
    py_assert(start instanceof Property);
    expect(start.match_name).toBe("ADBE Text Percent Start");
    expect(start.min_value).toBe(-100);
    expect(start.max_value).toBe(100);
    expect(start.units_text).toBe("percent");
  });

  test("test_add_selectors_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(AEP);
    const sel = _selectors(app);
    sel.add_property("ADBE Text Wiggly Selector");
    sel.add_property("ADBE Text Expressible Selector");
    sel.add_property("ADBE Text Selector");
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const sel2 = _selectors(parse_aep(out));
    expect(py_eq(sel2.properties.map((s: Property | PropertyGroup) => [s.name, s.match_name]), [
      ["Range Selector 1", "ADBE Text Selector"],
      ["Wiggly Selector 1", "ADBE Text Wiggly Selector"],
      ["Expression Selector 1", "ADBE Text Expressible Selector"],
      ["Range Selector 2", "ADBE Text Selector"],
    ])).toBe(true);
  });

  test("test_selectors_removable", () => {
    /** Selectors are children of an indexed group, so removable. */
    const sel = _selectors(parse_aep(AEP));
    sel.add_property("ADBE Text Wiggly Selector");
    expect(sel.properties.length).toBe(2);
    sel.properties[1].remove();
    expect(py_eq(sel.properties.map((s: Property | PropertyGroup) => s.match_name), ["ADBE Text Selector"])).toBe(true);
  });
});

describe("TestAddTextAnimator", () => {
  /** Tests for PropertyGroup.add_property('ADBE Text Animator'). */

  const AEP = new Path(import.meta.dir, "..", "..", "samples", "models", "selection", "selection_text_source_text.aep");

  /** Method `_animators` in the Python class. */
  function _animators(app: Application): PropertyGroup {
    const comp = app.project.compositions[0];
    const layer = _next(comp.layers, (lyr) => lyr instanceof TextLayer);
    const anims = layer.property("ADBE Text Properties").property("ADBE Text Animators");
    py_assert(anims instanceof PropertyGroup);
    return anims;
  }

  test("test_animators_group_can_add", () => {
    const anims = _animators(parse_aep(AEP));
    expect(anims.property_type).toBe(PropertyType.INDEXED_GROUP);
    expect(py_bool(anims.can_add_property("ADBE Text Animator"))).toBe(true);
    expect(py_bool(anims.can_add_property("Animator"))).toBe(true); // display name
  });

  test("test_add_pristine_animator", () => {
    /**
     * A fresh animator has an empty Selectors group + the 103-prop
     * pool, matching AE; it is not yet modified.
     */
    const anims = _animators(parse_aep(AEP));
    const a1 = anims.add_property("ADBE Text Animator");
    py_assert(a1 instanceof PropertyGroup);
    expect(a1.name).toBe("Animator 1");
    expect(a1.can_set_enabled).toBe(true);
    expect(a1.is_modified).toBe(false);
    expect(py_eq(a1.properties.map((c: Property | PropertyGroup) => [c.name, c.match_name]), [
      ["Selectors", "ADBE Text Selectors"],
      ["Properties", "ADBE Text Animator Properties"],
    ])).toBe(true);
    const sel = a1.property("ADBE Text Selectors");
    py_assert(sel instanceof PropertyGroup);
    expect(sel.property_type).toBe(PropertyType.INDEXED_GROUP);
    expect(sel.properties.length).toBe(0);
    expect(a1.property("ADBE Text Animator Properties").properties.length).toBe(103);
  });

  test("test_animator_numbering", () => {
    const anims = _animators(parse_aep(AEP));
    const a1 = anims.add_property("ADBE Text Animator");
    const a2 = anims.add_property("ADBE Text Animator");
    expect(a1.name).toBe("Animator 1");
    expect(a2.name).toBe("Animator 2");
  });

  test("test_animator_modified_after_adding_selector", () => {
    const anims = _animators(parse_aep(AEP));
    const a1 = anims.add_property("ADBE Text Animator");
    expect(a1.is_modified).toBe(false);
    a1.property("ADBE Text Selectors").add_property("ADBE Text Selector");
    expect(a1.is_modified).toBe(true);
  });

  test("test_add_animator_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(AEP);
    const anims = _animators(app);
    const a1 = anims.add_property("ADBE Text Animator");
    a1.property("ADBE Text Selectors").add_property("ADBE Text Wiggly Selector");
    anims.add_property("ADBE Text Animator");
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const anims2 = _animators(parse_aep(out));
    const summary = anims2.properties.map((child) => {
      const a = as_instance(child, PropertyGroup);
      return [
      a.name,
      a.property("ADBE Text Selectors").properties.length,
      a.property("ADBE Text Animator Properties").properties.length,
      ];
    });
    expect(py_eq(summary, [
      ["Animator 1", 1, 103],
      ["Animator 2", 0, 103],
    ])).toBe(true);
  });
});

describe("TestAddAnimatorProperty", () => {
  /**
   * add_property on ADBE Text Animator Properties (named-group
   * exception: materialize a fixed-pool member in place).
   */

  const AEP = new Path(import.meta.dir, "..", "..", "samples", "models", "selection", "selection_text_source_text.aep");

  /** Method `_props` in the Python class. */
  function _props(app: Application): PropertyGroup {
    const comp = app.project.compositions[0];
    const layer = _next(comp.layers, (lyr) => lyr instanceof TextLayer);
    const anims = layer.property("ADBE Text Properties").property("ADBE Text Animators");
    const pg = anims.add_property("ADBE Text Animator").property("ADBE Text Animator Properties");
    py_assert(pg instanceof PropertyGroup);
    return pg;
  }

  test("test_named_group_can_add", () => {
    const pg = _props(parse_aep(AEP));
    expect(pg.property_type).toBe(PropertyType.NAMED_GROUP);
    expect(py_bool(pg.can_add_property("ADBE Text Position 3D"))).toBe(true);
    expect(py_bool(pg.can_add_property("Position"))).toBe(true); // display name
    // The 8 variable-font axes are not addable.
    expect(py_bool(pg.can_add_property("ADBE Text VF Axis 1"))).toBe(false);
    expect(py_bool(pg.can_add_property("Not A Property"))).toBe(false);
  });

  test("test_add_materializes_in_place", () => {
    /** Adding keeps the pool position and count (103); idempotent. */
    const pg = _props(parse_aep(AEP));
    const pos = pg.add_property("ADBE Text Position 3D");
    py_assert(pos instanceof Property);
    expect(pos.name).toBe("Position");
    expect(pos.property_index).toBe(1); // Anchor Point is 0
    expect(pg.properties.length).toBe(103);
    // Idempotent: re-adding returns the same member, no new child.
    const again = pg.add_property("ADBE Text Position 3D");
    expect(again).toBe(pos);
    expect(pg.properties.length).toBe(103);
  });

  test("test_added_property_parity", () => {
    /**
     * An applied animator property carries units / isSpatial /
     * canSetExpression matching AE (unlike the unapplied pool).
     */
    const pg = _props(parse_aep(AEP));
    const opacity = pg.add_property("ADBE Text Opacity");
    py_assert(opacity instanceof Property);
    expect(as_instance(opacity, Property).units_text).toBe("percent");
    expect(as_instance(opacity, Property).can_set_expression).toBe(true);
    const fill = pg.add_property("ADBE Text Fill Color");
    py_assert(fill instanceof Property);
    expect(as_instance(fill, Property).is_spatial).toBe(true);
    expect(as_instance(fill, Property).can_set_expression).toBe(true);
  });

  test("test_add_by_display_name", () => {
    const pg = _props(parse_aep(AEP));
    const scale = pg.add_property("Scale");
    expect(scale.match_name).toBe("ADBE Text Scale 3D");
  });

  test("test_add_property_value_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(AEP);
    const pg = _props(app);
    const op = pg.add_property("ADBE Text Opacity");
    py_assert(op instanceof Property);
    as_instance(op, Property).value = 40.0;
    const fill = pg.add_property("ADBE Text Fill Color");
    py_assert(fill instanceof Property);
    as_instance(fill, Property).value = [0.0, 1.0, 0.0, 1.0];
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const layer2 = _next(parse_aep(out).project.compositions[0].layers, (lyr) => lyr instanceof TextLayer);
    const pg2 = as_instance(
      layer2.property("ADBE Text Properties").property("ADBE Text Animators").properties[0],
      PropertyGroup,
    ).property("ADBE Text Animator Properties");
    expect(pg2.properties.length).toBe(103);
    const op2 = pg2.properties.find((p: Property | PropertyGroup) => p.match_name === "ADBE Text Opacity");
    py_assert(op2 instanceof Property);
    expect(op2.value).toBe(40.0);
    const fill2 = pg2.properties.find((p: Property | PropertyGroup) => p.match_name === "ADBE Text Fill Color");
    py_assert(fill2 instanceof Property);
    expect(py_eq(fill2.value, [0.0, 1.0, 0.0, 1.0])).toBe(true);
  });
});

describe("TestAddShapeElement", () => {
  /** Tests for PropertyGroup.add_property() (shape elements). */

  const BASE_AEP = LAYER_SAMPLES_DIR.div("gray_solid_1_above.aep");

  // AE 2026 creation names per element type (ground truth).
  const EXPECTED_NAMES = new Map<string, string>([
    ["ADBE Vector Group", "Group 1"],
    ["ADBE Vector Shape - Rect", "Rectangle Path 1"],
    ["ADBE Vector Shape - Ellipse", "Ellipse Path 1"],
    ["ADBE Vector Shape - Star", "Polystar Path 1"],
    ["ADBE Vector Shape - Group", "Path 1"],
    ["ADBE Vector Graphic - Fill", "Fill 1"],
    ["ADBE Vector Graphic - Stroke", "Stroke 1"],
    ["ADBE Vector Graphic - G-Fill", "Gradient Fill 1"],
    ["ADBE Vector Graphic - G-Stroke", "Gradient Stroke 1"],
    ["ADBE Vector Filter - Merge", "Merge Paths 1"],
    ["ADBE Vector Filter - Offset", "Offset Paths 1"],
    ["ADBE Vector Filter - PB", "Pucker & Bloat 1"],
    ["ADBE Vector Filter - Repeater", "Repeater 1"],
    ["ADBE Vector Filter - RC", "Round Corners 1"],
    ["ADBE Vector Filter - Trim", "Trim Paths 1"],
    ["ADBE Vector Filter - Twist", "Twist 1"],
    ["ADBE Vector Filter - Roughen", "Wiggle Paths 1"],
    ["ADBE Vector Filter - Wiggler", "Wiggle Transform 1"],
    ["ADBE Vector Filter - Zigzag", "Zig Zag 1"],
  ]);

  /** Method `_new_contents` in the Python class. */
  function _new_contents(): [Application, PropertyGroup] {
    const app = parse_aep(BASE_AEP);
    const layer = app.project.compositions[0].add_shape();
    const contents = layer.property("ADBE Root Vectors Group");
    py_assert(contents instanceof PropertyGroup);
    return [app, contents];
  }

  test("test_add_every_element_type", () => {
    /** Every addable element creates with AE's creation name. */
    const [_app, contents] = _new_contents();
    for (const [match_name, expected_name] of EXPECTED_NAMES) {
      const el = contents.add_property(match_name);
      py_assert(el instanceof PropertyGroup);
      expect(el.match_name).toBe(match_name);
      expect(el.name).toBe(expected_name);
    }
    expect(contents.properties.length).toBe(EXPECTED_NAMES.size);
  });

  test("test_add_rect_minimal_chunks", () => {
    /**
     * A new element is a named empty group; children stay AE-side
     * defaults (synthesized, not written to binary).
     */
    const [_app, contents] = _new_contents();
    const rect = contents.add_property("ADBE Vector Shape - Rect");
    py_assert(rect instanceof PropertyGroup);
    py_assert(rect._tdgp != null);
    expect(py_eq(rect._tdgp.chunks.map((c: Chunk) => py_or(getattr(c, "list_type", null), c.chunk_type)), [
      "tdsb",
      "tdsn",
      "tdmn",
    ])).toBe(true);
    expect(py_eq(rect.properties.map((c: Property | PropertyGroup) => c.name), [
      "Shape Direction",
      "Size",
      "Position",
      "Roundness",
    ])).toBe(true);
  });

  test("test_add_group_carries_mandatory_subgroups", () => {
    /**
     * A Vector Group is created with contents, transform and
     * material subgroups; its contents accepts nested adds.
     */
    const [_app, contents] = _new_contents();
    const group = contents.add_property("ADBE Vector Group");
    py_assert(group instanceof PropertyGroup);
    const inner = group.property("ADBE Vectors Group");
    py_assert(inner instanceof PropertyGroup);
    expect(inner.property_type).toBe(PropertyType.INDEXED_GROUP);
    expect(py_bool(inner.can_add_property("ADBE Vector Shape - Ellipse"))).toBe(true);
    const nested = inner.add_property("ADBE Vector Shape - Ellipse");
    // Numbering is per container: this is the first ellipse here.
    expect(nested.name).toBe("Ellipse Path 1");
  });

  test("test_numbering_per_type_and_container", () => {
    const [_app, contents] = _new_contents();
    contents.add_property("ADBE Vector Shape - Rect");
    contents.add_property("ADBE Vector Graphic - Fill");
    const second = contents.add_property("ADBE Vector Shape - Rect");
    expect(second.name).toBe("Rectangle Path 2");
  });

  test("test_add_elements_roundtrip", () => {
    const tmp_path = make_tmp_path();
    /**
     * Elements (incl. nested and non-adjacent same-type) survive
     * save/reload in order.
     */
    const [app, contents] = _new_contents();
    const group = contents.add_property("ADBE Vector Group");
    py_assert(group instanceof PropertyGroup);
    group.property("ADBE Vectors Group").add_property("ADBE Vector Shape - Star");
    contents.add_property("ADBE Vector Shape - Rect");
    contents.add_property("ADBE Vector Graphic - Fill");
    contents.add_property("ADBE Vector Shape - Rect");
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const comp2 = parse_aep(out).project.compositions[0];
    const layer2 = _next(comp2.layers, (lyr) => lyr instanceof ShapeLayer);
    const contents2 = layer2.property("ADBE Root Vectors Group");
    py_assert(contents2 instanceof PropertyGroup);
    expect(py_eq(contents2.properties.map((e: Property | PropertyGroup) => e.name), [
      "Group 1",
      "Rectangle Path 1",
      "Fill 1",
      "Rectangle Path 2",
    ])).toBe(true);
    const group2 = contents2.properties[0];
    py_assert(group2 instanceof PropertyGroup);
    const inner2 = group2.property("ADBE Vectors Group");
    py_assert(inner2 instanceof PropertyGroup);
    expect(py_eq(inner2.properties.map((e: Property | PropertyGroup) => e.name), ["Polystar Path 1"])).toBe(true);
  });

  test("test_add_fill_then_set_color", () => {
    const tmp_path = make_tmp_path();
    /**
     * A new element's synthesized child accepts writes that
     * survive reload.
     */
    const [app, contents] = _new_contents();
    const fill = contents.add_property("ADBE Vector Graphic - Fill");
    py_assert(fill instanceof PropertyGroup);
    const color = fill.properties.find((p: Property | PropertyGroup) => p.name === "Color");
    py_assert(color instanceof Property);
    color.value = [0.0, 1.0, 0.0, 1.0];
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const comp2 = parse_aep(out).project.compositions[0];
    const layer2 = _next(comp2.layers, (lyr) => lyr instanceof ShapeLayer);
    const contents2 = layer2.property("ADBE Root Vectors Group");
    py_assert(contents2 instanceof PropertyGroup);
    const fill2 = contents2.properties[0];
    py_assert(fill2 instanceof PropertyGroup);
    const color2 = fill2.properties.find((p: Property | PropertyGroup) => p.name === "Color");
    py_assert(color2 instanceof Property);
    expect(py_eq(color2.value, [0.0, 1.0, 0.0, 1.0])).toBe(true);
  });

  test("test_add_to_contents_rejects_non_shape_names", () => {
    const [_app, contents] = _new_contents();
    raises(ValueError, () => {
      contents.add_property("ADBE Mask Atom");
    }, "Cannot add property");
    raises(ValueError, () => {
      contents.add_property("ADBE Slider Control");
    }, "Cannot add property");
  });

  test("test_filter_children_synthesized", () => {
    /**
     * Shape filters report their full child sets (from specs),
     * matching ExtendScript - including the nested Wiggle Transform.
     */
    const [_app, contents] = _new_contents();
    const expected = new Map<string, string[]>([
      ["ADBE Vector Filter - Merge", ["Mode"]],
      ["ADBE Vector Filter - Trim", ["Start", "End", "Offset", "Trim Multiple Shapes"]],
      ["ADBE Vector Filter - Twist", ["Angle", "Center"]],
      ["ADBE Vector Filter - Zigzag", ["Size", "Ridges per segment", "Points"]],
    ]);
    for (const [match_name, child_names] of expected) {
      const el = contents.add_property(match_name);
      py_assert(el instanceof PropertyGroup);
      expect(py_eq(el.properties.map((c: Property | PropertyGroup) => c.name), child_names)).toBe(true);
    }

    const wiggler = contents.add_property("ADBE Vector Filter - Wiggler");
    py_assert(wiggler instanceof PropertyGroup);
    const transform = wiggler.property("ADBE Vector Wiggler Transform");
    py_assert(transform instanceof PropertyGroup);
    expect(py_eq(transform.properties.map((c: Property | PropertyGroup) => c.name), [
      "Anchor Point",
      "Position",
      "Scale",
      "Rotation",
    ])).toBe(true);
    expect(transform.can_set_enabled).toBe(false);
  });

  test("test_filter_child_bounds_and_units", () => {
    /**
     * Synthesized filter children carry the min/max and units
     * ExtendScript reports.
     */
    const [_app, contents] = _new_contents();
    const trim = contents.add_property("ADBE Vector Filter - Trim");
    py_assert(trim instanceof PropertyGroup);
    const start = trim.properties[0];
    py_assert(start instanceof Property);
    expect(start.name).toBe("Start");
    expect(start.min_value).toBe(0);
    expect(start.max_value).toBe(100);
    expect(start.units_text).toBe("percent");
  });

  test("test_path_element_has_shape_direction", () => {
    /**
     * The Path element exposes Shape Direction + Path (the path
     * property is spatial), matching ExtendScript.
     */
    const [_app, contents] = _new_contents();
    const path = contents.add_property("ADBE Vector Shape - Group");
    py_assert(path instanceof PropertyGroup);
    expect(py_eq(path.properties.map((c: Property | PropertyGroup) => c.name), ["Shape Direction", "Path"])).toBe(true);
    const path_prop = path.properties[1];
    py_assert(path_prop instanceof Property);
    expect(path_prop.is_spatial).toBe(true);
  });

  test("test_add_path_value_is_empty_shape", () => {
    /**
     * A fresh Path element's value is an empty Shape, not None
     * (the empty bezier path carries no ldat chunk).
     */
    const [_app, contents] = _new_contents();
    const path = contents.add_property("ADBE Vector Shape - Group");
    py_assert(path instanceof PropertyGroup);
    const path_prop = path.property("ADBE Vector Shape");
    py_assert(path_prop instanceof Property);
    expect(path_prop.name).toBe("Path");
    const value = path_prop.value;
    py_assert(value instanceof Shape);
    expect(py_eq(value.vertices, [])).toBe(true);
  });

  test("test_set_path_geometry_marks_normalized_and_roundtrips", () => {
    const tmp_path = make_tmp_path();
    /**
     * Setting a from-scratch Shape writes a `normalized` shph (bit 0)
     * and the absolute vertices survive reload. Without bit 0 AE reads
     * the normalized points as literal coordinates (AE 2026 verified).
     */
    const [app, contents] = _new_contents();
    const path = contents.add_property("ADBE Vector Shape - Group");
    py_assert(path instanceof PropertyGroup);
    const path_prop = path.property("ADBE Vector Shape");
    py_assert(path_prop instanceof Property);
    const tri = [[100.0, 100.0], [300.0, 100.0], [200.0, 280.0]];
    path_prop.value = new Shape(tri, null, null, { closed: true });

    const out = tmp_path.div("path.aep");
    app.project.save(out);
    const reparsed = parse_aep(out).project;
    const rifx = reparsed._rifx;
    const shph = find_by_type(as_instance(recursive_find(rifx.chunks, null, "shap")[0], ListChunk).chunks, "shph");
    expect(shph.normalized).toBe(true);
    expect(shph.open).toBe(false);

    const comp2 = reparsed.compositions[0];
    const layer2 = _next(comp2.layers, (lyr) => lyr instanceof ShapeLayer);
    const contents2 = layer2.property("ADBE Root Vectors Group");
    py_assert(contents2 instanceof PropertyGroup);
    const path2 = contents2.properties[0];
    py_assert(path2 instanceof PropertyGroup);
    const verts2 = path2.property("ADBE Vector Shape").value.vertices;
    for (const [got, want] of zip(verts2, tri)) {
      expect(approx(got, want, { abs: 1e-3 })).toBe(true);
    }
  });

  test("test_set_vector_position_survives_reload", () => {
    const tmp_path = make_tmp_path();
    /**
     * Setting a shape group's Vector Position writes the canonical
     * tdb4 flags AE honours (else AE silently shows 0,0; AE 2026
     * verified) and the value survives reload.
     */
    const [app, contents] = _new_contents();
    const group = contents.add_property("ADBE Vector Group");
    py_assert(group instanceof PropertyGroup);
    const transform = group.property("ADBE Vector Transform Group");
    py_assert(transform instanceof PropertyGroup);
    const pos = transform.properties.find((p: Property | PropertyGroup) => p.name === "Position");
    py_assert(pos instanceof Property);
    pos.value = [200.0, 160.0];
    py_assert(pos._tdb4 != null);
    expect(pos._tdb4._spatial_static_flags).toBe(0x0f);
    expect(pos._tdb4._pad2a).toBe(3);
    expect(pos._tdb4._value_hint_type).toBe(0xffff);
    expect(pos._tdb4._property_category).toBe(0x09);

    const out = tmp_path.div("vpos.aep");
    app.project.save(out);
    const comp2 = parse_aep(out).project.compositions[0];
    const layer2 = _next(comp2.layers, (lyr) => lyr instanceof ShapeLayer);
    const group2 = layer2.property("ADBE Root Vectors Group").properties[0];
    py_assert(group2 instanceof PropertyGroup);
    const pos2 = as_instance(
      _next(group2.property("ADBE Vector Transform Group").properties, (p) => p.name === "Position"),
      Property,
    );
    expect(py_eq(pos2.value, [200.0, 160.0])).toBe(true);
  });
});

describe("TestRoundtripName", () => {
  /** Roundtrip: modify PropertyBase.name and verify save/reload. */

  test("test_modify_effect_group_name", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("2_gaussian.aep")).project;
    const layer = get_first_layer(project);
    const effect = as_instance(layer.effects, PropertyGroup).properties[0];
    expect(effect.name).toBe("Gaussian Blur");

    effect.name = "My Blur";
    const out = tmp_path.div("renamed_effect.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const layer2 = get_first_layer(project2);
    expect(as_instance(layer2.effects, PropertyGroup).properties[0].name).toBe("My Blur");
  });

  test("test_modify_mask_name", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("mask_add.aep")).project;
    const layer = get_first_layer(project);
    const mask = as_instance(layer.masks, PropertyGroup).properties[0];
    py_assert(mask instanceof MaskPropertyGroup);

    mask.name = "Custom Mask";
    const out = tmp_path.div("renamed_mask.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const layer2 = get_first_layer(project2);
    const mask2 = as_instance(layer2.masks, PropertyGroup).properties[0];
    expect(mask2.name).toBe("Custom Mask");
  });
});

describe("TestRoundtripProxyBody", () => {
  /** Roundtrip: modify synthesized (ProxyBody-backed) property attributes. */

  /** Find a synthesized effect property by match name. */
  function _find_synthesized_effect_prop(layer: Layer, effect_index: number, match_name: string): Property {
    const effect = as_instance(layer.effects, PropertyGroup).properties[effect_index];
    py_assert(effect instanceof PropertyGroup);
    for (const prop of effect.properties) {
      if (prop instanceof Property && prop.match_name === match_name) {
        return prop;
      }
    }
    throw new AssertionError_(`Property ${match_name} not found in effect`);
  }

  test("test_synthesized_effect_property_is_attached", () => {
    /** Synthesized effect properties are attached before user code sees them. */
    const project = parse_aep(SAMPLES_DIR.div("2_gaussian.aep")).project;
    const layer = get_first_layer(project);
    const effect = as_instance(layer.effects, PropertyGroup).properties[0];
    const blur = _find_synthesized_effect_prop(layer, 0, "ADBE Gaussian Blur 2-0001");

    py_assert(effect instanceof PropertyGroup);
    expect(blur.parent_property).toBe(effect);
  });

  test("test_modify_synthesized_value", () => {
    const tmp_path = make_tmp_path();
    /** Modify the value of a synthesized (default) effect property. */
    const project = parse_aep(SAMPLES_DIR.div("2_gaussian.aep")).project;
    const layer = get_first_layer(project);
    const blur = _find_synthesized_effect_prop(layer, 0, "ADBE Gaussian Blur 2-0001");
    const original = blur.value;
    blur.value = 42.0;
    const out = tmp_path.div("proxy_value.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const layer2 = get_first_layer(project2);
    const blur2 = _find_synthesized_effect_prop(layer2, 0, "ADBE Gaussian Blur 2-0001");
    expect(blur2.value).toBe(42.0);
    expect(py_eq(blur2.value, original)).toBe(false);
  });

  test("test_synthesized_enabled_read_only", () => {
    /** Effect-parameter `enabled` is read-only (AE `canSetEnabled` is False). */
    const project = parse_aep(SAMPLES_DIR.div("2_gaussian.aep")).project;
    const layer = get_first_layer(project);
    const blur = _find_synthesized_effect_prop(layer, 0, "ADBE Gaussian Blur 2-0001");
    expect(blur.enabled).toBe(true);
    expect(blur.can_set_enabled).toBe(false);
    raises(AttributeError, () => {
      blur.enabled = false;
    });
  });

  test("test_synthesized_effect_param_name_rejected", () => {
    /**
     * An effect parameter cannot be renamed: its parent is a NAMED group.
     *
     * AE 2026: `param.name = "x"` throws "Can not 'set name' this property,
     * because parent is not an INDEXED_GROUP" for a Gaussian Blur param and
     * for a Slider Control param alike; only the effect itself, whose parent
     * is the indexed Effect Parade, can be renamed.
     */
    const project = parse_aep(SAMPLES_DIR.div("2_gaussian.aep")).project;
    const layer = get_first_layer(project);
    const blur = _find_synthesized_effect_prop(layer, 0, "ADBE Gaussian Blur 2-0001");
    raises(ValueError, () => {
      blur.name = "Custom Blur Name";
    }, "not an indexed group");
  });

  test("test_effect_group_name_is_writable", () => {
    const tmp_path = make_tmp_path();
    /** The effect itself renames and round-trips. */
    const project = parse_aep(SAMPLES_DIR.div("2_gaussian.aep")).project;
    const layer = get_first_layer(project);
    py_assert(layer.effects != null);
    const effect = as_instance(layer.effects, PropertyGroup).properties[0];
    effect.name = "Custom Blur Name";
    const out = tmp_path.div("proxy_name.aep");
    project.save(out);

    const project2 = parse_aep(out).project;
    const layer2 = get_first_layer(project2);
    py_assert(layer2.effects != null);
    expect(as_instance(layer2.effects, PropertyGroup).properties[0].name).toBe("Custom Blur Name");
  });
});

describe("TestValueValidation", () => {
  /** Tests for Property.value setter min/max validation. */

  test("test_scalar_below_min_raises", () => {
    /** Setting a scalar value below min_value raises ValueError. */
    // Fresh parse (not the cached parse_project_fresh): _deanimate mutates the
    // property, which would corrupt the session-shared cached Project.
    const project = parse_aep(SAMPLES_DIR.div("property_types.aep")).project;
    const layer = get_layer(project, "property_1D_opacity");
    const opacity = _find_property(layer, "ADBE Opacity");
    py_assert(opacity != null);
    _deanimate(opacity);
    expect(opacity.has_min).toBe(true);
    expect(opacity.min_value).toBe(0);
    raises(ValueError, () => {
      opacity.value = -10.0;
    }, "must be >= 0");
  });

  test("test_scalar_above_max_raises", () => {
    /** Setting a scalar value above max_value raises ValueError. */
    const project = parse_aep(SAMPLES_DIR.div("property_types.aep")).project;
    const layer = get_layer(project, "property_1D_opacity");
    const opacity = _find_property(layer, "ADBE Opacity");
    py_assert(opacity != null);
    _deanimate(opacity);
    expect(opacity.has_max).toBe(true);
    expect(opacity.max_value).toBe(100);
    raises(ValueError, () => {
      opacity.value = 150.0;
    }, "must be <= 100");
  });

  test("test_valid_value_accepted", () => {
    /** Setting a value within bounds does not raise. */
    const project = parse_aep(SAMPLES_DIR.div("property_types.aep")).project;
    const layer = get_layer(project, "property_1D_opacity");
    const opacity = _find_property(layer, "ADBE Opacity");
    py_assert(opacity != null);
    _deanimate(opacity);
    opacity.value = 50.0;
    expect(opacity.value).toBe(50.0);
  });

  test("test_wrong_list_length_raises", () => {
    /** Setting a list with wrong number of dimensions raises ValueError. */
    const project = parse_aep(SAMPLES_DIR.div("property_types.aep")).project;
    const layer = get_layer(project, "property_3D_position");
    const position = _find_property(layer, "ADBE Position");
    py_assert(position != null);
    _deanimate(position);
    expect(position.dimensions).toBe(3);
    raises(ValueError, () => {
      position.value = [100.0, 200.0];
    }, "expected 3 elements, got 2");
  });

  test("test_list_on_scalar_raises", () => {
    /** Setting a list on a scalar (1D) property raises TypeError. */
    const project = parse_aep(SAMPLES_DIR.div("property_types.aep")).project;
    const layer = get_layer(project, "property_1D_opacity");
    const opacity = _find_property(layer, "ADBE Opacity");
    py_assert(opacity != null);
    _deanimate(opacity);
    expect(opacity.dimensions).toBe(1);
    raises(TypeError_, () => {
      opacity.value = [50.0, 60.0];
    }, "expected a number, got list");
  });

  test("test_scalar_on_multidim_raises", () => {
    /** Setting a scalar on a multi-dimensional property raises TypeError. */
    const project = parse_aep(SAMPLES_DIR.div("property_types.aep")).project;
    const layer = get_layer(project, "property_3D_position");
    const position = _find_property(layer, "ADBE Position");
    py_assert(position != null);
    _deanimate(position);
    expect(position.dimensions).toBe(3);
    raises(TypeError_, () => {
      position.value = 42.0;
    }, "expected a sequence of 3 elements");
  });
});

describe("TestValueInPlaceMutation", () => {
  /**
   * Regression: re-assigning a mutated list value must write through.
   *
   * The value setter early-returns when re-assigning the identical object,
   * which is correct only for complex write-through types. A plain list read,
   * mutated in place, and re-assigned must still reach the cdat chunk.
   */

  test("test_inplace_list_mutation_roundtrips", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SAMPLES_DIR.div("is_modified_false.aep")).project;
    const layer = project.compositions[0].layers[0];
    const pos = _find_property(layer, "ADBE Position");
    py_assert(pos != null);
    const original = [...pos.value];

    const v = pos.value;
    v[0] = original[0] + 123.0; // mutate in place
    pos.value = v; // re-assign the SAME object

    const out = tmp_path.div("out.aep");
    project.save(out);
    const project2 = parse_aep(out).project;
    const pos2 = _find_property(project2.compositions[0].layers[0], "ADBE Position");
    py_assert(pos2 != null);
    expect(approx(pos2.value[0], original[0] + 123.0)).toBe(true);
  });
});

/** Recursively find a leaf Property by match name under a layer/group. */
function _find_descendant(node: Layer | PropertyGroup, match_name: string): Property | null {
  for (const child of node) {
    if (child instanceof Property && child.match_name === match_name) {
      return child;
    }
    if (child instanceof PropertyGroup) {
      const found = _find_descendant(child, match_name);
      if (found != null) {
        return found;
      }
    }
  }
  return null;
}

describe("TestPlaceholderBoundsValueSetter", () => {
  /**
   * Setting a value on properties carrying AE's `[0.0]` placeholder bounds.
   *
   * AE writes a `[0.0]` tdum/tduM placeholder for Scale, the separated
   * Position followers, and Time Remapping. py_aep used to read this as a
   * real `max=0` and reject any non-zero value on the static `.value` setter.
   * The placeholder is now suppressed for the value setter, and for Scale /
   * separated Position on the read API too, matching ExtendScript. Time
   * Remapping keeps its read bounds (ExtendScript reports `hasMax=True`/
   * `maxValue=0`) while the setter no longer enforces them.
   */

  const SAMPLE = PROPERTY_SAMPLES_DIR.div("transform_separated.aep");

  /** Method `_layer` in the Python class. */
  function _layer(): Layer {
    return parse_aep(SAMPLE).project.compositions[0].layers[0];
  }

  test("test_set_time_remapping_value", () => {
    const tr = _find_descendant(_layer(), "ADBE Time Remapping");
    py_assert(tr != null && !py_bool(tr.keyframes));
    tr.value = 5.0; // used to raise "must be <= 0.0"
    expect(approx(tr.value, 5.0)).toBe(true);
    // Read bounds still match ExtendScript (hasMax True, maxValue 0).
    expect(tr.has_max).toBe(true);
    expect(tr.max_value).toBe(0);
  });

  test("test_set_separated_position_dimension", () => {
    const px = _find_descendant(_layer(), "ADBE Position_0");
    py_assert(px != null && !py_bool(px.keyframes));
    px.value = -50.0; // used to raise; only 0.0 was accepted
    expect(approx(px.value, -50.0)).toBe(true);
    // ExtendScript reports no bounds for separated Position dimensions.
    expect(px.has_min).toBe(false);
    expect(px.has_max).toBe(false);
  });

  test("test_set_scale_value", () => {
    const scale = _find_descendant(_layer(), "ADBE Scale");
    py_assert(scale != null && !py_bool(scale.keyframes));
    scale.value = [150.0, 150.0, 150.0];
    // A 2-D layer reports Scale Z as 100 whatever was written.
    expect(approx(scale.value, [150.0, 150.0, 100.0])).toBe(true);
    expect(scale.has_max).toBe(false);
  });

  test("test_real_bounds_still_enforced", () => {
    const op = _find_descendant(_layer(), "ADBE Opacity");
    py_assert(op != null);
    expect(py_eq([op.min_value, op.max_value], [0, 100])).toBe(true);
    raises(ValueError, () => {
      op.value = 150.0;
    });
  });

  test("test_min_zero_bound_still_enforced", () => {
    // Regression guard: a property with a real min=0 but a placeholder
    // (all-zero) max must still reject negatives. A prior fix wrongly
    // dropped the min whenever the max was absent, letting AE-invalid
    // negatives through for ~24 props (stroke width, light/camera, etc.).
    const project = parse_aep(VERSIONS_DIR.div("ae2026", "complete.aep")).project;
    let falloff = null;
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        const p = _find_descendant(layer, "ADBE Light Falloff Distance");
        if (p != null && !py_bool(p.keyframes)) {
          falloff = p;
          break;
        }
      }
      if (falloff != null) {
        break;
      }
    }
    py_assert(falloff != null);
    expect(falloff.min_value).toBe(0);
    raises(ValueError, () => {
      falloff.value = -5.0;
    });
    falloff.value = 50.0; // positive accepted (placeholder max not enforced)
    expect(approx(falloff.value, 50.0)).toBe(true);
  });

  test("test_roundtrip_is_byte_identical", () => {
    const tmp_path = make_tmp_path();
    // Parsing (which reads the suppressed bounds) must not mutate chunks.
    const raw = SAMPLE.read_bytes();
    const out = tmp_path.div("rt.aep");
    parse_aep(SAMPLE).project.save(out);
    expect(py_eq(out.read_bytes(), raw)).toBe(true);
  });

  test("test_unbounded_props_match_extendscript", () => {
    // Properties ExtendScript reports as unbounded must not over-report
    // bounds: fully-unbounded (channel blend, given a UI-range fallback)
    // and placeholder-max (light props with an all-zero [0.0] tduM).
    const project = parse_aep(VERSIONS_DIR.div("ae2026", "complete.aep")).project;
    const found = new Map<string, Property>();

    const collect = (node: Layer | PropertyGroup): void => {
      for (const p of node) {
        if (p instanceof Property) {
          setdefault(found, p.match_name, p);
        } else if (p instanceof PropertyGroup) {
          collect(p);
        }
      }
    };

    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        collect(layer);
      }
    }

    // Fully unbounded in ExtendScript (hasMin=False, hasMax=False):
    const rb = getitem(found, "ADBE R Channel Blend");
    expect(py_eq([rb.has_min, rb.has_max], [false, false])).toBe(true);
    // Light Falloff Distance: ES hasMin=True, hasMax=False (placeholder max).
    const lf = getitem(found, "ADBE Light Falloff Distance");
    expect(py_eq([lf.has_min, lf.has_max], [true, false])).toBe(true);
    // Light Intensity: ES hasMin=False, hasMax=False.
    const li = getitem(found, "ADBE Light Intensity");
    expect(py_eq([li.has_min, li.has_max], [false, false])).toBe(true);
  });
});

describe("TestIsInterpolationTypeValid", () => {
  /**
   * Truth table probed against AE 2026 (2026-07-14 probe run): every type
   * is valid for normal properties; marker / source text / checkbox /
   * dropdown are HOLD-only; a property that cannot vary over time (Layer
   * Control) rejects all three; integer sliders interpolate fully; an
   * out-of-enum argument raises instead of returning False.
   */

  const ALL = [
    KeyframeInterpolationType.LINEAR,
    KeyframeInterpolationType.BEZIER,
    KeyframeInterpolationType.HOLD,
  ];

  /** Method `_table` in the Python class. */
  function _table(prop: Property): boolean[] {
    return ALL.map((t) => prop.is_interpolation_type_valid(t));
  }

  test("test_transform_properties_accept_all", () => {
    const project = parse_aep(SAMPLES_DIR.div("is_modified_false.aep")).project;
    const layer = project.compositions[0].layers[0];
    for (const match of [
      "ADBE Position",
      "ADBE Scale",
      "ADBE Rotate Z",
      "ADBE Opacity",
      "ADBE Anchor Point",
    ]) {
      const prop = layer.transform.property(match);
      py_assert(prop instanceof Property);
      expect(py_eq(_table(prop), [true, true, true])).toBe(true);
    }
  });

  test("test_marker_is_hold_only", () => {
    const project = parse_aep(SAMPLES_DIR.parent.div("marker", "layer_marker.aep")).project;
    const layer = project.compositions[0].layers[0];
    const marker = layer.marker;
    py_assert(marker != null);
    expect(py_eq(_table(marker), [false, false, true])).toBe(true);
  });

  test("test_source_text_is_hold_only", () => {
    const project = parse_aep(SAMPLES_DIR.parent.div("text", "text_ranges.aep")).project;
    const layer = as_instance(project.compositions
      .flatMap((comp: CompItem) => comp.layers)
      .find((ly: Layer) => ly instanceof TextLayer), TextLayer);
    const prop = layer.property("ADBE Text Properties").property("ADBE Text Document");
    py_assert(prop instanceof Property);
    expect(py_eq(_table(prop), [false, false, true])).toBe(true);
  });

  test("test_mask_shape_accepts_all", () => {
    const project = parse_aep(SAMPLES_DIR.div("mask_add.aep")).project;
    const layer = project.compositions[0].layers[0];
    const mask = as_instance(as_instance(layer.masks, PropertyGroup).property(0), MaskPropertyGroup);
    const shape = mask.property("ADBE Mask Shape");
    py_assert(shape instanceof Property);
    expect(py_eq(_table(shape), [true, true, true])).toBe(true);
  });

  test("test_effect_controls", () => {
    const project = parse_aep(SAMPLES_DIR.div("is_modified_false.aep")).project;
    const layer = project.compositions[0].layers[0];
    const parade = layer.effects;
    py_assert(parade != null);

    const slider = as_instance(as_instance(parade.add_property("ADBE Slider Control"), PropertyGroup).properties[0], Property);
    expect(py_eq(_table(slider), [true, true, true])).toBe(true);

    const checkbox = as_instance(as_instance(parade.add_property("ADBE Checkbox Control"), PropertyGroup).properties[0], Property);
    expect(py_eq(_table(checkbox), [false, false, true])).toBe(true);

    const dropdown = as_instance(as_instance(parade.add_property("ADBE Dropdown Control"), PropertyGroup).properties[0], Property);
    expect(py_eq(_table(dropdown), [false, false, true])).toBe(true);

    const layer_ctl = as_instance(as_instance(parade.add_property("ADBE Layer Control"), PropertyGroup).properties[0], Property);
    expect(py_eq(_table(layer_ctl), [false, false, false])).toBe(true);
  });

  test("test_invalid_type_raises", () => {
    const project = parse_aep(SAMPLES_DIR.div("is_modified_false.aep")).project;
    const prop = project.compositions[0].layers[0].transform.property("ADBE Position");
    py_assert(prop instanceof Property);
    raises(ValueError, () => {
      prop.is_interpolation_type_valid(9999);
    });
    raises(TypeError_, () => {
      // @ts-expect-error a string is not a KeyframeInterpolationType; the call must raise TypeError at runtime
      prop.is_interpolation_type_valid("hold");
    });
  });
});

describe("TestKeyframeInterpolationTypeGuard", () => {
  /**
   * The in/out interpolation setters are gated on
   * `is_interpolation_type_valid`, so a hold-only property cannot be given
   * a LINEAR/BEZIER byte AE never writes.
   */

  const SIDES = ["in_interpolation_type", "out_interpolation_type"];

  /** Method `_marker_keyframe` in the Python class. */
  function _marker_keyframe(): Keyframe {
    const project = parse_aep(SAMPLES_DIR.parent.div("marker", "layer_marker.aep")).project;
    const marker = project.compositions[0].layers[0].marker;
    py_assert(marker != null);
    return marker.keyframes[0];
  }

  // Cartesian product of the stacked parametrize decorators.
  const hold_only_rows: [string, KeyframeInterpolationType][] = [];
  for (const side of SIDES) {
    for (const interp of [KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.BEZIER]) {
      hold_only_rows.push([side, interp]);
    }
  }

  test.each(hold_only_rows)("test_hold_only_property_rejects_non_hold[%#]", (side, interp) => {
    const kf = _marker_keyframe();
    raises(ValueError, () => {
      setattr(kf, side, interp);
    }, "not a valid interpolation type");
    expect(getattr(kf, side)).toBe(KeyframeInterpolationType.HOLD);
  });

  test.each(SIDES)("test_hold_only_property_accepts_hold[%#]", (side) => {
    // A no-op rewrite of an AE-written marker keyframe must not raise.
    const kf = _marker_keyframe();
    setattr(kf, side, KeyframeInterpolationType.HOLD);
    expect(getattr(kf, side)).toBe(KeyframeInterpolationType.HOLD);
  });

  const normal_rows: [string, KeyframeInterpolationType][] = [];
  for (const side of SIDES) {
    for (const interp of [
      KeyframeInterpolationType.LINEAR,
      KeyframeInterpolationType.BEZIER,
      KeyframeInterpolationType.HOLD,
    ]) {
      normal_rows.push([side, interp]);
    }
  }

  test.each(normal_rows)("test_normal_property_accepts_every_type[%#]", (side, interp) => {
    const project = parse_aep(SAMPLES_DIR.div("keyframe_interpolation.aep")).project;
    const layer = get_comp(project, "keyframe_LINEAR").layers[0];
    const prop = as_instance(_find_property(layer, "ADBE Position"), Property);
    setattr(prop.keyframes[0], side, interp);
    expect(getattr(prop.keyframes[0], side)).toBe(interp);
  });

  test.each(SIDES)("test_out_of_enum_value_rejected[%#]", (side) => {
    const kf = _marker_keyframe();
    raises(ValueError, () => {
      setattr(kf, side, 9999);
    });
    raises(TypeError_, () => {
      setattr(kf, side, "hold");
    });
  });
});

describe("TestRoundtripAnimatedTdb4Stamps", () => {
  /**
   * Animating a property must stamp the comp-derived tdb4 fields.
   *
   * AE writes `cdta.internal_timebase` into every property tdb4 and the comp
   * pixel aspect into spatial ones. The animated-tdb4 template used to
   * hard-code 24576, so animating anything in a non-24 fps comp wrote a 24 fps
   * timebase - the field AE rejects a file over ("zero denominator converting
   * ratio denominators"). Measured on AE 2026.
   */

  const SAMPLE = PROPERTY_SAMPLES_DIR.div("effect_point_speed.aep");

  test("test_animate_stamps_comp_timebase", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const comp = project.compositions[0];
    expect(comp.frame_rate).toBe(25.0);
    expect(comp._cdta.internal_timebase).toBe(25600);

    const prop = comp.layers[0].transform.property("ADBE Scale");
    prop.add_key(1.0);
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const comp2 = parse_aep(out).project.compositions[0];
    const prop2 = comp2.layers[0].transform.property("ADBE Scale");
    expect(py_bool(prop2.keyframes)).toBe(true);
    expect(prop2._tdb4._time_base).toBe(25600);
  });

  test("test_set_value_at_time_stamps_comp_timebase", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const comp = project.compositions[0];
    const prop = comp.layers[0].transform.property("ADBE Rotate Z");
    prop.set_value_at_time(1.0, 45.0);
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const comp2 = parse_aep(out).project.compositions[0];
    const prop2 = comp2.layers[0].transform.property("ADBE Rotate Z");
    expect(prop2._tdb4._time_base).toBe(25600);
  });

  test("test_animate_stamps_pixel_aspect_on_spatial", () => {
    const tmp_path = make_tmp_path();
    /**
     * AE writes the comp pixel aspect into a spatial property tdb4, but
     * the layer display aspect into a footage layer's Anchor Point, which
     * it stores normalized (AE 2026 keying both on this 400x300 layer in a
     * 1.5 comp: 1.5 / 1e-4 and 4/3 / 6.25e-12).
     */
    const project = parse_project_fresh(SAMPLE);
    const comp = project.compositions[0];
    comp.pixel_aspect = 1.5;

    comp.layers[0].transform.property("ADBE Anchor Point").add_key(1.0);
    comp.layers[0].transform.property("ADBE Position").add_key(1.0);
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const comp2 = parse_aep(out).project.compositions[0];
    const anchor = comp2.layers[0].transform.property("ADBE Anchor Point");
    expect(py_bool(anchor.is_spatial)).toBe(true);
    expect(approx(anchor._tdb4.pixel_aspect, 400 / 300)).toBe(true);
    expect(anchor._tdb4._arc_accuracy).toBe(NORMALIZED_ARC_ACCURACY);
    expect(anchor._tdb4._time_base).toBe(25600);
    const position = comp2.layers[0].transform.property("ADBE Position");
    expect(approx(position._tdb4.pixel_aspect, 1.5)).toBe(true);
    expect(approx(position._tdb4._arc_accuracy, 1e-4)).toBe(true);
  });

  test("test_animate_leaves_pixel_aspect_alone_on_scalar", () => {
    const tmp_path = make_tmp_path();
    /**
     * Non-spatial properties keep 1.0 even in a non-square-pixel comp -
     * the predicate is narrower than `is_spatial`, so a scalar must not
     * pick the comp aspect up.
     */
    const project = parse_project_fresh(SAMPLE);
    const comp = project.compositions[0];
    comp.pixel_aspect = 1.5;

    comp.layers[0].transform.property("ADBE Opacity").add_key(1.0);
    const out = tmp_path.div("modified.aep");
    project.save(out);

    const comp2 = parse_aep(out).project.compositions[0];
    const opacity = comp2.layers[0].transform.property("ADBE Opacity");
    expect(py_bool(opacity.is_spatial)).toBe(false);
    expect(approx(opacity._tdb4.pixel_aspect, 1.0)).toBe(true);
  });
});

/** Shared `_AE_STATIC` bytes: AE 2026 output after removing the last key, keyed by property path. */
const _AE_STATIC = new Map<string, [string, string]>([
  [
    tkey("ADBE Transform Group", "ADBE Position"),
    [
      [
        "db990003000f0003ffffffff000060003f1a36e2eb1c432d3ff0000000000000",
        "3ff00000000000003ff00000000000003ff00000000000000000000809000000",
        "0000000000000000000000000101000100000001000000000000000000000000",
        "00000000000000000000000000000000000000000000000000000000",
      ].join(""),
      [
        "407f4000000000004072c0000000000040490000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000",
      ].join(""),
    ],
  ],
  [
    tkey("ADBE Transform Group", "ADBE Scale"),
    [
      [
        "db990003000100000001ffff000060003f1a36e2eb1c432d3ff0000000000000",
        "3ff00000000000003ff00000000000003ff00000000000000000000809000000",
        "0000000000000000000000000101000000000000000000000000000000000000",
        "00000000000000000000000000000000000000000000000000000000",
      ].join(""),
      [
        "3ff80000000000003ff80000000000003ff00000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "000000000000000000000000000000000000000000000000",
      ].join(""),
    ],
  ],
  [
    tkey("ADBE Transform Group", "ADBE Opacity"),
    [
      [
        "db990001000100000001ffff000060003f1a36e2eb1c432d3ff0000000000000",
        "3ff00000000000003ff00000000000003ff00000000000000000000809000000",
        "0000000000000000000000000101000000000000000000000000000000000000",
        "00000000000000000000000000000000000000000000000000000000",
      ].join(""),
      [
        "3fe999999999999a000000000000000000000000000000000000000000000000",
        "0000000000000000",
      ].join(""),
    ],
  ],
  [
    tkey("ADBE Effect Parade", "ADBE Fill", "ADBE Fill-0002"),
    [
      [
        "db990004000700010002ffff000060003f1a36e2eb1c432d3ff0000000000000",
        "3ff00000000000003ff00000000000003ff00000000000000000000101000000",
        "0000000000000000000000000101000100000000000000000000000000000000",
        "00000000000000000000000000000000000000000000000000000000",
      ].join(""),
      [
        "406fe0000000000000000000000000000000000000000000406fe00000000000",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000000",
      ].join(""),
    ],
  ],
]);

/** The keys of `_AE_STATIC` as Python tuples, in insertion order (parametrize list). */
const _AE_STATIC_PATHS: string[][] = [
  ["ADBE Transform Group", "ADBE Position"],
  ["ADBE Transform Group", "ADBE Scale"],
  ["ADBE Transform Group", "ADBE Opacity"],
  ["ADBE Effect Parade", "ADBE Fill", "ADBE Fill-0002"],
];

describe("TestDeanimateMatchesAe", () => {
  /**
   * Removing the last keyframe reproduces AE 2026's static stream.
   *
   * AE only sets the static bit, clears the animated flag and stores the
   * removed keyframe's record (in/out interpolation, spatial flags); every
   * other `tdb4` byte keeps its animated value, and the `cdat` holds 3
   * doubles per dimension for a colour or spatial stream, 5 otherwise. The
   * expected bytes are AE 2026's output for `removeKey(1)` until no key is
   * left, on the same sample. Restoring a never-animated stream's bytes
   * instead made AE ignore the static value: Position read back at its
   * default, a shape Fill Color failed to evaluate.
   */

  /** Method `_prop` in the Python class. */
  function _prop(project: Project, path: string[]): Property {
    const layer =_next( get_comp(project, "type_camera").layers, (lyr) => lyr.name === "XF");
    let prop: Property | PropertyGroup = layer;
    for (const match_name of path) {
      prop = as_instance(prop, PropertyGroup).property(match_name);
    }
    py_assert(prop instanceof Property);
    return prop;
  }

  test.each(_AE_STATIC_PATHS.map((p) => [p]))("test_remove_keys_bytes[%#]", (path) => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("all_animated.aep"));
    const prop = _prop(project, path);
    _deanimate(prop);
    const out = tmp_path.div("deanimated.aep");
    project.save(out);
    const prop2 = _prop(parse_aep(out).project, path);
    const [tdb4_hex, cdat_hex] = getitem(_AE_STATIC, tkey(...path));
    expect(bytes_.hex(prop2._tdb4.tobytes())).toBe(tdb4_hex);
    py_assert(prop2._cdat != null);
    expect(bytes_.hex(prop2._cdat.tobytes())).toBe(cdat_hex);
  });

  test("test_shape_props_keep_animated_flags", () => {
    const tmp_path = make_tmp_path();
    /**
     * A shape group's Position and Fill Color animated by py and
     * de-animated again keep the value-bearing flags AE writes (static
     * bit, value-hint/cvot bytes and category of the animated state).
     */
    const project = parse_project_fresh(LAYER_SAMPLES_DIR.div("shape_source_rect.aep"));
    const layer =_next( get_comp(project, "SHAPE_RECTS").layers, (lyr) => lyr.name === "animated_rect");
    const group = layer.property("ADBE Root Vectors Group").property("ADBE Vector Group");
    const pos = group
      .property("ADBE Vector Transform Group")
      .property("ADBE Vector Position");
    const fill = group
      .property("ADBE Vectors Group")
      .property("ADBE Vector Graphic - Fill")
      .property("ADBE Vector Fill Color");
    const steps: [Property<number[]>, number[], number[]][] = [
      [pos, [10.0, 20.0], [30.0, 40.0]],
      [fill, [0.0, 1.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0]],
    ];
    for (const [prop, first, last] of steps) {
      prop.set_value_at_time(0.0, first);
      prop.set_value_at_time(1.0, last);
      _deanimate(prop);
    }
    const out = tmp_path.div("shape_deanimated.aep");
    project.save(out);
    const layer2 =_next( get_comp(parse_aep(out).project, "SHAPE_RECTS").layers, (lyr) => lyr.name === "animated_rect");
    const group2 = layer2.property("ADBE Root Vectors Group").property("ADBE Vector Group");
    const pos2 = group2
      .property("ADBE Vector Transform Group")
      .property("ADBE Vector Position");
    const fill2 = group2
      .property("ADBE Vectors Group")
      .property("ADBE Vector Graphic - Fill")
      .property("ADBE Vector Fill Color");
    // AE 2026 de-animating the same streams: 0x05-0x0B, the category
    // and the record's interpolation bytes.
    expect(bytes_.hex(bytes_.slice(pos2._tdb4.tobytes(), 0x04, 0x0c))).toBe("000f0003ffffffff");
    expect(pos2._tdb4.tobytes()[0x3c]).toBe(0x09);
    expect(bytes_.hex(bytes_.slice(pos2._tdb4.tobytes(), 0x4c, 0x50))).toBe("01010001");
    expect(bytes_.hex(bytes_.slice(fill2._tdb4.tobytes(), 0x04, 0x06))).toBe("0007");
    expect(bytes_.hex(bytes_.slice(fill2._tdb4.tobytes(), 0x08, 0x0c))).toBe("0002ffff");
    expect(fill2._tdb4.tobytes()[0x3c]).toBe(0x01);
    expect(bytes_.hex(bytes_.slice(fill2._tdb4.tobytes(), 0x4c, 0x50))).toBe("01010001");
    py_assert(pos2._cdat != null && fill2._cdat != null);
    expect(py_eq(pos2._cdat.values, [30.0, 40.0, 0.0, 0.0, 0.0, 0.0])).toBe(true);
    expect(fill2._cdat.values.length).toBe(12);
    expect(py_eq(pos2.value, [30.0, 40.0])).toBe(true);
    expect(py_eq(fill2.value, [0.0, 0.0, 1.0, 1.0])).toBe(true);
  });
});

describe("TestEffectParamDefaults", () => {
  /**
   * `is_modified` of an effect parameter stored in the instance compares
   * against its pard default: popup s2 at 0x3E, point percent at 0x44/0x48
   * (or the 3D point doubles), scaled to the layer.
   *
   * `effect_param_defaults.aep` is AE 2026 output (2_gaussian.aep plus two
   * Gradient Ramps): `blur_changed` stores Blur Dimensions = 3 and
   * `ramp_changed` Start of Ramp = [100, 200]. ExtendScript reports a
   * parameter holding its default (Blur Dimensions 1, Start of Ramp
   * [960, 0] on the 1920 x 1080 layer) as unmodified.
   */

  const SAMPLE = SAMPLES_DIR.div("effect_param_defaults.aep");

  /** Method `_effect` in the Python class. */
  function _effect(project: Project, name: string): PropertyGroup {
    const layer = get_first_layer(project);
    py_assert(layer.effects != null);
    const effect = [...layer.effects].find((e) => e.name === name);
    py_assert(effect instanceof PropertyGroup);
    return effect;
  }

  test("test_stored_popup_back_to_default", () => {
    const project = parse_project_fresh(SAMPLE);
    const dims = as_instance(_effect(project, "blur_changed").property("ADBE Gaussian Blur 2-0002"), Property);
    expect(dims.value).toBe(3);
    expect(dims.default_value).toBe(1);
    expect(dims.is_modified).toBe(true);
    dims.value = 1;
    expect(dims.is_modified).toBe(false);
  });

  test("test_stored_point_back_to_default", () => {
    const project = parse_project_fresh(SAMPLE);
    const start = as_instance(_effect(project, "ramp_changed").property("ADBE Ramp-0001"), Property);
    expect(py_eq(start.value, [100.0, 200.0])).toBe(true);
    expect(py_eq(start.default_value, [960.0, 0.0])).toBe(true);
    expect(start.is_modified).toBe(true);
    start.value = [960.0, 0.0];
    expect(start.is_modified).toBe(false);
  });
});

describe("TestExpressionEnabledGuard", () => {
  /**
   * `expression_enabled = True` needs an expression to enable.
   *
   * AE silently no-ops this. py-aep raises instead: mirroring the no-op
   * would clear the tdb4 disabled bit for an expression that does not
   * exist - a byte AE never writes, and one the getter then masks behind
   * `bool(self.expression)`, so nothing would surface the mistake.
   */

  const SAMPLE = PROPERTY_SAMPLES_DIR.div("keyframe_1D.aep");

  test("test_enabling_without_an_expression_raises", () => {
    const project = parse_project_fresh(SAMPLE);
    const prop = project.compositions[0].layers[0].transform.property("ADBE Opacity");
    expect(prop.expression).toBe("");

    raises(ValueError, () => {
      prop.expression_enabled = true;
    }, "no expression to enable");
  });

  test("test_the_rejected_write_leaves_the_byte_alone", () => {
    const project = parse_project_fresh(SAMPLE);
    const prop = project.compositions[0].layers[0].transform.property("ADBE Opacity");
    const before = prop._tdb4.expression_disabled;

    raises(ValueError, () => {
      prop.expression_enabled = true;
    });

    expect(prop._tdb4.expression_disabled).toBe(before);
  });

  test("test_enabling_with_an_expression_still_works", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const prop = project.compositions[0].layers[0].transform.property("ADBE Opacity");
    prop.expression = "value * 2";
    prop.expression_enabled = false;
    prop.expression_enabled = true;

    const out = tmp_path.div("modified.aep");
    project.save(out);
    const prop2 = parse_aep(out).project.compositions[0].layers[0].transform.property(
      "ADBE Opacity",
    );
    expect(prop2.expression).toBe("value * 2");
    expect(prop2.expression_enabled).toBe(true);
  });

  test("test_disabling_without_an_expression_is_allowed", () => {
    /** Only enabling is guarded; clearing the flag stays a no-op write. */
    const project = parse_project_fresh(SAMPLE);
    const prop = project.compositions[0].layers[0].transform.property("ADBE Opacity");
    prop.expression_enabled = false;
    expect(prop.expression_enabled).toBe(false);
  });
});

describe("TestCanSetExpressionAfterLayerEdits", () => {
  /**
   * What the Timeline hides follows a py-side edit, and still does once
   * saved: AE recomputes the stored `tdsb` hidden flags when it opens the
   * file, so they are not read for a layer property.
   */

  test("test_three_d_switch", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(PROPERTY_SAMPLES_DIR.div("property_2D_position.aep")).project;
    const layer = project.compositions[0].layers[0];
    let orientation = layer.transform.property("ADBE Orientation");
    expect(orientation.can_set_expression).toBe(false);
    as_instance(layer, AVLayer).three_d_layer = true;
    expect(orientation.can_set_expression).toBe(true);
    const out = tmp_path.div("three_d.aep");
    project.save(out);
    const reloaded = parse_aep(out).project.compositions[0].layers[0];
    orientation = reloaded.transform.property("ADBE Orientation");
    expect(orientation.can_set_expression).toBe(true);
  });

  test("test_renderer_switch", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(PROPERTY_SAMPLES_DIR.div("property_2D_position.aep")).project;
    const comp = project.compositions[0];
    as_instance(comp.layers[0], AVLayer).three_d_layer = true;
    comp.renderer = "ADBE Ernst";
    const out = tmp_path.div("cinema_4d.aep");
    project.save(out);
    const reloaded = parse_aep(out).project.compositions[0].layers[0];
    const materials = reloaded.property("ADBE Material Options Group");
    const reflection = materials.property("ADBE Reflection Coefficient");
    expect(reflection.can_set_expression).toBe(true);
    const transmission = materials.property("ADBE Light Transmission");
    expect(transmission.can_set_expression).toBe(false);
  });
});

describe("TestLockedRatio", () => {
  /**
   * `locked_ratio` reads the X/Y link AE saves with a Scale or Mask Feather
   * (clear on a new layer, set once its dimensions are unlinked).
   */

  test("test_new_layer_is_linked", () => {
    const project = parse_aep(PROPERTY_SAMPLES_DIR.div("property_2D_position.aep")).project;
    const scale = project.compositions[0].layers[0].transform.property("ADBE Scale");
    expect(scale.locked_ratio).toBe(true);
  });

  test("test_unlinked_in_after_effects", () => {
    // Scale's proportions unlinked in the AE 2026 UI, then saved.
    const project = parse_aep(PROPERTY_SAMPLES_DIR.div("scale_unlinked.aep")).project;
    const scale = project.compositions[0].layers[0].transform.property("ADBE Scale");
    py_assert(scale._tdsb != null);
    expect(scale._tdsb.ratio_unlinked).toBe(true);
    expect(scale.locked_ratio).toBe(false);
  });
});

describe("TestKeyPathlessMask", () => {
  /**
   * A mask with no stored path keys the default full-frame rectangle,
   * as After Effects does (`maskShape.addKey()` on the same mask, AE 2026).
   */

  const AEP = new Path(
    import.meta.dir,
    "..",
    "..",
    "samples",
    "models",
    "essential_graphics",
    "indexed_group_controllers.aep",
  );

  /** Static method `_mask_path` in the Python class. */
  function _mask_path(project: Project): Property<Shape> {
    const comp = get_comp(project, "Comp 1");
    const layer = _next(comp.layers, (layer) => layer.name === "Gray Solid 1");
    return as_instance(as_instance(layer.masks, PropertyGroup).properties[0], MaskPropertyGroup).property("ADBE Mask Shape");
  }

  test("test_add_key_stores_the_default_rectangle", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(AEP).project;
    const mask_path = _mask_path(project);
    expect(py_bool(mask_path.keyframes)).toBe(false);
    expect(mask_path.add_key(0.0)).toBe(0);
    mask_path.add_key(1.0);
    const out = tmp_path.div("keyed_mask.aep");
    project.save(out);
    const reparsed = _mask_path(parse_project_fresh(out));
    expect(reparsed.keyframes.length).toBe(2);
    for (const keyframe of reparsed.keyframes) {
      expect(py_eq(keyframe.value.vertices, [
        [0.0, 0.0],
        [0.0, 1080.0],
        [1920.0, 1080.0],
        [1920.0, 0.0],
      ])).toBe(true);
      expect(keyframe.value.closed).toBe(true);
    }
  });
});

/** The serialized `LIST:om-s` of a mask's stored Mask Shape. */
function _mask_shape_bytes(mask: MaskPropertyGroup): Uint8Array {
  py_assert(mask._tdgp != null);
  const chunks = mask._tdgp.chunks;
  const index = chunks.findIndex(
    (c) => c.chunk_type === "tdmn" && getattr(c, "value", null) === "ADBE Mask Shape",
  );
  py_assert(index >= 0, "StopIteration"); // `next(...)` raises when nothing matches
  return chunks[index + 1].tobytes();
}

describe("TestMaskLayerSpaceWrites", () => {
  /**
   * Mask Path writes in each layer's mask space, against the paths AE 2026
   * stored for the same input (`mask_layer_space.aep`).
   */

  const AEP = SAMPLES_DIR.div("mask_layer_space.aep");
  const _PATH = [[10.0, 20.0], [300.0, 20.0], [300.0, 200.0], [10.0, 200.0]];

  /** Static method `_masks` in the Python class. */
  function _masks(project: Project, layer_name: string): Map<string, MaskPropertyGroup> {
    const comp = get_comp(project, "MASK_LAYER_SPACE");
    const layer = _next(comp.layers, (lay) => lay.name === layer_name);
    return new Map(as_instance(layer.masks, PropertyGroup).properties.map((m): [string, MaskPropertyGroup] => [m.name, as_instance(m, MaskPropertyGroup)]));
  }

  test("test_reading_unstored_paths_writes_nothing", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(AEP).project;
    for (const name of ["solid_640x360", "text", "footage"]) {
      const mask_path = getitem(_masks(project, name), "Mask 1").property("ADBE Mask Shape");
      expect(py_bool(mask_path.value.vertices)).toBe(true);
      expect(py_bool(mask_path.value_at_time(1.0).vertices)).toBe(true);
    }
    const out = tmp_path.div("read.aep");
    project.save(out);
    expect(py_eq(out.read_bytes(), AEP.read_bytes())).toBe(true);
  });

  test("test_edited_unstored_path_is_written", () => {
    const tmp_path = make_tmp_path();
    /**
     * The value of a path-less mask is built per read: editing it and
     * assigning it back stores the edit.
     */
    const project = parse_aep(AEP).project;
    const mask_path = getitem(_masks(project, "solid_640x360"), "Mask 1").property(
      "ADBE Mask Shape",
    );
    const shape = mask_path.value;
    expect(mask_path.value !== shape).toBe(true);
    shape.vertices = [[10.0, 20.0], [0.0, 360.0], [640.0, 360.0], [640.0, 0.0]];
    mask_path.value = shape;
    const out = tmp_path.div("edited.aep");
    project.save(out);
    const reparsed = getitem(_masks(parse_project_fresh(out), "solid_640x360"), "Mask 1");
    const vertices = reparsed.property("ADBE Mask Shape").value.vertices;
    expect(approx(
      vertices.flatMap((point) => point),
      [10.0, 20.0, 0.0, 360.0, 640.0, 360.0, 640.0, 0.0],
      { abs: 1e-4 },
    )).toBe(true);
  });

  test.each(["solid_640x360", "text", "shape"])("test_set_path_is_stored_as_ae_stores_it[%#]", (layer_name) => {
    const tmp_path = make_tmp_path();
    /**
     * Setting a path on a path-less mask writes the Mask Shape AE wrote
     * for the same path: normalized to the source on a solid, in layer
     * pixels on a text or shape layer.
     */
    const project = parse_aep(AEP).project;
    const mask_path = getitem(_masks(project, layer_name), "Mask 1").property("ADBE Mask Shape");
    mask_path.value = new Shape(_PATH);
    const out = tmp_path.div("set.aep");
    project.save(out);
    const masks = _masks(parse_project_fresh(out), layer_name);
    expect(py_eq(_mask_shape_bytes(getitem(masks, "Mask 1")), _mask_shape_bytes(getitem(masks, "stored")))).toBe(true);
  });
});

describe("TestRotoBezierWrites", () => {
  /**
   * Reporting a RotoBezier mask's derived tangents changes nothing that is
   * written (`mask_rotobezier_tensions.aep`).
   */

  const AEP = SAMPLES_DIR.div("mask_rotobezier_tensions.aep");

  /** Static method `_keyed` in the Python class. */
  function _keyed(project: Project): Property<Shape> {
    const comp = get_comp(project, "ROTO");
    for (const layer of comp.layers) {
      for (const m of as_instance(layer.masks, PropertyGroup).properties) {
        if (m.name === "keyed") return as_instance(m, MaskPropertyGroup).property("ADBE Mask Shape");
      }
    }
    throw new StopIteration();
  }

  test("test_reading_derived_tangents_writes_nothing", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(AEP).project;
    const comp = get_comp(project, "ROTO");
    for (const layer of comp.layers) {
      for (const mask of as_instance(layer.masks, PropertyGroup).properties) {
        const mask_path = as_instance(mask, MaskPropertyGroup).property("ADBE Mask Shape");
        for (const time of [0.0, 0.5, 1.0]) {
          const shape = mask_path.value_at_time(time);
          expect(shape.in_tangents.length).toBe(shape.vertices.length);
        }
      }
    }
    const out = tmp_path.div("read.aep");
    project.save(out);
    expect(py_eq(out.read_bytes(), AEP.read_bytes())).toBe(true);
  });

  test("test_interpolated_value_stores_the_blended_stored_handles", () => {
    const tmp_path = make_tmp_path();
    // The first key stores handles on vertex 0 only, the second none.
    // Halfway, the value reports the derived RotoBezier tangents, but
    // writing it back stores half of the stored handles, as before.
    const project = parse_aep(AEP).project;
    const mask_path = _keyed(project);
    const halfway = mask_path.value_at_time(0.5);
    expect(approx(halfway.in_tangents[0], [-15.0, 5.0], { abs: 1e-3 })).toBe(false);
    mask_path.set_value_at_time(0.5, halfway);
    const out = tmp_path.div("keyed.aep");
    project.save(out);
    const reparsed = _keyed(parse_project_fresh(out));
    const value = _next(reparsed.keyframes, (kf) => kf.time === 0.5).value;
    expect(approx(value.vertices[0], [200.0, 150.0], { abs: 1e-3 })).toBe(true);
    expect(approx(value._stored_tangents(-1)[0], [-15.0, 5.0], { abs: 1e-3 })).toBe(true);
    expect(approx(value._stored_tangents(1)[0], [20.0, -10.0], { abs: 1e-3 })).toBe(true);
  });
});

describe("TestSyntheticValuesAreOwned", () => {
  /**
   * Default properties a file leaves out are built from shared spec values;
   * each must own its value, as AE hands out a fresh array on every read.
   */

  const AEP = VERSIONS_DIR.div("ae2025", "complete.aep");

  /** Static method `_audio_levels` in the Python class. */
  function _audio_levels(project: Project, comp_name: string): Property<number[]> {
    const layer = get_layer(project, comp_name);
    return as_instance(layer.property("ADBE Audio Group").property("ADBE Audio Levels"), Property<number[]>);
  }

  function _synthetic(prop: Property): boolean {
    py_assert(prop._tdsb != null);
    return prop._tdsb.synthetic;
  }

  test("test_read_modify_write_touches_one_property", () => {
    const project = parse_project_fresh(AEP);
    const levels = _audio_levels(project, "DropFrame_Comp");
    const other = _audio_levels(project, "HighFPS_Comp");
    py_assert(_synthetic(levels) && _synthetic(other));
    const value = levels.value;
    value[0] = 3.0;
    levels.value = value;
    expect(py_eq(levels.value, [3.0, 0.0])).toBe(true);
    expect(py_eq(other.value, [0.0, 0.0])).toBe(true);
    expect(py_eq(other.default_value, [0.0, 0.0])).toBe(true);
    // Nor does it reach a later parse in the same process.
    const fresh = _audio_levels(parse_project_fresh(AEP), "HighFPS_Comp");
    expect(py_eq(fresh.value, [0.0, 0.0])).toBe(true);
  });

  test("test_item_assignment_writes_the_property", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(AEP);
    const levels = _audio_levels(project, "DropFrame_Comp");
    py_assert(_synthetic(levels));
    levels.value[0] = 3.0;
    expect(py_eq(levels.value, [3.0, 0.0])).toBe(true);
    py_assert(!_synthetic(levels));
    const value = levels.value;
    value[1] += 1.5;
    expect(py_eq(value, [3.0, 1.5])).toBe(true);
    // `levels.value[:] = [4.0, 5.0]`: JS has no slice assignment; assigning
    // the items one by one goes through the same item writes.
    Object.assign(levels.value, [4.0, 5.0]);
    const default_value = levels.default_value;
    py_assert(default_value != null);
    default_value[0] = 3.0;
    expect(py_eq(_audio_levels(project, "HighFPS_Comp").value, [0.0, 0.0])).toBe(true);
    expect(py_eq(_audio_levels(project, "HighFPS_Comp").default_value, [0.0, 0.0])).toBe(true);
    const out = tmp_path.div("levels.aep");
    project.save(out);
    const saved = _audio_levels(parse_project_fresh(out), "DropFrame_Comp");
    expect(py_eq(saved.value, [4.0, 5.0])).toBe(true);
  });

  /** A list read earlier only sets the item it is given. */
  test("test_item_assignment_starts_from_the_current_value", () => {
    const project = parse_project_fresh(AEP);
    const levels = _audio_levels(project, "DropFrame_Comp");
    const stale = levels.value;
    levels.value = [1.0, 2.0];
    stale[0] = 3.0;
    expect(py_eq(levels.value, [3.0, 2.0])).toBe(true);
    expect(py_eq(stale, [3.0, 2.0])).toBe(true);
  });

  /** A 2-D layer reads Position Z as 0 but keeps the stored one. */
  test("test_item_assignment_keeps_a_2d_layers_stored_z", () => {
    const project = parse_project_fresh(AEP);
    const layer = as_instance(get_layer(project, "DropFrame_Comp"), AVLayer);
    expect(layer.three_d_layer).toBe(false);
    const position = layer.property("ADBE Transform Group").property("ADBE Position");
    position.value = [10.0, 20.0, 40.0];
    position.value[0] = 5.0;
    expect(py_eq(position.value, [5.0, 20.0, 0.0])).toBe(true);
    const stored = position._stored_static_value();
    py_assert(Array.isArray(stored));
    expect(stored[2]).toBe(40.0);
  });

  test("test_item_assignment_follows_the_setter_rules", () => {
    const project = parse_project_fresh(AEP);
    const levels = _audio_levels(project, "DropFrame_Comp");
    levels.add_key(0.0);
    raises(
      ValueError,
      () => {
        levels.value[0] = 3.0;
      },
      "keyframes",
    );
  });

  /**
   * A keyframe keeps a copy of the list it is given and hands out a copy:
   * editing either never reaches another property.
   */
  test("test_keyframe_values_are_detached", () => {
    const project = parse_project_fresh(AEP);
    const levels = _audio_levels(project, "DropFrame_Comp");
    const other = _audio_levels(project, "HighFPS_Comp");
    levels.set_value_at_time(0.0, other.value);
    levels.keyframes[0].value[0] = 9.0;
    expect(py_eq(levels.keyframes[0].value, [0.0, 0.0])).toBe(true);
    expect(py_eq(other.value, [0.0, 0.0])).toBe(true);
    py_assert(_synthetic(other));
  });

  test("test_a_kept_value_does_not_keep_its_project", async () => {
    // `del project; gc.collect()`. JSC's collector scans the stack
    // conservatively, so a stale slot can keep a freshly parsed project
    // alive whatever holds it (a bare parse included); a strong reference
    // from the value would keep every attempt alive, so one collected
    // attempt is the proof.
    for (let attempt = 0; attempt < 8; attempt++) {
      const [value, ref] = (() => {
        const project = parse_project_fresh(AEP);
        return [_audio_levels(project, "DropFrame_Comp").value, new WeakRef(project)] as const;
      })();
      for (let i = 0; i < 5 && ref.deref() !== undefined; i++) {
        await Bun.sleep(1);
        Bun.gc(true);
      }
      if (ref.deref() !== undefined) continue;
      value[0] = 3.0; // the property is gone: a plain list
      expect(py_eq(value, [3.0, 0.0])).toBe(true);
      return;
    }
    // Collection is up to the engine (as in `TestInstanceDictSize`, CPython
    // specifics): when none of the attempts is collected there is nothing to
    // observe, which is not a retained reference.
    skip("the garbage collector kept every attempt's project alive");
  });

  test("test_copies_are_plain_lists", () => {
    const project = parse_project_fresh(AEP);
    const levels = _audio_levels(project, "DropFrame_Comp");
    for (const duplicate of [copy(levels.value), deepcopy(levels.value)]) {
      expect(Object.getPrototypeOf(duplicate)).toBe(Array.prototype);
      duplicate[0] = 3.0;
    }
    expect(py_eq(levels.value, [0.0, 0.0])).toBe(true);
    py_assert(_synthetic(levels));
  });
});

class TestTextPathWrite {
  static _text_layer(project: Project): TextLayer {
    const comp = get_comp(project, "type_text");
    const layer = comp.layers.find((ly) => ly.name === "TextLayer");
    return as_instance(layer, TextLayer);
  }

  static _path(layer: TextLayer): Property<number> {
    const text = layer.text;
    py_assert(text != null);
    return text.property("ADBE Text Path Options").property("ADBE Text Path");
  }
}

describe("TestTextPathWrite", () => {
  /**
   * A text layer's Path set to a mask is written as AE 2026 writes it
   * (and reads back py_aep's file): a mask index in a `tdli`.
   */
  test("test_path_set_to_a_mask", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("all_animated.aep"));
    const layer = TestTextPathWrite._text_layer(project);
    py_assert(layer.masks != null);
    as_instance(layer.masks, PropertyGroup).add_property("ADBE Mask Atom");
    TestTextPathWrite._path(layer).value = 1;
    const out = tmp_path.div("text_path.aep");
    project.save(out);

    const path = TestTextPathWrite._path(TestTextPathWrite._text_layer(parse_project_fresh(out)));
    py_assert(path._tdsb != null);
    expect(path._tdsb.synthetic).toBe(false);
    expect(path.property_value_type).toBe(PropertyValueType.MASK_INDEX);
    expect(path.value).toBe(1);
    const tdb4 = path._tdb4;
    expect(
      py_eq(
        [tdb4._spatial_static_flags, tdb4._value_hint_type, tdb4._cvot_flags, tdb4._type_flags, tdb4._property_category],
        [0x01, 1, 0x00, 0x04, 0x04],
      ),
    ).toBe(true);
  });

  /**
   * AE 2026 refuses a mask the layer lacks ("Value 2 out of range 0 to 1")
   * and -1 / 1.6 / true ("is not an unsigned integer").
   */
  test("test_path_value_is_validated", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("all_animated.aep"));
    const layer = TestTextPathWrite._text_layer(project);
    py_assert(layer.masks != null);
    as_instance(layer.masks, PropertyGroup).add_property("ADBE Mask Atom");
    const path = TestTextPathWrite._path(layer);
    const bad_values: unknown[] = [2, -1, 1.6, true, "1"];
    for (const bad of bad_values) {
      // `pytest.raises((TypeError, ValueError))`; the untyped values go
      // through the setter as Python's dynamic ones do.
      const e = raises(Error, () => Reflect.set(path, "value", bad));
      py_assert(e instanceof TypeError_ || e instanceof ValueError);
    }
    path.value = 0;
    expect(path.value).toBe(0);
  });
});

describe("TestMaskReferences", () => {
  /**
   * A text Path or an effect's mask parameter stores the id (`mkif`) of
   * the mask it names in a `tdli`, so it follows the mask (AE 2026).
   */

  /** Static method `_text_path` in the Python class. */
  function _text_path(project: Project): [TextLayer, Property<number>] {
    const layer = TestTextPathWrite._text_layer(project);
    return [layer, TestTextPathWrite._path(layer)];
  }

  /** Static method `_fill_mask` in the Python class. */
  function _fill_mask(project: Project): [AVLayer, Property] {
    const layer = as_instance(
      get_comp(project, "coverage").layers.find((ly) => ly.name === "normal"),
      AVLayer,
    );
    py_assert(layer.effects != null);
    const fill = as_instance(as_instance(layer.effects, PropertyGroup).property("ADBE Fill"), PropertyGroup);
    return [layer, as_instance(fill.property("ADBE Fill-0001"), Property)];
  }

  function _masks(layer: Layer): PropertyGroup {
    py_assert(layer.masks != null);
    return layer.masks;
  }

  /** AE moved the Fill Mask's mask (id 2) first and kept the id. */
  test("test_reads_the_moved_mask_position", () => {
    const [layer, fill_mask] = _fill_mask(parse_project_fresh(SAMPLES_DIR.div("mask_reference_moved.aep")));
    const masks = _masks(layer).properties;
    expect(masks.map((m) => as_instance(m, MaskPropertyGroup)._mkif.mask_id)).toEqual([2, 1]);
    expect(fill_mask._tdli_chunk()?.value).toBe(2);
    expect(fill_mask.value).toBe(1);
  });

  test("test_follows_a_moved_mask", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("mask_reference_moved.aep"));
    const [layer, fill_mask] = _fill_mask(project);
    const masks = _masks(layer);
    masks.properties[0].move_to(1);
    expect(fill_mask.value).toBe(2);
    const out = tmp_path.div("moved.aep");
    project.save(out);
    expect(_fill_mask(parse_project_fresh(out))[1].value).toBe(2);
  });

  test("test_follows_masks_removed_or_duplicated_around_it", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("all_animated.aep"));
    const [layer, path] = _text_path(project);
    const masks = _masks(layer);
    for (let i = 0; i < 3; i++) masks.add_property("ADBE Mask Atom");
    path.value = 2;
    masks.properties[0].duplicate(); // the copy goes before the path's
    expect(path.value).toBe(3);
    masks.properties[2].duplicate(); // a copy of the path's mask, after it
    expect(path.value).toBe(3);
    masks.properties[0].remove();
    expect(path.value).toBe(2);
    masks.properties[3].remove();
    expect(path.value).toBe(2);
  });

  /**
   * AE 2026 leaves the reset reference out of the file, and a mask that
   * later takes the removed mask's id is not picked up.
   */
  test("test_removing_the_named_mask_resets_it", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("all_animated.aep"));
    const [layer, path] = _text_path(project);
    const masks = _masks(layer);
    masks.add_property("ADBE Mask Atom");
    masks.add_property("ADBE Mask Atom");
    path.value = 2;
    masks.properties[1].remove();
    expect(path.value).toBe(0);
    py_assert(path._tdsb != null);
    expect(path._tdsb.synthetic).toBe(true);
    masks.add_property("ADBE Mask Atom"); // takes id 2 again
    expect(path.value).toBe(0);
    const out = tmp_path.div("reset.aep");
    project.save(out);
    expect(_text_path(parse_project_fresh(out))[1].value).toBe(0);
  });
});

describe("TestRoundedControls", () => {
  /**
   * AE 2026 stores a checkbox or popup value as given and reports it
   * rounded half up, statically and on keys.
   */

  function _dims(project: Project): Property {
    const effects = get_first_layer(project).effects;
    py_assert(effects != null);
    const blur = as_instance(effects.properties[0], PropertyGroup);
    return as_instance(blur.property("ADBE Gaussian Blur 2-0002"), Property);
  }

  test("test_popup_value_reported_rounded", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("2_gaussian.aep"));
    const dims = _dims(project);
    for (const [written, reported] of [
      [1.4, 1],
      [1.5, 2],
      [2.5, 3],
    ]) {
      dims.value = written;
      expect(dims.value).toBe(reported);
    }
    const out = tmp_path.div("rounded.aep");
    project.save(out);
    const saved = _dims(parse_project_fresh(out));
    expect(saved._read_cdat_raw()).toBe(2.5);
    expect(saved.value).toBe(3);
  });

  /** A shape's Star Points infers a BOOLEAN control type, yet 5.5 reports 5.5. */
  test("test_non_effect_scalar_not_rounded", () => {
    const project = parse_project_fresh(LAYER_SAMPLES_DIR.div("shape_source_rect.aep"));
    const layer = get_comp(project, "SHAPE_RECTS").layers.find((ly) => ly.name === "ps_k2_p5.5_r50");
    py_assert(layer != null);
    const points = [...layer._leaf_properties()].find((p) => p.match_name === "ADBE Vector Star Points");
    py_assert(points != null);
    expect(points.value).toBe(5.5);
  });
});

describe("TestEffectPointBasis", () => {
  /**
   * Effect points are stored normalized to the layer (the comp for an
   * adjustment layer), and AE 2026 re-reads values and pard defaults
   * against the current basis.
   */

  /** Static method `_layer` in the Python class. */
  function _layer(project: Project): AVLayer {
    return as_instance(
      get_comp(project, "coverage").layers.find((ly) => ly.name === "normal"),
      AVLayer,
    );
  }

  /** Static method `_point` in the Python class. */
  function _point(layer: AVLayer): Property {
    py_assert(layer.effects != null);
    const effect = as_instance(as_instance(layer.effects, PropertyGroup).property("ADBE Point Control"), PropertyGroup);
    return as_instance(effect.property("ADBE Point Control-0001"), Property);
  }

  test("test_untouched_point_follows_an_adjustment_toggle", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLES_DIR.div("effect_point_adjustment.aep"));
    const layer = _layer(project);
    py_assert(layer.effects != null);
    as_instance(layer.effects, PropertyGroup).add_property("ADBE Point Control");
    const point = _point(layer);
    // A 200 x 100 solid in a 1920 x 1080 comp.
    expect(py_eq(point.value, point.default_value) && py_eq(point.default_value, [100.0, 50.0])).toBe(true);
    layer.adjustment_layer = true;
    expect(py_eq(point.value, point.default_value) && py_eq(point.default_value, [960.0, 540.0])).toBe(true);
    expect(point.is_modified).toBe(false);
    const out = tmp_path.div("toggled.aep");
    project.save(out);
    expect(py_eq(_point(_layer(parse_project_fresh(out))).value, [960.0, 540.0])).toBe(true);
  });

  test("test_written_point_follows_a_resize", () => {
    const project = parse_project_fresh(SAMPLES_DIR.div("effect_point_adjustment.aep"));
    const layer = _layer(project);
    py_assert(layer.effects != null);
    as_instance(layer.effects, PropertyGroup).add_property("ADBE Point Control");
    const point = _point(layer);
    point.value = [30.0, 40.0];
    const source = as_instance(layer.source, FootageItem);
    source.replace_with_solid([1.0, 0.0, 0.0], "wide", 400, 100);
    expect(py_eq(point.value, [60.0, 40.0])).toBe(true);
    expect(py_eq(point.default_value, [200.0, 50.0])).toBe(true);
  });
});

describe("TestAudioLayerMasks", () => {
  /**
   * An audio-only layer's mask space is 0 x 0: AE 2026 reports its default
   * path as four points at the origin and hangs writing one.
   */

  /** Static method `_mask_path` in the Python class. */
  function _mask_path(project: Project): Property<Shape> {
    const layer = get_layer(project, "audioEnabled_true");
    py_assert(layer.masks != null);
    const mask = as_instance(layer.masks, PropertyGroup).add_property("ADBE Mask Atom");
    return mask.property("ADBE Mask Shape");
  }

  test("test_value_write_refused", () => {
    const path = _mask_path(parse_project_fresh(LAYER_SAMPLES_DIR.div("audioEnabled.aep")));
    expect(path.value.vertices).toEqual([
      [0.0, 0.0],
      [0.0, 0.0],
      [0.0, 0.0],
      [0.0, 0.0],
    ]);
    raises(
      ValueError,
      () => {
        path.value = new Shape([
          [0, 0],
          [0, 10],
          [10, 10],
          [10, 0],
        ]);
      },
      "audio-only",
    );
  });

  /** AE 2026 opens py_aep's file and reads the same. */
  test("test_expression_write_saves", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(LAYER_SAMPLES_DIR.div("audioEnabled.aep"));
    _mask_path(project).expression = "value";
    const out = tmp_path.div("audio_mask.aep");
    project.save(out);
    const layer = get_layer(parse_project_fresh(out), "audioEnabled_true");
    py_assert(layer.masks != null);
    const path = as_instance(as_instance(as_instance(layer.masks, PropertyGroup).properties[0], MaskPropertyGroup).property("ADBE Mask Shape"), Property);
    expect(path.expression).toBe("value");
    const value = as_instance(path.value, Shape);
    expect(value.vertices).toEqual([
      [0.0, 0.0],
      [0.0, 0.0],
      [0.0, 0.0],
      [0.0, 0.0],
    ]);
    expect(value.closed).toBe(true);
  });
});
