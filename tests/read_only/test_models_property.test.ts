/** Tests for Property model parsing with strengthened assertions. */

import { describe, expect, test } from "bun:test";
import { approx, skip, fail } from "../../src/pyrt/pytest.ts";
import {
  AssertionError_,
  IndexError,
  Path,
  StopIteration,
  float,
  getattr,
  getitem,
  int,
  len,
  py_and,
  py_assert,
  py_bool,
  py_eq,
  py_or,
  range,
  repr,
  setdefault,
  sorted,
  str,
  zip,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { get_comp, get_comp_from_json_by_name, get_first_layer, get_layer, load_expected, parse_project } from "../conftest.ts";
import { as_instance } from "../helpers.ts";
import { Project, parse as parse_aep, type Application } from "../../src/py_aep/index.ts";
import { KeyframeInterpolationType, MaskFeatherFalloff, MaskMode, MaskMotionBlur, PropertyType, PropertyValueType } from "../../src/py_aep/enums/index.ts";
import { AVLayer, MaskPropertyGroup, Property, PropertyGroup, Shape } from "../../src/py_aep/models/index.ts";
import type { CompItem, Layer } from "../../src/py_aep/models/index.ts";

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `json.loads` becomes `JSON.parse` (plain objects).

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");
const BUGS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "bugs");
// Python assigns LAYER_SAMPLES_DIR twice with the same value; a TS const cannot repeat.
const LAYER_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const VERSIONS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");
const PROPERTY_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");
const CANVARY_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "debug", "canvary");

/** Find a property in the layer's transform by match_name. */
function _find_property(layer: Layer, match_name: string): Property | null {
  for (const prop of layer.transform) {
    if (prop.match_name === match_name) {
      return prop as Property;
    }
  }
  return null;
}

/** Extract transform properties from the expected JSON structure. */
// NOTE(port): load_expected returns JSON.parse output (plain objects, tests/helpers.ts), so
// `.get(...)` is property access and `"k" in x` is unchanged; missing keys compare unequal as in Python.
function _get_json_transform_properties(expected: any, comp_name = ""): any[] {
  for (const item of expected["items"]) {
    if ("layers" in item) {
      if (py_bool(comp_name) && item["name"] !== comp_name) {
        continue;
      }
      for (const group of item["layers"][0]["properties"]) {
        if (group["matchName"] === "ADBE Transform Group") {
          return group["properties"];
        }
      }
    }
  }
  return [];
}

/**
 * Map each property match name in an ExtendScript export to its value
 * (the first occurrence wins).
 */
// NOTE(port): walks plain JSON objects (see _get_json_transform_properties).
function _json_values_by_match_name(expected: any): Map<string, any> {
  const values = new Map<string, any>();

  const walk = (node: any): void => {
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
      if (node["propertyType"] === "Property" && "matchName" in node) {
        setdefault(values, node["matchName"], node["value"] ?? null);
      }
      for (const child of Object.values(node)) {
        walk(child);
      }
    } else if (Array.isArray(node)) {
      for (const child of node) {
        walk(child);
      }
    }
  };

  walk(expected);
  return values;
}

/** Return the `ADBE Mask Shape` property from the first mask. */
function _get_mask_shape(layer: Layer): Property<Shape> {
  expect(layer.masks).not.toBeNull();
  if (layer.masks === null) throw new AssertionError_("layer.masks is None");
  const mask = layer.masks.properties[0] as MaskPropertyGroup;
  for (const prop of mask.properties) {
    if (prop.match_name === "ADBE Mask Shape") {
      return prop as Property;
    }
  }
  throw new AssertionError_("ADBE Mask Shape not found");
}

describe("TestExpressions", () => {
  /** Position has expression 'wiggle(2, 50)' and is enabled. */
  test("test_expression_enabled", () => {
    const expected = load_expected(SAMPLES_DIR, "expression");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("expression.aep")), "expression_enabled");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    expect(position.expression_enabled).toBe(true);
    expect(position.expression).toBe("wiggle(2, 50)");
    // Verify against JSON
    for (const prop of _get_json_transform_properties(expected, "expression_enabled")) {
      if (prop["matchName"] === "ADBE Position") {
        expect(prop["expressionEnabled"]).toBe(true);
        expect(prop["expression"]).toBe("wiggle(2, 50)");
      }
    }
  });

  /** Opacity has expression '50' but expression is disabled. */
  test("test_expression_disabled", () => {
    const expected = load_expected(SAMPLES_DIR, "expression");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("expression.aep")), "expression_disabled");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(opacity.expression_enabled).toBe(false);
    expect(opacity.expression).toBe("50");
    // Value should be the static value, not the expression result
    for (const prop of _get_json_transform_properties(expected, "expression_disabled")) {
      if (prop["matchName"] === "ADBE Opacity") {
        expect(prop["expressionEnabled"]).toBe(false);
        expect(prop["expression"]).toBe("50");
        expect(prop["value"]).toBe(100);
      }
    }
  });

  /** Rotation has expression 'time * 36' and is enabled. */
  test("test_expression_time", () => {
    const expected = load_expected(SAMPLES_DIR, "expression");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("expression.aep")), "expression_time");
    const rotation = _find_property(layer, "ADBE Rotate Z");
    expect(rotation).not.toBeNull();
    if (rotation === null) throw new AssertionError_("rotation is None");
    expect(rotation.expression_enabled).toBe(true);
    expect(rotation.expression).toBe("time * 36");
    // Verify against JSON
    for (const prop of _get_json_transform_properties(expected, "expression_time")) {
      if (prop["matchName"] === "ADBE Rotate Z") {
        expect(prop["expressionEnabled"]).toBe(true);
        expect(prop["expression"]).toBe("time * 36");
      }
    }
  });
});

describe("TestKeyframeLabel", () => {
  /** Keyframe labels as After Effects stored them. */

  /**
   * AE 2026 `setLabelAtKey(1, 5, 16)` on the first three Opacity keys
   * of keyframe_bezier_multi_ease_1D.aep, saved as keyframe_labels.aep.
   */
  test("test_labels_set_by_after_effects", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_labels.aep")), "TestComp");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(py_eq(opacity.keyframes.map((kf) => int(kf.label)), [1, 5, 16, 0, 0])).toBe(true);
  });
});

describe("TestKeyframes", () => {
  /** Tests for keyframe interpolation types. */

  /** Position has 2 LINEAR keyframes with values [0,50,0] and [100,50,0]. */
  test("test_keyframe_LINEAR", () => {
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("keyframe_interpolation.aep")),
      "keyframe_LINEAR",
    );
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    expect(position._animated).toBe(true);
    expect(len(position.keyframes)).toBe(2);
    for (const kf of position.keyframes) {
      expect(kf.out_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
    }
    expect(py_eq(position.keyframes[0].value, [0.0, 50.0, 0.0])).toBe(true);
    expect(py_eq(position.keyframes[1].value, [100.0, 50.0, 0.0])).toBe(true);
  });

  /** Position has 2 BEZIER keyframes with values [0,50,0] and [100,50,0]. */
  test("test_keyframe_BEZIER", () => {
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("keyframe_interpolation.aep")),
      "keyframe_BEZIER",
    );
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    expect(position._animated).toBe(true);
    expect(len(position.keyframes)).toBe(2);
    for (const kf of position.keyframes) {
      expect(kf.out_interpolation_type).toBe(KeyframeInterpolationType.BEZIER);
    }
    expect(py_eq(position.keyframes[0].value, [0.0, 50.0, 0.0])).toBe(true);
    expect(py_eq(position.keyframes[1].value, [100.0, 50.0, 0.0])).toBe(true);
  });

  /** Opacity has 3 keyframes, second is HOLD, values 1.0/0.0/1.0. */
  test("test_keyframe_HOLD", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_HOLD");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(opacity._animated).toBe(true);
    expect(len(opacity.keyframes)).toBe(3);
    // Keyframe 2 (index 1) is HOLD
    expect(opacity.keyframes[1].out_interpolation_type).toBe(KeyframeInterpolationType.HOLD);
    expect(opacity.keyframes[0].value).toBe(100.0);
    expect(opacity.keyframes[1].value).toBe(0.0);
    expect(opacity.keyframes[2].value).toBe(100.0);
  });
});

describe("TestPropertyStructure", () => {
  /** Tests for property structural attributes (depth, index, is_time_varying). */

  /** Transform properties are at depth 2 (layer=0, transform-group=1, prop=2). */
  test("test_transform_properties_depth", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    // All transform properties should be at depth 2
    for (const prop of layer.transform.properties) {
      py_assert(prop.property_depth === 2, `${prop.match_name} has depth ${prop.property_depth}, expected 2`);
    }
  });

  /** Effects (PropertyGroup) are at depth 2; their properties at depth 3. */
  test("test_effect_depth", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("effects.aep")), "effect_2dPoint");
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    expect(len(layer.effects.properties) > 0).toBe(true);
    const effect = layer.effects.properties[0] as PropertyGroup;
    expect(effect.property_depth).toBe(2);
    for (const prop of effect.properties) {
      py_assert(prop.property_depth === 3, `${prop.match_name} has depth ${prop.property_depth}, expected 3`);
    }
  });

  /** Opacity with keyframes has is_time_varying == True. */
  test("test_is_time_varying_with_keyframes", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(opacity.is_time_varying).toBe(true);
  });

  /** Position with enabled expression has is_time_varying == True. */
  test("test_is_time_varying_with_expression", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("expression.aep")), "expression_enabled");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    expect(position.is_time_varying).toBe(true);
  });

  /** A non-animated property with no actual expression has is_time_varying == False. */
  test("test_is_time_varying_static", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_rotation");
    // Only ADBE Rotate Z is animated; ADBE Rotate X is static
    const rotate_x = _find_property(layer, "ADBE Rotate X");
    expect(rotate_x).not.toBeNull();
    if (rotate_x === null) throw new AssertionError_("rotate_x is None");
    expect(py_bool(rotate_x._animated)).toBe(false);
    expect(rotate_x.is_time_varying).toBe(false);
  });
});

describe("TestPropertyDimensions", () => {
  /** Tests for property value types and dimensions. */

  /** Opacity is a 1D property with 2 keyframes going 0>100. */
  test("test_property_1D_opacity", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(opacity.dimensions).toBe(1);
    expect(opacity._animated).toBe(true);
    expect(len(opacity.keyframes)).toBe(2);
  });

  /** Position in a 2D layer has 2 keyframes. */
  test("test_property_2D_position", () => {
    const expected = load_expected(SAMPLES_DIR, "property_types");
    const project = parse_project(SAMPLES_DIR.div("property_types.aep"));
    const layer = get_layer(project, "property_2D_position");
    // Verify the layer is not 3D
    const comp_json = get_comp_from_json_by_name(expected, "property_2D_position");
    expect(comp_json["layers"][0]["threeDLayer"]).toBe(false);
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    expect(position._animated).toBe(true);
    expect(len(position.keyframes)).toBe(2);
  });

  /** Position in a 3D layer has 3 dimensions and 2 keyframes. */
  test("test_property_3D_position", () => {
    const expected = load_expected(SAMPLES_DIR, "property_types");
    const project = parse_project(SAMPLES_DIR.div("property_types.aep"));
    const layer = get_layer(project, "property_3D_position");
    // Verify the layer is 3D
    const comp_json = get_comp_from_json_by_name(expected, "property_3D_position");
    expect(comp_json["layers"][0]["threeDLayer"]).toBe(true);
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    expect(position._animated).toBe(true);
    expect(len(position.keyframes)).toBe(2);
  });

  /** Rotation is a 1D property with 2 keyframes going 0>360. */
  test("test_property_rotation", () => {
    const expected = load_expected(SAMPLES_DIR, "property_types");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_rotation");
    const rotation = _find_property(layer, "ADBE Rotate Z");
    expect(rotation).not.toBeNull();
    if (rotation === null) throw new AssertionError_("rotation is None");
    expect(rotation.dimensions).toBe(1);
    expect(rotation._animated).toBe(true);
    expect(len(rotation.keyframes)).toBe(2);
    // Verify against JSON
    for (const prop of _get_json_transform_properties(expected, "property_rotation")) {
      if (prop["matchName"] === "ADBE Rotate Z") {
        expect(prop["numKeys"]).toBe(2);
      }
    }
  });

  /** Scale has 2 keyframes. */
  test("test_property_scale", () => {
    const expected = load_expected(SAMPLES_DIR, "property_types");
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_scale");
    const scale = _find_property(layer, "ADBE Scale");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError_("scale is None");
    expect(scale._animated).toBe(true);
    expect(len(scale.keyframes)).toBe(2);
    // Verify against JSON
    for (const prop of _get_json_transform_properties(expected, "property_scale")) {
      if (prop["matchName"] === "ADBE Scale") {
        expect(prop["numKeys"]).toBe(2);
      }
    }
  });

  /**
   * Scale is 3-D even on a 2-D layer, so nothing pads it.
   *
   * Probed on AE 2026: a 2-D layer's Scale reports three components
   * and `ThreeD` exactly like a 3-D layer's, and even
   * `setValue([50, 50])` stores `[50, 50, 100]`. Synthesis used to
   * carry a 2-to-3 padding branch for this; it never ran on any of
   * the 12721 Scale properties in samples/, and it is gone.
   */
  test("test_scale_is_always_three_dimensional", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_scale");
    const scale = _find_property(layer, "ADBE Scale");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError_("scale is None");
    expect(scale.dimensions).toBe(3);
    expect(scale.property_value_type).toBe(PropertyValueType.ThreeD);
    for (const keyframe of scale.keyframes) {
      expect(Array.isArray(keyframe.value)).toBe(true);
      expect(len(keyframe.value)).toBe(3);
    }
  });
});

describe("TestOrientation", () => {
  /**
   * Tests for orientation property parsing (OTST chunks).
   *
   * Orientation is stored in a special OTST chunk whose cdat uses
   * little-endian doubles (unlike the rest of the big-endian RIFX file).
   */

  /** Default orientation [0, 0, 0] when no OTST chunk is present. */
  test("test_orientation_default", () => {
    const layer = get_first_layer(parse_project(LAYER_SAMPLES_DIR.div("orientation_0.aep")));
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(py_eq(orientation.value, [0.0, 0.0, 0.0])).toBe(true);
    expect(orientation.dimensions).toBe(3);
  });

  /** Orientation with only X component set to 5. */
  test("test_orientation_x_only", () => {
    const layer = get_first_layer(parse_project(LAYER_SAMPLES_DIR.div("orientation_5_0_0.aep")));
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(py_eq(orientation.value, [5.0, 0.0, 0.0])).toBe(true);
    expect(orientation.dimensions).toBe(3);
    expect(orientation.is_spatial).toBe(true);
  });

  /** Orientation with only Y component set to 279. */
  test("test_orientation_y_only", () => {
    const layer = get_first_layer(parse_project(LAYER_SAMPLES_DIR.div("orientation_0_279_0.aep")));
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(py_eq(orientation.value, [0.0, 279.0, 0.0])).toBe(true);
    expect(orientation.dimensions).toBe(3);
  });

  /** Orientation with only Z component set to 5. */
  test("test_orientation_z_only", () => {
    const layer = get_first_layer(parse_project(LAYER_SAMPLES_DIR.div("orientation_0_0_5.aep")));
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(py_eq(orientation.value, [0.0, 0.0, 5.0])).toBe(true);
    expect(orientation.dimensions).toBe(3);
  });

  /** Orientation has correct property metadata. */
  test("test_orientation_metadata", () => {
    const layer = get_first_layer(parse_project(LAYER_SAMPLES_DIR.div("orientation_5_0_0.aep")));
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(orientation.name).toBe("Orientation");
    expect(orientation.match_name).toBe("ADBE Orientation");
    expect(orientation.is_spatial).toBe(true);
    expect(orientation._vector).toBe(true);
    expect(py_bool(orientation._animated)).toBe(false);
  });

  /** Animated orientation keyframes carry 3-component values from otda. */
  test("test_orientation_animated_keyframe_values", () => {
    const layer = get_first_layer(parse_project(LAYER_SAMPLES_DIR.div("orientation_with_keyframes.aep")));
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(orientation._animated).toBe(true);
    expect(len(orientation.keyframes)).toBe(2);
    expect(py_eq(orientation.keyframes[0].value, [5.0, 0.0, 0.0])).toBe(true);
    expect(py_eq(orientation.keyframes[1].value, [0.0, 0.0, 0.0])).toBe(true);
  });

  /** Animated orientation keyframes have correct frame times. */
  test("test_orientation_animated_keyframe_times", () => {
    const layer = get_first_layer(parse_project(LAYER_SAMPLES_DIR.div("orientation_with_keyframes.aep")));
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(orientation.keyframes[0].frame_time).toBe(0);
    expect(orientation.keyframes[1].frame_time).toBe(240);
  });

  /** Animated orientation retains correct property metadata. */
  test("test_orientation_animated_metadata", () => {
    const layer = get_first_layer(parse_project(LAYER_SAMPLES_DIR.div("orientation_with_keyframes.aep")));
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(orientation.dimensions).toBe(3);
    expect(orientation.is_spatial).toBe(true);
    expect(orientation._vector).toBe(true);
    expect(py_eq(orientation.value, [5.0, 0.0, 0.0])).toBe(true);
  });
});

describe("TestEffectProperties", () => {
  /** Tests for effect-related property samples. */

  test("test_effect_2dPoint", () => {
    const project = parse_project(SAMPLES_DIR.div("effects.aep"));
    const comp = get_comp(project, "effect_2dPoint");
    expect(project instanceof Project).toBe(true);
    expect(len(comp.layers) >= 1).toBe(true);
  });

  test("test_effect_3dPoint", () => {
    const project = parse_project(SAMPLES_DIR.div("effects.aep"));
    const comp = get_comp(project, "effect_3dPoint");
    expect(project instanceof Project).toBe(true);
    expect(len(comp.layers) >= 1).toBe(true);
  });

  test("test_effect_puppet", () => {
    const project = parse_project(SAMPLES_DIR.div("effects.aep"));
    const comp = get_comp(project, "effect_puppet");
    expect(project instanceof Project).toBe(true);
    expect(len(comp.layers) >= 1).toBe(true);
  });

  /**
   * Two Gaussian Blur effects on the same layer are both parsed.
   *
   * When the same effect type is applied more than once, only the first
   * instance carries a `parT` chunk at layer level. The parser falls
   * back to project-level EfdG definitions for subsequent instances.
   */
  test("test_duplicate_effects", () => {
    const project = parse_project(SAMPLES_DIR.div("2_gaussian.aep"));
    const layer = get_first_layer(project);
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    expect(len(layer.effects.properties)).toBe(2);
    for (const effect of layer.effects as Iterable<PropertyGroup>) {
      expect(effect.match_name).toBe("ADBE Gaussian Blur 2");
      expect(effect.is_effect).toBe(true);
    }
    // Second effect should have a user-defined name
    expect(layer.effects.properties[0].name).toBe("Gaussian Blur");
    expect(layer.effects.properties[1].name).toBe("Gaussian Blur 2");
  });

  /** Gaussian Blur effects with non-default Blurriness values 20 and 30. */
  test("test_duplicate_effects_values", () => {
    const project = parse_project(SAMPLES_DIR.div("2_gaussian_20_30.aep"));
    const layer = get_first_layer(project);
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    expect(len(layer.effects.properties)).toBe(2);

    // Each effect should have a Blurriness property with modified value
    const effect_0 = layer.effects.properties[0] as PropertyGroup;
    let blurriness_0: Property | null = null;
    for (const prop of effect_0.properties) {
      if (prop.match_name === "ADBE Gaussian Blur 2-0001") {
        blurriness_0 = prop as Property;
        break;
      }
    }
    expect(blurriness_0).not.toBeNull();
    if (blurriness_0 === null) throw new AssertionError_("blurriness_0 is None");
    expect(blurriness_0.value).toBe(20.0);

    const effect_1 = layer.effects.properties[1] as PropertyGroup;
    let blurriness_1: Property | null = null;
    for (const prop of effect_1.properties) {
      if (prop.match_name === "ADBE Gaussian Blur 2-0001") {
        blurriness_1 = prop as Property;
        break;
      }
    }
    expect(blurriness_1).not.toBeNull();
    if (blurriness_1 === null) throw new AssertionError_("blurriness_1 is None");
    expect(blurriness_1.value).toBe(30.0);
  });

  /**
   * LAYER_INDEX effect property reads layer index from tdpi chunk.
   *
   * The S_BlurDirectional effect's "Matte from Layer" parameter has
   * property_value_type LAYER_INDEX. When no layer is selected the
   * value is 0.
   */
  test("test_layer_index_value", () => {
    const project = parse_project(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
    // Find the S_BlurDirectional effect in any composition
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        if (layer.effects == null) {
          continue;
        }
        for (const effect of layer.effects as Iterable<PropertyGroup>) {
          if (effect.name === "S_BlurDirectional") {
            for (const prop of effect.properties) {
              if (prop.name === "Matte from Layer") {
                expect(as_instance(prop, Property).property_value_type).toBe(PropertyValueType.LAYER_INDEX);
                expect(as_instance(prop, Property).value).toBe(0);
                return;
              }
            }
          }
        }
      }
    }
    fail("S_BlurDirectional 'Matte from Layer' property not found");
  });

  /**
   * A popup parameter absent from the effect instance holds the pard
   * default (s2 at 0x3E), not the cached value at 0x38: S_BlurDirectional
   * Edge Mode / Opacity cache 1 but default to 3 / 2, which is what
   * ExtendScript reports.
   */
  test("test_omitted_popup_takes_pard_default", () => {
    const project = parse_project(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
    const expected = load_expected(BUGS_DIR, "29.97_fps_time_scale_3.125");
    const json_values = _json_values_by_match_name(expected);
    let checked = 0;
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        if (layer.effects == null) {
          continue;
        }
        for (const effect of layer.effects as Iterable<PropertyGroup>) {
          if (effect.match_name !== "S_BlurDirectional") {
            continue;
          }
          for (const match_name of ["S_BlurDirectional-0063", "S_BlurDirectional-0068"]) {
            const prop = as_instance(effect.__getitem__(match_name), Property);
            expect(py_eq(prop.value, getitem(json_values, match_name))).toBe(true);
            expect(prop.is_modified).toBe(false);
            checked += 1;
          }
        }
      }
    }
    expect(getitem(json_values, "S_BlurDirectional-0063")).toBe(3);
    expect(getitem(json_values, "S_BlurDirectional-0068")).toBe(2);
    expect(py_bool(checked)).toBe(true);
  });

  /**
   * An omitted point parameter is its pard default percentage of the
   * layer size: Path Text's 80 % x 50 % on a 100 x 100 layer reports
   * exactly [80, 50] in ExtendScript, not the cached 16.16 fraction
   * (0.79998779 x 100).
   */
  // skipif: samples/debug is not committed
  test.skipIf(!CANVARY_DIR.is_dir())("test_omitted_point_takes_pard_default", () => {
    const project = parse_project(CANVARY_DIR.div("effects_canvary.aep"));
    const expected = load_expected(CANVARY_DIR, "effects_canvary");
    expect(py_eq(getitem(_json_values_by_match_name(expected), "ADBE Path Text-0020"), [80, 50])).toBe(true);
    const layer = get_layer(project, "type_null");
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    const prop = as_instance(
      (layer.effects.__getitem__("ADBE Path Text") as PropertyGroup).__getitem__("ADBE Path Text-0020"),
      Property,
    );
    expect(py_eq(prop.value, [80.0, 50.0])).toBe(true);
    expect(prop.is_modified).toBe(false);
  });

  /**
   * MASK_INDEX effect property reads mask index from tdli chunk.
   *
   * The S_BlurDirectional effect's "Matte from Path" parameter has
   * property_value_type MASK_INDEX.  Value 1 means mask #1.
   */
  test("test_mask_index_value", () => {
    const project = parse_project(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        if (layer.effects == null) {
          continue;
        }
        for (const effect of layer.effects as Iterable<PropertyGroup>) {
          if (effect.name === "S_BlurDirectional") {
            for (const prop of effect.properties) {
              if (prop.name === "Matte from Path") {
                expect(as_instance(prop, Property).property_value_type).toBe(PropertyValueType.MASK_INDEX);
                expect(as_instance(prop, Property).value).toBe(1);
                return;
              }
            }
          }
        }
      }
    }
    fail("S_BlurDirectional 'Matte from Path' property not found");
  });

  /**
   * A parameter the effect does not store reads its pard default.
   *
   * The parT caches stale values for these popups (Edge Mode 1) and
   * sliders (Bias, Blur Red, Brightness, Mocha Opacity, Resize Rel X:
   * 0): AE 2026 reports their defaults, unmodified.
   */
  test.each([
    ["S_BlurDirectional-0063", 3],
    ["S_BlurDirectional-0068", 2],
    ["S_BlurDirectional-0053", 0.5],
    ["S_BlurDirectional-0054", 1],
    ["S_BlurDirectional-0060", 1],
    ["S_BlurDirectional-0522", 1],
    ["S_BlurDirectional-0525", 1],
  ])("test_param_absent_from_tdgp_is_at_its_default[%#]", (match_name: string, expected: number) => {
    const project = parse_project(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        for (const effect of py_or(layer.effects, [])) {
          if (effect.match_name !== "S_BlurDirectional") {
            continue;
          }
          const prop = as_instance(effect, PropertyGroup).__getitem__(match_name);
          expect(prop instanceof Property).toBe(true);
          if (!(prop instanceof Property)) throw new AssertionError_("prop is not a Property");
          expect(prop.value).toBe(expected);
          expect(prop.default_value).toBe(expected);
          expect(prop.is_modified).toBe(false);
          return;
        }
      }
    }
    fail("S_BlurDirectional not found");
  });
});

describe("TestMasks", () => {
  /** Tests for mask property groups. */

  /** Layer with one mask: Mask Parade has is_mask=False, atom has is_mask=True. */
  test("test_is_mask_true_single", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    expect(layer.masks.is_mask).toBe(false);
    expect(layer.masks.match_name).toBe("ADBE Mask Parade");
    expect(layer.masks.property_type).toBe(PropertyType.INDEXED_GROUP);
    expect(len(layer.masks.properties)).toBe(1);
    expect(layer.masks.properties[0].is_mask).toBe(true);
  });

  /** Layer with two masks: Mask Parade has is_mask=False, atoms have is_mask=True. */
  test("test_is_mask_multiple", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("mask.aep")), "is_mask_multiple");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    expect(layer.masks.is_mask).toBe(false);
    expect(len(layer.masks.properties)).toBe(2);
    for (const mask of layer.masks.properties) {
      expect(mask.is_mask).toBe(true);
    }
  });

  /** Mask vertices match ExtendScript on a solid, a shape and a text layer.
   *
   * A 200x100 solid keeps its masks in pixels from its top-left corner;
   * shape and text layers have no source and keep theirs in pixels around
   * the layer origin, although both report the comp's 640x360 as their
   * size - scaling their masks by it multiplied every point by the comp.
   */
  test.each([
    ["solid", [[10, 20], [70, 20], [70, 60], [10, 60]]],
    ["shape", [[-50, -30], [50, -30], [50, 30], [-50, 30]]],
    ["text", [[-40, -25], [40, -25], [40, 25], [-40, 25]]],
  ])("test_mask_vertices_on_each_layer_kind[%#]", (layer_name: string, expected: number[][]) => {
    const project = parse_project(SAMPLES_DIR.div("mask_shape_and_text_layers.aep"));
    const comp = get_comp(project, "masks_on_layer_kinds");
    const layer = comp.layers.find((layer) => layer.name === layer_name);
    if (layer === undefined) throw new StopIteration();
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    const shape = (layer.masks.properties[0] as PropertyGroup).property("ADBE Mask Shape").value;
    expect(len(shape.vertices)).toBe(len(expected));
    for (const [vertex, want] of zip(shape.vertices, expected)) {
      expect(approx(vertex, want, { abs: 1e-4 })).toBe(true);
    }
  });

  /** Layer without masks has an empty (falsy) mask parade. */
  test("test_no_masks", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    expect(py_bool(layer.masks)).toBe(false);
  });

  /** Mask children have parent_property pointing to mask parade. */
  test("test_mask_parent_property", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    for (const mask of layer.masks.properties) {
      expect(mask.parent_property).toBe(layer.masks);
    }
  });

  /** Each mask atom is a MaskPropertyGroup instance. */
  test("test_mask_atom_is_mask_property_group", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    expect(len(layer.masks.properties)).toBe(1);
    expect(layer.masks.properties[0] instanceof MaskPropertyGroup).toBe(true);
  });

  /** Default mask has inverted=False. */
  test("test_mask_atom_inverted_default", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    const mask = layer.masks.properties[0] as MaskPropertyGroup;
    expect(mask instanceof MaskPropertyGroup).toBe(true);
    expect(mask.inverted).toBe(false);
  });

  /** Default mask has locked=False. */
  test("test_mask_atom_locked_default", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    const mask = layer.masks.properties[0] as MaskPropertyGroup;
    expect(mask instanceof MaskPropertyGroup).toBe(true);
    expect(mask.locked).toBe(false);
  });

  /** Default mask has mask_mode=MaskMode.ADD. */
  test("test_mask_atom_mode_default", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    const mask = layer.masks.properties[0] as MaskPropertyGroup;
    expect(mask instanceof MaskPropertyGroup).toBe(true);
    expect(mask.mask_mode).toBe(MaskMode.ADD);
  });

  /** All mask atoms in a multi-mask layer are MaskPropertyGroup. */
  test("test_mask_multiple_all_mask_property_groups", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("mask.aep")), "is_mask_multiple");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    for (const mask of layer.masks.properties) {
      expect(mask instanceof MaskPropertyGroup).toBe(true);
    }
  });

  /** MaskPropertyGroup children point to the mask atom as parent. */
  test("test_mask_children_parent_is_mask_group", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    const mask = layer.masks.properties[0] as MaskPropertyGroup;
    expect(mask instanceof MaskPropertyGroup).toBe(true);
    for (const child of mask.properties) {
      expect(child.parent_property).toBe(mask);
    }
  });
});

class TestMaskAttributes {
  /** Parse a mask sample and return the first MaskPropertyGroup. */
  static _get_mask(filename: string): MaskPropertyGroup {
    const project = parse_project(SAMPLES_DIR.div(filename));
    const layer = get_first_layer(project);
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    const mask = layer.masks.properties[0] as MaskPropertyGroup;
    expect(mask instanceof MaskPropertyGroup).toBe(true);
    return mask;
  }
}

describe("TestMaskAttributes", () => {
  /** Tests for MaskPropertyGroup attributes (color, featherFalloff, motionBlur, rotoBezier). */

  // --- color ---

  /** Default mask color is [30/255, 64/255, 30/255]. */
  test("test_color_default", () => {
    const mask = TestMaskAttributes._get_mask("mask_add.aep");
    expect(len(mask.color)).toBe(3);
    expect(
      approx(mask.color, [30 / 255, 64 / 255, 30 / 255], { abs: 1e-3 }),
    ).toBe(true);
  });

  /** Custom mask color [0.102, 0.2, 0.302] (26/255, 51/255, 77/255). */
  test("test_color_custom_1", () => {
    const mask = TestMaskAttributes._get_mask("mask_color_0.102_0.2_0.302.aep");
    expect(
      approx(mask.color, [26 / 255, 51 / 255, 77 / 255], { abs: 1e-3 }),
    ).toBe(true);
  });

  /** Custom mask color [0.2, 0.302, 0.4] (51/255, 77/255, 102/255). */
  test("test_color_custom_2", () => {
    const mask = TestMaskAttributes._get_mask("mask_color_0.2_0.302_0.4.aep");
    expect(
      approx(mask.color, [51 / 255, 77 / 255, 102 / 255], { abs: 1e-3 }),
    ).toBe(true);
  });

  // --- maskFeatherFalloff ---

  /** Feather falloff Smooth is the default. */
  test("test_feather_falloff_smooth", () => {
    const mask = TestMaskAttributes._get_mask("mask_feather_falloff_smooth.aep");
    expect(mask.mask_feather_falloff).toBe(MaskFeatherFalloff.FFO_SMOOTH);
  });

  /** Feather falloff Linear. */
  test("test_feather_falloff_linear", () => {
    const mask = TestMaskAttributes._get_mask("mask_feather_falloff_linear.aep");
    expect(mask.mask_feather_falloff).toBe(MaskFeatherFalloff.FFO_LINEAR);
  });

  // --- maskMotionBlur ---

  /** Motion blur Same as Layer is the default. */
  test("test_motion_blur_same_as_layer", () => {
    const mask = TestMaskAttributes._get_mask("mask_motion_blur_same_as_layer.aep");
    expect(mask.mask_motion_blur).toBe(MaskMotionBlur.SAME_AS_LAYER);
  });

  /** Motion blur On. */
  test("test_motion_blur_on", () => {
    const mask = TestMaskAttributes._get_mask("mask_motion_blur_on.aep");
    expect(mask.mask_motion_blur).toBe(MaskMotionBlur.ON);
  });

  /** Motion blur Off. */
  test("test_motion_blur_off", () => {
    const mask = TestMaskAttributes._get_mask("mask_motion_blur_off.aep");
    expect(mask.mask_motion_blur).toBe(MaskMotionBlur.OFF);
  });

  // --- rotoBezier ---

  /** Default mask has rotoBezier=False. */
  test("test_roto_bezier_default_false", () => {
    const mask = TestMaskAttributes._get_mask("mask_add.aep");
    expect(mask.roto_bezier).toBe(false);
  });

  /** Mask with RotoBezier enabled. */
  test("test_roto_bezier_on", () => {
    const mask = TestMaskAttributes._get_mask("mask_rotobezier_on.aep");
    expect(mask.roto_bezier).toBe(true);
  });

  // --- mask_mode (all modes via from_binary) ---

  test("test_mask_mode_none", () => {
    const mask = TestMaskAttributes._get_mask("mask_none.aep");
    expect(mask.mask_mode).toBe(MaskMode.NONE);
  });

  test("test_mask_mode_add", () => {
    const mask = TestMaskAttributes._get_mask("mask_add.aep");
    expect(mask.mask_mode).toBe(MaskMode.ADD);
  });

  test("test_mask_mode_subtract", () => {
    const mask = TestMaskAttributes._get_mask("mask_subtract.aep");
    expect(mask.mask_mode).toBe(MaskMode.SUBTRACT);
  });

  test("test_mask_mode_intersect", () => {
    const mask = TestMaskAttributes._get_mask("mask_intersect.aep");
    expect(mask.mask_mode).toBe(MaskMode.INTERSECT);
  });

  test("test_mask_mode_darken", () => {
    const mask = TestMaskAttributes._get_mask("mask_darken.aep");
    expect(mask.mask_mode).toBe(MaskMode.DARKEN);
  });

  test("test_mask_mode_lighten", () => {
    const mask = TestMaskAttributes._get_mask("mask_lighten.aep");
    expect(mask.mask_mode).toBe(MaskMode.LIGHTEN);
  });

  test("test_mask_mode_difference", () => {
    const mask = TestMaskAttributes._get_mask("mask_difference.aep");
    expect(mask.mask_mode).toBe(MaskMode.DIFFERENCE);
  });
});

describe("TestIsModified", () => {
  /** Tests for PropertyBase.is_modified computed property. */

  /** Transform properties at their default values have is_modified=False. */
  test("test_transform_defaults_at_default_values", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("is_modified_false.aep")));
    // These transform properties are at their defaults in this sample.
    for (const match_name of [
      "ADBE Orientation",
      "ADBE Rotate X",
      "ADBE Rotate Y",
      "ADBE Envir Appear in Reflect",
    ]) {
      const prop = _find_property(layer, match_name);
      if (prop != null) {
        py_assert(
          prop.is_modified === false,
          `${match_name}: expected is_modified=False, value=${repr(prop.value)}, default=${repr(prop.default_value)}`,
        );
      }
    }
  });

  /** X/Y Position followers moved to 0 from center are is_modified=True. */
  test("test_separated_position_modified", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("is_modified_false.aep")));
    const pos_x = _find_property(layer, "ADBE Position_0");
    const pos_y = _find_property(layer, "ADBE Position_1");
    if (pos_x != null) {
      py_assert(
        pos_x.is_modified === true,
        `X Position value=${str(pos_x.value)}, default=${str(pos_x.default_value)}`,
      );
    }
    if (pos_y != null) {
      py_assert(
        pos_y.is_modified === true,
        `Y Position value=${str(pos_y.value)}, default=${str(pos_y.default_value)}`,
      );
    }
  });

  /** Transform group is_modified=True when any child is modified. */
  test("test_transform_group_is_modified", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("is_modified_false.aep")));
    expect(layer.transform).not.toBeNull();
    // X/Y Position are moved > at least one child is modified
    expect(layer.transform.is_modified).toBe(true);
  });

  /** Effect Parade (indexed group) with effects has is_modified=True. */
  test("test_effect_parade_indexed_group_with_children", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("is_modified_false.aep")));
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    expect(layer.effects.property_type).toBe(PropertyType.INDEXED_GROUP);
    expect(len(layer.effects.properties) > 0).toBe(true);
    expect(layer.effects.is_modified).toBe(true);
  });

  /** An animated property (with keyframes) has is_modified=True. */
  test("test_animated_property_is_modified", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(opacity._animated).toBe(true);
    expect(opacity.is_modified).toBe(true);
  });

  /** Property with enabled expression has is_modified=True. */
  test("test_expression_enabled_is_modified", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("expression.aep")), "expression_enabled");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    expect(position.expression_enabled).toBe(true);
    expect(position.is_modified).toBe(true);
  });

  /** Property with disabled expression is still modified (expression text present). */
  test("test_expression_disabled_not_modified", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("expression.aep")), "expression_disabled");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(opacity.expression_enabled).toBe(false);
    // AE considers a property modified whenever an expression exists,
    // regardless of whether the expression is enabled.
    expect(opacity.expression).not.toBeNull();
    expect(opacity.is_modified).toBe(true);
  });

  /** Scale [100,100,100] at default is is_modified=False. */
  test("test_scale_at_default_not_modified", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_rotation");
    const scale = _find_property(layer, "ADBE Scale");
    if (scale != null && scale.default_value != null) {
      py_assert(
        scale.is_modified === false,
        `Scale value=${str(scale.value)}, default=${str(scale.default_value)}`,
      );
    }
  });

  /** Effect properties at their default values have is_modified=False. */
  test("test_effect_properties_at_default", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("is_modified_false.aep")));
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    for (const effect of layer.effects as Iterable<PropertyGroup>) {
      for (const prop of effect.properties) {
        if (prop instanceof Property && prop.default_value != null) {
          // In this sample all effect params are at defaults
          py_assert(
            prop.is_modified === false,
            `${prop.match_name}: value=${repr(prop.value)}, default=${repr(prop.default_value)}`,
          );
        }
      }
    }
  });

  /** Effect property with value != default has is_modified=True. */
  test("test_effect_modified_value", () => {
    const project = parse_project(SAMPLES_DIR.div("2_gaussian_20_30.aep"));
    const layer = get_first_layer(project);
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    const effect = layer.effects.properties[0] as PropertyGroup;
    let blurriness: Property | null = null;
    for (const prop of effect.properties) {
      if (prop.match_name === "ADBE Gaussian Blur 2-0001") {
        blurriness = prop as Property;
        break;
      }
    }
    expect(blurriness).not.toBeNull();
    if (blurriness === null) throw new AssertionError_("blurriness is None");
    expect(blurriness.value).toBe(20.0);
    // Blurriness default from pard chunk is 0.0
    if (blurriness.default_value != null) {
      expect(blurriness.is_modified).toBe(true);
    }
  });

  /** Property with no default_value returns is_modified=False (conservative). */
  test("test_no_default_value_not_modified", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    // Check a property that might not have a default
    for (const prop of layer.transform.properties) {
      if (prop instanceof Property && prop.default_value == null) {
        if (!prop._animated && !py_bool(py_and(prop.expression, prop.expression_enabled))) {
          py_assert(prop.is_modified === false, `${prop.match_name} with no default should be False`);
        }
      }
    }
  });
});

describe("TestSeparation", () => {
  /**
   * Tests for separation leader/follower properties.
   *
   * In After Effects, Position is a "separation leader" that can be
   * split into X/Y/Z Position "followers".  These roles are structural
   * and persist regardless of whether dimensions are currently separated.
   */

  /** Position is always a separation leader. */
  test("test_is_separation_leader", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("transform_separated.aep")));
    const pos = _find_property(layer, "ADBE Position");
    expect(pos).not.toBeNull();
    if (pos === null) throw new AssertionError_("pos is None");
    expect(pos.is_separation_leader).toBe(true);
    expect(pos.is_separation_follower).toBe(false);
    expect(pos.separation_dimension).toBeNull();
  });

  /** Position_0/1/2 are always separation followers. */
  test("test_is_separation_follower", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("transform_separated.aep")));
    for (const [suffix, dim] of [
      ["_0", 0],
      ["_1", 1],
      ["_2", 2],
    ] as const) {
      const prop = _find_property(layer, `ADBE Position${suffix}`);
      py_assert(prop != null, `ADBE Position${suffix} not found`);
      expect(prop.is_separation_follower).toBe(true);
      expect(prop.is_separation_leader).toBe(false);
      expect(prop.separation_dimension).toBe(dim);
    }
  });

  /** Position.get_separation_follower(dim) returns the follower. */
  test("test_get_separation_follower", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("transform_separated.aep")));
    const pos = _find_property(layer, "ADBE Position");
    expect(pos).not.toBeNull();
    if (pos === null) throw new AssertionError_("pos is None");
    for (const dim of range(3)) {
      const follower = pos.get_separation_follower(dim);
      py_assert(follower != null, `follower dim ${dim} is None`);
      expect(follower.match_name).toBe(`ADBE Position_${dim}`);
    }
  });

  /** Follower.separation_leader returns the Position property. */
  test("test_separation_leader_back_reference", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("transform_separated.aep")));
    const pos = _find_property(layer, "ADBE Position");
    const x_pos = _find_property(layer, "ADBE Position_0");
    expect(x_pos).not.toBeNull();
    if (x_pos === null) throw new AssertionError_("x_pos is None");
    expect(x_pos.separation_leader).toBe(pos);
  });

  /** Leader/follower roles hold even when never separated. */
  test("test_before_separation_still_structural", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("before_separation.aep")));
    const pos = _find_property(layer, "ADBE Position");
    expect(pos).not.toBeNull();
    if (pos === null) throw new AssertionError_("pos is None");
    expect(pos.is_separation_leader).toBe(true);
    expect(pos.dimensions_separated).toBe(false);

    const x_pos = _find_property(layer, "ADBE Position_0");
    expect(x_pos).not.toBeNull();
    if (x_pos === null) throw new AssertionError_("x_pos is None");
    expect(x_pos.is_separation_follower).toBe(true);
    expect(x_pos.separation_dimension).toBe(0);
  });

  /** Opacity has neither leader nor follower role. */
  test("test_non_position_not_separation", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("transform_separated.aep")));
    const opa = _find_property(layer, "ADBE Opacity");
    expect(opa).not.toBeNull();
    if (opa === null) throw new AssertionError_("opa is None");
    expect(opa.is_separation_leader).toBe(false);
    expect(opa.is_separation_follower).toBe(false);
    expect(opa.separation_dimension).toBeNull();
    expect(opa.separation_leader).toBeNull();
    expect(opa.get_separation_follower(0)).toBeNull();
  });

  /** Leader/follower roles hold after un-separating. */
  test("test_unseparated_structural", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("transform_unseparated.aep")));
    const pos = _find_property(layer, "ADBE Position");
    expect(pos).not.toBeNull();
    if (pos === null) throw new AssertionError_("pos is None");
    expect(pos.is_separation_leader).toBe(true);
    expect(pos.dimensions_separated).toBe(false);

    const y_pos = _find_property(layer, "ADBE Position_1");
    expect(y_pos).not.toBeNull();
    if (y_pos === null) throw new AssertionError_("y_pos is None");
    expect(y_pos.is_separation_follower).toBe(true);
    expect(y_pos.separation_dimension).toBe(1);
  });
});

class TestTransformSynthesis {
  /**
   * Tests for synthesized transform properties.
   *
   * After Effects always reports 12 transform properties via ExtendScript
   * regardless of layer dimensionality (2-D vs 3-D). The binary format only
   * stores properties relevant to the current state, so the parser synthesises
   * the missing ones.
   */
  static _CANONICAL_ORDER: string[] = [
    "ADBE Anchor Point",
    "ADBE Position",
    "ADBE Position_0",
    "ADBE Position_1",
    "ADBE Position_2",
    "ADBE Scale",
    "ADBE Orientation",
    "ADBE Rotate X",
    "ADBE Rotate Y",
    "ADBE Rotate Z",
    "ADBE Opacity",
    "ADBE Envir Appear in Reflect",
  ];
}

describe("TestTransformSynthesis", () => {
  /** Transform group always contains exactly 12 properties. */
  test("test_twelve_properties", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("is_modified_false.aep")));
    expect(layer.transform).not.toBeNull();
    expect(len(layer.transform.properties)).toBe(12);
  });

  /** Properties appear in the canonical ExtendScript order. */
  test("test_canonical_order", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("is_modified_false.aep")));
    const match_names = layer.transform.properties.map((p) => p.match_name);
    expect(py_eq(match_names, TestTransformSynthesis._CANONICAL_ORDER)).toBe(true);
  });

  /** Orientation always present with correct defaults. */
  test("test_synthesized_orientation_metadata", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(orientation.default_value).not.toBeNull();
    expect(orientation.is_modified).toBe(false);
  });

  /** X Rotation always present with correct defaults. */
  test("test_synthesized_rotate_x_metadata", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const rotate_x = _find_property(layer, "ADBE Rotate X");
    expect(rotate_x).not.toBeNull();
    if (rotate_x === null) throw new AssertionError_("rotate_x is None");
    expect(rotate_x.dimensions).toBe(1);
    expect(rotate_x.default_value).not.toBeNull();
    expect(rotate_x.is_modified).toBe(false);
  });

  /** Non-animated transform properties at default have is_modified=False. */
  test("test_synthesized_value_equals_default", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    // All non-animated transform properties should have a default and
    // be at that default (the sample only animates Opacity).
    for (const prop of layer.transform.properties) {
      if (prop instanceof Property && !prop._animated) {
        py_assert(prop.default_value != null, `${prop.match_name} should have a default_value`);
      }
    }

    // Verify specific properties
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(orientation.is_modified).toBe(false);

    const rotate_x = _find_property(layer, "ADBE Rotate X");
    expect(rotate_x).not.toBeNull();
    if (rotate_x === null) throw new AssertionError_("rotate_x is None");
    expect(rotate_x.value).toBe(0.0);
    expect(rotate_x.is_modified).toBe(false);
  });

  /** Synthesized properties have animated=False. */
  test("test_synthesized_not_animated", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    for (const match_name of ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y"]) {
      const prop = _find_property(layer, match_name);
      expect(prop).not.toBeNull();
      if (prop === null) throw new AssertionError_("prop is None");
      py_assert(!prop._animated, `${match_name} should not be animated`);
      expect(prop.expression).toBe("");
      expect(py_eq(prop.keyframes, [])).toBe(true);
    }
  });

  /** Synthesized properties point to the transform group as parent. */
  test("test_synthesized_parent_property", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    for (const prop of layer.transform.properties) {
      py_assert(prop.parent_property === layer.transform, `${prop.match_name} parent should be transform group`);
    }
  });

  /** Appears in Reflections is synthesised with correct name and value. */
  test("test_envir_appear_in_reflect", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const envir = _find_property(layer, "ADBE Envir Appear in Reflect");
    expect(envir).not.toBeNull();
    if (envir === null) throw new AssertionError_("envir is None");
    expect(envir.name).toBe("Appears in Reflections");
    expect(envir.value).toBe(1.0);
    expect(envir.default_value).toBe(1.0);
    expect(envir.is_modified).toBe(false);
  });

  /** Another sample (property_rotation) also gets 12 transform props. */
  test("test_property_rotation_twelve_properties", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_rotation");
    expect(layer.transform).not.toBeNull();
    expect(len(layer.transform.properties)).toBe(12);
    const match_names = layer.transform.properties.map((p) => p.match_name);
    expect(py_eq(match_names, TestTransformSynthesis._CANONICAL_ORDER)).toBe(true);
  });
});

describe("TestUnitsText", () => {
  /**
   * Tests for Property.units_text.
   *
   * The `units_text` attribute is determined by the property's `match_name`
   * and returns one of `"pixels"`, `"degrees"`, `"percent"`,
   * `"seconds"`, `"dB"`, or `""` (no unit).
   */

  // -- Transform properties ------------------------------------------------

  /** Anchor Point and Position report 'pixels'. */
  test("test_transform_pixels", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const anchor = _find_property(layer, "ADBE Anchor Point");
    expect(anchor).not.toBeNull();
    if (anchor === null) throw new AssertionError_("anchor is None");
    expect(anchor.units_text).toBe("pixels");

    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    expect(position.units_text).toBe("pixels");
  });

  /** Scale and Opacity report 'percent'. */
  test("test_transform_percent", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const scale = _find_property(layer, "ADBE Scale");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError_("scale is None");
    expect(scale.units_text).toBe("percent");

    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(opacity.units_text).toBe("percent");
  });

  /** Rotation and Orientation report 'degrees'. */
  test("test_transform_degrees", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_rotation");
    const rotate_z = _find_property(layer, "ADBE Rotate Z");
    expect(rotate_z).not.toBeNull();
    if (rotate_z === null) throw new AssertionError_("rotate_z is None");
    expect(rotate_z.units_text).toBe("degrees");

    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError_("orientation is None");
    expect(orientation.units_text).toBe("degrees");
  });

  /** Appears in Reflections has empty units_text. */
  test("test_transform_no_unit", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const envir = _find_property(layer, "ADBE Envir Appear in Reflect");
    expect(envir).not.toBeNull();
    if (envir === null) throw new AssertionError_("envir is None");
    expect(envir.units_text).toBe("");
  });

  // -- Separated position followers ----------------------------------------

  /** X/Y/Z Position followers report 'pixels'. */
  test("test_separation_followers_pixels", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("transform_separated.aep")));
    for (const mn of ["ADBE Position_0", "ADBE Position_1"]) {
      const prop = _find_property(layer, mn);
      py_assert(prop != null, `${mn} missing`);
      py_assert(prop.units_text === "pixels", `${mn} wrong units`);
    }
  });

  // -- Mask properties -----------------------------------------------------

  /** Mask Feather reports 'pixels'. */
  test("test_mask_feather_pixels", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("mask_add.aep")));
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    const mask = layer.masks.properties[0] as MaskPropertyGroup;
    // Mask children: [0]=MaskPath, [1]=Feather, [2]=Opacity, [3]=Expansion
    const feather = as_instance(mask.properties[1], Property);
    expect(feather.match_name).toBe("ADBE Mask Feather");
    expect(feather.units_text).toBe("pixels");
  });

  /** Mask Opacity reports 'percent'. */
  test("test_mask_opacity_percent", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("mask_add.aep")));
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    const mask = layer.masks.properties[0] as MaskPropertyGroup;
    const opacity = as_instance(mask.properties[2], Property);
    expect(opacity.match_name).toBe("ADBE Mask Opacity");
    expect(opacity.units_text).toBe("percent");
  });

  // -- Effect properties ---------------------------------------------------

  /** Effect Mask Opacity (Compositing Options) reports 'percent'. */
  test("test_effect_mask_opacity_percent", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("effects.aep")), "effect_2dPoint");
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    const effect = layer.effects.properties[0] as PropertyGroup;
    // Compositing Options group is the last child of an effect
    let comp_opts: PropertyGroup | null = null;
    for (const child of effect.properties) {
      if (child.match_name === "ADBE Effect Built In Params") {
        comp_opts = child as PropertyGroup;
        break;
      }
    }
    expect(comp_opts).not.toBeNull();
    if (comp_opts === null) throw new AssertionError_("comp_opts is None");
    let opacity: Property | null = null;
    for (const child of comp_opts.properties) {
      if (child.match_name === "ADBE Effect Mask Opacity") {
        opacity = child as Property;
        break;
      }
    }
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(opacity.units_text).toBe("percent");
  });

  /** Every effect has Compositing Options with its expected children. */
  test("test_compositing_options_always_present", () => {
    const project = parse_project(SAMPLES_DIR.div("effects.aep"));
    const layer = get_layer(project, "effect_2dPoint");
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    for (const effect of layer.effects as Iterable<PropertyGroup>) {
      const comp_opts = effect.property("ADBE Effect Built In Params");
      py_assert(comp_opts != null, `Effect ${repr(effect.name)} missing Compositing Options`);
      expect(comp_opts.name).toBe("Compositing Options");
      const child_mns = (comp_opts as PropertyGroup).properties.map((c) => c.match_name);
      expect(child_mns.includes("ADBE Effect Mask Parade")).toBe(true);
      expect(child_mns.includes("ADBE Effect Mask Opacity")).toBe(true);
      expect(child_mns.includes("ADBE Force CPU GPU")).toBe(true);
    }
  });

  /** Gaussian Blur Blurriness has no units in the map > empty string. */
  test("test_effect_property_no_unit", () => {
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("2_gaussian_20_30.aep")));
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    const effect = layer.effects.properties[0] as PropertyGroup;
    let blurriness: Property | null = null;
    for (const child of effect.properties) {
      if (child.match_name === "ADBE Gaussian Blur 2-0001") {
        blurriness = child as Property;
        break;
      }
    }
    expect(blurriness).not.toBeNull();
    if (blurriness === null) throw new AssertionError_("blurriness is None");
    expect(blurriness.units_text).toBe("");
  });

  // -- Unknown match name --------------------------------------------------

  /** Unknown match names default to empty string. */
  test("test_unknown_match_name_empty", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const envir = _find_property(layer, "ADBE Envir Appear in Reflect");
    expect(envir).not.toBeNull();
    if (envir === null) throw new AssertionError_("envir is None");
    expect(envir.units_text).toBe("");
  });
});

describe("TestKeyframeInterpolationTypes", () => {
  /** Tests for in/out interpolation type fields on keyframes. */

  /** LINEAR keyframes have matching in/out interpolation types. */
  test("test_linear_in_out_match", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_LINEAR");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    for (const kf of position.keyframes) {
      expect(kf.in_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
      expect(kf.out_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
    }
  });

  /** BEZIER keyframes have matching in/out interpolation types. */
  test("test_bezier_in_out_match", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_BEZIER");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    for (const kf of position.keyframes) {
      expect(kf.in_interpolation_type).toBe(KeyframeInterpolationType.BEZIER);
      expect(kf.out_interpolation_type).toBe(KeyframeInterpolationType.BEZIER);
    }
  });

  /** Mixed interpolation keyframes have different in/out types. */
  test("test_mixed_interpolation", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(len(opacity.keyframes)).toBe(4);
    // KF[0]: LINEAR in/out
    expect(opacity.keyframes[0].in_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
    expect(opacity.keyframes[0].out_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
    // KF[1]: BEZIER in, HOLD out
    expect(opacity.keyframes[1].in_interpolation_type).toBe(KeyframeInterpolationType.BEZIER);
    expect(opacity.keyframes[1].out_interpolation_type).toBe(KeyframeInterpolationType.HOLD);
    // KF[2]: HOLD in, LINEAR out
    expect(opacity.keyframes[2].in_interpolation_type).toBe(KeyframeInterpolationType.HOLD);
    expect(opacity.keyframes[2].out_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
    // KF[3]: LINEAR in/out
    expect(opacity.keyframes[3].in_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
    expect(opacity.keyframes[3].out_interpolation_type).toBe(KeyframeInterpolationType.LINEAR);
  });
});

describe("TestTemporalEase", () => {
  /** Tests for in/out temporal ease on keyframes. */

  /** 1D Bezier ease has one KeyframeEase per keyframe. */
  test("test_bezier_ease_in_out_1d", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_bezier_ease_in_out_1D");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    for (const kf of opacity.keyframes) {
      expect(len(kf.in_temporal_ease)).toBe(1);
      expect(len(kf.out_temporal_ease)).toBe(1);
    }
  });

  /** Scale (3D) has three KeyframeEase per keyframe. */
  test("test_bezier_ease_scale_multi_dim", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_misc.aep")), "keyframe_bezier_ease_scale");
    const scale = _find_property(layer, "ADBE Scale");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError_("scale is None");
    expect(len(scale.keyframes) >= 2).toBe(true);
    for (const kf of scale.keyframes) {
      expect(len(kf.in_temporal_ease)).toBe(3);
      expect(len(kf.out_temporal_ease)).toBe(3);
    }
  });

  /** Scale ease-scale sample: KF0 out influence=75, KF1 in influence=75. */
  test("test_bezier_ease_scale_influence_values", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_misc.aep")), "keyframe_bezier_ease_scale");
    const scale = _find_property(layer, "ADBE Scale");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError_("scale is None");
    // KF0 out_ease all 75%
    for (const ease of scale.keyframes[0].out_temporal_ease) {
      expect(Math.abs(ease.influence - 75.0) < 0.01).toBe(true);
    }
    // KF1 in_ease all 75%
    for (const ease of scale.keyframes[1].in_temporal_ease) {
      expect(Math.abs(ease.influence - 75.0) < 0.01).toBe(true);
    }
  });

  /** Percent property speeds are scaled to match ExtendScript units. */
  test("test_bezier_nonzero_speed", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_bezier_nonzero_speed");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    // KF0 out speed = 20 (%/sec), KF1 in speed = 15 (%/sec)
    expect(Math.abs(opacity.keyframes[0].out_temporal_ease[0].speed - 20.0) < 0.1).toBe(true);
    expect(Math.abs(opacity.keyframes[1].in_temporal_ease[0].speed - 15.0) < 0.1).toBe(true);
  });

  /** Asymmetric ease has different in/out influence values. */
  test("test_bezier_asymmetric_ease", () => {
    const layer = get_layer(
      parse_project(SAMPLES_DIR.div("keyframe_1D.aep")),
      "keyframe_bezier_asymmetric_ease_1D",
    );
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    // Should have at least 2 keyframes with different in/out
    const kf0 = opacity.keyframes[0];
    expect(len(kf0.in_temporal_ease)).toBe(1);
    expect(len(kf0.out_temporal_ease)).toBe(1);
  });

  /** Spatial properties (Position) always have 1 ease element. */
  test("test_spatial_position_single_ease", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_spatial.aep")), "keyframe_spatial_bezier_arc");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    for (const kf of position.keyframes) {
      expect(len(kf.in_temporal_ease)).toBe(1);
      expect(len(kf.out_temporal_ease)).toBe(1);
    }
  });

  /** Bounce pattern has 10 keyframes, each with ease data. */
  test("test_bounce_pattern_ease_count", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_bounce_pattern");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(len(opacity.keyframes)).toBe(10);
    for (const kf of opacity.keyframes) {
      expect(len(kf.in_temporal_ease)).toBe(1);
      expect(len(kf.out_temporal_ease)).toBe(1);
    }
  });
});

describe("TestSpatialTangents", () => {
  /** Tests for in/out spatial tangents on keyframes. */

  /** Spatial bezier arc has non-None tangent vectors. */
  test("test_spatial_tangents_present", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_spatial.aep")), "keyframe_spatial_bezier_arc");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    for (const kf of position.keyframes) {
      expect(kf.in_spatial_tangent).not.toBeNull();
      expect(kf.out_spatial_tangent).not.toBeNull();
      expect(len(kf.in_spatial_tangent)).toBe(3); // x, y, z
      expect(len(kf.out_spatial_tangent)).toBe(3);
    }
  });

  /** Spatial bezier arc: KF0 out tangent = [60, -80, 0]. */
  test("test_spatial_tangent_values_arc", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_spatial.aep")), "keyframe_spatial_bezier_arc");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    const kf0 = position.keyframes[0];
    expect(kf0.out_spatial_tangent).not.toBeNull();
    if (kf0.out_spatial_tangent === null) throw new AssertionError_("kf0.out_spatial_tangent is None");
    expect(Math.abs(kf0.out_spatial_tangent[0] - 60.0) < 0.01).toBe(true);
    expect(Math.abs(kf0.out_spatial_tangent[1] - -80.0) < 0.01).toBe(true);
    expect(Math.abs(kf0.out_spatial_tangent[2] - 0.0) < 0.01).toBe(true);
  });

  /** Non-spatial properties (Opacity) have None tangents. */
  test("test_non_spatial_no_tangents", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_bezier_ease_in_out_1D");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    for (const kf of opacity.keyframes) {
      expect(kf.in_spatial_tangent).toBeNull();
      expect(kf.out_spatial_tangent).toBeNull();
    }
  });

  /** 3D spatial bezier has 3-component tangent vectors. */
  test("test_3d_spatial_tangents", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_spatial.aep")), "keyframe_spatial_bezier_3D");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    for (const kf of position.keyframes) {
      expect(kf.in_spatial_tangent).not.toBeNull();
      expect(kf.out_spatial_tangent).not.toBeNull();
      expect(len(kf.in_spatial_tangent)).toBe(3);
      expect(len(kf.out_spatial_tangent)).toBe(3);
    }
  });

  /** S-curve: KF1 in tangent = [-40, -60, 0]. */
  test("test_s_curve_spatial_tangents", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_spatial.aep")), "keyframe_spatial_bezier_s_curve");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    const kf1 = position.keyframes[1];
    expect(kf1.in_spatial_tangent).not.toBeNull();
    if (kf1.in_spatial_tangent === null) throw new AssertionError_("kf1.in_spatial_tangent is None");
    expect(Math.abs(kf1.in_spatial_tangent[0] - -40.0) < 0.01).toBe(true);
    expect(Math.abs(kf1.in_spatial_tangent[1] - -60.0) < 0.01).toBe(true);
  });
});

class TestLinearHoldEase {
  /**
   * Tests for computed temporal ease on LINEAR and HOLD keyframes.
   *
   * The binary stores zeros for LINEAR/HOLD ease but ExtendScript computes
   * and reports actual values: influence = 100/6 (≈16.667 %) and speed =
   * value_change / time_in_seconds.
   */
  static DEFAULT_INFLUENCE = 100.0 / 6.0;
}

describe("TestLinearHoldEase", () => {
  /** LINEAR position: KF0 out speed = distance / time. */
  test("test_linear_position_out_speed", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_LINEAR");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    const kf0 = position.keyframes[0];
    // [0,50,0] > [100,50,0] over 5 seconds (120 frames @ 24fps)
    // distance = 100, speed = 100/5 = 20
    expect(Math.abs(kf0.out_temporal_ease[0].speed - 20.0) < 0.01).toBe(true);
    expect(Math.abs(kf0.out_temporal_ease[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** LINEAR position: KF1 in speed = distance / time. */
  test("test_linear_position_in_speed", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_LINEAR");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    const kf1 = position.keyframes[1];
    expect(Math.abs(kf1.in_temporal_ease[0].speed - 20.0) < 0.01).toBe(true);
    expect(Math.abs(kf1.in_temporal_ease[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** First keyframe in a LINEAR property has in speed = 0. */
  test("test_linear_first_keyframe_in_speed_zero", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_LINEAR");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    const kf0 = position.keyframes[0];
    expect(Math.abs(kf0.in_temporal_ease[0].speed) < 0.001).toBe(true);
    expect(Math.abs(kf0.in_temporal_ease[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** Last keyframe in a LINEAR property has out speed = 0. */
  test("test_linear_last_keyframe_out_speed_zero", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_LINEAR");
    const position = _find_property(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    const kf_last = position.keyframes.at(-1);
    if (kf_last === undefined) throw new IndexError("list index out of range");
    expect(Math.abs(kf_last.out_temporal_ease[0].speed) < 0.001).toBe(true);
    expect(
      Math.abs(kf_last.out_temporal_ease[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001,
    ).toBe(true);
  });

  /** Mixed interpolation: LINEAR opacity out speed = value_change / time. */
  test("test_mixed_linear_opacity_speed", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    // KF[0] (100%) > KF[1] (0%) over 3 sec (72 frames @ 24fps)
    // speed = (0 - 100) / 3 = -33.333
    const kf0 = opacity.keyframes[0];
    expect(Math.abs(kf0.out_temporal_ease[0].speed - -100.0 / 3.0) < 0.01).toBe(true);
    expect(Math.abs(kf0.out_temporal_ease[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** HOLD out keyframe has speed = 0 and influence = 100/6. */
  test("test_mixed_hold_out_speed_zero", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    // KF[1]: BEZIER in, HOLD out
    const kf1 = opacity.keyframes[1];
    expect(Math.abs(kf1.out_temporal_ease[0].speed) < 0.001).toBe(true);
    expect(Math.abs(kf1.out_temporal_ease[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** HOLD in keyframe has speed = 0 and influence = 100/6. */
  test("test_mixed_hold_in_speed_zero", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    // KF[2]: HOLD in, LINEAR out
    const kf2 = opacity.keyframes[2];
    expect(Math.abs(kf2.in_temporal_ease[0].speed) < 0.001).toBe(true);
    expect(Math.abs(kf2.in_temporal_ease[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** LINEAR out after HOLD in computes speed from adjacent keyframes. */
  test("test_mixed_linear_out_after_hold", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    // KF[2] (100%) > KF[3] (50%) over 3 sec (72 frames @ 24fps)
    // speed = (50 - 100) / 3 = -16.667
    const kf2 = opacity.keyframes[2];
    expect(Math.abs(kf2.out_temporal_ease[0].speed - -50.0 / 3.0) < 0.01).toBe(true);
    expect(Math.abs(kf2.out_temporal_ease[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** BEZIER keyframes retain their stored binary ease values. */
  test("test_bezier_ease_unchanged", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    // KF[1]: BEZIER in - binary stores (speed=0, influence=0)
    const kf1 = opacity.keyframes[1];
    expect(Math.abs(kf1.in_temporal_ease[0].speed) < 0.001).toBe(true);
    expect(Math.abs(kf1.in_temporal_ease[0].influence) < 0.001).toBe(true);
  });
});

describe("TestShapeValue", () => {
  /** Tests for Shape value parsing (vertices, tangents, feather). */

  /** Closed square mask has 4 vertices at the expected positions. */
  test("test_closed_square_vertices", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("shape_basic.aep")), "shape_closed_square");
    const shape = _get_mask_shape(layer).value;
    expect(shape.closed).toBe(true);
    expect(len(shape.vertices)).toBe(4);
    expect(
      py_eq(shape.vertices, [
        [100.0, 100.0],
        [100.0, 300.0],
        [300.0, 300.0],
        [300.0, 100.0],
      ]),
    ).toBe(true);
  });

  /** Closed square mask has zero tangents (straight line segments). */
  test("test_closed_square_tangents_zero", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("shape_basic.aep")), "shape_closed_square");
    const shape = _get_mask_shape(layer).value;
    for (const t of [...shape.in_tangents, ...shape.out_tangents]) {
      expect(py_eq(t, [0, 0])).toBe(true);
    }
  });

  /** Closed square mask has no feather points. */
  test("test_closed_square_no_feather", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("shape_basic.aep")), "shape_closed_square");
    const shape = _get_mask_shape(layer).value;
    expect(py_eq(shape.feather_points, [])).toBe(true);
  });

  /** Closed oval mask has non-zero tangents. */
  test("test_closed_oval_tangents", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("shape_basic.aep")), "shape_closed_oval");
    const shape = _get_mask_shape(layer).value;
    expect(shape.closed).toBe(true);
    expect(len(shape.vertices)).toBe(4);
    // Tangents should be non-zero (bezier curves)
    for (const t of [...shape.in_tangents, ...shape.out_tangents]) {
      expect(!py_eq(t, [0, 0])).toBe(true);
    }
  });

  /** Open path mask has closed=False. */
  test("test_open_path", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("shape_basic.aep")), "shape_open");
    const shape = _get_mask_shape(layer).value;
    expect(shape.closed).toBe(false);
    expect(len(shape.vertices)).toBe(4);
  });

  /** Feather points mask has 2 outer feather points at segments 1 and 2. */
  test("test_feather_points", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("shape_feather.aep")), "shape_feather_points");
    const shape = _get_mask_shape(layer).value;
    expect(len(shape.feather_points)).toBe(2);
    const [fp0, fp1] = shape.feather_points;
    expect(fp0.seg_loc).toBe(1);
    expect(fp0.rel_seg_loc).toBe(0.15);
    expect(fp0.radius).toBe(30.0);
    expect(fp0.type).toBe(0);
    expect(fp0.interp).toBe(0);
    expect(fp0.tension).toBe(0.0);
    expect(fp0.rel_corner_angle).toBe(0.0);
    expect(fp1.seg_loc).toBe(2);
    expect(fp1.rel_seg_loc).toBe(0.5);
    expect(fp1.radius).toBe(100.0);
    expect(fp1.type).toBe(0);
    expect(fp1.interp).toBe(0);
    expect(fp1.tension).toBe(0.0);
    expect(fp1.rel_corner_angle).toBe(0.0);
  });

  /** Feather with inner/outer types and hold/non-hold interpolation. */
  test("test_feather_inner_hold", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("shape_feather.aep")), "shape_feather_inner_hold");
    const shape = _get_mask_shape(layer).value;
    expect(len(shape.feather_points)).toBe(4);
    expect(py_eq(shape.feather_points.map((fp) => fp.seg_loc), [0, 1, 2, 3])).toBe(true);
    expect(py_eq(shape.feather_points.map((fp) => fp.radius), [50.0, -30.0, 80.0, -20.0])).toBe(true);
    expect(py_eq(shape.feather_points.map((fp) => fp.type), [0, 1, 0, 1])).toBe(true);
    expect(py_eq(shape.feather_points.map((fp) => fp.interp), [0, 0, 1, 1])).toBe(true);
    expect(py_eq(shape.feather_points.map((fp) => fp.tension), [0.0, 0.5, 1.0, 0.25])).toBe(true);
    expect(py_eq(shape.feather_points.map((fp) => fp.rel_corner_angle), [0.0, 0.0, 0.0, 0.0])).toBe(true);
  });

  /** Animated mask shape has 2 keyframes with different vertices. */
  test("test_animated_keyframes", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("shape_misc.aep")), "shape_animated");
    const prop = _get_mask_shape(layer);
    expect(len(prop.keyframes)).toBe(2);
    const kf0 = prop.keyframes[0].value as Shape;
    const kf1 = prop.keyframes[1].value as Shape;
    expect(
      py_eq(kf0.vertices, [
        [100.0, 100.0],
        [100.0, 300.0],
        [300.0, 300.0],
        [300.0, 100.0],
      ]),
    ).toBe(true);
    expect(
      py_eq(kf1.vertices, [
        [150.0, 150.0],
        [150.0, 250.0],
        [250.0, 250.0],
        [250.0, 150.0],
      ]),
    ).toBe(true);
  });

  /** 300-vertex mask with feather seg_locs >255 proves u4le field width. */
  test("test_many_points_seg_locs", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("shape_misc.aep")), "shape_many_points");
    const shape = _get_mask_shape(layer).value;
    expect(len(shape.vertices)).toBe(300);
    expect(py_eq(shape.feather_points.map((fp) => fp.seg_loc), [0, 128, 255, 256, 270, 299])).toBe(true);
    expect(py_eq(shape.feather_points.map((fp) => fp.radius), [10.0, 20.0, 30.0, 40.0, 50.0, 60.0])).toBe(true);
  });
});

class TestTextAnimatorPool {
  /**
   * The ADBE Text Animator Properties pool is synthesized to match
   * ExtendScript (fixed pool, renderer-independent).
   */
  static AEP = SAMPLES_DIR.div("text_animator.aep");

  static _props(app: Application): PropertyGroup {
    const comp = app.project.compositions[0];
    const layer = comp.layers.find((lyr) => lyr.name === "Animate Me");
    if (layer === undefined) throw new StopIteration();
    const animator = as_instance(
      layer.__getitem__("ADBE Text Properties").__getitem__("ADBE Text Animators").properties[0],
      PropertyGroup,
    );
    const props = animator.__getitem__("ADBE Text Animator Properties");
    expect(props instanceof PropertyGroup).toBe(true);
    return props;
  }
}

describe("TestTextAnimatorPool", () => {
  test("test_pool_size_and_names", () => {
    const props = TestTextAnimatorPool._props(parse_aep(TestTextAnimatorPool.AEP));
    const children = props.properties;
    expect(len(children)).toBe(103);
    const by_mn = new Map(children.map((c) => [c.match_name, c] as const));
    expect(getitem(by_mn, "ADBE Text Position 3D").name).toBe("Position");
    expect(getitem(by_mn, "ADBE Text Rotation").name).toBe("Rotation");
    expect(getitem(by_mn, "ADBE 3DText Front RGB").name).toBe("Front Color");
    // Variable-font axis props have empty display names.
    expect(getitem(by_mn, "ADBE Text VF Axis 1").name).toBe("");
  });

  test("test_pool_values_and_units", () => {
    const props = TestTextAnimatorPool._props(parse_aep(TestTextAnimatorPool.AEP));
    const by_mn = new Map(props.properties.map((c) => [c.match_name, c] as const));
    const opacity = as_instance(getitem(by_mn, "ADBE Text Opacity"), Property);
    expect(opacity instanceof Property).toBe(true);
    expect(opacity.value).toBe(100);
    expect(opacity.min_value).toBe(0);
    expect(opacity.max_value).toBe(100);
    expect(opacity.units_text).toBe("percent");
    const scale = as_instance(getitem(by_mn, "ADBE Text Scale 3D"), Property);
    expect(scale instanceof Property).toBe(true);
    expect(py_eq(scale.value, [100.0, 100.0, 100.0])).toBe(true);
    expect(scale.units_text).toBe("percent");
  });

  test("test_pool_properties_not_expressionable", () => {
    const props = TestTextAnimatorPool._props(parse_aep(TestTextAnimatorPool.AEP));
    for (const c of props.properties) {
      expect(c instanceof Property).toBe(true);
      expect(as_instance(c, Property).can_set_expression).toBe(false);
    }
  });

  test("test_pool_group_is_elided", () => {
    const props = TestTextAnimatorPool._props(parse_aep(TestTextAnimatorPool.AEP));
    expect(props.elided).toBe(true);
  });
});

describe("TestEffectMetadata", () => {
  /** Tests for effect property metadata not covered by aep-validate. */

  /** Blur Dimensions is a dropdown with 3 options. */
  test("test_gaussian_blur_dimensions_dropdown", () => {
    const project = parse_project(SAMPLES_DIR.div("2_gaussian.aep"));
    const layer = get_first_layer(project);
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    const effect = layer.effects.properties[0] as PropertyGroup;
    let blur_dims: Property | null = null;
    for (const prop of effect.properties) {
      if (prop.match_name === "ADBE Gaussian Blur 2-0002") {
        blur_dims = prop as Property;
        break;
      }
    }
    expect(blur_dims).not.toBeNull();
    if (blur_dims === null) throw new AssertionError_("blur_dims is None");
    expect(blur_dims.nb_options).toBe(3);
    expect(blur_dims.property_parameters).not.toBeNull();
    if (blur_dims.property_parameters === null) throw new AssertionError_("blur_dims.property_parameters is None");
    expect(len(blur_dims.property_parameters)).toBe(3);
  });

  /** Synthesized default properties have is_modified == False. */
  test("test_synthesized_property_not_modified", () => {
    const project = parse_project(SAMPLES_DIR.div("2_gaussian.aep"));
    const layer = get_first_layer(project);
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    const effect = layer.effects.properties[0] as PropertyGroup;
    // Repeat Edge Pixels is a boolean at its default - should not be modified
    let repeat_edge: Property | null = null;
    for (const prop of effect.properties) {
      if (prop.match_name === "ADBE Gaussian Blur 2-0003") {
        repeat_edge = prop as Property;
        break;
      }
    }
    expect(repeat_edge).not.toBeNull();
    if (repeat_edge === null) throw new AssertionError_("repeat_edge is None");
    expect(repeat_edge.is_modified).toBe(false);
  });

  /** Synthesized 2D point values are scaled to composition dimensions. */
  test("test_2d_point_scaled_to_composition", () => {
    const project = parse_project(SAMPLES_DIR.div("effects.aep"));
    const comp = get_comp(project, "effect_2dPoint");
    expect(len(comp.layers) >= 1).toBe(true);
    const layer = comp.layers[0];
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    const effect = layer.effects.properties[0] as PropertyGroup;
    let flare_center: Property | null = null;
    for (const prop of effect.properties) {
      if (prop.match_name === "ADBE Lens Flare-0001") {
        flare_center = prop as Property;
        break;
      }
    }
    expect(flare_center).not.toBeNull();
    if (flare_center === null) throw new AssertionError_("flare_center is None");
    expect(flare_center.property_value_type).toBe(PropertyValueType.TwoD_SPATIAL);
    // Value should be in pixel coordinates, not parT's 0-512 range
    expect(Array.isArray(flare_center.value)).toBe(true);
    expect(len(flare_center.value)).toBe(2);
    // Composition dimensions determine the scale
    expect(flare_center.value[0] <= comp.width).toBe(true);
    expect(flare_center.value[1] <= comp.height).toBe(true);
  });

  /**
   * AE 2026 reports isDropdownEffect on a Dropdown Menu Control's menu,
   * not on an effect's own popup.
   */
  test("test_only_dropdown_menu_controls_are_dropdown_effects", () => {
    const comp = get_comp(
      parse_project(SAMPLES_DIR.parent.div("essential_graphics", "dropdown_controller.aep")),
      "primary",
    );
    let layer = comp.layers.find((ly) => ly.name === "Gray Solid 1");
    if (layer === undefined) throw new StopIteration();
    const control = as_instance(
      layer.property("ADBE Effect Parade").property("Pseudo/@@nQHCs0tHTTGgMy9vbNKNrQ"),
      PropertyGroup,
    );
    expect(as_instance(control.property("Pseudo/@@nQHCs0tHTTGgMy9vbNKNrQ-0001"), Property).is_dropdown_effect).toBe(
      true,
    );

    layer = get_first_layer(parse_project(SAMPLES_DIR.div("2_gaussian.aep")));
    const blur = as_instance(layer.property("ADBE Effect Parade").property("ADBE Gaussian Blur 2"), PropertyGroup);
    expect(as_instance(blur.property("ADBE Gaussian Blur 2-0002"), Property).is_dropdown_effect).toBe(false);
  });

  /**
   * AE 2026 bounds a checkbox 0-1 even when it cannot vary over time,
   * except Puppet's (and Paint's) On Transparent.
   */
  test("test_checkboxes_are_bounded_0_1", () => {
    const comp = get_comp(parse_project(SAMPLES_DIR.div("all_animated.aep")), "type_camera");
    let layer = comp.layers.find((ly) => ly.name === "XF");
    if (layer === undefined) throw new StopIteration();
    const fill = as_instance(layer.property("ADBE Effect Parade").property("ADBE Fill"), PropertyGroup);
    const all_masks = as_instance(fill.property("ADBE Fill-0007"), Property);
    expect(all_masks.can_vary_over_time).toBe(false);
    expect(py_eq([all_masks.has_min, all_masks.min_value, all_masks.max_value], [true, 0, 1])).toBe(true);
    layer = get_layer(parse_project(SAMPLES_DIR.div("effects.aep")), "effect_puppet");
    const puppet = as_instance(layer.property("ADBE Effect Parade").property("ADBE FreePin3"), PropertyGroup);
    const on_transparent = as_instance(puppet.property("ADBE FreePin3 On Transparent"), Property);
    expect(py_eq([on_transparent.has_min, on_transparent.has_max], [false, false])).toBe(true);
    const auto_rotate = as_instance(puppet.property("ADBE FreePin3 Auto Rotate Pins"), Property);
    expect(py_eq([auto_rotate.has_min, auto_rotate.has_max], [true, true])).toBe(true);
  });
});

describe("TestTextPathOptions", () => {
  /** A text layer's Path picks one of its masks, None reading 0. */
  test("test_path_is_a_mask_index", () => {
    const comp = get_comp(parse_project(SAMPLES_DIR.div("all_animated.aep")), "type_text");
    const layer = comp.layers.find((ly) => ly.name === "TextLayer");
    if (layer === undefined) throw new StopIteration();
    const path = layer
      .property("ADBE Text Properties")
      .property("ADBE Text Path Options")
      .property("ADBE Text Path");
    expect(path.property_value_type).toBe(PropertyValueType.MASK_INDEX);
    expect(path.value).toBe(0);
  });
});

/** A 2D solid in a Classic 3D comp, each sample read by its own AE. */
class TestMaterialOptionsByVersion {
  static _materials(version: string): PropertyGroup {
    const comp = get_comp(parse_project(VERSIONS_DIR.div(version, "complete.aep")), "DropFrame_Comp");
    const layer = comp.layers.find((ly) => ly.name === "DF_Solid");
    if (layer === undefined) throw new StopIteration();
    py_assert(as_instance(layer, AVLayer).three_d_layer === false);
    return layer.property("ADBE Material Options Group");
  }
}

describe("TestMaterialOptionsByVersion", () => {
  /** AE 15.1, 22.5 and 23.6 show these options on a 2D layer too. */
  test.each<[string, boolean]>([
    ["ae2023", true],
    ["ae2024", false],
  ])("test_2d_layer_options_take_expressions_until_ae_23[%#]", (version, expected) => {
    const materials = TestMaterialOptionsByVersion._materials(version);
    for (const mn of ["ADBE Light Transmission", "ADBE Diffuse Coefficient"]) {
      expect(as_instance(materials.property(mn), Property).can_set_expression).toBe(expected);
    }
  });

  test.each<[string, boolean]>([
    ["ae2023", false],
    ["ae2024", true],
  ])("test_shadow_color_from_ae_24[%#]", (version, expected) => {
    const names = TestMaterialOptionsByVersion._materials(version).properties.map((p) => p.match_name);
    expect(names.includes("ADBE Shadow Color")).toBe(expected);
  });
});

class TestCanSetExpression {
  /** Tests for Property.can_set_expression. */

  static _get_main_comp_layer(index: number): Layer {
    const project = parse_project(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = get_comp(project, "Main_Comp");
    return comp.layers[index];
  }
}

describe("TestCanSetExpression", () => {
  /** Standard 2D AV layer transform properties are expressionable. */
  test("test_basic_av_layer_transform", () => {
    const layer = TestCanSetExpression._get_main_comp_layer(0);
    for (const mn of ["ADBE Position", "ADBE Scale", "ADBE Opacity", "ADBE Rotate Z"]) {
      const prop = _find_property(layer, mn);
      py_assert(prop != null, `${mn} not found`);
      py_assert(prop.can_set_expression === true, mn);
    }
  });

  /** 3D-only transform properties are not expressionable on 2D layers. */
  test("test_non_3d_layer_3d_only_props", () => {
    const layer = TestCanSetExpression._get_main_comp_layer(0);
    for (const mn of ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y"]) {
      const prop = _find_property(layer, mn);
      py_assert(prop != null, `${mn} not found`);
      py_assert(prop.can_set_expression === false, mn);
    }
  });

  /** 3D-only transform properties are expressionable on 3D layers. */
  test("test_3d_layer_3d_only_props", () => {
    const layer = TestCanSetExpression._get_main_comp_layer(11);
    for (const mn of ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y"]) {
      const prop = _find_property(layer, mn);
      py_assert(prop != null, `${mn} not found`);
      py_assert(prop.can_set_expression === true, mn);
    }
  });

  /** Dimension separation followers are never expressionable. */
  test("test_separation_followers_always_false", () => {
    const layer = TestCanSetExpression._get_main_comp_layer(0);
    for (const mn of ["ADBE Position_0", "ADBE Position_1"]) {
      const prop = _find_property(layer, mn);
      py_assert(prop != null, `${mn} not found`);
      py_assert(prop.can_set_expression === false, mn);
    }
  });

  /** Camera layers cannot set expressions on Scale/Opacity. */
  test("test_camera_layer", () => {
    const layer = TestCanSetExpression._get_main_comp_layer(15);
    const scale = _find_property(layer, "ADBE Scale");
    const opacity = _find_property(layer, "ADBE Opacity");
    const position = _find_property(layer, "ADBE Position");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError_("scale is None");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError_("opacity is None");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError_("position is None");
    expect(scale.can_set_expression).toBe(false);
    expect(opacity.can_set_expression).toBe(false);
    expect(position.can_set_expression).toBe(true);
  });

  /** All light layers cannot set expressions on Scale/Opacity. */
  test("test_light_scale_opacity_always_false", () => {
    for (const idx of [12, 13, 14]) {
      // ambient, spot, point
      const layer = TestCanSetExpression._get_main_comp_layer(idx);
      for (const mn of ["ADBE Scale", "ADBE Opacity"]) {
        const prop = _find_property(layer, mn);
        py_assert(prop != null, `layer[${idx}] ${mn} not found`);
        py_assert(prop.can_set_expression === false, `layer[${idx}] ${mn}`);
      }
    }
  });

  /**
   * A parallel light aims at its point of interest: no rotation
   * expressions.
   */
  test("test_parallel_light_rotation", () => {
    const project = parse_project(LAYER_SAMPLES_DIR.div("lightType.aep"));
    const light = get_comp(project, "lightType_PARALLEL").layers[0];
    for (const mn of ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Z"]) {
      const prop = _find_property(light, mn);
      py_assert(prop != null, `${mn} not found`);
      py_assert(prop.can_set_expression === false, mn);
    }
  });

  /** An environment light takes expressions on its rotations only. */
  test("test_environment_light", () => {
    const project = parse_project(LAYER_SAMPLES_DIR.div("light_source_default.aep"));
    const light = get_comp(project, "crystal").layers[0];
    const transform = light.property("ADBE Transform Group") as PropertyGroup;
    expect(transform.property("ADBE Rotate X").can_set_expression).toBe(true);
    expect(transform.property("ADBE Position").can_set_expression).toBe(false);
    const options = light.property("ADBE Light Options Group") as PropertyGroup;
    for (const mn of ["ADBE Light Color", "ADBE Light Falloff Type", "ADBE Light Shadow Diffusion"]) {
      expect(as_instance(options.property(mn), Property).can_set_expression).toBe(false);
    }
  });

  /**
   * A 3D model layer hides the material options its model replaces
   * and keeps plane bending and its own Shadow Color.
   */
  test("test_3d_model_layer", () => {
    const project = parse_project(LAYER_SAMPLES_DIR.div("light_source_default.aep"));
    const model = get_comp(project, "crystal").layers[2];
    const materials = model.property("ADBE Material Options Group") as PropertyGroup;
    for (const mn of ["ADBE Light Transmission", "ADBE Metal Coefficient", "ADBE Shadow Color"]) {
      expect(as_instance(materials.property(mn), Property).can_set_expression).toBe(false);
    }
    const plane = model.property("ADBE Plane Options Group") as PropertyGroup;
    expect(as_instance(plane.property("ADBE Plane Curvature"), Property).can_set_expression).toBe(true);
    const compositing = model.property("ADBE Compositing Options Group") as PropertyGroup;
    expect(as_instance(compositing.property("ADBE Shadow Color"), Property).can_set_expression).toBe(true);
  });

  /**
   * Effect parameters take expressions by parameter type, whatever
   * their name; a mask reference does not.
   */
  test("test_effect_params_follow_their_type", () => {
    const effects = TestCanSetExpression._get_main_comp_layer(1).property("ADBE Effect Parade") as PropertyGroup;
    const drop_shadow = effects.property("ADBE Drop Shadow") as PropertyGroup;
    expect(as_instance(drop_shadow.property("Distance"), Property).can_set_expression).toBe(true);
    expect(as_instance(drop_shadow.property("Softness"), Property).can_set_expression).toBe(true);
    const fill = effects.property("ADBE Fill") as PropertyGroup;
    expect(as_instance(fill.property("Color"), Property).can_set_expression).toBe(true);
    expect(as_instance(fill.property("Fill Mask"), Property).can_set_expression).toBe(false);
  });

  /** AE shows a stroke's Miter Limit only while it joins by miter. */
  test("test_stroke_miter_limit_needs_a_miter_join", () => {
    const layer = parse_project(SAMPLES_DIR.div("gradient.aep")).compositions[0].layers[0];
    const stroke = (layer
      .property("ADBE Root Vectors Group") as PropertyGroup)
      .property("ADBE Vector Graphic - G-Stroke") as PropertyGroup;
    expect(stroke.property("ADBE Vector Stroke Line Join").value).toBe(2); // round
    const miter = stroke.property("ADBE Vector Stroke Miter Limit");
    expect(miter.can_set_expression).toBe(false);
  });
});

describe("TestCanVaryOverTime", () => {
  /** Tests for Property.can_vary_over_time. */

  /** The Puppet Engine popup is fixed; its sibling toggles vary. */
  test("test_puppet_engine_cannot_vary", () => {
    const layer = get_layer(parse_project(SAMPLES_DIR.div("effects.aep")), "effect_puppet");
    const puppet = (layer.property("ADBE Effect Parade") as PropertyGroup).property("ADBE FreePin3") as PropertyGroup;
    const engine = as_instance(puppet.property("ADBE FreePin3 Puppet Engine"), Property);
    expect(engine.can_vary_over_time).toBe(false);
    expect(engine.can_set_expression).toBe(false);
    const auto_rotate = as_instance(puppet.property("ADBE FreePin3 Auto Rotate Pins"), Property);
    expect(auto_rotate.can_vary_over_time).toBe(true);
  });
});

describe("TestCanAddProperty", () => {
  /** Tests for PropertyGroup.can_add_property(). */

  /** Transform group is a NAMED_GROUP, not INDEXED_GROUP. */
  test("test_non_indexed_group_returns_false", () => {
    const project = parse_project(LAYER_SAMPLES_DIR.div("type.aep"));
    const comp = get_comp(project, "type_null");
    const layer = comp.layers[0];
    const transform = layer.transform;
    expect(transform.property_type).toBe(PropertyType.NAMED_GROUP);
    expect(transform.can_add_property("anything")).toBe(false);
  });

  test("test_empty_name_returns_false", () => {
    const project = parse_project(PROPERTY_SAMPLES_DIR.div("effects.aep"));
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    const effect_parade = layer.effects;
    if (effect_parade === null) throw new AssertionError_("layer.effects is None");
    expect(effect_parade.can_add_property("")).toBe(false);
  });

  /**
   * Effect Parade accepts the controls py_aep can create, by
   * match name or display name; unknown effects are rejected.
   */
  test("test_effect_parade_accepts_expression_controls", () => {
    const project = parse_project(PROPERTY_SAMPLES_DIR.div("effects.aep"));
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    const effect_parade = layer.effects;
    if (effect_parade === null) throw new AssertionError_("layer.effects is None");
    expect(effect_parade.match_name).toBe("ADBE Effect Parade");
    expect(effect_parade.property_type).toBe(PropertyType.INDEXED_GROUP);
    expect(effect_parade.can_add_property("ADBE Slider Control")).toBe(true);
    expect(effect_parade.can_add_property("Slider Control")).toBe(true);
    expect(effect_parade.can_add_property("ADBE Dropdown Control")).toBe(true);
    expect(effect_parade.can_add_property("ADBE Gaussian Blur 2")).toBe(false);
    expect(effect_parade.can_add_property("Some Custom Effect")).toBe(false);
  });

  test("test_mask_parade_accepts_mask_atom", () => {
    const project = parse_project(PROPERTY_SAMPLES_DIR.div("mask.aep"));
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    const mask_parade = layer.masks;
    if (mask_parade == null) {
      return skip("No mask parade found");
    }
    expect(mask_parade.match_name).toBe("ADBE Mask Parade");
    expect(mask_parade.can_add_property("ADBE Mask Atom")).toBe(true);
  });

  test("test_mask_parade_rejects_other_names", () => {
    const project = parse_project(PROPERTY_SAMPLES_DIR.div("mask.aep"));
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    const mask_parade = layer.masks;
    if (mask_parade == null) {
      return skip("No mask parade found");
    }
    expect(mask_parade.can_add_property("ADBE Position")).toBe(false);
    expect(mask_parade.can_add_property("ADBE Effect Parade")).toBe(false);
  });

  /** Root Vectors Group should accept valid shape match names. */
  test("test_shape_group_accepts_shape_names", () => {
    const project = parse_project(LAYER_SAMPLES_DIR.div("type.aep"));
    const comp = get_comp(project, "type_shape");
    const layer = comp.layers[0];
    let contents: Property | null = null;
    for (const prop of layer.properties) {
      if (prop.match_name === "ADBE Root Vectors Group") {
        contents = prop as Property;
        break;
      }
    }
    if (contents == null) {
      return skip("No Root Vectors Group found");
    }
    expect((contents as any).can_add_property("ADBE Vector Shape - Rect")).toBe(true);
    expect((contents as any).can_add_property("ADBE Vector Shape - Ellipse")).toBe(true);
    expect((contents as any).can_add_property("ADBE Vector Graphic - Fill")).toBe(true);
    expect((contents as any).can_add_property("ADBE Vector Group")).toBe(true);
    expect((contents as any).can_add_property("ADBE Vector Filter - Trim")).toBe(true);
  });

  test("test_shape_group_rejects_invalid_names", () => {
    const project = parse_project(LAYER_SAMPLES_DIR.div("type.aep"));
    const comp = get_comp(project, "type_shape");
    const layer = comp.layers[0];
    let contents: Property | null = null;
    for (const prop of layer.properties) {
      if (prop.match_name === "ADBE Root Vectors Group") {
        contents = prop as Property;
        break;
      }
    }
    if (contents == null) {
      return skip("No Root Vectors Group found");
    }
    expect((contents as any).can_add_property("ADBE Position")).toBe(false);
    expect((contents as any).can_add_property("ADBE Mask Atom")).toBe(false);
  });
});

class TestEffectPointSpeed {
  /**
   * Speed units for effect point properties.
   *
   * AE stores an effect point's ease speed normalized against the composition
   * height and ExtendScript reports it in pixel units, so reading the ease has
   * to scale by that height. `effect_point_speed.aep` is a Gradient Ramp whose
   * Start of Ramp is animated with BEZIER keys and an explicit ease on the
   * middle key; its `.json` is the ExtendScript ground truth.
   */
  static SAMPLE = SAMPLES_DIR.div("effect_point_speed.aep");
  static MATCH_NAME = "ADBE Ramp-0001";

  static _ramp_start(project: Project): Property {
    const comp = get_comp(project, "EffectPoint");
    const prop = (as_instance(comp.layers[0].effects, PropertyGroup).__getitem__(0) as PropertyGroup).property(TestEffectPointSpeed.MATCH_NAME);
    expect(prop instanceof Property).toBe(true);
    return prop as Property;
  }

  static _expected_keyframes(): any[] {
    const expected = load_expected(SAMPLES_DIR, "effect_point_speed");

    const walk = (node: any): any => {
      if (typeof node === "object" && node !== null && !Array.isArray(node)) {
        if (node["matchName"] === TestEffectPointSpeed.MATCH_NAME) {
          return node;
        }
        for (const value of Object.values(node)) {
          const found = walk(value);
          if (found != null) {
            return found;
          }
        }
      } else if (Array.isArray(node)) {
        for (const value of node) {
          const found = walk(value);
          if (found != null) {
            return found;
          }
        }
      }
      return null;
    };

    const node = walk(expected);
    expect(typeof node === "object" && node !== null && !Array.isArray(node)).toBe(true);
    return node["keyframes"];
  }
}

describe("TestEffectPointSpeed", () => {
  test("test_speeds_match_extendscript", () => {
    const prop = TestEffectPointSpeed._ramp_start(parse_project(TestEffectPointSpeed.SAMPLE));
    const expected = TestEffectPointSpeed._expected_keyframes();
    expect(len(prop.keyframes)).toBe(len(expected));
    for (const [keyframe, want] of zip(prop.keyframes, expected)) {
      expect(approx(keyframe.in_temporal_ease[0].speed, want["inTemporalEase"][0]["speed"])).toBe(true);
      expect(approx(keyframe.out_temporal_ease[0].speed, want["outTemporalEase"][0]["speed"])).toBe(true);
    }
  });

  test("test_factor_is_comp_height_not_width", () => {
    // The comp is 400x300 and the stored speeds are 0.4 / 0.8666...;
    // ExtendScript reports 120 / 260, i.e. exactly height (300) - the same
    // scalar for both directions, and independent of the width.
    const prop = TestEffectPointSpeed._ramp_start(parse_project(TestEffectPointSpeed.SAMPLE));
    expect(py_eq(prop._effect_scale, [400.0, 300.0])).toBe(true);
    expect(prop._effect_point_speed_factor).toBe(300.0);
    const middle = prop.keyframes[1];
    expect(approx((middle._ldat_item.kf_data as import("../../src/py_aep/binary/ldat_chunks.ts").KfPosition).in_speed, 0.4)).toBe(true);
    expect(approx(middle.in_temporal_ease[0].speed, 120.0)).toBe(true);
    expect(approx(middle.out_temporal_ease[0].speed, 260.0)).toBe(true);
  });

  test("test_reading_effect_scale_does_not_touch_ease", () => {
    // `_effect_scale` used to push factors onto every keyframe's ease on
    // each read, which made resolving a property's speeds quadratic in its
    // keyframe count. It must be a pure computation. Parsed fresh: the
    // cached project is shared, and reading ease anywhere creates it.
    const prop = TestEffectPointSpeed._ramp_start(parse_aep(TestEffectPointSpeed.SAMPLE).project);
    expect(
      prop.keyframes.every(
        (keyframe) => keyframe._in_temporal_ease == null && keyframe._out_temporal_ease == null,
      ),
    ).toBe(true);
    for (const _ of range(3)) {
      expect(prop._effect_scale).not.toBeNull();
    }
    expect(
      prop.keyframes.every(
        (keyframe) => keyframe._in_temporal_ease == null && keyframe._out_temporal_ease == null,
      ),
    ).toBe(true);
  });

  test("test_resolving_ease_stays_linear", () => {
    // One factor lookup per resolved ease, not a rescan of every keyframe.
    const prop = TestEffectPointSpeed._ramp_start(parse_project(TestEffectPointSpeed.SAMPLE));
    let lookups = 0;
    // NOTE(port): Python swaps `type(prop)._effect_point_speed_factor` for a counting
    // property on the class; this patches the accessor on the prototype the same way.
    const proto = Object.getPrototypeOf(prop) as object;
    const original = Object.getOwnPropertyDescriptor(proto, "_effect_point_speed_factor")!;
    const counting = function (this: Property): number | null {
      lookups += 1;
      return original.get!.call(this);
    };
    Object.defineProperty(proto, "_effect_point_speed_factor", { get: counting, configurable: true });
    try {
      for (const keyframe of prop.keyframes) {
        keyframe.in_temporal_ease;
        keyframe.out_temporal_ease;
      }
    } finally {
      Object.defineProperty(proto, "_effect_point_speed_factor", original);
    }

    expect(lookups <= 2 * len(prop.keyframes)).toBe(true);
  });

  test("test_speeds_are_stable_across_repeated_reads", () => {
    const prop = TestEffectPointSpeed._ramp_start(parse_project(TestEffectPointSpeed.SAMPLE));
    const first = prop.keyframes.map((kf) => kf.out_temporal_ease[0].speed);
    const second = prop.keyframes.map((kf) => kf.out_temporal_ease[0].speed);
    expect(py_eq(first, second)).toBe(true);
  });

  /**
   * A LINEAR effect point's speed is computed from the segment instead,
   * so it must not pick up the height factor.
   */
  test("test_linear_effect_point_speeds_unaffected", () => {
    const project = parse_project(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        const stack: (Property | PropertyGroup)[] = [...layer.properties];
        while (py_bool(stack)) {
          const child = stack.shift();
          if (child instanceof PropertyGroup) {
            stack.push(...child.properties);
          } else if (
            child instanceof Property &&
            child.match_name === "ADBE Geometry2-0001" &&
            py_bool(child.keyframes)
          ) {
            expect(py_eq(child._effect_scale, [2356.0, 1002.0])).toBe(true);
            expect(approx(child.keyframes[0].out_temporal_ease[0].speed, 29.151890878813)).toBe(true);
            expect(approx(child.keyframes[1].in_temporal_ease[0].speed, 29.151890878813)).toBe(true);
            return;
          }
        }
      }
    }
    fail("no keyframed ADBE Geometry2-0001 property found");
  });
});

describe("TestEffectPointNormalization", () => {
  /**
   * Effect point parameters normalize against the LAYER, not the
   * composition - including the parT defaults of parameters AE omits from
   * binary because they sit at their default.
   *
   * Measured in AE 2026 across three comp/layer size pairs: an untouched
   * Gradient Ramp `End of Ramp` (parT default 256, 512) reports [100, 100]
   * on a 200x100 layer in an 800x600 comp and [128, 256] on a 256x256
   * layer in a 512x512 comp. Only the layer reproduces both, which is why
   * the layer size is threaded through `_ParseContext`.
   */

  test("test_synthesized_point_uses_layer_not_comp", () => {
    const project = parse_aep(LAYER_SAMPLES_DIR.div("geometry_probe.aep")).project;
    const comp = get_comp(project, "PROBE_MAIN");
    const layer = as_instance(comp.layers.find((lay) => lay.name === "solid_default"), AVLayer);
    expect(py_eq([comp.width, comp.height], [1920, 1080])).toBe(true);
    expect(py_eq([layer.width, layer.height], [200, 100])).toBe(true);

    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    const point = as_instance(
      layer.effects.properties
        .filter((effect) => effect.name === "Point Control")
        .flatMap((effect) => (effect as PropertyGroup).properties)
        .find((child) => child.name === "Point"),
      Property,
    );
    expect(point._is_live()).toBe(false);
    // AE's default is the layer centre; the composition centre would be
    // [960, 540] - what py_aep reported before the layer was threaded in.
    expect(py_eq(point.value, [100.0, 50.0])).toBe(true);
  });

  /**
   * A 3D point's Z shares the height divisor (AE 2026: [100, 50, 7]
   * on a 200x100 layer stores [0.5, 0.5, 0.07]).
   */
  test("test_synthesized_3d_point_z_uses_height", () => {
    const project = parse_aep(LAYER_SAMPLES_DIR.div("geometry_probe.aep")).project;
    const comp = get_comp(project, "PROBE_MAIN");
    const layer = comp.layers.find((lay) => lay.name === "solid_default");
    if (layer === undefined) throw new StopIteration();
    if (layer.effects === null) throw new AssertionError_("layer.effects is None");
    const point = as_instance(
      layer.effects.properties
        .filter((effect) => effect.name === "3D Point Control")
        .flatMap((effect) => (effect as PropertyGroup).properties)
        .find((child) => child.name === "3D Point"),
      Property,
    );
    expect(py_eq(point.value, [100.0, 50.0, 0.0])).toBe(true);
    // The fixture's Z is 0, which every divisor reproduces, so assert the
    // divisor itself: [width, height, height], not [width, height, 1] or
    // the comp size.
    expect(py_eq(point._effect_scale, [200.0, 100.0, 100.0])).toBe(true);
  });
});

// json.loads at import time, as in Python.
const _MASK_LAYER_SPACE_PROBE: any = JSON.parse(
  SAMPLES_DIR.div("mask_layer_space_probe.json").read_text("utf-8"),
);

class TestMaskLayerSpace {
  /**
   * Mask Path values against AE 2026 (`mask_layer_space_probe.json`).
   *
   * A fresh mask stores no path: AE reports the rectangle bounding the
   * layer's mask space - its source's size, a unit square on a text or
   * shape layer, where a stored path is kept in layer pixels.
   */
  static _comp: CompItem | null = null;

  /** Class-scoped fixture (`@pytest.fixture(scope="class")`), cached once per run. */
  static comp(): CompItem {
    if (TestMaskLayerSpace._comp == null) {
      const project = parse_project(SAMPLES_DIR.div("mask_layer_space.aep"));
      TestMaskLayerSpace._comp = get_comp(project, "MASK_LAYER_SPACE");
    }
    return TestMaskLayerSpace._comp;
  }
}

describe("TestMaskLayerSpace", () => {
  test.each(sorted(Object.keys(_MASK_LAYER_SPACE_PROBE)))("test_mask_path_matches_ae[%#]", (key: string) => {
    const comp = TestMaskLayerSpace.comp();
    const [layer_name, mask_name] = key.split("/");
    const expected = _MASK_LAYER_SPACE_PROBE[key];
    const layer = comp.layers.find((lay) => lay.name === layer_name);
    if (layer === undefined) throw new StopIteration();
    if (layer.masks === null) throw new AssertionError_("layer.masks is None");
    const mask = as_instance(
      layer.masks.properties.find((m) => m.name === mask_name),
      MaskPropertyGroup,
    );
    // The fixture's fresh masks really are path-less.
    expect(mask._mask_shape_tdsb == null).toBe(mask_name === "Mask 1");
    const mask_path = mask.property("ADBE Mask Shape");
    expect(mask_path.property_value_type).toBe(PropertyValueType.SHAPE);
    expect(mask_path.can_set_expression).toBe(expected["canSetExpression"]);
    expect(mask_path.can_vary_over_time).toBe(expected["canVaryOverTime"]);
    expect(mask_path.is_modified).toBe(expected["isModified"]);
    const shape = mask_path.value;
    expect(shape.closed).toBe(expected["closed"]);
    for (const [attr, name] of [
      ["vertices", "vertices"],
      ["in_tangents", "inTangents"],
      ["out_tangents", "outTangents"],
    ] as const) {
      const got = getattr(shape, attr).flatMap((point: any) => [...point]);
      const want = expected[name].flatMap((point: any) => [...point]);
      py_assert(approx(got, want, { abs: 1e-4 }), attr);
    }
  });
});

/**
 * (fixture stem, mask name, sampled time / key or None for static).
 */
function _rotobezier_cases(): [string, string, string | null][] {
  const cases: [string, string, string | null][] = [];
  for (const stem of ["mask_rotobezier_shapes", "mask_rotobezier_tensions"]) {
    const probe = load_expected(SAMPLES_DIR, `${stem}_probe`);
    for (const mask of sorted(Object.keys(probe))) {
      const value = probe[mask];
      if ("vertices" in value) {
        cases.push([stem, mask, null]);
      } else {
        cases.push(
          ...sorted(Object.keys(value)).map((sample): [string, string, string | null] => [stem, mask, sample]),
        );
      }
    }
  }
  return cases;
}

describe("TestRotoBezierTangents", () => {
  /**
   * A RotoBezier mask reports the tangents After Effects derives from its
   * vertices and per-vertex tensions, not its stored handles
   * (`resolvers.roto_bezier`). Ground truth: AE 2026 reading each fixture in
   * a fresh session (`<stem>_probe.json`). `mask_rotobezier_shapes` holds
   * AE-scripted masks (tension 1, zero tangents, except one converted from
   * handles at 1/3); `mask_rotobezier_tensions` is the same file with the
   * tensions and Mask Path aspects byte-patched per layer (mixed tensions,
   * aspect 1.0, missing tensions, a keyframe without tensions).
   */
  test.each(_rotobezier_cases())(
    "test_tangents_match_ae[%#]",
    (stem: string, mask_name: string, sample: string | null) => {
      const probe = load_expected(SAMPLES_DIR, `${stem}_probe`);
      const expected = sample == null ? probe[mask_name] : probe[mask_name][sample];
      const comp = get_comp(parse_project(SAMPLES_DIR.div(`${stem}.aep`)), "ROTO");
      let mask: any = null;
      outer: for (const layer of comp.layers) {
        if (layer.masks === null) throw new AssertionError_("layer.masks is None");
        for (const m of layer.masks.properties) {
          if (m.name === mask_name) {
            mask = m;
            break outer;
          }
        }
      }
      expect(mask.roto_bezier).toBe(true);
      const mask_path = mask.property("ADBE Mask Shape");
      let shape: any;
      if (sample == null) {
        shape = mask_path.value;
      } else if (sample.startsWith("key")) {
        shape = mask_path.keyframes[int(sample.slice(3)) - 1].value;
      } else {
        shape = mask_path.value_at_time(float(sample));
      }
      expect(shape.closed).toBe(expected["closed"]);
      for (const [attr, name] of [
        ["vertices", "vertices"],
        ["in_tangents", "inTangents"],
        ["out_tangents", "outTangents"],
      ] as const) {
        const got = getattr(shape, attr).flatMap((point: any) => [...point]);
        const want = expected[name].flatMap((point: any) => [...point]);
        py_assert(approx(got, want, { abs: 1e-3 }), attr);
      }
    },
  );

  test("test_stale_aspect_sample_matches_extendscript", () => {
    // Tensions missing (1/3) and a Mask Path aspect of 1.0: AE measures
    // the full-layer rectangle as a unit square (mask_rotobezier_on.json).
    const layer = get_first_layer(parse_project(SAMPLES_DIR.div("mask_rotobezier_on.aep")));
    const shape = _get_mask_shape(layer).value;
    expect(approx(shape.in_tangents[0], [452.5483, -254.5584], { abs: 1e-3 })).toBe(true);
    expect(approx(shape.out_tangents[3], [-452.5483, -254.5584], { abs: 1e-3 })).toBe(true);
  });
});

describe("TestAnchorPointNormalization", () => {
  /**
   * A 3D anchor point's Z is normalized like its Y on a layer with a source.
   *
   * `anchor_point_z.aep` was built in AE 2026 and read back via ExtendScript.
   * A solid stores its anchor divided by the source size, Z by the height -
   * read with a divisor of 1, a 120 px Z on a 150 px tall solid came back as
   * 0.8. A shape layer has no source and keeps its anchor in pixels.
   */
  test.each([
    ["solid", [100.0, 75.0, 120.0]],
    ["shape", [10.0, 20.0, 30.0]],
  ])("test_static_anchor_point[%#]", (layer_name: string, expected: number[]) => {
    const comp = get_comp(parse_aep(SAMPLES_DIR.div("anchor_point_z.aep")).project, "anchor_z");
    const layer = comp.layers.find((lay) => lay.name === layer_name);
    if (layer === undefined) throw new StopIteration();
    const anchor = (layer.property("ADBE Transform Group") as PropertyGroup).property("ADBE Anchor Point");
    expect(approx(anchor.value, expected)).toBe(true);
  });

  test("test_animated_anchor_point", () => {
    const comp = get_comp(parse_aep(SAMPLES_DIR.div("anchor_point_z.aep")).project, "anchor_z");
    const layer = comp.layers.find((lay) => lay.name === "solid_animated");
    if (layer === undefined) throw new StopIteration();
    const anchor = (layer.property("ADBE Transform Group") as PropertyGroup).property("ADBE Anchor Point");
    const values = anchor.keyframes.map((kf) => kf.value);
    expect(len(values)).toBe(2);
    expect(approx(values[0], [150.0, 50.0, 0.0])).toBe(true);
    expect(approx(values[1], [150.0, 50.0, 80.0])).toBe(true);
  });
});
