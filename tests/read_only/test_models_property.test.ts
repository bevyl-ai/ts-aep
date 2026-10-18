/** Tests for Property model parsing with strengthened assertions. */

import { describe, expect, test } from "bun:test";
import { approx, skip, fail } from "../../src/pyrt/pytest.ts";
import {
  AssertionError,
  IndexError,
  Path,
  StopIteration,
  float,
  getMember,
  getOrThrow,
  int,
  len,
  pyAnd,
  assert,
  truthy,
  valueEquals,
  truthyOr,
  range,
  repr,
  getOrInsert,
  sorted,
  str,
  zip,
} from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { getComp, getCompFromJsonByName, getFirstLayer, getLayer, loadExpected, parseProject } from "../conftest.ts";
import { asInstance, jsonField, type ExpectedProject, type ExpectedProperty } from "../helpers.ts";
import { Project, parse as parseAep, type Application } from "../../src/py_aep/index.ts";
import { KeyframeInterpolationType, MaskFeatherFalloff, MaskMode, MaskMotionBlur, PropertyType, PropertyValueType } from "../../src/py_aep/enums/index.ts";
import { KfPosition } from "../../src/py_aep/binary/ldat_chunks.ts";
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
function _findProperty(layer: Layer, matchName: string): Property | null {
  for (const prop of layer.transform) {
    if (prop.matchName === matchName) {
      return asInstance(prop, Property);
    }
  }
  return null;
}

/** Extract transform properties from the expected JSON structure. */
// NOTE(port): load_expected returns JSON.parse output (plain objects, tests/helpers.ts), so
// `.get(...)` is property access and `"k" in x` is unchanged; missing keys compare unequal as in Python.
function _getJsonTransformProperties(expected: ExpectedProject, compName = ""): ExpectedProperty[] {
  for (const item of expected["items"]) {
    if ("layers" in item) {
      if (truthy(compName) && item["name"] !== compName) {
        continue;
      }
      for (const group of item["layers"][0]["properties"]) {
        if (group["matchName"] === "ADBE Transform Group") {
          return jsonField(group, "properties");
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
function _jsonValuesByMatchName(expected: unknown): Map<unknown, unknown> {
  const values = new Map<unknown, unknown>();

  const walk = (node: unknown): void => {
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
      if ("propertyType" in node && node.propertyType === "Property" && "matchName" in node) {
        getOrInsert(values, node.matchName, "value" in node ? node.value ?? null : null);
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
function _getMaskShape(layer: Layer): Property<Shape> {
  expect(layer.masks).not.toBeNull();
  if (layer.masks === null) throw new AssertionError("layer.masks is None");
  const mask = asInstance(layer.masks.properties[0], MaskPropertyGroup);
  for (const prop of mask.properties) {
    if (prop.matchName === "ADBE Mask Shape") {
      return asInstance(prop, Property);
    }
  }
  throw new AssertionError("ADBE Mask Shape not found");
}

describe("TestExpressions", () => {
  /** Position has expression 'wiggle(2, 50)' and is enabled. */
  test("test_expression_enabled", () => {
    const expected = loadExpected(SAMPLES_DIR, "expression");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("expression.aep")), "expression_enabled");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    expect(position.expressionEnabled).toBe(true);
    expect(position.expression).toBe("wiggle(2, 50)");
    // Verify against JSON
    for (const prop of _getJsonTransformProperties(expected, "expression_enabled")) {
      if (prop["matchName"] === "ADBE Position") {
        expect(prop["expressionEnabled"]).toBe(true);
        expect(prop["expression"]).toBe("wiggle(2, 50)");
      }
    }
  });

  /** Opacity has expression '50' but expression is disabled. */
  test("test_expression_disabled", () => {
    const expected = loadExpected(SAMPLES_DIR, "expression");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("expression.aep")), "expression_disabled");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(opacity.expressionEnabled).toBe(false);
    expect(opacity.expression).toBe("50");
    // Value should be the static value, not the expression result
    for (const prop of _getJsonTransformProperties(expected, "expression_disabled")) {
      if (prop["matchName"] === "ADBE Opacity") {
        expect(prop["expressionEnabled"]).toBe(false);
        expect(prop["expression"]).toBe("50");
        expect(prop["value"]).toBe(100);
      }
    }
  });

  /** Rotation has expression 'time * 36' and is enabled. */
  test("test_expression_time", () => {
    const expected = loadExpected(SAMPLES_DIR, "expression");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("expression.aep")), "expression_time");
    const rotation = _findProperty(layer, "ADBE Rotate Z");
    expect(rotation).not.toBeNull();
    if (rotation === null) throw new AssertionError("rotation is None");
    expect(rotation.expressionEnabled).toBe(true);
    expect(rotation.expression).toBe("time * 36");
    // Verify against JSON
    for (const prop of _getJsonTransformProperties(expected, "expression_time")) {
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
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_labels.aep")), "TestComp");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(valueEquals(opacity.keyframes.map((kf) => int(kf.label)), [1, 5, 16, 0, 0])).toBe(true);
  });
});

describe("TestKeyframes", () => {
  /** Tests for keyframe interpolation types. */

  /** Position has 2 LINEAR keyframes with values [0,50,0] and [100,50,0]. */
  test("test_keyframe_LINEAR", () => {
    const layer = getLayer(
      parseProject(SAMPLES_DIR.div("keyframe_interpolation.aep")),
      "keyframe_LINEAR",
    );
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    expect(position._animated).toBe(true);
    expect(len(position.keyframes)).toBe(2);
    for (const kf of position.keyframes) {
      expect(kf.outInterpolationType).toBe(KeyframeInterpolationType.LINEAR);
    }
    expect(valueEquals(position.keyframes[0].value, [0.0, 50.0, 0.0])).toBe(true);
    expect(valueEquals(position.keyframes[1].value, [100.0, 50.0, 0.0])).toBe(true);
  });

  /** Position has 2 BEZIER keyframes with values [0,50,0] and [100,50,0]. */
  test("test_keyframe_BEZIER", () => {
    const layer = getLayer(
      parseProject(SAMPLES_DIR.div("keyframe_interpolation.aep")),
      "keyframe_BEZIER",
    );
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    expect(position._animated).toBe(true);
    expect(len(position.keyframes)).toBe(2);
    for (const kf of position.keyframes) {
      expect(kf.outInterpolationType).toBe(KeyframeInterpolationType.BEZIER);
    }
    expect(valueEquals(position.keyframes[0].value, [0.0, 50.0, 0.0])).toBe(true);
    expect(valueEquals(position.keyframes[1].value, [100.0, 50.0, 0.0])).toBe(true);
  });

  /** Opacity has 3 keyframes, second is HOLD, values 1.0/0.0/1.0. */
  test("test_keyframe_HOLD", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_HOLD");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(opacity._animated).toBe(true);
    expect(len(opacity.keyframes)).toBe(3);
    // Keyframe 2 (index 1) is HOLD
    expect(opacity.keyframes[1].outInterpolationType).toBe(KeyframeInterpolationType.HOLD);
    expect(opacity.keyframes[0].value).toBe(100.0);
    expect(opacity.keyframes[1].value).toBe(0.0);
    expect(opacity.keyframes[2].value).toBe(100.0);
  });
});

describe("TestPropertyStructure", () => {
  /** Tests for property structural attributes (depth, index, is_time_varying). */

  /** Transform properties are at depth 2 (layer=0, transform-group=1, prop=2). */
  test("test_transform_properties_depth", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    // All transform properties should be at depth 2
    for (const prop of layer.transform.properties) {
      assert(prop.propertyDepth === 2, `${prop.matchName} has depth ${prop.propertyDepth}, expected 2`);
    }
  });

  /** Effects (PropertyGroup) are at depth 2; their properties at depth 3. */
  test("test_effect_depth", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("effects.aep")), "effect_2dPoint");
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    expect(len(layer.effects.properties) > 0).toBe(true);
    const effect = asInstance(layer.effects.properties[0], PropertyGroup);
    expect(effect.propertyDepth).toBe(2);
    for (const prop of effect.properties) {
      assert(prop.propertyDepth === 3, `${prop.matchName} has depth ${prop.propertyDepth}, expected 3`);
    }
  });

  /** Opacity with keyframes has is_time_varying == True. */
  test("test_is_time_varying_with_keyframes", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(opacity.isTimeVarying).toBe(true);
  });

  /** Position with enabled expression has is_time_varying == True. */
  test("test_is_time_varying_with_expression", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("expression.aep")), "expression_enabled");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    expect(position.isTimeVarying).toBe(true);
  });

  /** A non-animated property with no actual expression has is_time_varying == False. */
  test("test_is_time_varying_static", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_rotation");
    // Only ADBE Rotate Z is animated; ADBE Rotate X is static
    const rotateX = _findProperty(layer, "ADBE Rotate X");
    expect(rotateX).not.toBeNull();
    if (rotateX === null) throw new AssertionError("rotate_x is None");
    expect(truthy(rotateX._animated)).toBe(false);
    expect(rotateX.isTimeVarying).toBe(false);
  });
});

describe("TestPropertyDimensions", () => {
  /** Tests for property value types and dimensions. */

  /** Opacity is a 1D property with 2 keyframes going 0>100. */
  test("test_property_1D_opacity", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(opacity.dimensions).toBe(1);
    expect(opacity._animated).toBe(true);
    expect(len(opacity.keyframes)).toBe(2);
  });

  /** Position in a 2D layer has 2 keyframes. */
  test("test_property_2D_position", () => {
    const expected = loadExpected(SAMPLES_DIR, "property_types");
    const project = parseProject(SAMPLES_DIR.div("property_types.aep"));
    const layer = getLayer(project, "property_2D_position");
    // Verify the layer is not 3D
    const compJson = getCompFromJsonByName(expected, "property_2D_position");
    expect(compJson["layers"][0]["threeDLayer"]).toBe(false);
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    expect(position._animated).toBe(true);
    expect(len(position.keyframes)).toBe(2);
  });

  /** Position in a 3D layer has 3 dimensions and 2 keyframes. */
  test("test_property_3D_position", () => {
    const expected = loadExpected(SAMPLES_DIR, "property_types");
    const project = parseProject(SAMPLES_DIR.div("property_types.aep"));
    const layer = getLayer(project, "property_3D_position");
    // Verify the layer is 3D
    const compJson = getCompFromJsonByName(expected, "property_3D_position");
    expect(compJson["layers"][0]["threeDLayer"]).toBe(true);
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    expect(position._animated).toBe(true);
    expect(len(position.keyframes)).toBe(2);
  });

  /** Rotation is a 1D property with 2 keyframes going 0>360. */
  test("test_property_rotation", () => {
    const expected = loadExpected(SAMPLES_DIR, "property_types");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_rotation");
    const rotation = _findProperty(layer, "ADBE Rotate Z");
    expect(rotation).not.toBeNull();
    if (rotation === null) throw new AssertionError("rotation is None");
    expect(rotation.dimensions).toBe(1);
    expect(rotation._animated).toBe(true);
    expect(len(rotation.keyframes)).toBe(2);
    // Verify against JSON
    for (const prop of _getJsonTransformProperties(expected, "property_rotation")) {
      if (prop["matchName"] === "ADBE Rotate Z") {
        expect(prop["numKeys"]).toBe(2);
      }
    }
  });

  /** Scale has 2 keyframes. */
  test("test_property_scale", () => {
    const expected = loadExpected(SAMPLES_DIR, "property_types");
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_scale");
    const scale = _findProperty(layer, "ADBE Scale");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError("scale is None");
    expect(scale._animated).toBe(true);
    expect(len(scale.keyframes)).toBe(2);
    // Verify against JSON
    for (const prop of _getJsonTransformProperties(expected, "property_scale")) {
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
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_scale");
    const scale = _findProperty(layer, "ADBE Scale");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError("scale is None");
    expect(scale.dimensions).toBe(3);
    expect(scale.propertyValueType).toBe(PropertyValueType.ThreeD);
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
    const layer = getFirstLayer(parseProject(LAYER_SAMPLES_DIR.div("orientation_0.aep")));
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(valueEquals(orientation.value, [0.0, 0.0, 0.0])).toBe(true);
    expect(orientation.dimensions).toBe(3);
  });

  /** Orientation with only X component set to 5. */
  test("test_orientation_x_only", () => {
    const layer = getFirstLayer(parseProject(LAYER_SAMPLES_DIR.div("orientation_5_0_0.aep")));
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(valueEquals(orientation.value, [5.0, 0.0, 0.0])).toBe(true);
    expect(orientation.dimensions).toBe(3);
    expect(orientation.isSpatial).toBe(true);
  });

  /** Orientation with only Y component set to 279. */
  test("test_orientation_y_only", () => {
    const layer = getFirstLayer(parseProject(LAYER_SAMPLES_DIR.div("orientation_0_279_0.aep")));
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(valueEquals(orientation.value, [0.0, 279.0, 0.0])).toBe(true);
    expect(orientation.dimensions).toBe(3);
  });

  /** Orientation with only Z component set to 5. */
  test("test_orientation_z_only", () => {
    const layer = getFirstLayer(parseProject(LAYER_SAMPLES_DIR.div("orientation_0_0_5.aep")));
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(valueEquals(orientation.value, [0.0, 0.0, 5.0])).toBe(true);
    expect(orientation.dimensions).toBe(3);
  });

  /** Orientation has correct property metadata. */
  test("test_orientation_metadata", () => {
    const layer = getFirstLayer(parseProject(LAYER_SAMPLES_DIR.div("orientation_5_0_0.aep")));
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(orientation.name).toBe("Orientation");
    expect(orientation.matchName).toBe("ADBE Orientation");
    expect(orientation.isSpatial).toBe(true);
    expect(orientation._vector).toBe(true);
    expect(truthy(orientation._animated)).toBe(false);
  });

  /** Animated orientation keyframes carry 3-component values from otda. */
  test("test_orientation_animated_keyframe_values", () => {
    const layer = getFirstLayer(parseProject(LAYER_SAMPLES_DIR.div("orientation_with_keyframes.aep")));
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(orientation._animated).toBe(true);
    expect(len(orientation.keyframes)).toBe(2);
    expect(valueEquals(orientation.keyframes[0].value, [5.0, 0.0, 0.0])).toBe(true);
    expect(valueEquals(orientation.keyframes[1].value, [0.0, 0.0, 0.0])).toBe(true);
  });

  /** Animated orientation keyframes have correct frame times. */
  test("test_orientation_animated_keyframe_times", () => {
    const layer = getFirstLayer(parseProject(LAYER_SAMPLES_DIR.div("orientation_with_keyframes.aep")));
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(orientation.keyframes[0].frameTime).toBe(0);
    expect(orientation.keyframes[1].frameTime).toBe(240);
  });

  /** Animated orientation retains correct property metadata. */
  test("test_orientation_animated_metadata", () => {
    const layer = getFirstLayer(parseProject(LAYER_SAMPLES_DIR.div("orientation_with_keyframes.aep")));
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(orientation.dimensions).toBe(3);
    expect(orientation.isSpatial).toBe(true);
    expect(orientation._vector).toBe(true);
    expect(valueEquals(orientation.value, [5.0, 0.0, 0.0])).toBe(true);
  });
});

describe("TestEffectProperties", () => {
  /** Tests for effect-related property samples. */

  test("test_effect_2dPoint", () => {
    const project = parseProject(SAMPLES_DIR.div("effects.aep"));
    const comp = getComp(project, "effect_2dPoint");
    expect(project instanceof Project).toBe(true);
    expect(len(comp.layers) >= 1).toBe(true);
  });

  test("test_effect_3dPoint", () => {
    const project = parseProject(SAMPLES_DIR.div("effects.aep"));
    const comp = getComp(project, "effect_3dPoint");
    expect(project instanceof Project).toBe(true);
    expect(len(comp.layers) >= 1).toBe(true);
  });

  test("test_effect_puppet", () => {
    const project = parseProject(SAMPLES_DIR.div("effects.aep"));
    const comp = getComp(project, "effect_puppet");
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
    const project = parseProject(SAMPLES_DIR.div("2_gaussian.aep"));
    const layer = getFirstLayer(project);
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    expect(len(layer.effects.properties)).toBe(2);
    for (const effect of layer.effects) {
      expect(effect.matchName).toBe("ADBE Gaussian Blur 2");
      expect(effect.isEffect).toBe(true);
    }
    // Second effect should have a user-defined name
    expect(layer.effects.properties[0].name).toBe("Gaussian Blur");
    expect(layer.effects.properties[1].name).toBe("Gaussian Blur 2");
  });

  /** Gaussian Blur effects with non-default Blurriness values 20 and 30. */
  test("test_duplicate_effects_values", () => {
    const project = parseProject(SAMPLES_DIR.div("2_gaussian_20_30.aep"));
    const layer = getFirstLayer(project);
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    expect(len(layer.effects.properties)).toBe(2);

    // Each effect should have a Blurriness property with modified value
    const effect0 = asInstance(layer.effects.properties[0], PropertyGroup);
    let blurriness0: Property | null = null;
    for (const prop of effect0.properties) {
      if (prop.matchName === "ADBE Gaussian Blur 2-0001") {
        blurriness0 = asInstance(prop, Property);
        break;
      }
    }
    expect(blurriness0).not.toBeNull();
    if (blurriness0 === null) throw new AssertionError("blurriness_0 is None");
    expect(blurriness0.value).toBe(20.0);

    const effect1 = asInstance(layer.effects.properties[1], PropertyGroup);
    let blurriness1: Property | null = null;
    for (const prop of effect1.properties) {
      if (prop.matchName === "ADBE Gaussian Blur 2-0001") {
        blurriness1 = asInstance(prop, Property);
        break;
      }
    }
    expect(blurriness1).not.toBeNull();
    if (blurriness1 === null) throw new AssertionError("blurriness_1 is None");
    expect(blurriness1.value).toBe(30.0);
  });

  /**
   * LAYER_INDEX effect property reads layer index from tdpi chunk.
   *
   * The S_BlurDirectional effect's "Matte from Layer" parameter has
   * property_value_type LAYER_INDEX. When no layer is selected the
   * value is 0.
   */
  test("test_layer_index_value", () => {
    const project = parseProject(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
    // Find the S_BlurDirectional effect in any composition
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        if (layer.effects == null) {
          continue;
        }
        for (const item of layer.effects) {
          const effect = asInstance(item, PropertyGroup);
          if (effect.name === "S_BlurDirectional") {
            for (const prop of effect.properties) {
              if (prop.name === "Matte from Layer") {
                expect(asInstance(prop, Property).propertyValueType).toBe(PropertyValueType.LAYER_INDEX);
                expect(asInstance(prop, Property).value).toBe(0);
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
    const project = parseProject(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
    const expected = loadExpected(BUGS_DIR, "29.97_fps_time_scale_3.125");
    const jsonValues = _jsonValuesByMatchName(expected);
    let checked = 0;
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        if (layer.effects == null) {
          continue;
        }
        for (const item of layer.effects) {
          const effect = asInstance(item, PropertyGroup);
          if (effect.matchName !== "S_BlurDirectional") {
            continue;
          }
          for (const matchName of ["S_BlurDirectional-0063", "S_BlurDirectional-0068"]) {
            const prop = asInstance(effect.property(matchName), Property);
            expect(valueEquals(prop.value, getOrThrow(jsonValues, matchName))).toBe(true);
            expect(prop.isModified).toBe(false);
            checked += 1;
          }
        }
      }
    }
    expect(getOrThrow(jsonValues, "S_BlurDirectional-0063")).toBe(3);
    expect(getOrThrow(jsonValues, "S_BlurDirectional-0068")).toBe(2);
    expect(truthy(checked)).toBe(true);
  });

  /**
   * An omitted point parameter is its pard default percentage of the
   * layer size: Path Text's 80 % x 50 % on a 100 x 100 layer reports
   * exactly [80, 50] in ExtendScript, not the cached 16.16 fraction
   * (0.79998779 x 100).
   */
  // skipif: samples/debug is not committed
  test.skipIf(!CANVARY_DIR.isDir())("test_omitted_point_takes_pard_default", () => {
    const project = parseProject(CANVARY_DIR.div("effects_canvary.aep"));
    const expected = loadExpected(CANVARY_DIR, "effects_canvary");
    expect(valueEquals(getOrThrow(_jsonValuesByMatchName(expected), "ADBE Path Text-0020"), [80, 50])).toBe(true);
    const layer = getLayer(project, "type_null");
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    const prop = asInstance(
      asInstance(layer.effects.property("ADBE Path Text"), PropertyGroup).property("ADBE Path Text-0020"),
      Property,
    );
    expect(valueEquals(prop.value, [80.0, 50.0])).toBe(true);
    expect(prop.isModified).toBe(false);
  });

  /**
   * MASK_INDEX effect property reads mask index from tdli chunk.
   *
   * The S_BlurDirectional effect's "Matte from Path" parameter has
   * property_value_type MASK_INDEX.  Value 1 means mask #1.
   */
  test("test_mask_index_value", () => {
    const project = parseProject(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        if (layer.effects == null) {
          continue;
        }
        for (const item of layer.effects) {
          const effect = asInstance(item, PropertyGroup);
          if (effect.name === "S_BlurDirectional") {
            for (const prop of effect.properties) {
              if (prop.name === "Matte from Path") {
                expect(asInstance(prop, Property).propertyValueType).toBe(PropertyValueType.MASK_INDEX);
                expect(asInstance(prop, Property).value).toBe(1);
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
  ])("test_param_absent_from_tdgp_is_at_its_default[%#]", (matchName: string, expected: number) => {
    const project = parseProject(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        for (const effect of truthyOr(layer.effects, [])) {
          if (effect.matchName !== "S_BlurDirectional") {
            continue;
          }
          const prop = asInstance(effect, PropertyGroup).property(matchName);
          expect(prop instanceof Property).toBe(true);
          if (!(prop instanceof Property)) throw new AssertionError("prop is not a Property");
          expect(prop.value).toBe(expected);
          expect(prop.defaultValue).toBe(expected);
          expect(prop.isModified).toBe(false);
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
    const layer = getLayer(parseProject(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    expect(layer.masks.isMask).toBe(false);
    expect(layer.masks.matchName).toBe("ADBE Mask Parade");
    expect(layer.masks.propertyType).toBe(PropertyType.INDEXED_GROUP);
    expect(len(layer.masks.properties)).toBe(1);
    expect(layer.masks.properties[0].isMask).toBe(true);
  });

  /** Layer with two masks: Mask Parade has is_mask=False, atoms have is_mask=True. */
  test("test_is_mask_multiple", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("mask.aep")), "is_mask_multiple");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    expect(layer.masks.isMask).toBe(false);
    expect(len(layer.masks.properties)).toBe(2);
    for (const mask of layer.masks.properties) {
      expect(mask.isMask).toBe(true);
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
  ])("test_mask_vertices_on_each_layer_kind[%#]", (layerName: string, expected: number[][]) => {
    const project = parseProject(SAMPLES_DIR.div("mask_shape_and_text_layers.aep"));
    const comp = getComp(project, "masks_on_layer_kinds");
    const layer = comp.layers.find((layer) => layer.name === layerName);
    if (layer === undefined) throw new StopIteration();
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    const shape = asInstance(layer.masks.properties[0], PropertyGroup).property("ADBE Mask Shape").value;
    expect(len(shape.vertices)).toBe(len(expected));
    for (const [vertex, want] of zip(shape.vertices, expected)) {
      expect(approx(vertex, want, { abs: 1e-4 })).toBe(true);
    }
  });

  /** Layer without masks has an empty (falsy) mask parade. */
  test("test_no_masks", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    expect(truthy(layer.masks)).toBe(false);
  });

  /** Mask children have parent_property pointing to mask parade. */
  test("test_mask_parent_property", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    for (const mask of layer.masks.properties) {
      expect(mask.parentProperty).toBe(layer.masks);
    }
  });

  /** Each mask atom is a MaskPropertyGroup instance. */
  test("test_mask_atom_is_mask_property_group", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    expect(len(layer.masks.properties)).toBe(1);
    expect(layer.masks.properties[0] instanceof MaskPropertyGroup).toBe(true);
  });

  /** Default mask has inverted=False. */
  test("test_mask_atom_inverted_default", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    const mask = asInstance(layer.masks.properties[0], MaskPropertyGroup);
    expect(mask instanceof MaskPropertyGroup).toBe(true);
    expect(mask.inverted).toBe(false);
  });

  /** Default mask has locked=False. */
  test("test_mask_atom_locked_default", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    const mask = asInstance(layer.masks.properties[0], MaskPropertyGroup);
    expect(mask instanceof MaskPropertyGroup).toBe(true);
    expect(mask.locked).toBe(false);
  });

  /** Default mask has mask_mode=MaskMode.ADD. */
  test("test_mask_atom_mode_default", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    const mask = asInstance(layer.masks.properties[0], MaskPropertyGroup);
    expect(mask instanceof MaskPropertyGroup).toBe(true);
    expect(mask.maskMode).toBe(MaskMode.ADD);
  });

  /** All mask atoms in a multi-mask layer are MaskPropertyGroup. */
  test("test_mask_multiple_all_mask_property_groups", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("mask.aep")), "is_mask_multiple");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    for (const mask of layer.masks.properties) {
      expect(mask instanceof MaskPropertyGroup).toBe(true);
    }
  });

  /** MaskPropertyGroup children point to the mask atom as parent. */
  test("test_mask_children_parent_is_mask_group", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("mask.aep")), "is_mask_true");
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    const mask = asInstance(layer.masks.properties[0], MaskPropertyGroup);
    expect(mask instanceof MaskPropertyGroup).toBe(true);
    for (const child of mask.properties) {
      expect(child.parentProperty).toBe(mask);
    }
  });
});

class TestMaskAttributes {
  /** Parse a mask sample and return the first MaskPropertyGroup. */
  static _get_mask(filename: string): MaskPropertyGroup {
    const project = parseProject(SAMPLES_DIR.div(filename));
    const layer = getFirstLayer(project);
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    const mask = asInstance(layer.masks.properties[0], MaskPropertyGroup);
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
    expect(mask.maskFeatherFalloff).toBe(MaskFeatherFalloff.FFO_SMOOTH);
  });

  /** Feather falloff Linear. */
  test("test_feather_falloff_linear", () => {
    const mask = TestMaskAttributes._get_mask("mask_feather_falloff_linear.aep");
    expect(mask.maskFeatherFalloff).toBe(MaskFeatherFalloff.FFO_LINEAR);
  });

  // --- maskMotionBlur ---

  /** Motion blur Same as Layer is the default. */
  test("test_motion_blur_same_as_layer", () => {
    const mask = TestMaskAttributes._get_mask("mask_motion_blur_same_as_layer.aep");
    expect(mask.maskMotionBlur).toBe(MaskMotionBlur.SAME_AS_LAYER);
  });

  /** Motion blur On. */
  test("test_motion_blur_on", () => {
    const mask = TestMaskAttributes._get_mask("mask_motion_blur_on.aep");
    expect(mask.maskMotionBlur).toBe(MaskMotionBlur.ON);
  });

  /** Motion blur Off. */
  test("test_motion_blur_off", () => {
    const mask = TestMaskAttributes._get_mask("mask_motion_blur_off.aep");
    expect(mask.maskMotionBlur).toBe(MaskMotionBlur.OFF);
  });

  // --- rotoBezier ---

  /** Default mask has rotoBezier=False. */
  test("test_roto_bezier_default_false", () => {
    const mask = TestMaskAttributes._get_mask("mask_add.aep");
    expect(mask.rotoBezier).toBe(false);
  });

  /** Mask with RotoBezier enabled. */
  test("test_roto_bezier_on", () => {
    const mask = TestMaskAttributes._get_mask("mask_rotobezier_on.aep");
    expect(mask.rotoBezier).toBe(true);
  });

  // --- mask_mode (all modes via from_binary) ---

  test("test_mask_mode_none", () => {
    const mask = TestMaskAttributes._get_mask("mask_none.aep");
    expect(mask.maskMode).toBe(MaskMode.NONE);
  });

  test("test_mask_mode_add", () => {
    const mask = TestMaskAttributes._get_mask("mask_add.aep");
    expect(mask.maskMode).toBe(MaskMode.ADD);
  });

  test("test_mask_mode_subtract", () => {
    const mask = TestMaskAttributes._get_mask("mask_subtract.aep");
    expect(mask.maskMode).toBe(MaskMode.SUBTRACT);
  });

  test("test_mask_mode_intersect", () => {
    const mask = TestMaskAttributes._get_mask("mask_intersect.aep");
    expect(mask.maskMode).toBe(MaskMode.INTERSECT);
  });

  test("test_mask_mode_darken", () => {
    const mask = TestMaskAttributes._get_mask("mask_darken.aep");
    expect(mask.maskMode).toBe(MaskMode.DARKEN);
  });

  test("test_mask_mode_lighten", () => {
    const mask = TestMaskAttributes._get_mask("mask_lighten.aep");
    expect(mask.maskMode).toBe(MaskMode.LIGHTEN);
  });

  test("test_mask_mode_difference", () => {
    const mask = TestMaskAttributes._get_mask("mask_difference.aep");
    expect(mask.maskMode).toBe(MaskMode.DIFFERENCE);
  });
});

describe("TestIsModified", () => {
  /** Tests for PropertyBase.isModified computed property. */

  /** Transform properties at their default values have is_modified=False. */
  test("test_transform_defaults_at_default_values", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("is_modified_false.aep")));
    // These transform properties are at their defaults in this sample.
    for (const matchName of [
      "ADBE Orientation",
      "ADBE Rotate X",
      "ADBE Rotate Y",
      "ADBE Envir Appear in Reflect",
    ]) {
      const prop = _findProperty(layer, matchName);
      if (prop != null) {
        assert(
          prop.isModified === false,
          `${matchName}: expected is_modified=False, value=${repr(prop.value)}, default=${repr(prop.defaultValue)}`,
        );
      }
    }
  });

  /** X/Y Position followers moved to 0 from center are is_modified=True. */
  test("test_separated_position_modified", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("is_modified_false.aep")));
    const posX = _findProperty(layer, "ADBE Position_0");
    const posY = _findProperty(layer, "ADBE Position_1");
    if (posX != null) {
      assert(
        posX.isModified === true,
        `X Position value=${str(posX.value)}, default=${str(posX.defaultValue)}`,
      );
    }
    if (posY != null) {
      assert(
        posY.isModified === true,
        `Y Position value=${str(posY.value)}, default=${str(posY.defaultValue)}`,
      );
    }
  });

  /** Transform group is_modified=True when any child is modified. */
  test("test_transform_group_is_modified", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("is_modified_false.aep")));
    expect(layer.transform).not.toBeNull();
    // X/Y Position are moved > at least one child is modified
    expect(layer.transform.isModified).toBe(true);
  });

  /** Effect Parade (indexed group) with effects has is_modified=True. */
  test("test_effect_parade_indexed_group_with_children", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("is_modified_false.aep")));
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    expect(layer.effects.propertyType).toBe(PropertyType.INDEXED_GROUP);
    expect(len(layer.effects.properties) > 0).toBe(true);
    expect(layer.effects.isModified).toBe(true);
  });

  /** An animated property (with keyframes) has is_modified=True. */
  test("test_animated_property_is_modified", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(opacity._animated).toBe(true);
    expect(opacity.isModified).toBe(true);
  });

  /** Property with enabled expression has is_modified=True. */
  test("test_expression_enabled_is_modified", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("expression.aep")), "expression_enabled");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    expect(position.expressionEnabled).toBe(true);
    expect(position.isModified).toBe(true);
  });

  /** Property with disabled expression is still modified (expression text present). */
  test("test_expression_disabled_not_modified", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("expression.aep")), "expression_disabled");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(opacity.expressionEnabled).toBe(false);
    // AE considers a property modified whenever an expression exists,
    // regardless of whether the expression is enabled.
    expect(opacity.expression).not.toBeNull();
    expect(opacity.isModified).toBe(true);
  });

  /** Scale [100,100,100] at default is is_modified=False. */
  test("test_scale_at_default_not_modified", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_rotation");
    const scale = _findProperty(layer, "ADBE Scale");
    if (scale != null && scale.defaultValue != null) {
      assert(
        scale.isModified === false,
        `Scale value=${str(scale.value)}, default=${str(scale.defaultValue)}`,
      );
    }
  });

  /** Effect properties at their default values have is_modified=False. */
  test("test_effect_properties_at_default", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("is_modified_false.aep")));
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    for (const item of layer.effects) {
      const effect = asInstance(item, PropertyGroup);
      for (const prop of effect.properties) {
        if (prop instanceof Property && prop.defaultValue != null) {
          // In this sample all effect params are at defaults
          assert(
            prop.isModified === false,
            `${prop.matchName}: value=${repr(prop.value)}, default=${repr(prop.defaultValue)}`,
          );
        }
      }
    }
  });

  /** Effect property with value != default has is_modified=True. */
  test("test_effect_modified_value", () => {
    const project = parseProject(SAMPLES_DIR.div("2_gaussian_20_30.aep"));
    const layer = getFirstLayer(project);
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    const effect = asInstance(layer.effects.properties[0], PropertyGroup);
    let blurriness: Property | null = null;
    for (const prop of effect.properties) {
      if (prop.matchName === "ADBE Gaussian Blur 2-0001") {
        blurriness = asInstance(prop, Property);
        break;
      }
    }
    expect(blurriness).not.toBeNull();
    if (blurriness === null) throw new AssertionError("blurriness is None");
    expect(blurriness.value).toBe(20.0);
    // Blurriness default from pard chunk is 0.0
    if (blurriness.defaultValue != null) {
      expect(blurriness.isModified).toBe(true);
    }
  });

  /** Property with no default_value returns is_modified=False (conservative). */
  test("test_no_default_value_not_modified", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    // Check a property that might not have a default
    for (const prop of layer.transform.properties) {
      if (prop instanceof Property && prop.defaultValue == null) {
        if (!prop._animated && !truthy(pyAnd(prop.expression, prop.expressionEnabled))) {
          assert(prop.isModified === false, `${prop.matchName} with no default should be False`);
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
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("transform_separated.aep")));
    const pos = _findProperty(layer, "ADBE Position");
    expect(pos).not.toBeNull();
    if (pos === null) throw new AssertionError("pos is None");
    expect(pos.isSeparationLeader).toBe(true);
    expect(pos.isSeparationFollower).toBe(false);
    expect(pos.separationDimension).toBeNull();
  });

  /** Position_0/1/2 are always separation followers. */
  test("test_is_separation_follower", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("transform_separated.aep")));
    for (const [suffix, dim] of [
      ["_0", 0],
      ["_1", 1],
      ["_2", 2],
    ] as const) {
      const prop = _findProperty(layer, `ADBE Position${suffix}`);
      assert(prop != null, `ADBE Position${suffix} not found`);
      expect(prop.isSeparationFollower).toBe(true);
      expect(prop.isSeparationLeader).toBe(false);
      expect(prop.separationDimension).toBe(dim);
    }
  });

  /** Position.getSeparationFollower(dim) returns the follower. */
  test("test_get_separation_follower", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("transform_separated.aep")));
    const pos = _findProperty(layer, "ADBE Position");
    expect(pos).not.toBeNull();
    if (pos === null) throw new AssertionError("pos is None");
    for (const dim of range(3)) {
      const follower = pos.getSeparationFollower(dim);
      assert(follower != null, `follower dim ${dim} is None`);
      expect(follower.matchName).toBe(`ADBE Position_${dim}`);
    }
  });

  /** Follower.separationLeader returns the Position property. */
  test("test_separation_leader_back_reference", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("transform_separated.aep")));
    const pos = _findProperty(layer, "ADBE Position");
    const xPos = _findProperty(layer, "ADBE Position_0");
    expect(xPos).not.toBeNull();
    if (xPos === null) throw new AssertionError("x_pos is None");
    expect(xPos.separationLeader).toBe(pos);
  });

  /** Leader/follower roles hold even when never separated. */
  test("test_before_separation_still_structural", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("before_separation.aep")));
    const pos = _findProperty(layer, "ADBE Position");
    expect(pos).not.toBeNull();
    if (pos === null) throw new AssertionError("pos is None");
    expect(pos.isSeparationLeader).toBe(true);
    expect(pos.dimensionsSeparated).toBe(false);

    const xPos = _findProperty(layer, "ADBE Position_0");
    expect(xPos).not.toBeNull();
    if (xPos === null) throw new AssertionError("x_pos is None");
    expect(xPos.isSeparationFollower).toBe(true);
    expect(xPos.separationDimension).toBe(0);
  });

  /** Opacity has neither leader nor follower role. */
  test("test_non_position_not_separation", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("transform_separated.aep")));
    const opa = _findProperty(layer, "ADBE Opacity");
    expect(opa).not.toBeNull();
    if (opa === null) throw new AssertionError("opa is None");
    expect(opa.isSeparationLeader).toBe(false);
    expect(opa.isSeparationFollower).toBe(false);
    expect(opa.separationDimension).toBeNull();
    expect(opa.separationLeader).toBeNull();
    expect(opa.getSeparationFollower(0)).toBeNull();
  });

  /** Leader/follower roles hold after un-separating. */
  test("test_unseparated_structural", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("transform_unseparated.aep")));
    const pos = _findProperty(layer, "ADBE Position");
    expect(pos).not.toBeNull();
    if (pos === null) throw new AssertionError("pos is None");
    expect(pos.isSeparationLeader).toBe(true);
    expect(pos.dimensionsSeparated).toBe(false);

    const yPos = _findProperty(layer, "ADBE Position_1");
    expect(yPos).not.toBeNull();
    if (yPos === null) throw new AssertionError("y_pos is None");
    expect(yPos.isSeparationFollower).toBe(true);
    expect(yPos.separationDimension).toBe(1);
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
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("is_modified_false.aep")));
    expect(layer.transform).not.toBeNull();
    expect(len(layer.transform.properties)).toBe(12);
  });

  /** Properties appear in the canonical ExtendScript order. */
  test("test_canonical_order", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("is_modified_false.aep")));
    const matchNames = layer.transform.properties.map((p) => p.matchName);
    expect(valueEquals(matchNames, TestTransformSynthesis._CANONICAL_ORDER)).toBe(true);
  });

  /** Orientation always present with correct defaults. */
  test("test_synthesized_orientation_metadata", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(orientation.defaultValue).not.toBeNull();
    expect(orientation.isModified).toBe(false);
  });

  /** X Rotation always present with correct defaults. */
  test("test_synthesized_rotate_x_metadata", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const rotateX = _findProperty(layer, "ADBE Rotate X");
    expect(rotateX).not.toBeNull();
    if (rotateX === null) throw new AssertionError("rotate_x is None");
    expect(rotateX.dimensions).toBe(1);
    expect(rotateX.defaultValue).not.toBeNull();
    expect(rotateX.isModified).toBe(false);
  });

  /** Non-animated transform properties at default have is_modified=False. */
  test("test_synthesized_value_equals_default", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    // All non-animated transform properties should have a default and
    // be at that default (the sample only animates Opacity).
    for (const prop of layer.transform.properties) {
      if (prop instanceof Property && !prop._animated) {
        assert(prop.defaultValue != null, `${prop.matchName} should have a default_value`);
      }
    }

    // Verify specific properties
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(orientation.isModified).toBe(false);

    const rotateX = _findProperty(layer, "ADBE Rotate X");
    expect(rotateX).not.toBeNull();
    if (rotateX === null) throw new AssertionError("rotate_x is None");
    expect(rotateX.value).toBe(0.0);
    expect(rotateX.isModified).toBe(false);
  });

  /** Synthesized properties have animated=False. */
  test("test_synthesized_not_animated", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    for (const matchName of ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y"]) {
      const prop = _findProperty(layer, matchName);
      expect(prop).not.toBeNull();
      if (prop === null) throw new AssertionError("prop is None");
      assert(!prop._animated, `${matchName} should not be animated`);
      expect(prop.expression).toBe("");
      expect(valueEquals(prop.keyframes, [])).toBe(true);
    }
  });

  /** Synthesized properties point to the transform group as parent. */
  test("test_synthesized_parent_property", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    for (const prop of layer.transform.properties) {
      assert(prop.parentProperty === layer.transform, `${prop.matchName} parent should be transform group`);
    }
  });

  /** Appears in Reflections is synthesised with correct name and value. */
  test("test_envir_appear_in_reflect", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const envir = _findProperty(layer, "ADBE Envir Appear in Reflect");
    expect(envir).not.toBeNull();
    if (envir === null) throw new AssertionError("envir is None");
    expect(envir.name).toBe("Appears in Reflections");
    expect(envir.value).toBe(1.0);
    expect(envir.defaultValue).toBe(1.0);
    expect(envir.isModified).toBe(false);
  });

  /** Another sample (property_rotation) also gets 12 transform props. */
  test("test_property_rotation_twelve_properties", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_rotation");
    expect(layer.transform).not.toBeNull();
    expect(len(layer.transform.properties)).toBe(12);
    const matchNames = layer.transform.properties.map((p) => p.matchName);
    expect(valueEquals(matchNames, TestTransformSynthesis._CANONICAL_ORDER)).toBe(true);
  });
});

describe("TestUnitsText", () => {
  /**
   * Tests for Property.unitsText.
   *
   * The `unitsText` attribute is determined by the property's `match_name`
   * and returns one of `"pixels"`, `"degrees"`, `"percent"`,
   * `"seconds"`, `"dB"`, or `""` (no unit).
   */

  // -- Transform properties ------------------------------------------------

  /** Anchor Point and Position report 'pixels'. */
  test("test_transform_pixels", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const anchor = _findProperty(layer, "ADBE Anchor Point");
    expect(anchor).not.toBeNull();
    if (anchor === null) throw new AssertionError("anchor is None");
    expect(anchor.unitsText).toBe("pixels");

    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    expect(position.unitsText).toBe("pixels");
  });

  /** Scale and Opacity report 'percent'. */
  test("test_transform_percent", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const scale = _findProperty(layer, "ADBE Scale");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError("scale is None");
    expect(scale.unitsText).toBe("percent");

    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(opacity.unitsText).toBe("percent");
  });

  /** Rotation and Orientation report 'degrees'. */
  test("test_transform_degrees", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_rotation");
    const rotateZ = _findProperty(layer, "ADBE Rotate Z");
    expect(rotateZ).not.toBeNull();
    if (rotateZ === null) throw new AssertionError("rotate_z is None");
    expect(rotateZ.unitsText).toBe("degrees");

    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation).not.toBeNull();
    if (orientation === null) throw new AssertionError("orientation is None");
    expect(orientation.unitsText).toBe("degrees");
  });

  /** Appears in Reflections has empty units_text. */
  test("test_transform_no_unit", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const envir = _findProperty(layer, "ADBE Envir Appear in Reflect");
    expect(envir).not.toBeNull();
    if (envir === null) throw new AssertionError("envir is None");
    expect(envir.unitsText).toBe("");
  });

  // -- Separated position followers ----------------------------------------

  /** X/Y/Z Position followers report 'pixels'. */
  test("test_separation_followers_pixels", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("transform_separated.aep")));
    for (const mn of ["ADBE Position_0", "ADBE Position_1"]) {
      const prop = _findProperty(layer, mn);
      assert(prop != null, `${mn} missing`);
      assert(prop.unitsText === "pixels", `${mn} wrong units`);
    }
  });

  // -- Mask properties -----------------------------------------------------

  /** Mask Feather reports 'pixels'. */
  test("test_mask_feather_pixels", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("mask_add.aep")));
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    const mask = asInstance(layer.masks.properties[0], MaskPropertyGroup);
    // Mask children: [0]=MaskPath, [1]=Feather, [2]=Opacity, [3]=Expansion
    const feather = asInstance(mask.properties[1], Property);
    expect(feather.matchName).toBe("ADBE Mask Feather");
    expect(feather.unitsText).toBe("pixels");
  });

  /** Mask Opacity reports 'percent'. */
  test("test_mask_opacity_percent", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("mask_add.aep")));
    expect(layer.masks).not.toBeNull();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    const mask = asInstance(layer.masks.properties[0], MaskPropertyGroup);
    const opacity = asInstance(mask.properties[2], Property);
    expect(opacity.matchName).toBe("ADBE Mask Opacity");
    expect(opacity.unitsText).toBe("percent");
  });

  // -- Effect properties ---------------------------------------------------

  /** Effect Mask Opacity (Compositing Options) reports 'percent'. */
  test("test_effect_mask_opacity_percent", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("effects.aep")), "effect_2dPoint");
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    const effect = asInstance(layer.effects.properties[0], PropertyGroup);
    // Compositing Options group is the last child of an effect
    let compOpts: PropertyGroup | null = null;
    for (const child of effect.properties) {
      if (child.matchName === "ADBE Effect Built In Params") {
        compOpts = asInstance(child, PropertyGroup);
        break;
      }
    }
    expect(compOpts).not.toBeNull();
    if (compOpts === null) throw new AssertionError("comp_opts is None");
    let opacity: Property | null = null;
    for (const child of compOpts.properties) {
      if (child.matchName === "ADBE Effect Mask Opacity") {
        opacity = asInstance(child, Property);
        break;
      }
    }
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(opacity.unitsText).toBe("percent");
  });

  /** Every effect has Compositing Options with its expected children. */
  test("test_compositing_options_always_present", () => {
    const project = parseProject(SAMPLES_DIR.div("effects.aep"));
    const layer = getLayer(project, "effect_2dPoint");
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    for (const item of layer.effects) {
      const effect = asInstance(item, PropertyGroup);
      const compOpts = effect.property("ADBE Effect Built In Params");
      assert(compOpts != null, `Effect ${repr(effect.name)} missing Compositing Options`);
      expect(compOpts.name).toBe("Compositing Options");
      const childMns = asInstance(compOpts, PropertyGroup).properties.map((c) => c.matchName);
      expect(childMns.includes("ADBE Effect Mask Parade")).toBe(true);
      expect(childMns.includes("ADBE Effect Mask Opacity")).toBe(true);
      expect(childMns.includes("ADBE Force CPU GPU")).toBe(true);
    }
  });

  /** Gaussian Blur Blurriness has no units in the map > empty string. */
  test("test_effect_property_no_unit", () => {
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("2_gaussian_20_30.aep")));
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    const effect = asInstance(layer.effects.properties[0], PropertyGroup);
    let blurriness: Property | null = null;
    for (const child of effect.properties) {
      if (child.matchName === "ADBE Gaussian Blur 2-0001") {
        blurriness = asInstance(child, Property);
        break;
      }
    }
    expect(blurriness).not.toBeNull();
    if (blurriness === null) throw new AssertionError("blurriness is None");
    expect(blurriness.unitsText).toBe("");
  });

  // -- Unknown match name --------------------------------------------------

  /** Unknown match names default to empty string. */
  test("test_unknown_match_name_empty", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("property_types.aep")), "property_1D_opacity");
    const envir = _findProperty(layer, "ADBE Envir Appear in Reflect");
    expect(envir).not.toBeNull();
    if (envir === null) throw new AssertionError("envir is None");
    expect(envir.unitsText).toBe("");
  });
});

describe("TestKeyframeInterpolationTypes", () => {
  /** Tests for in/out interpolation type fields on keyframes. */

  /** LINEAR keyframes have matching in/out interpolation types. */
  test("test_linear_in_out_match", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_LINEAR");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    for (const kf of position.keyframes) {
      expect(kf.inInterpolationType).toBe(KeyframeInterpolationType.LINEAR);
      expect(kf.outInterpolationType).toBe(KeyframeInterpolationType.LINEAR);
    }
  });

  /** BEZIER keyframes have matching in/out interpolation types. */
  test("test_bezier_in_out_match", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_BEZIER");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    for (const kf of position.keyframes) {
      expect(kf.inInterpolationType).toBe(KeyframeInterpolationType.BEZIER);
      expect(kf.outInterpolationType).toBe(KeyframeInterpolationType.BEZIER);
    }
  });

  /** Mixed interpolation keyframes have different in/out types. */
  test("test_mixed_interpolation", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(len(opacity.keyframes)).toBe(4);
    // KF[0]: LINEAR in/out
    expect(opacity.keyframes[0].inInterpolationType).toBe(KeyframeInterpolationType.LINEAR);
    expect(opacity.keyframes[0].outInterpolationType).toBe(KeyframeInterpolationType.LINEAR);
    // KF[1]: BEZIER in, HOLD out
    expect(opacity.keyframes[1].inInterpolationType).toBe(KeyframeInterpolationType.BEZIER);
    expect(opacity.keyframes[1].outInterpolationType).toBe(KeyframeInterpolationType.HOLD);
    // KF[2]: HOLD in, LINEAR out
    expect(opacity.keyframes[2].inInterpolationType).toBe(KeyframeInterpolationType.HOLD);
    expect(opacity.keyframes[2].outInterpolationType).toBe(KeyframeInterpolationType.LINEAR);
    // KF[3]: LINEAR in/out
    expect(opacity.keyframes[3].inInterpolationType).toBe(KeyframeInterpolationType.LINEAR);
    expect(opacity.keyframes[3].outInterpolationType).toBe(KeyframeInterpolationType.LINEAR);
  });
});

describe("TestTemporalEase", () => {
  /** Tests for in/out temporal ease on keyframes. */

  /** 1D Bezier ease has one KeyframeEase per keyframe. */
  test("test_bezier_ease_in_out_1d", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_bezier_ease_in_out_1D");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    for (const kf of opacity.keyframes) {
      expect(len(kf.inTemporalEase)).toBe(1);
      expect(len(kf.outTemporalEase)).toBe(1);
    }
  });

  /** Scale (3D) has three KeyframeEase per keyframe. */
  test("test_bezier_ease_scale_multi_dim", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_misc.aep")), "keyframe_bezier_ease_scale");
    const scale = _findProperty(layer, "ADBE Scale");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError("scale is None");
    expect(len(scale.keyframes) >= 2).toBe(true);
    for (const kf of scale.keyframes) {
      expect(len(kf.inTemporalEase)).toBe(3);
      expect(len(kf.outTemporalEase)).toBe(3);
    }
  });

  /** Scale ease-scale sample: KF0 out influence=75, KF1 in influence=75. */
  test("test_bezier_ease_scale_influence_values", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_misc.aep")), "keyframe_bezier_ease_scale");
    const scale = _findProperty(layer, "ADBE Scale");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError("scale is None");
    // KF0 out_ease all 75%
    for (const ease of scale.keyframes[0].outTemporalEase) {
      expect(Math.abs(ease.influence - 75.0) < 0.01).toBe(true);
    }
    // KF1 in_ease all 75%
    for (const ease of scale.keyframes[1].inTemporalEase) {
      expect(Math.abs(ease.influence - 75.0) < 0.01).toBe(true);
    }
  });

  /** Percent property speeds are scaled to match ExtendScript units. */
  test("test_bezier_nonzero_speed", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_bezier_nonzero_speed");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    // KF0 out speed = 20 (%/sec), KF1 in speed = 15 (%/sec)
    expect(Math.abs(opacity.keyframes[0].outTemporalEase[0].speed - 20.0) < 0.1).toBe(true);
    expect(Math.abs(opacity.keyframes[1].inTemporalEase[0].speed - 15.0) < 0.1).toBe(true);
  });

  /** Asymmetric ease has different in/out influence values. */
  test("test_bezier_asymmetric_ease", () => {
    const layer = getLayer(
      parseProject(SAMPLES_DIR.div("keyframe_1D.aep")),
      "keyframe_bezier_asymmetric_ease_1D",
    );
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    // Should have at least 2 keyframes with different in/out
    const kf0 = opacity.keyframes[0];
    expect(len(kf0.inTemporalEase)).toBe(1);
    expect(len(kf0.outTemporalEase)).toBe(1);
  });

  /** Spatial properties (Position) always have 1 ease element. */
  test("test_spatial_position_single_ease", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_spatial.aep")), "keyframe_spatial_bezier_arc");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    for (const kf of position.keyframes) {
      expect(len(kf.inTemporalEase)).toBe(1);
      expect(len(kf.outTemporalEase)).toBe(1);
    }
  });

  /** Bounce pattern has 10 keyframes, each with ease data. */
  test("test_bounce_pattern_ease_count", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_bounce_pattern");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(len(opacity.keyframes)).toBe(10);
    for (const kf of opacity.keyframes) {
      expect(len(kf.inTemporalEase)).toBe(1);
      expect(len(kf.outTemporalEase)).toBe(1);
    }
  });
});

describe("TestSpatialTangents", () => {
  /** Tests for in/out spatial tangents on keyframes. */

  /** Spatial bezier arc has non-None tangent vectors. */
  test("test_spatial_tangents_present", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_spatial.aep")), "keyframe_spatial_bezier_arc");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    for (const kf of position.keyframes) {
      expect(kf.inSpatialTangent).not.toBeNull();
      expect(kf.outSpatialTangent).not.toBeNull();
      expect(len(kf.inSpatialTangent)).toBe(3); // x, y, z
      expect(len(kf.outSpatialTangent)).toBe(3);
    }
  });

  /** Spatial bezier arc: KF0 out tangent = [60, -80, 0]. */
  test("test_spatial_tangent_values_arc", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_spatial.aep")), "keyframe_spatial_bezier_arc");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    const kf0 = position.keyframes[0];
    expect(kf0.outSpatialTangent).not.toBeNull();
    if (kf0.outSpatialTangent === null) throw new AssertionError("kf0.out_spatial_tangent is None");
    expect(Math.abs(kf0.outSpatialTangent[0] - 60.0) < 0.01).toBe(true);
    expect(Math.abs(kf0.outSpatialTangent[1] - -80.0) < 0.01).toBe(true);
    expect(Math.abs(kf0.outSpatialTangent[2] - 0.0) < 0.01).toBe(true);
  });

  /** Non-spatial properties (Opacity) have None tangents. */
  test("test_non_spatial_no_tangents", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_bezier_ease_in_out_1D");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    for (const kf of opacity.keyframes) {
      expect(kf.inSpatialTangent).toBeNull();
      expect(kf.outSpatialTangent).toBeNull();
    }
  });

  /** 3D spatial bezier has 3-component tangent vectors. */
  test("test_3d_spatial_tangents", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_spatial.aep")), "keyframe_spatial_bezier_3D");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    for (const kf of position.keyframes) {
      expect(kf.inSpatialTangent).not.toBeNull();
      expect(kf.outSpatialTangent).not.toBeNull();
      expect(len(kf.inSpatialTangent)).toBe(3);
      expect(len(kf.outSpatialTangent)).toBe(3);
    }
  });

  /** S-curve: KF1 in tangent = [-40, -60, 0]. */
  test("test_s_curve_spatial_tangents", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_spatial.aep")), "keyframe_spatial_bezier_s_curve");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    const kf1 = position.keyframes[1];
    expect(kf1.inSpatialTangent).not.toBeNull();
    if (kf1.inSpatialTangent === null) throw new AssertionError("kf1.in_spatial_tangent is None");
    expect(Math.abs(kf1.inSpatialTangent[0] - -40.0) < 0.01).toBe(true);
    expect(Math.abs(kf1.inSpatialTangent[1] - -60.0) < 0.01).toBe(true);
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
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_LINEAR");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    const kf0 = position.keyframes[0];
    // [0,50,0] > [100,50,0] over 5 seconds (120 frames @ 24fps)
    // distance = 100, speed = 100/5 = 20
    expect(Math.abs(kf0.outTemporalEase[0].speed - 20.0) < 0.01).toBe(true);
    expect(Math.abs(kf0.outTemporalEase[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** LINEAR position: KF1 in speed = distance / time. */
  test("test_linear_position_in_speed", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_LINEAR");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    const kf1 = position.keyframes[1];
    expect(Math.abs(kf1.inTemporalEase[0].speed - 20.0) < 0.01).toBe(true);
    expect(Math.abs(kf1.inTemporalEase[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** First keyframe in a LINEAR property has in speed = 0. */
  test("test_linear_first_keyframe_in_speed_zero", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_LINEAR");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    const kf0 = position.keyframes[0];
    expect(Math.abs(kf0.inTemporalEase[0].speed) < 0.001).toBe(true);
    expect(Math.abs(kf0.inTemporalEase[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** Last keyframe in a LINEAR property has out speed = 0. */
  test("test_linear_last_keyframe_out_speed_zero", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_interpolation.aep")), "keyframe_LINEAR");
    const position = _findProperty(layer, "ADBE Position");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    const kfLast = position.keyframes.at(-1);
    if (kfLast === undefined) throw new IndexError("list index out of range");
    expect(Math.abs(kfLast.outTemporalEase[0].speed) < 0.001).toBe(true);
    expect(
      Math.abs(kfLast.outTemporalEase[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001,
    ).toBe(true);
  });

  /** Mixed interpolation: LINEAR opacity out speed = value_change / time. */
  test("test_mixed_linear_opacity_speed", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    // KF[0] (100%) > KF[1] (0%) over 3 sec (72 frames @ 24fps)
    // speed = (0 - 100) / 3 = -33.333
    const kf0 = opacity.keyframes[0];
    expect(Math.abs(kf0.outTemporalEase[0].speed - -100.0 / 3.0) < 0.01).toBe(true);
    expect(Math.abs(kf0.outTemporalEase[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** HOLD out keyframe has speed = 0 and influence = 100/6. */
  test("test_mixed_hold_out_speed_zero", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    // KF[1]: BEZIER in, HOLD out
    const kf1 = opacity.keyframes[1];
    expect(Math.abs(kf1.outTemporalEase[0].speed) < 0.001).toBe(true);
    expect(Math.abs(kf1.outTemporalEase[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** HOLD in keyframe has speed = 0 and influence = 100/6. */
  test("test_mixed_hold_in_speed_zero", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    // KF[2]: HOLD in, LINEAR out
    const kf2 = opacity.keyframes[2];
    expect(Math.abs(kf2.inTemporalEase[0].speed) < 0.001).toBe(true);
    expect(Math.abs(kf2.inTemporalEase[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** LINEAR out after HOLD in computes speed from adjacent keyframes. */
  test("test_mixed_linear_out_after_hold", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    // KF[2] (100%) > KF[3] (50%) over 3 sec (72 frames @ 24fps)
    // speed = (50 - 100) / 3 = -16.667
    const kf2 = opacity.keyframes[2];
    expect(Math.abs(kf2.outTemporalEase[0].speed - -50.0 / 3.0) < 0.01).toBe(true);
    expect(Math.abs(kf2.outTemporalEase[0].influence - TestLinearHoldEase.DEFAULT_INFLUENCE) < 0.001).toBe(true);
  });

  /** BEZIER keyframes retain their stored binary ease values. */
  test("test_bezier_ease_unchanged", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("keyframe_1D.aep")), "keyframe_mixed_interpolation");
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    // KF[1]: BEZIER in - binary stores (speed=0, influence=0)
    const kf1 = opacity.keyframes[1];
    expect(Math.abs(kf1.inTemporalEase[0].speed) < 0.001).toBe(true);
    expect(Math.abs(kf1.inTemporalEase[0].influence) < 0.001).toBe(true);
  });
});

describe("TestShapeValue", () => {
  /** Tests for Shape value parsing (vertices, tangents, feather). */

  /** Closed square mask has 4 vertices at the expected positions. */
  test("test_closed_square_vertices", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("shape_basic.aep")), "shape_closed_square");
    const shape = _getMaskShape(layer).value;
    expect(shape.closed).toBe(true);
    expect(len(shape.vertices)).toBe(4);
    expect(
      valueEquals(shape.vertices, [
        [100.0, 100.0],
        [100.0, 300.0],
        [300.0, 300.0],
        [300.0, 100.0],
      ]),
    ).toBe(true);
  });

  /** Closed square mask has zero tangents (straight line segments). */
  test("test_closed_square_tangents_zero", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("shape_basic.aep")), "shape_closed_square");
    const shape = _getMaskShape(layer).value;
    for (const t of [...shape.inTangents, ...shape.outTangents]) {
      expect(valueEquals(t, [0, 0])).toBe(true);
    }
  });

  /** Closed square mask has no feather points. */
  test("test_closed_square_no_feather", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("shape_basic.aep")), "shape_closed_square");
    const shape = _getMaskShape(layer).value;
    expect(valueEquals(shape.featherPoints, [])).toBe(true);
  });

  /** Closed oval mask has non-zero tangents. */
  test("test_closed_oval_tangents", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("shape_basic.aep")), "shape_closed_oval");
    const shape = _getMaskShape(layer).value;
    expect(shape.closed).toBe(true);
    expect(len(shape.vertices)).toBe(4);
    // Tangents should be non-zero (bezier curves)
    for (const t of [...shape.inTangents, ...shape.outTangents]) {
      expect(!valueEquals(t, [0, 0])).toBe(true);
    }
  });

  /** Open path mask has closed=False. */
  test("test_open_path", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("shape_basic.aep")), "shape_open");
    const shape = _getMaskShape(layer).value;
    expect(shape.closed).toBe(false);
    expect(len(shape.vertices)).toBe(4);
  });

  /** Feather points mask has 2 outer feather points at segments 1 and 2. */
  test("test_feather_points", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("shape_feather.aep")), "shape_feather_points");
    const shape = _getMaskShape(layer).value;
    expect(len(shape.featherPoints)).toBe(2);
    const [fp0, fp1] = shape.featherPoints;
    expect(fp0.segLoc).toBe(1);
    expect(fp0.relSegLoc).toBe(0.15);
    expect(fp0.radius).toBe(30.0);
    expect(fp0.type).toBe(0);
    expect(fp0.interp).toBe(0);
    expect(fp0.tension).toBe(0.0);
    expect(fp0.relCornerAngle).toBe(0.0);
    expect(fp1.segLoc).toBe(2);
    expect(fp1.relSegLoc).toBe(0.5);
    expect(fp1.radius).toBe(100.0);
    expect(fp1.type).toBe(0);
    expect(fp1.interp).toBe(0);
    expect(fp1.tension).toBe(0.0);
    expect(fp1.relCornerAngle).toBe(0.0);
  });

  /** Feather with inner/outer types and hold/non-hold interpolation. */
  test("test_feather_inner_hold", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("shape_feather.aep")), "shape_feather_inner_hold");
    const shape = _getMaskShape(layer).value;
    expect(len(shape.featherPoints)).toBe(4);
    expect(valueEquals(shape.featherPoints.map((fp) => fp.segLoc), [0, 1, 2, 3])).toBe(true);
    expect(valueEquals(shape.featherPoints.map((fp) => fp.radius), [50.0, -30.0, 80.0, -20.0])).toBe(true);
    expect(valueEquals(shape.featherPoints.map((fp) => fp.type), [0, 1, 0, 1])).toBe(true);
    expect(valueEquals(shape.featherPoints.map((fp) => fp.interp), [0, 0, 1, 1])).toBe(true);
    expect(valueEquals(shape.featherPoints.map((fp) => fp.tension), [0.0, 0.5, 1.0, 0.25])).toBe(true);
    expect(valueEquals(shape.featherPoints.map((fp) => fp.relCornerAngle), [0.0, 0.0, 0.0, 0.0])).toBe(true);
  });

  /** Animated mask shape has 2 keyframes with different vertices. */
  test("test_animated_keyframes", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("shape_misc.aep")), "shape_animated");
    const prop = _getMaskShape(layer);
    expect(len(prop.keyframes)).toBe(2);
    const kf0 = prop.keyframes[0].value;
    const kf1 = prop.keyframes[1].value;
    expect(
      valueEquals(kf0.vertices, [
        [100.0, 100.0],
        [100.0, 300.0],
        [300.0, 300.0],
        [300.0, 100.0],
      ]),
    ).toBe(true);
    expect(
      valueEquals(kf1.vertices, [
        [150.0, 150.0],
        [150.0, 250.0],
        [250.0, 250.0],
        [250.0, 150.0],
      ]),
    ).toBe(true);
  });

  /** 300-vertex mask with feather seg_locs >255 proves u4le field width. */
  test("test_many_points_seg_locs", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("shape_misc.aep")), "shape_many_points");
    const shape = _getMaskShape(layer).value;
    expect(len(shape.vertices)).toBe(300);
    expect(valueEquals(shape.featherPoints.map((fp) => fp.segLoc), [0, 128, 255, 256, 270, 299])).toBe(true);
    expect(valueEquals(shape.featherPoints.map((fp) => fp.radius), [10.0, 20.0, 30.0, 40.0, 50.0, 60.0])).toBe(true);
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
    const animator = asInstance(
      layer.property("ADBE Text Properties").property("ADBE Text Animators").properties[0],
      PropertyGroup,
    );
    const props = animator.property("ADBE Text Animator Properties");
    expect(props instanceof PropertyGroup).toBe(true);
    return props;
  }
}

describe("TestTextAnimatorPool", () => {
  test("test_pool_size_and_names", () => {
    const props = TestTextAnimatorPool._props(parseAep(TestTextAnimatorPool.AEP));
    const children = props.properties;
    expect(len(children)).toBe(103);
    const byMn = new Map(children.map((c) => [c.matchName, c] as const));
    expect(getOrThrow(byMn, "ADBE Text Position 3D").name).toBe("Position");
    expect(getOrThrow(byMn, "ADBE Text Rotation").name).toBe("Rotation");
    expect(getOrThrow(byMn, "ADBE 3DText Front RGB").name).toBe("Front Color");
    // Variable-font axis props have empty display names.
    expect(getOrThrow(byMn, "ADBE Text VF Axis 1").name).toBe("");
  });

  test("test_pool_values_and_units", () => {
    const props = TestTextAnimatorPool._props(parseAep(TestTextAnimatorPool.AEP));
    const byMn = new Map(props.properties.map((c) => [c.matchName, c] as const));
    const opacity = asInstance(getOrThrow(byMn, "ADBE Text Opacity"), Property);
    expect(opacity instanceof Property).toBe(true);
    expect(opacity.value).toBe(100);
    expect(opacity.minValue).toBe(0);
    expect(opacity.maxValue).toBe(100);
    expect(opacity.unitsText).toBe("percent");
    const scale = asInstance(getOrThrow(byMn, "ADBE Text Scale 3D"), Property);
    expect(scale instanceof Property).toBe(true);
    expect(valueEquals(scale.value, [100.0, 100.0, 100.0])).toBe(true);
    expect(scale.unitsText).toBe("percent");
  });

  test("test_pool_properties_not_expressionable", () => {
    const props = TestTextAnimatorPool._props(parseAep(TestTextAnimatorPool.AEP));
    for (const c of props.properties) {
      expect(c instanceof Property).toBe(true);
      expect(asInstance(c, Property).canSetExpression).toBe(false);
    }
  });

  test("test_pool_group_is_elided", () => {
    const props = TestTextAnimatorPool._props(parseAep(TestTextAnimatorPool.AEP));
    expect(props.elided).toBe(true);
  });
});

describe("TestEffectMetadata", () => {
  /** Tests for effect property metadata not covered by aep-validate. */

  /** Blur Dimensions is a dropdown with 3 options. */
  test("test_gaussian_blur_dimensions_dropdown", () => {
    const project = parseProject(SAMPLES_DIR.div("2_gaussian.aep"));
    const layer = getFirstLayer(project);
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    const effect = asInstance(layer.effects.properties[0], PropertyGroup);
    let blurDims: Property | null = null;
    for (const prop of effect.properties) {
      if (prop.matchName === "ADBE Gaussian Blur 2-0002") {
        blurDims = asInstance(prop, Property);
        break;
      }
    }
    expect(blurDims).not.toBeNull();
    if (blurDims === null) throw new AssertionError("blur_dims is None");
    expect(blurDims.nbOptions).toBe(3);
    expect(blurDims.propertyParameters).not.toBeNull();
    if (blurDims.propertyParameters === null) throw new AssertionError("blur_dims.property_parameters is None");
    expect(len(blurDims.propertyParameters)).toBe(3);
  });

  /** Synthesized default properties have is_modified == False. */
  test("test_synthesized_property_not_modified", () => {
    const project = parseProject(SAMPLES_DIR.div("2_gaussian.aep"));
    const layer = getFirstLayer(project);
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    const effect = asInstance(layer.effects.properties[0], PropertyGroup);
    // Repeat Edge Pixels is a boolean at its default - should not be modified
    let repeatEdge: Property | null = null;
    for (const prop of effect.properties) {
      if (prop.matchName === "ADBE Gaussian Blur 2-0003") {
        repeatEdge = asInstance(prop, Property);
        break;
      }
    }
    expect(repeatEdge).not.toBeNull();
    if (repeatEdge === null) throw new AssertionError("repeat_edge is None");
    expect(repeatEdge.isModified).toBe(false);
  });

  /** Synthesized 2D point values are scaled to composition dimensions. */
  test("test_2d_point_scaled_to_composition", () => {
    const project = parseProject(SAMPLES_DIR.div("effects.aep"));
    const comp = getComp(project, "effect_2dPoint");
    expect(len(comp.layers) >= 1).toBe(true);
    const layer = comp.layers[0];
    expect(layer.effects).not.toBeNull();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    const effect = asInstance(layer.effects.properties[0], PropertyGroup);
    let flareCenter: Property | null = null;
    for (const prop of effect.properties) {
      if (prop.matchName === "ADBE Lens Flare-0001") {
        flareCenter = asInstance(prop, Property);
        break;
      }
    }
    expect(flareCenter).not.toBeNull();
    if (flareCenter === null) throw new AssertionError("flare_center is None");
    expect(flareCenter.propertyValueType).toBe(PropertyValueType.TwoD_SPATIAL);
    // Value should be in pixel coordinates, not parT's 0-512 range
    expect(Array.isArray(flareCenter.value)).toBe(true);
    expect(len(flareCenter.value)).toBe(2);
    // Composition dimensions determine the scale
    expect(flareCenter.value[0] <= comp.width).toBe(true);
    expect(flareCenter.value[1] <= comp.height).toBe(true);
  });

  /**
   * AE 2026 reports isDropdownEffect on a Dropdown Menu Control's menu,
   * not on an effect's own popup.
   */
  test("test_only_dropdown_menu_controls_are_dropdown_effects", () => {
    const comp = getComp(
      parseProject(SAMPLES_DIR.parent.div("essential_graphics", "dropdown_controller.aep")),
      "primary",
    );
    let layer = comp.layers.find((ly) => ly.name === "Gray Solid 1");
    if (layer === undefined) throw new StopIteration();
    const control = asInstance(
      layer.property("ADBE Effect Parade").property("Pseudo/@@nQHCs0tHTTGgMy9vbNKNrQ"),
      PropertyGroup,
    );
    expect(asInstance(control.property("Pseudo/@@nQHCs0tHTTGgMy9vbNKNrQ-0001"), Property).isDropdownEffect).toBe(
      true,
    );

    layer = getFirstLayer(parseProject(SAMPLES_DIR.div("2_gaussian.aep")));
    const blur = asInstance(layer.property("ADBE Effect Parade").property("ADBE Gaussian Blur 2"), PropertyGroup);
    expect(asInstance(blur.property("ADBE Gaussian Blur 2-0002"), Property).isDropdownEffect).toBe(false);
  });

  /**
   * AE 2026 bounds a checkbox 0-1 even when it cannot vary over time,
   * except Puppet's (and Paint's) On Transparent.
   */
  test("test_checkboxes_are_bounded_0_1", () => {
    const comp = getComp(parseProject(SAMPLES_DIR.div("all_animated.aep")), "type_camera");
    let layer = comp.layers.find((ly) => ly.name === "XF");
    if (layer === undefined) throw new StopIteration();
    const fill = asInstance(layer.property("ADBE Effect Parade").property("ADBE Fill"), PropertyGroup);
    const allMasks = asInstance(fill.property("ADBE Fill-0007"), Property);
    expect(allMasks.canVaryOverTime).toBe(false);
    expect(valueEquals([allMasks.hasMin, allMasks.minValue, allMasks.maxValue], [true, 0, 1])).toBe(true);
    layer = getLayer(parseProject(SAMPLES_DIR.div("effects.aep")), "effect_puppet");
    const puppet = asInstance(layer.property("ADBE Effect Parade").property("ADBE FreePin3"), PropertyGroup);
    const onTransparent = asInstance(puppet.property("ADBE FreePin3 On Transparent"), Property);
    expect(valueEquals([onTransparent.hasMin, onTransparent.hasMax], [false, false])).toBe(true);
    const autoRotate = asInstance(puppet.property("ADBE FreePin3 Auto Rotate Pins"), Property);
    expect(valueEquals([autoRotate.hasMin, autoRotate.hasMax], [true, true])).toBe(true);
  });
});

// TestInstanceDictSize (CPython's shared instance-dict key table) measures
// CPython object layout; a JS object has no `__dict__` to size, so it has no
// twin here.

describe("TestTextPathOptions", () => {
  /** A text layer's Path picks one of its masks, None reading 0. */
  test("test_path_is_a_mask_index", () => {
    const comp = getComp(parseProject(SAMPLES_DIR.div("all_animated.aep")), "type_text");
    const layer = comp.layers.find((ly) => ly.name === "TextLayer");
    if (layer === undefined) throw new StopIteration();
    const path = layer
      .property("ADBE Text Properties")
      .property("ADBE Text Path Options")
      .property("ADBE Text Path");
    expect(path.propertyValueType).toBe(PropertyValueType.MASK_INDEX);
    expect(path.value).toBe(0);
  });
});

/** A 2D solid in a Classic 3D comp, each sample read by its own AE. */
class TestMaterialOptionsByVersion {
  static _materials(version: string): PropertyGroup {
    const comp = getComp(parseProject(VERSIONS_DIR.div(version, "complete.aep")), "DropFrame_Comp");
    const layer = comp.layers.find((ly) => ly.name === "DF_Solid");
    if (layer === undefined) throw new StopIteration();
    assert(asInstance(layer, AVLayer).threeDLayer === false);
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
      expect(asInstance(materials.property(mn), Property).canSetExpression).toBe(expected);
    }
  });

  test.each<[string, boolean]>([
    ["ae2023", false],
    ["ae2024", true],
  ])("test_shadow_color_from_ae_24[%#]", (version, expected) => {
    const names = TestMaterialOptionsByVersion._materials(version).properties.map((p) => p.matchName);
    expect(names.includes("ADBE Shadow Color")).toBe(expected);
  });
});

class TestCanSetExpression {
  /** Tests for Property.canSetExpression. */

  static _get_main_comp_layer(index: number): Layer {
    const project = parseProject(VERSIONS_DIR.div("ae2025", "complete.aep"));
    const comp = getComp(project, "Main_Comp");
    return comp.layers[index];
  }
}

describe("TestCanSetExpression", () => {
  /** Standard 2D AV layer transform properties are expressionable. */
  test("test_basic_av_layer_transform", () => {
    const layer = TestCanSetExpression._get_main_comp_layer(0);
    for (const mn of ["ADBE Position", "ADBE Scale", "ADBE Opacity", "ADBE Rotate Z"]) {
      const prop = _findProperty(layer, mn);
      assert(prop != null, `${mn} not found`);
      assert(prop.canSetExpression === true, mn);
    }
  });

  /** 3D-only transform properties are not expressionable on 2D layers. */
  test("test_non_3d_layer_3d_only_props", () => {
    const layer = TestCanSetExpression._get_main_comp_layer(0);
    for (const mn of ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y"]) {
      const prop = _findProperty(layer, mn);
      assert(prop != null, `${mn} not found`);
      assert(prop.canSetExpression === false, mn);
    }
  });

  /** 3D-only transform properties are expressionable on 3D layers. */
  test("test_3d_layer_3d_only_props", () => {
    const layer = TestCanSetExpression._get_main_comp_layer(11);
    for (const mn of ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y"]) {
      const prop = _findProperty(layer, mn);
      assert(prop != null, `${mn} not found`);
      assert(prop.canSetExpression === true, mn);
    }
  });

  /** Dimension separation followers are never expressionable. */
  test("test_separation_followers_always_false", () => {
    const layer = TestCanSetExpression._get_main_comp_layer(0);
    for (const mn of ["ADBE Position_0", "ADBE Position_1"]) {
      const prop = _findProperty(layer, mn);
      assert(prop != null, `${mn} not found`);
      assert(prop.canSetExpression === false, mn);
    }
  });

  /** Camera layers cannot set expressions on Scale/Opacity. */
  test("test_camera_layer", () => {
    const layer = TestCanSetExpression._get_main_comp_layer(15);
    const scale = _findProperty(layer, "ADBE Scale");
    const opacity = _findProperty(layer, "ADBE Opacity");
    const position = _findProperty(layer, "ADBE Position");
    expect(scale).not.toBeNull();
    if (scale === null) throw new AssertionError("scale is None");
    expect(opacity).not.toBeNull();
    if (opacity === null) throw new AssertionError("opacity is None");
    expect(position).not.toBeNull();
    if (position === null) throw new AssertionError("position is None");
    expect(scale.canSetExpression).toBe(false);
    expect(opacity.canSetExpression).toBe(false);
    expect(position.canSetExpression).toBe(true);
  });

  /** All light layers cannot set expressions on Scale/Opacity. */
  test("test_light_scale_opacity_always_false", () => {
    for (const idx of [12, 13, 14]) {
      // ambient, spot, point
      const layer = TestCanSetExpression._get_main_comp_layer(idx);
      for (const mn of ["ADBE Scale", "ADBE Opacity"]) {
        const prop = _findProperty(layer, mn);
        assert(prop != null, `layer[${idx}] ${mn} not found`);
        assert(prop.canSetExpression === false, `layer[${idx}] ${mn}`);
      }
    }
  });

  /**
   * A parallel light aims at its point of interest: no rotation
   * expressions.
   */
  test("test_parallel_light_rotation", () => {
    const project = parseProject(LAYER_SAMPLES_DIR.div("lightType.aep"));
    const light = getComp(project, "lightType_PARALLEL").layers[0];
    for (const mn of ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Z"]) {
      const prop = _findProperty(light, mn);
      assert(prop != null, `${mn} not found`);
      assert(prop.canSetExpression === false, mn);
    }
  });

  /** An environment light takes expressions on its rotations only. */
  test("test_environment_light", () => {
    const project = parseProject(LAYER_SAMPLES_DIR.div("light_source_default.aep"));
    const light = getComp(project, "crystal").layers[0];
    const transform = light.property("ADBE Transform Group");
    expect(transform.property("ADBE Rotate X").canSetExpression).toBe(true);
    expect(transform.property("ADBE Position").canSetExpression).toBe(false);
    const options = light.property("ADBE Light Options Group");
    for (const mn of ["ADBE Light Color", "ADBE Light Falloff Type", "ADBE Light Shadow Diffusion"]) {
      expect(asInstance(options.property(mn), Property).canSetExpression).toBe(false);
    }
  });

  /**
   * A 3D model layer hides the material options its model replaces
   * and keeps plane bending and its own Shadow Color.
   */
  test("test_3d_model_layer", () => {
    const project = parseProject(LAYER_SAMPLES_DIR.div("light_source_default.aep"));
    const model = getComp(project, "crystal").layers[2];
    const materials = model.property("ADBE Material Options Group");
    for (const mn of ["ADBE Light Transmission", "ADBE Metal Coefficient", "ADBE Shadow Color"]) {
      expect(asInstance(materials.property(mn), Property).canSetExpression).toBe(false);
    }
    const plane = model.property("ADBE Plane Options Group");
    expect(asInstance(plane.property("ADBE Plane Curvature"), Property).canSetExpression).toBe(true);
    const compositing = asInstance(model.property("ADBE Compositing Options Group"), PropertyGroup);
    expect(asInstance(compositing.property("ADBE Shadow Color"), Property).canSetExpression).toBe(true);
  });

  /**
   * Effect parameters take expressions by parameter type, whatever
   * their name; a mask reference does not.
   */
  test("test_effect_params_follow_their_type", () => {
    const effects = TestCanSetExpression._get_main_comp_layer(1).property("ADBE Effect Parade");
    const dropShadow = asInstance(effects.property("ADBE Drop Shadow"), PropertyGroup);
    expect(asInstance(dropShadow.property("Distance"), Property).canSetExpression).toBe(true);
    expect(asInstance(dropShadow.property("Softness"), Property).canSetExpression).toBe(true);
    const fill = asInstance(effects.property("ADBE Fill"), PropertyGroup);
    expect(asInstance(fill.property("Color"), Property).canSetExpression).toBe(true);
    expect(asInstance(fill.property("Fill Mask"), Property).canSetExpression).toBe(false);
  });

  /** AE shows a stroke's Miter Limit only while it joins by miter. */
  test("test_stroke_miter_limit_needs_a_miter_join", () => {
    const layer = parseProject(SAMPLES_DIR.div("gradient.aep")).compositions[0].layers[0];
    const stroke = layer.property("ADBE Root Vectors Group").property("ADBE Vector Graphic - G-Stroke");
    expect(stroke.property("ADBE Vector Stroke Line Join").value).toBe(2); // round
    const miter = stroke.property("ADBE Vector Stroke Miter Limit");
    expect(miter.canSetExpression).toBe(false);
  });
});

describe("TestCanVaryOverTime", () => {
  /** Tests for Property.canVaryOverTime. */

  /** The Puppet Engine popup is fixed; its sibling toggles vary. */
  test("test_puppet_engine_cannot_vary", () => {
    const layer = getLayer(parseProject(SAMPLES_DIR.div("effects.aep")), "effect_puppet");
    const puppet = asInstance(layer.property("ADBE Effect Parade").property("ADBE FreePin3"), PropertyGroup);
    const engine = asInstance(puppet.property("ADBE FreePin3 Puppet Engine"), Property);
    expect(engine.canVaryOverTime).toBe(false);
    expect(engine.canSetExpression).toBe(false);
    const autoRotate = asInstance(puppet.property("ADBE FreePin3 Auto Rotate Pins"), Property);
    expect(autoRotate.canVaryOverTime).toBe(true);
  });
});

describe("TestCanAddProperty", () => {
  /** Tests for PropertyGroup.canAddProperty(). */

  /** Transform group is a NAMED_GROUP, not INDEXED_GROUP. */
  test("test_non_indexed_group_returns_false", () => {
    const project = parseProject(LAYER_SAMPLES_DIR.div("type.aep"));
    const comp = getComp(project, "type_null");
    const layer = comp.layers[0];
    const transform = layer.transform;
    expect(transform.propertyType).toBe(PropertyType.NAMED_GROUP);
    expect(transform.canAddProperty("anything")).toBe(false);
  });

  test("test_empty_name_returns_false", () => {
    const project = parseProject(PROPERTY_SAMPLES_DIR.div("effects.aep"));
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    const effectParade = layer.effects;
    if (effectParade === null) throw new AssertionError("layer.effects is None");
    expect(effectParade.canAddProperty("")).toBe(false);
  });

  /**
   * Effect Parade accepts the controls py_aep can create, by
   * match name or display name; unknown effects are rejected.
   */
  test("test_effect_parade_accepts_expression_controls", () => {
    const project = parseProject(PROPERTY_SAMPLES_DIR.div("effects.aep"));
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    const effectParade = layer.effects;
    if (effectParade === null) throw new AssertionError("layer.effects is None");
    expect(effectParade.matchName).toBe("ADBE Effect Parade");
    expect(effectParade.propertyType).toBe(PropertyType.INDEXED_GROUP);
    expect(effectParade.canAddProperty("ADBE Slider Control")).toBe(true);
    expect(effectParade.canAddProperty("Slider Control")).toBe(true);
    expect(effectParade.canAddProperty("ADBE Dropdown Control")).toBe(true);
    expect(effectParade.canAddProperty("ADBE Gaussian Blur 2")).toBe(false);
    expect(effectParade.canAddProperty("Some Custom Effect")).toBe(false);
  });

  test("test_mask_parade_accepts_mask_atom", () => {
    const project = parseProject(PROPERTY_SAMPLES_DIR.div("mask.aep"));
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    const maskParade = layer.masks;
    if (maskParade == null) {
      return skip("No mask parade found");
    }
    expect(maskParade.matchName).toBe("ADBE Mask Parade");
    expect(maskParade.canAddProperty("ADBE Mask Atom")).toBe(true);
  });

  test("test_mask_parade_rejects_other_names", () => {
    const project = parseProject(PROPERTY_SAMPLES_DIR.div("mask.aep"));
    const comp = project.compositions[0];
    const layer = comp.layers[0];
    const maskParade = layer.masks;
    if (maskParade == null) {
      return skip("No mask parade found");
    }
    expect(maskParade.canAddProperty("ADBE Position")).toBe(false);
    expect(maskParade.canAddProperty("ADBE Effect Parade")).toBe(false);
  });

  /** Root Vectors Group should accept valid shape match names. */
  test("test_shape_group_accepts_shape_names", () => {
    const project = parseProject(LAYER_SAMPLES_DIR.div("type.aep"));
    const comp = getComp(project, "type_shape");
    const layer = comp.layers[0];
    let contents: PropertyGroup | null = null;
    for (const prop of layer.properties) {
      if (prop.matchName === "ADBE Root Vectors Group") {
        contents = asInstance(prop, PropertyGroup);
        break;
      }
    }
    if (contents == null) {
      return skip("No Root Vectors Group found");
    }
    expect(contents.canAddProperty("ADBE Vector Shape - Rect")).toBe(true);
    expect(contents.canAddProperty("ADBE Vector Shape - Ellipse")).toBe(true);
    expect(contents.canAddProperty("ADBE Vector Graphic - Fill")).toBe(true);
    expect(contents.canAddProperty("ADBE Vector Group")).toBe(true);
    expect(contents.canAddProperty("ADBE Vector Filter - Trim")).toBe(true);
  });

  test("test_shape_group_rejects_invalid_names", () => {
    const project = parseProject(LAYER_SAMPLES_DIR.div("type.aep"));
    const comp = getComp(project, "type_shape");
    const layer = comp.layers[0];
    let contents: PropertyGroup | null = null;
    for (const prop of layer.properties) {
      if (prop.matchName === "ADBE Root Vectors Group") {
        contents = asInstance(prop, PropertyGroup);
        break;
      }
    }
    if (contents == null) {
      return skip("No Root Vectors Group found");
    }
    expect(contents.canAddProperty("ADBE Position")).toBe(false);
    expect(contents.canAddProperty("ADBE Mask Atom")).toBe(false);
  });
});

/** The ExtendScript export's shape for the Ramp's Start of Ramp keyframes. */
interface JsonEaseKeyframe {
  inTemporalEase: Array<{ speed: number }>;
  outTemporalEase: Array<{ speed: number }>;
}
interface JsonRampStart {
  matchName: string;
  keyframes: JsonEaseKeyframe[];
}

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
    const comp = getComp(project, "EffectPoint");
    const effect = asInstance(asInstance(comp.layers[0].effects, PropertyGroup).property(0), PropertyGroup);
    const prop = effect.property(TestEffectPointSpeed.MATCH_NAME);
    assert(prop instanceof Property);
    return prop;
  }

  static _expected_keyframes(): JsonEaseKeyframe[] {
    const expected = loadExpected(SAMPLES_DIR, "effect_point_speed");

    const isRampStart = (node: object): node is JsonRampStart =>
      "matchName" in node && node.matchName === TestEffectPointSpeed.MATCH_NAME;

    const walk = (node: unknown): JsonRampStart | null => {
      if (typeof node === "object" && node !== null && !Array.isArray(node)) {
        if (isRampStart(node)) {
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
    assert(typeof node === "object" && node !== null && !Array.isArray(node));
    return node["keyframes"];
  }
}

describe("TestEffectPointSpeed", () => {
  test("test_speeds_match_extendscript", () => {
    const prop = TestEffectPointSpeed._ramp_start(parseProject(TestEffectPointSpeed.SAMPLE));
    const expected = TestEffectPointSpeed._expected_keyframes();
    expect(len(prop.keyframes)).toBe(len(expected));
    for (const [keyframe, want] of zip(prop.keyframes, expected)) {
      expect(approx(keyframe.inTemporalEase[0].speed, want["inTemporalEase"][0]["speed"])).toBe(true);
      expect(approx(keyframe.outTemporalEase[0].speed, want["outTemporalEase"][0]["speed"])).toBe(true);
    }
  });

  test("test_factor_is_comp_height_not_width", () => {
    // The comp is 400x300 and the stored speeds are 0.4 / 0.8666...;
    // ExtendScript reports 120 / 260, i.e. exactly height (300) - the same
    // scalar for both directions, and independent of the width.
    const prop = TestEffectPointSpeed._ramp_start(parseProject(TestEffectPointSpeed.SAMPLE));
    expect(valueEquals(prop._effectScale, [400.0, 300.0])).toBe(true);
    expect(prop._effectPointSpeedFactor).toBe(300.0);
    const middle = prop.keyframes[1];
    expect(approx(asInstance(middle._ldatItem.kfData, KfPosition).inSpeed, 0.4)).toBe(true);
    expect(approx(middle.inTemporalEase[0].speed, 120.0)).toBe(true);
    expect(approx(middle.outTemporalEase[0].speed, 260.0)).toBe(true);
  });

  test("test_reading_effect_scale_does_not_touch_ease", () => {
    // `_effectScale` used to push factors onto every keyframe's ease on
    // each read, which made resolving a property's speeds quadratic in its
    // keyframe count. It must be a pure computation. Parsed fresh: the
    // cached project is shared, and reading ease anywhere creates it.
    const prop = TestEffectPointSpeed._ramp_start(parseAep(TestEffectPointSpeed.SAMPLE).project);
    expect(
      prop.keyframes.every(
        (keyframe) => keyframe._inTemporalEase == null && keyframe._outTemporalEase == null,
      ),
    ).toBe(true);
    for (const _ of range(3)) {
      expect(prop._effectScale).not.toBeNull();
    }
    expect(
      prop.keyframes.every(
        (keyframe) => keyframe._inTemporalEase == null && keyframe._outTemporalEase == null,
      ),
    ).toBe(true);
  });

  test("test_resolving_ease_stays_linear", () => {
    // One factor lookup per resolved ease, not a rescan of every keyframe.
    const prop = TestEffectPointSpeed._ramp_start(parseProject(TestEffectPointSpeed.SAMPLE));
    let lookups = 0;
    // NOTE(port): Python swaps `type(prop)._effect_point_speed_factor` for a counting
    // property on the class; this patches the accessor on the prototype the same way.
    const proto: object = Object.getPrototypeOf(prop);
    const original = Object.getOwnPropertyDescriptor(proto, "_effectPointSpeedFactor");
    const originalGet = original?.get;
    if (original === undefined || originalGet === undefined) {
      throw new AssertionError("_effect_point_speed_factor is not a getter on the class");
    }
    const counting = function (this: Property): number | null {
      lookups += 1;
      return originalGet.call(this);
    };
    Object.defineProperty(proto, "_effectPointSpeedFactor", { get: counting, configurable: true });
    try {
      for (const keyframe of prop.keyframes) {
        keyframe.inTemporalEase;
        keyframe.outTemporalEase;
      }
    } finally {
      Object.defineProperty(proto, "_effectPointSpeedFactor", original);
    }

    expect(lookups <= 2 * len(prop.keyframes)).toBe(true);
  });

  test("test_speeds_are_stable_across_repeated_reads", () => {
    const prop = TestEffectPointSpeed._ramp_start(parseProject(TestEffectPointSpeed.SAMPLE));
    const first = prop.keyframes.map((kf) => kf.outTemporalEase[0].speed);
    const second = prop.keyframes.map((kf) => kf.outTemporalEase[0].speed);
    expect(valueEquals(first, second)).toBe(true);
  });

  /**
   * A LINEAR effect point's speed is computed from the segment instead,
   * so it must not pick up the height factor.
   */
  test("test_linear_effect_point_speeds_unaffected", () => {
    const project = parseProject(BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"));
    for (const comp of project.compositions) {
      for (const layer of comp.layers) {
        const stack: (Property | PropertyGroup)[] = [...layer.properties];
        while (truthy(stack)) {
          const child = stack.shift();
          if (child instanceof PropertyGroup) {
            stack.push(...child.properties);
          } else if (
            child instanceof Property &&
            child.matchName === "ADBE Geometry2-0001" &&
            truthy(child.keyframes)
          ) {
            expect(valueEquals(child._effectScale, [2356.0, 1002.0])).toBe(true);
            expect(approx(child.keyframes[0].outTemporalEase[0].speed, 29.151890878813)).toBe(true);
            expect(approx(child.keyframes[1].inTemporalEase[0].speed, 29.151890878813)).toBe(true);
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
    const project = parseAep(LAYER_SAMPLES_DIR.div("geometry_probe.aep")).project;
    const comp = getComp(project, "PROBE_MAIN");
    const layer = asInstance(comp.layers.find((lay) => lay.name === "solid_default"), AVLayer);
    expect(valueEquals([comp.width, comp.height], [1920, 1080])).toBe(true);
    expect(valueEquals([layer.width, layer.height], [200, 100])).toBe(true);

    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    const point = asInstance(
      layer.effects.properties
        .filter((effect) => effect.name === "Point Control")
        .flatMap((effect) => asInstance(effect, PropertyGroup).properties)
        .find((child) => child.name === "Point"),
      Property,
    );
    expect(point._isLive()).toBe(false);
    // AE's default is the layer centre; the composition centre would be
    // [960, 540] - what py_aep reported before the layer was threaded in.
    expect(valueEquals(point.value, [100.0, 50.0])).toBe(true);
  });

  /**
   * A 3D point's Z shares the height divisor (AE 2026: [100, 50, 7]
   * on a 200x100 layer stores [0.5, 0.5, 0.07]).
   */
  test("test_synthesized_3d_point_z_uses_height", () => {
    const project = parseAep(LAYER_SAMPLES_DIR.div("geometry_probe.aep")).project;
    const comp = getComp(project, "PROBE_MAIN");
    const layer = comp.layers.find((lay) => lay.name === "solid_default");
    if (layer === undefined) throw new StopIteration();
    if (layer.effects === null) throw new AssertionError("layer.effects is None");
    const point = asInstance(
      layer.effects.properties
        .filter((effect) => effect.name === "3D Point Control")
        .flatMap((effect) => asInstance(effect, PropertyGroup).properties)
        .find((child) => child.name === "3D Point"),
      Property,
    );
    expect(valueEquals(point.value, [100.0, 50.0, 0.0])).toBe(true);
    // The fixture's Z is 0, which every divisor reproduces, so assert the
    // divisor itself: [width, height, height], not [width, height, 1] or
    // the comp size.
    expect(valueEquals(point._effectScale, [200.0, 100.0, 100.0])).toBe(true);
  });
});

/** A mask path as the AE 2026 probes export it. */
interface JsonMaskShape {
  closed: boolean;
  vertices: number[][];
  inTangents: number[][];
  outTangents: number[][];
}
interface JsonMaskLayerSpaceProbe extends JsonMaskShape {
  canSetExpression: boolean;
  canVaryOverTime: boolean;
  isModified: boolean;
}

// json.loads at import time, as in Python.
const _MASK_LAYER_SPACE_PROBE: Record<string, JsonMaskLayerSpaceProbe> = JSON.parse(
  SAMPLES_DIR.div("mask_layer_space_probe.json").readText("utf-8"),
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
      const project = parseProject(SAMPLES_DIR.div("mask_layer_space.aep"));
      TestMaskLayerSpace._comp = getComp(project, "MASK_LAYER_SPACE");
    }
    return TestMaskLayerSpace._comp;
  }
}

describe("TestMaskLayerSpace", () => {
  test.each(sorted(Object.keys(_MASK_LAYER_SPACE_PROBE)))("test_mask_path_matches_ae[%#]", (key: string) => {
    const comp = TestMaskLayerSpace.comp();
    const [layerName, maskName] = key.split("/");
    const expected = _MASK_LAYER_SPACE_PROBE[key];
    const layer = comp.layers.find((lay) => lay.name === layerName);
    if (layer === undefined) throw new StopIteration();
    if (layer.masks === null) throw new AssertionError("layer.masks is None");
    const mask = asInstance(
      layer.masks.properties.find((m) => m.name === maskName),
      MaskPropertyGroup,
    );
    // The fixture's fresh masks really are path-less.
    expect(mask._maskShapeTdsb == null).toBe(maskName === "Mask 1");
    const maskPath = mask.property("ADBE Mask Shape");
    expect(maskPath.propertyValueType).toBe(PropertyValueType.SHAPE);
    expect(maskPath.canSetExpression).toBe(expected["canSetExpression"]);
    expect(maskPath.canVaryOverTime).toBe(expected["canVaryOverTime"]);
    expect(maskPath.isModified).toBe(expected["isModified"]);
    const shape = maskPath.value;
    expect(shape.closed).toBe(expected["closed"]);
    for (const [attr, name] of [
      ["vertices", "vertices"],
      ["inTangents", "inTangents"],
      ["outTangents", "outTangents"],
    ] as const) {
      const got = getMember(shape, attr).flatMap((point) => [...point]);
      const want = expected[name].flatMap((point) => [...point]);
      assert(approx(got, want, { abs: 1e-4 }), attr);
    }
  });
});

/** A `<stem>_probe.json`: per mask, its static shape, or `{sample: shape}` per sampled time / key. */
type RotoBezierProbe = Record<string, JsonMaskShape | Record<string, JsonMaskShape>>;

// NOTE(port): Python reads the probe with `load_expected`; it is no project
// export, so it is parsed here with its own shape (as `_MASK_LAYER_SPACE_PROBE` is).
function _loadRotobezierProbe(stem: string): RotoBezierProbe {
  return JSON.parse(SAMPLES_DIR.div(`${stem}_probe.json`).readText("utf-8"));
}

/** Python `"vertices" in value`: a static mask's probe entry is the shape itself. */
function _isStaticEntry(value: RotoBezierProbe[string]): value is JsonMaskShape {
  return "vertices" in value;
}

/**
 * (fixture stem, mask name, sampled time / key or None for static).
 */
function _rotobezierCases(): [string, string, string | null][] {
  const cases: [string, string, string | null][] = [];
  for (const stem of ["mask_rotobezier_shapes", "mask_rotobezier_tensions"]) {
    const probe = _loadRotobezierProbe(stem);
    for (const mask of sorted(Object.keys(probe))) {
      const value = probe[mask];
      if (_isStaticEntry(value)) {
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
   * (`resolvers.rotoBezier`). Ground truth: AE 2026 reading each fixture in
   * a fresh session (`<stem>_probe.json`). `mask_rotobezier_shapes` holds
   * AE-scripted masks (tension 1, zero tangents, except one converted from
   * handles at 1/3); `mask_rotobezier_tensions` is the same file with the
   * tensions and Mask Path aspects byte-patched per layer (mixed tensions,
   * aspect 1.0, missing tensions, a keyframe without tensions).
   */
  test.each(_rotobezierCases())(
    "test_tangents_match_ae[%#]",
    (stem: string, maskName: string, sample: string | null) => {
      const entry = _loadRotobezierProbe(stem)[maskName];
      let expected: JsonMaskShape;
      if (_isStaticEntry(entry)) {
        assert(sample == null, maskName);
        expected = entry;
      } else {
        assert(sample != null, maskName);
        expected = entry[sample];
      }
      const comp = getComp(parseProject(SAMPLES_DIR.div(`${stem}.aep`)), "ROTO");
      let mask: MaskPropertyGroup | null = null;
      outer: for (const layer of comp.layers) {
        if (layer.masks === null) throw new AssertionError("layer.masks is None");
        for (const m of layer.masks.properties) {
          if (m.name === maskName) {
            mask = asInstance(m, MaskPropertyGroup);
            break outer;
          }
        }
      }
      if (mask === null) throw new StopIteration();
      expect(mask.rotoBezier).toBe(true);
      const maskPath = mask.property("ADBE Mask Shape");
      let shape: Shape;
      if (sample == null) {
        shape = maskPath.value;
      } else if (sample.startsWith("key")) {
        shape = maskPath.keyframes[int(sample.slice(3)) - 1].value;
      } else {
        shape = maskPath.valueAtTime(float(sample));
      }
      expect(shape.closed).toBe(expected["closed"]);
      for (const [attr, name] of [
        ["vertices", "vertices"],
        ["inTangents", "inTangents"],
        ["outTangents", "outTangents"],
      ] as const) {
        const got = getMember(shape, attr).flatMap((point) => [...point]);
        const want = expected[name].flatMap((point) => [...point]);
        assert(approx(got, want, { abs: 1e-3 }), attr);
      }
    },
  );

  test("test_stale_aspect_sample_matches_extendscript", () => {
    // Tensions missing (1/3) and a Mask Path aspect of 1.0: AE measures
    // the full-layer rectangle as a unit square (mask_rotobezier_on.json).
    const layer = getFirstLayer(parseProject(SAMPLES_DIR.div("mask_rotobezier_on.aep")));
    const shape = _getMaskShape(layer).value;
    expect(approx(shape.inTangents[0], [452.5483, -254.5584], { abs: 1e-3 })).toBe(true);
    expect(approx(shape.outTangents[3], [-452.5483, -254.5584], { abs: 1e-3 })).toBe(true);
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
  ])("test_static_anchor_point[%#]", (layerName: string, expected: number[]) => {
    const comp = getComp(parseAep(SAMPLES_DIR.div("anchor_point_z.aep")).project, "anchor_z");
    const layer = comp.layers.find((lay) => lay.name === layerName);
    if (layer === undefined) throw new StopIteration();
    const anchor = layer.property("ADBE Transform Group").property("ADBE Anchor Point");
    expect(approx(anchor.value, expected)).toBe(true);
  });

  test("test_animated_anchor_point", () => {
    const comp = getComp(parseAep(SAMPLES_DIR.div("anchor_point_z.aep")).project, "anchor_z");
    const layer = comp.layers.find((lay) => lay.name === "solid_animated");
    if (layer === undefined) throw new StopIteration();
    const anchor = layer.property("ADBE Transform Group").property("ADBE Anchor Point");
    const values = anchor.keyframes.map((kf) => kf.value);
    expect(len(values)).toBe(2);
    expect(approx(values[0], [150.0, 50.0, 0.0])).toBe(true);
    expect(approx(values[1], [150.0, 50.0, 80.0])).toBe(true);
  });
});
