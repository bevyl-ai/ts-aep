/**
 * Migration invariant tests.
 *
 * Regression suite designed to survive the Kaitai-to-struct migration.
 * All tests use the PUBLIC model API only - no Kaitai types, no chunk
 * internals. If any test here breaks during migration, the migration
 * has a bug.
 */

import { describe, test, expect } from "bun:test";
import { Path, len, assert, valueEquals, AssertionError, repr } from "../../src/pyrt/index.ts";
import { makeTmpPath } from "../../src/pyrt/pytest.ts";
import "../../src/py_aep/binary/_register.ts";
import { getFirstLayer, getLayer } from "../conftest.ts";
import { asInstance } from "../helpers.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";

// Samples are read from the ts-aep root (same layout as upstream `repo/samples`).
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples");
const PROPERTY_DIR = SAMPLES_DIR.div("models", "property");
const LAYER_DIR = SAMPLES_DIR.div("models", "layer");
const COMPOSITION_DIR = SAMPLES_DIR.div("models", "composition");
const EG_DIR = SAMPLES_DIR.div("models", "essential_graphics");
const VERSIONS_DIR = SAMPLES_DIR.div("versions");
const BUGS_DIR = SAMPLES_DIR.div("bugs");
const ROUNDTRIP_SAMPLES = [
  // Version coverage - conditional fields across AE eras
  VERSIONS_DIR.div("ae2018", "complete.aep"),
  VERSIONS_DIR.div("ae2022", "complete.aep"),
  VERSIONS_DIR.div("ae2023", "complete.aep"),
  VERSIONS_DIR.div("ae2024", "complete.aep"),
  VERSIONS_DIR.div("ae2025", "complete.aep"),
  VERSIONS_DIR.div("ae2026", "complete.aep"),
  // Feature coverage - unique binary patterns
  PROPERTY_DIR.div("effects.aep"),
  PROPERTY_DIR.div("2_gaussian.aep"),
  PROPERTY_DIR.div("keyframe_spatial.aep"),
  PROPERTY_DIR.div("keyframe_spatial_bezier_3D.aep"),
  PROPERTY_DIR.div("keyframe_1D.aep"),
  PROPERTY_DIR.div("shape_basic.aep"),
  PROPERTY_DIR.div("mask_add.aep"),
  EG_DIR.div("multiple_controllers.aep"),
  COMPOSITION_DIR.div("bgColor_custom.aep"),
  // Edge cases
  BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"),
  BUGS_DIR.div("windows-1250_decoding_error.aep"),
  BUGS_DIR.div("outputmodule_path.aep"),
];

/** Find a property by match_name anywhere in the layer's property tree. */
function _findProperty(layer: Layer, matchName: string): Property | null {
  function _search(group: PropertyGroup): Property | null {
    for (const prop of group.properties) {
      if (prop instanceof Property && prop.matchName === matchName) {
        return prop;
      }
      if (prop instanceof PropertyGroup) {
        const result = _search(prop);
        if (result != null) {
          return result;
        }
      }
    }
    return null;
  }

  for (const group of layer.properties) {
    if (group instanceof Property && group.matchName === matchName) {
      return group;
    }
    if (group instanceof PropertyGroup) {
      const result = _search(group);
      if (result != null) {
        return result;
      }
    }
  }
  return null;
}

/** Find a synthesized effect property by match name. */
function _findSynthesizedEffectProp(layer: Layer, effectIndex: number, matchName: string): Property {
  const effect = asInstance(layer.effects, PropertyGroup).properties[effectIndex];
  assert(effect instanceof PropertyGroup);
  for (const prop of effect.properties) {
    if (prop instanceof Property && prop.matchName === matchName) {
      return prop;
    }
  }
  throw new AssertionError(`Property ${repr(matchName)} not found in effect`);
}

/** Synthesized (ProxyBody-backed) properties must not affect saved bytes. */
describe("TestSynthesizedPropertyInvisibility", () => {
  test("test_effect_properties_invisible", () => {
    /** Synthesized effect properties exist in model but not in output. */
    const tmpPath = makeTmpPath();
    const aepPath = PROPERTY_DIR.div("2_gaussian.aep");
    const originalBytes = aepPath.readBytes();

    const app = parseAep(aepPath);
    const layer = getFirstLayer(app.project);

    // Verify synthesized properties exist in the model
    const blur = _findSynthesizedEffectProp(layer, 0, "ADBE Gaussian Blur 2-0001");
    expect(blur != null).toBe(true);
    expect(blur.value != null).toBe(true);

    // Save WITHOUT mutating anything
    const out = tmpPath.div("untouched.aep");
    app.project.save(out);
    expect(valueEquals(out.readBytes(), originalBytes)).toBe(true);
  });

  test("test_top_level_groups_invisible", () => {
    /** Synthesized top-level groups (Effects, Masks) don't affect output. */
    const tmpPath = makeTmpPath();
    const aepPath = PROPERTY_DIR.div("keyframe_1D.aep");
    const originalBytes = aepPath.readBytes();

    const app = parseAep(aepPath);
    const layer = getFirstLayer(app.project);

    // Verify synthesized groups exist in the property tree
    const matchNames = layer.properties.map((p) => p.matchName);
    expect(matchNames.includes("ADBE Effect Parade")).toBe(true);
    expect(matchNames.includes("ADBE Mask Parade")).toBe(true);

    // Save without mutation
    const out = tmpPath.div("untouched.aep");
    app.project.save(out);
    expect(valueEquals(out.readBytes(), originalBytes)).toBe(true);
  });
});

/**
 * Verify that specific binary patterns (LE cdat, spatial ldat, tdum/tduM)
 * survive parse > model access > save without corruption.
 */
describe("TestParameterizedBodyRoundtrip", () => {
  test("test_le_cdat_orientation", () => {
    /** LE cdat inside LIST:otst survives round-trip. */
    const tmpPath = makeTmpPath();
    const aepPath = LAYER_DIR.div("orientation_with_keyframes.aep");
    const originalBytes = aepPath.readBytes();

    const app = parseAep(aepPath);
    const layer = getFirstLayer(app.project);
    const orientation = _findProperty(layer, "ADBE Orientation");
    expect(orientation != null).toBe(true);
    if (orientation == null) throw new AssertionError("no ADBE Orientation property");
    expect(len(orientation.keyframes) > 0).toBe(true);

    const out = tmpPath.div("roundtrip.aep");
    app.project.save(out);
    expect(valueEquals(out.readBytes(), originalBytes)).toBe(true);
  });

  test("test_spatial_2d_ldat", () => {
    /** 2D spatial ldat with tangent arrays survives round-trip. */
    const tmpPath = makeTmpPath();
    const aepPath = PROPERTY_DIR.div("keyframe_spatial.aep");
    const originalBytes = aepPath.readBytes();

    const app = parseAep(aepPath);
    const layer = getLayer(app.project, "keyframe_spatial_bezier_arc");
    const position = _findProperty(layer, "ADBE Position");
    expect(position != null).toBe(true);
    if (position == null) throw new AssertionError("no ADBE Position property");
    expect(position.isSpatial).toBe(true);
    expect(len(position.keyframes) > 0).toBe(true);

    const out = tmpPath.div("roundtrip.aep");
    app.project.save(out);
    expect(valueEquals(out.readBytes(), originalBytes)).toBe(true);
  });

  test("test_spatial_3d_ldat", () => {
    /** 3D spatial ldat (promoted via tdb4.isSpatial) survives round-trip. */
    const tmpPath = makeTmpPath();
    const aepPath = PROPERTY_DIR.div("keyframe_spatial_bezier_3D.aep");
    const originalBytes = aepPath.readBytes();

    const app = parseAep(aepPath);
    const layer = getFirstLayer(app.project);
    const position = _findProperty(layer, "ADBE Position");
    expect(position != null).toBe(true);
    if (position == null) throw new AssertionError("no ADBE Position property");
    expect(position.isSpatial).toBe(true);
    expect(len(position.keyframes) > 0).toBe(true);

    const out = tmpPath.div("roundtrip.aep");
    app.project.save(out);
    expect(valueEquals(out.readBytes(), originalBytes)).toBe(true);
  });

  test("test_tdum_with_effects", () => {
    /** tdum/tduM min/max chunks with multiple value types survive round-trip. */
    const tmpPath = makeTmpPath();
    const aepPath = PROPERTY_DIR.div("effects.aep");
    const originalBytes = aepPath.readBytes();

    const app = parseAep(aepPath);
    const layer = getFirstLayer(app.project);
    // Verify effects parsed
    expect(layer.effects != null).toBe(true);
    expect(len(asInstance(layer.effects, PropertyGroup).properties) > 0).toBe(true);

    const out = tmpPath.div("roundtrip.aep");
    app.project.save(out);
    expect(valueEquals(out.readBytes(), originalBytes)).toBe(true);
  });

  test("test_nonspatial_1d_ldat", () => {
    /** Non-spatial 1D keyframes - simplest ldat pattern. */
    const tmpPath = makeTmpPath();
    const aepPath = PROPERTY_DIR.div("keyframe_1D.aep");
    const originalBytes = aepPath.readBytes();

    const app = parseAep(aepPath);
    const layer = getFirstLayer(app.project);
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity != null).toBe(true);
    if (opacity == null) throw new AssertionError("no ADBE Opacity property");
    expect(len(opacity.keyframes) > 0).toBe(true);
    expect(opacity.isSpatial).toBe(false);

    const out = tmpPath.div("roundtrip.aep");
    app.project.save(out);
    expect(valueEquals(out.readBytes(), originalBytes)).toBe(true);
  });
});
