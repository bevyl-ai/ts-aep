/**
 * Migration invariant tests.
 *
 * Regression suite designed to survive the Kaitai-to-struct migration.
 * All tests use the PUBLIC model API only - no Kaitai types, no chunk
 * internals. If any test here breaks during migration, the migration
 * has a bug.
 */

import { describe, expect, test } from "bun:test";
import { AttributeError, AssertionError_, Path, py_assert, py_eq, repr, RuntimeError, instance_dict } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import "../../src/py_aep/binary/_register.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { PropertyGroup } from "../../src/py_aep/models/properties/property_group.ts";
import { _suppress_materialization } from "../../src/py_aep/models/descriptors.ts";
import { get_first_layer } from "../helpers.ts";

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
function _sample_id(p: Path): string {
  return p.path.slice(SAMPLES_DIR.path.length + 1).replaceAll("/", "__");
}

/** Find a property by match_name anywhere in the layer's property tree. */
function _find_property(layer: Layer, match_name: string): Property | null {
  function _search(group: PropertyGroup): Property | null {
    for (const prop of group.properties) {
      if (prop instanceof Property && prop.matchName === match_name) {
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
    if (group instanceof Property && group.matchName === match_name) {
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
function _find_synthesized_effect_prop(layer: Layer, effect_index: number, match_name: string): Property {
  if (layer.effects == null) throw new Error("layer has no effects group");
  const effect = layer.effects.properties[effect_index];
  py_assert(effect instanceof PropertyGroup);
  for (const prop of effect.properties) {
    if (prop instanceof Property && prop.matchName === match_name) {
      return prop;
    }
  }
  throw new AssertionError_(`Property ${repr(match_name)} not found in effect`);
}

describe("TestByteIdentityRoundtrip", () => {
  /** Parse > save > compare bytes for diverse sample files. */
  test.each(ROUNDTRIP_SAMPLES.map((p) => [_sample_id(p), p] as [string, Path]))(
    "test_roundtrip[%s]",
    (_id, aep_path) => {
      const tmp_path = make_tmp_path();
      const original_bytes = aep_path.read_bytes();

      const app = parse_aep(aep_path);
      const out = tmp_path.div("roundtrip.aep");
      app.project.save(out);
      const roundtrip_bytes = out.read_bytes();

      expect(py_eq(roundtrip_bytes, original_bytes)).toBe(true);
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
    const tmp_path = make_tmp_path();
    const app = parse_aep(PROPERTY_DIR.div("2_gaussian.aep"));
    const layer = get_first_layer(app.project);
    const blur = _find_synthesized_effect_prop(layer, 0, "ADBE Gaussian Blur 2-0001");

    blur.value = 42.0;

    const out = tmp_path.div("materialized.aep");
    app.project.save(out);

    const app2 = parse_aep(out);
    const layer2 = get_first_layer(app2.project);
    const blur2 = _find_synthesized_effect_prop(layer2, 0, "ADBE Gaussian Blur 2-0001");
    expect(blur2.value).toBe(42.0);
  });

  test("test_enabled_read_only_on_effect_param", () => {
    /**
     * Effect-parameter `enabled` is read-only (AE `canSetEnabled` is
     * False), so the write is rejected and the property is left untouched.
     */
    const app = parse_aep(PROPERTY_DIR.div("2_gaussian.aep"));
    const layer = get_first_layer(app.project);
    const blur = _find_synthesized_effect_prop(layer, 0, "ADBE Gaussian Blur 2-0001");
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
    const tmp_path = make_tmp_path();
    const app = parse_aep(PROPERTY_DIR.div("2_gaussian.aep"));
    const layer = get_first_layer(app.project);
    expect(layer.effects != null).toBe(true);
    if (layer.effects == null) throw new Error("layer has no effects group");
    const effect = layer.effects.properties[0];

    effect.name = "Custom Blur Name";

    const out = tmp_path.div("materialized.aep");
    app.project.save(out);

    const app2 = parse_aep(out);
    const layer2 = get_first_layer(app2.project);
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
    const app = parse_aep(PROPERTY_DIR.div("keyframe_1D.aep"));
    const layer = get_first_layer(app.project);
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity != null).toBe(true);
    if (opacity == null) throw new Error("no ADBE Opacity property");

    // Python `with _suppress_materialization():` is `.run(() => body)`.
    _suppress_materialization().run(() => {
      raises(RuntimeError, () => {
        opacity.enabled = false;
      }, "Cannot write");
    });
  });

  test("test_dict_bypass_allowed_during_suppress", () => {
    /** __dict__ writes bypass ChunkField guard during suppression. */
    const app = parse_aep(PROPERTY_DIR.div("keyframe_1D.aep"));
    const layer = get_first_layer(app.project);
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity != null).toBe(true);
    if (opacity == null) throw new Error("no ADBE Opacity property");

    _suppress_materialization().run(() => {
      instance_dict(opacity).set("enabled", false);
      expect(instance_dict(opacity).get("enabled")).toBe(false);
    });
  });
});
