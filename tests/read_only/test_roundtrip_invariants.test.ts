/**
 * Migration invariant tests.
 *
 * Regression suite designed to survive the Kaitai-to-struct migration.
 * All tests use the PUBLIC model API only - no Kaitai types, no chunk
 * internals. If any test here breaks during migration, the migration
 * has a bug.
 */

import { describe, test, expect } from "bun:test";
import { Path, len, py_assert, py_eq, AssertionError_, repr } from "../../src/pyrt/index.ts";
import { make_tmp_path } from "../../src/pyrt/pytest.ts";
import "../../src/py_aep/binary/_register.ts";
import { get_first_layer, get_layer } from "../conftest.ts";
import { as_instance } from "../helpers.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
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
function _find_property(layer: Layer, match_name: string): Property | null {
  function _search(group: PropertyGroup): Property | null {
    for (const prop of group.properties) {
      if (prop instanceof Property && prop.match_name === match_name) {
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
    if (group instanceof Property && group.match_name === match_name) {
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
function _find_synthesized_effect_prop(layer: Layer, effect_index: number, match_name: string): Property {
  const effect = as_instance(layer.effects, PropertyGroup).properties[effect_index];
  py_assert(effect instanceof PropertyGroup);
  for (const prop of effect.properties) {
    if (prop instanceof Property && prop.match_name === match_name) {
      return prop;
    }
  }
  throw new AssertionError_(`Property ${repr(match_name)} not found in effect`);
}

/** Synthesized (ProxyBody-backed) properties must not affect saved bytes. */
describe("TestSynthesizedPropertyInvisibility", () => {
  test("test_effect_properties_invisible", () => {
    /** Synthesized effect properties exist in model but not in output. */
    const tmp_path = make_tmp_path();
    const aep_path = PROPERTY_DIR.div("2_gaussian.aep");
    const original_bytes = aep_path.read_bytes();

    const app = parse_aep(aep_path);
    const layer = get_first_layer(app.project);

    // Verify synthesized properties exist in the model
    const blur = _find_synthesized_effect_prop(layer, 0, "ADBE Gaussian Blur 2-0001");
    expect(blur != null).toBe(true);
    expect(blur.value != null).toBe(true);

    // Save WITHOUT mutating anything
    const out = tmp_path.div("untouched.aep");
    app.project.save(out);
    expect(py_eq(out.read_bytes(), original_bytes)).toBe(true);
  });

  test("test_top_level_groups_invisible", () => {
    /** Synthesized top-level groups (Effects, Masks) don't affect output. */
    const tmp_path = make_tmp_path();
    const aep_path = PROPERTY_DIR.div("keyframe_1D.aep");
    const original_bytes = aep_path.read_bytes();

    const app = parse_aep(aep_path);
    const layer = get_first_layer(app.project);

    // Verify synthesized groups exist in the property tree
    const match_names = layer.properties.map((p) => p.match_name);
    expect(match_names.includes("ADBE Effect Parade")).toBe(true);
    expect(match_names.includes("ADBE Mask Parade")).toBe(true);

    // Save without mutation
    const out = tmp_path.div("untouched.aep");
    app.project.save(out);
    expect(py_eq(out.read_bytes(), original_bytes)).toBe(true);
  });
});

/**
 * Verify that specific binary patterns (LE cdat, spatial ldat, tdum/tduM)
 * survive parse > model access > save without corruption.
 */
describe("TestParameterizedBodyRoundtrip", () => {
  test("test_le_cdat_orientation", () => {
    /** LE cdat inside LIST:otst survives round-trip. */
    const tmp_path = make_tmp_path();
    const aep_path = LAYER_DIR.div("orientation_with_keyframes.aep");
    const original_bytes = aep_path.read_bytes();

    const app = parse_aep(aep_path);
    const layer = get_first_layer(app.project);
    const orientation = _find_property(layer, "ADBE Orientation");
    expect(orientation != null).toBe(true);
    if (orientation == null) throw new AssertionError_("no ADBE Orientation property");
    expect(len(orientation.keyframes) > 0).toBe(true);

    const out = tmp_path.div("roundtrip.aep");
    app.project.save(out);
    expect(py_eq(out.read_bytes(), original_bytes)).toBe(true);
  });

  test("test_spatial_2d_ldat", () => {
    /** 2D spatial ldat with tangent arrays survives round-trip. */
    const tmp_path = make_tmp_path();
    const aep_path = PROPERTY_DIR.div("keyframe_spatial.aep");
    const original_bytes = aep_path.read_bytes();

    const app = parse_aep(aep_path);
    const layer = get_layer(app.project, "keyframe_spatial_bezier_arc");
    const position = _find_property(layer, "ADBE Position");
    expect(position != null).toBe(true);
    if (position == null) throw new AssertionError_("no ADBE Position property");
    expect(position.is_spatial).toBe(true);
    expect(len(position.keyframes) > 0).toBe(true);

    const out = tmp_path.div("roundtrip.aep");
    app.project.save(out);
    expect(py_eq(out.read_bytes(), original_bytes)).toBe(true);
  });

  test("test_spatial_3d_ldat", () => {
    /** 3D spatial ldat (promoted via tdb4.is_spatial) survives round-trip. */
    const tmp_path = make_tmp_path();
    const aep_path = PROPERTY_DIR.div("keyframe_spatial_bezier_3D.aep");
    const original_bytes = aep_path.read_bytes();

    const app = parse_aep(aep_path);
    const layer = get_first_layer(app.project);
    const position = _find_property(layer, "ADBE Position");
    expect(position != null).toBe(true);
    if (position == null) throw new AssertionError_("no ADBE Position property");
    expect(position.is_spatial).toBe(true);
    expect(len(position.keyframes) > 0).toBe(true);

    const out = tmp_path.div("roundtrip.aep");
    app.project.save(out);
    expect(py_eq(out.read_bytes(), original_bytes)).toBe(true);
  });

  test("test_tdum_with_effects", () => {
    /** tdum/tduM min/max chunks with multiple value types survive round-trip. */
    const tmp_path = make_tmp_path();
    const aep_path = PROPERTY_DIR.div("effects.aep");
    const original_bytes = aep_path.read_bytes();

    const app = parse_aep(aep_path);
    const layer = get_first_layer(app.project);
    // Verify effects parsed
    expect(layer.effects != null).toBe(true);
    expect(len(as_instance(layer.effects, PropertyGroup).properties) > 0).toBe(true);

    const out = tmp_path.div("roundtrip.aep");
    app.project.save(out);
    expect(py_eq(out.read_bytes(), original_bytes)).toBe(true);
  });

  test("test_nonspatial_1d_ldat", () => {
    /** Non-spatial 1D keyframes - simplest ldat pattern. */
    const tmp_path = make_tmp_path();
    const aep_path = PROPERTY_DIR.div("keyframe_1D.aep");
    const original_bytes = aep_path.read_bytes();

    const app = parse_aep(aep_path);
    const layer = get_first_layer(app.project);
    const opacity = _find_property(layer, "ADBE Opacity");
    expect(opacity != null).toBe(true);
    if (opacity == null) throw new AssertionError_("no ADBE Opacity property");
    expect(len(opacity.keyframes) > 0).toBe(true);
    expect(opacity.is_spatial).toBe(false);

    const out = tmp_path.div("roundtrip.aep");
    app.project.save(out);
    expect(py_eq(out.read_bytes(), original_bytes)).toBe(true);
  });
});
