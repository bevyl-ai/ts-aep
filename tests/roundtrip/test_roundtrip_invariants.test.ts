/**
 * Migration invariant tests.
 *
 * Regression suite designed to survive the Kaitai-to-struct migration.
 * All tests use the PUBLIC model API only - no Kaitai types, no chunk
 * internals. If any test here breaks during migration, the migration
 * has a bug.
 */

import { describe, expect, test } from "bun:test";
import { AttributeError, AssertionError, Path, assert, valueEquals, repr, RuntimeError, instanceDict } from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import "../../src/py_aep/binary/_register.ts";
import { parse as parseAep } from "../../src/py_aep/index.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { _suppressMaterialization } from "../../src/py_aep/models/descriptors.ts";
import { getFirstLayer } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples");
const PROPERTY_DIR = SAMPLES_DIR.div("models", "property");
const LAYER_DIR = SAMPLES_DIR.div("models", "layer");
const COMPOSITION_DIR = SAMPLES_DIR.div("models", "composition");
const EG_DIR = SAMPLES_DIR.div("models", "essential_graphics");
const VERSIONS_DIR = SAMPLES_DIR.div("versions");
const BUGS_DIR = SAMPLES_DIR.div("bugs");
const ROUNDTRIP_SAMPLES: Path[] = [
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
  // Orientation and path keyframes: their ldat items carry an ease but
  // no value, a layout the item reader has to get exactly right.
  PROPERTY_DIR.div("property_path_orientation_pin.aep"),
  PROPERTY_DIR.div("property_path_orientation_ease.aep"),
  PROPERTY_DIR.div("property_vat_edge_cases.aep"),
  EG_DIR.div("multiple_controllers.aep"),
  COMPOSITION_DIR.div("bgColor_custom.aep"),
  // Edge cases
  BUGS_DIR.div("29.97_fps_time_scale_3.125.aep"),
  BUGS_DIR.div("windows-1250_decoding_error.aep"),
  BUGS_DIR.div("outputmodule_path.aep"),
];

/** pytest `ids=lambda p: p.relative_to(SAMPLES_DIR).as_posix().replace("/", "__")` */
function _sampleId(p: Path): string {
  return p.path.slice(SAMPLES_DIR.path.length + 1).replaceAll("/", "__");
}

/** Find a property by match_name anywhere in the layer's property tree. */
function _findProperty(layer: Layer, matchName: string): Property | null {
  function _search(group: PropertyGroup): Property | null {
    for (const prop of group.properties) {
      if (prop instanceof Property && prop.matchName === matchName) {
        return prop;
      }
      if (prop instanceof PropertyGroup) {
        const result = _search(prop);
        if (result !== null) {
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
      if (result !== null) {
        return result;
      }
    }
  }
  return null;
}

/** Find a synthesized effect property by match name. */
function _findSynthesizedEffectProp(layer: Layer, effectIndex: number, matchName: string): Property {
  if (layer.effects == null) throw new Error("layer has no effects group");
  const effect = layer.effects.properties[effectIndex];
  assert(effect instanceof PropertyGroup);
  for (const prop of effect.properties) {
    if (prop instanceof Property && prop.matchName === matchName) {
      return prop;
    }
  }
  throw new AssertionError(`Property ${repr(matchName)} not found in effect`);
}

describe("TestByteIdentityRoundtrip", () => {
  /** Parse > save > compare bytes for diverse sample files. */
  test.each(ROUNDTRIP_SAMPLES.map((p) => [_sampleId(p), p] as [string, Path]))(
    "test_roundtrip[%s]",
    (_id, aepPath) => {
      const tmpPath = makeTmpPath();
      const originalBytes = aepPath.readBytes();

      const app = parseAep(aepPath);
      const out = tmpPath.div("roundtrip.aep");
      app.project.save(out);
      const roundtripBytes = out.readBytes();

      expect(valueEquals(roundtripBytes, originalBytes)).toBe(true);
    },
  );
});

describe("TestMaterializationLifecycle", () => {
  /**
   * Writing to synthesized properties triggers materialization that
   * survives save/re-parse.
   */

  test("test_materialize_on_value_write", () => {
    /** Setting value materializes the property into the chunk tree. */
    const tmpPath = makeTmpPath();
    const app = parseAep(PROPERTY_DIR.div("2_gaussian.aep"));
    const layer = getFirstLayer(app.project);
    const blur = _findSynthesizedEffectProp(layer, 0, "ADBE Gaussian Blur 2-0001");

    blur.value = 42.0;

    const out = tmpPath.div("materialized.aep");
    app.project.save(out);

    const app2 = parseAep(out);
    const layer2 = getFirstLayer(app2.project);
    const blur2 = _findSynthesizedEffectProp(layer2, 0, "ADBE Gaussian Blur 2-0001");
    expect(blur2.value).toBe(42.0);
  });

  test("test_enabled_read_only_on_effect_param", () => {
    /**
     * Effect-parameter `enabled` is read-only (AE `canSetEnabled` is
     * False), so the write is rejected and the property is left untouched.
     */
    const app = parseAep(PROPERTY_DIR.div("2_gaussian.aep"));
    const layer = getFirstLayer(app.project);
    const blur = _findSynthesizedEffectProp(layer, 0, "ADBE Gaussian Blur 2-0001");
    expect(blur.enabled).toBe(true);
    expect(blur.canSetEnabled).toBe(false);

    raises(AttributeError, () => {
      blur.enabled = false;
    });

    expect(blur.enabled).toBe(true);
  });

  test("test_materialize_on_name_write", () => {
    /**
     * Setting name materializes the property into the chunk tree.
     *
     * Renaming is only legal where AE allows it - the parent must be an
     * INDEXED_GROUP - so the effect itself stands in for the parameter this
     * used to rename (AE 2026 throws on an effect parameter).
     */
    const tmpPath = makeTmpPath();
    const app = parseAep(PROPERTY_DIR.div("2_gaussian.aep"));
    const layer = getFirstLayer(app.project);
    expect(layer.effects != null).toBe(true);
    if (layer.effects == null) throw new Error("layer has no effects group");
    const effect = layer.effects.properties[0];

    effect.name = "Custom Blur Name";

    const out = tmpPath.div("materialized.aep");
    app.project.save(out);

    const app2 = parseAep(out);
    const layer2 = getFirstLayer(app2.project);
    expect(layer2.effects != null).toBe(true);
    if (layer2.effects == null) throw new Error("layer has no effects group");
    expect(layer2.effects.properties[0].name).toBe("Custom Blur Name");
  });
});

describe("TestParseTimeWriteGuard", () => {
  /**
   * ChunkField.__set__ must block writes when materialization is suppressed,
   * while __dict__ bypass must still work.
   */

  test("test_write_blocked_during_suppress", () => {
    /** ChunkField raises RuntimeError when materialization is suppressed. */
    const app = parseAep(PROPERTY_DIR.div("keyframe_1D.aep"));
    const layer = getFirstLayer(app.project);
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity != null).toBe(true);
    if (opacity == null) throw new Error("no ADBE Opacity property");

    // Python `with _suppress_materialization():` is `.run(() => body)`.
    _suppressMaterialization().run(() => {
      raises(RuntimeError, () => {
        opacity.enabled = false;
      }, "Cannot write");
    });
  });

  test("test_dict_bypass_allowed_during_suppress", () => {
    /** __dict__ writes bypass ChunkField guard during suppression. */
    const app = parseAep(PROPERTY_DIR.div("keyframe_1D.aep"));
    const layer = getFirstLayer(app.project);
    const opacity = _findProperty(layer, "ADBE Opacity");
    expect(opacity != null).toBe(true);
    if (opacity == null) throw new Error("no ADBE Opacity property");

    _suppressMaterialization().run(() => {
      instanceDict(opacity).set("enabled", false);
      expect(instanceDict(opacity).get("enabled")).toBe(false);
    });
  });
});
