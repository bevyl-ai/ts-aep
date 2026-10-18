/**
 * Validate PropSpec and GroupSpec entries for internal consistency.
 *
 * These tests catch typos, wrong PropertyValueType, incorrect dimensions, and
 * other silent data errors in the spec tables used for property synthesis.
 */

import { describe, expect, test } from "bun:test";

import { MATCH_NAME_TO_AUTO_NAME } from "../../src/py_aep/data/match_names.ts";
import { PropertyValueType } from "../../src/py_aep/enums/index.ts";
import {
  _ADV_BLEND_SPECS,
  _AUDIO_SPECS,
  _BEVEL_EMBOSS_SPECS,
  _BLEND_OPTIONS_SPECS,
  _CAMERA_SPECS,
  _COLOR_MAX,
  _COLOR_MIN,
  _COLOR_OVERLAY_SPECS,
  _COMPOSITING_OPTIONS_SPECS,
  _DROP_SHADOW_SPECS,
  _EXTRUSION_SPECS,
  _GRADIENT_OVERLAY_SPECS,
  _GROUP_CHILD_SPECS,
  _INNER_GLOW_SPECS,
  _INNER_SHADOW_SPECS,
  _LAYER_STYLE_CHILD_SPECS,
  _LIGHT_SPECS,
  _MASK_ATOM_SPECS,
  _MATERIAL_SPECS,
  _OUTER_GLOW_SPECS,
  _PATTERN_OVERLAY_SPECS,
  _PLANE_SPECS,
  _SATIN_SPECS,
  _SOURCE_OPTIONS_SPECS,
  _STROKE_SPECS,
  _TEXT_MORE_OPTIONS_SPECS,
  _TEXT_PATH_OPTIONS_SPECS,
  _TOP_LEVEL_SPECS,
  _TRANSFORM_SPECS,
  _VECTOR_ELLIPSE_SPECS,
  _VECTOR_FILL_SPECS,
  _VECTOR_GROUP_SPECS,
  _VECTOR_MATERIALS_SPECS,
  _VECTOR_RECT_SPECS,
  _VECTOR_REPEATER_SPECS,
  _VECTOR_REPEATER_TRANSFORM_SPECS,
  _VECTOR_STAR_SPECS,
  _VECTOR_STROKE_DASHES_SPECS,
  _VECTOR_STROKE_SPECS,
  _VECTOR_STROKE_TAPER_SPECS,
  _VECTOR_STROKE_WAVE_SPECS,
  _VECTOR_TRANSFORM_SPECS,
  type GroupSpec,
  PropSpec,
} from "../../src/py_aep/synthesis/property.ts";
import { getOr, getOrThrow, len, assert, truthy, repr } from "../../src/pyrt/index.ts";
import { sorted } from "../support/python.ts";

// ---------------------------------------------------------------------------
// Collect all spec lists into a flat sequence of (list_name, spec) pairs
// for parametrized testing.
// ---------------------------------------------------------------------------

const _NAMED_SPEC_LISTS: [string, (PropSpec | GroupSpec)[]][] = [
  ["MATERIAL", _MATERIAL_SPECS],
  ["EXTRUSION", _EXTRUSION_SPECS],
  ["PLANE", _PLANE_SPECS],
  ["AUDIO", _AUDIO_SPECS],
  ["SOURCE_OPTIONS", _SOURCE_OPTIONS_SPECS],
  ["COMPOSITING_OPTIONS", _COMPOSITING_OPTIONS_SPECS],
  ["MASK_ATOM", _MASK_ATOM_SPECS],
  ["LIGHT", _LIGHT_SPECS],
  ["CAMERA", _CAMERA_SPECS],
  ["TEXT_PATH_OPTIONS", _TEXT_PATH_OPTIONS_SPECS],
  ["TEXT_MORE_OPTIONS", _TEXT_MORE_OPTIONS_SPECS],
  ["VECTOR_STAR", _VECTOR_STAR_SPECS],
  ["VECTOR_FILL", _VECTOR_FILL_SPECS],
  ["VECTOR_STROKE", _VECTOR_STROKE_SPECS],
  ["VECTOR_STROKE_DASHES", _VECTOR_STROKE_DASHES_SPECS],
  ["VECTOR_STROKE_TAPER", _VECTOR_STROKE_TAPER_SPECS],
  ["VECTOR_STROKE_WAVE", _VECTOR_STROKE_WAVE_SPECS],
  ["VECTOR_GROUP", _VECTOR_GROUP_SPECS],
  ["VECTOR_TRANSFORM", _VECTOR_TRANSFORM_SPECS],
  ["VECTOR_MATERIALS", _VECTOR_MATERIALS_SPECS],
  ["VECTOR_ELLIPSE", _VECTOR_ELLIPSE_SPECS],
  ["VECTOR_RECT", _VECTOR_RECT_SPECS],
  ["VECTOR_REPEATER_TRANSFORM", _VECTOR_REPEATER_TRANSFORM_SPECS],
  ["VECTOR_REPEATER", _VECTOR_REPEATER_SPECS],
  ["BLEND_OPTIONS", _BLEND_OPTIONS_SPECS],
  ["ADV_BLEND", _ADV_BLEND_SPECS],
  ["DROP_SHADOW", _DROP_SHADOW_SPECS],
  ["INNER_SHADOW", _INNER_SHADOW_SPECS],
  ["OUTER_GLOW", _OUTER_GLOW_SPECS],
  ["INNER_GLOW", _INNER_GLOW_SPECS],
  ["BEVEL_EMBOSS", _BEVEL_EMBOSS_SPECS],
  ["SATIN", _SATIN_SPECS],
  ["COLOR_OVERLAY", _COLOR_OVERLAY_SPECS],
  ["GRADIENT_OVERLAY", _GRADIENT_OVERLAY_SPECS],
  ["PATTERN_OVERLAY", _PATTERN_OVERLAY_SPECS],
  ["STROKE", _STROKE_SPECS],
  ["TRANSFORM", _TRANSFORM_SPECS],
  ["TOP_LEVEL", _TOP_LEVEL_SPECS],
];

// Add spec lists from the registry dicts.
for (const [_key, _specs] of _GROUP_CHILD_SPECS.entries()) {
  _NAMED_SPEC_LISTS.push([`GROUP_CHILD[${_key}]`, [..._specs]]);
}
for (const [_key, _specs] of _LAYER_STYLE_CHILD_SPECS.entries()) {
  _NAMED_SPEC_LISTS.push([`LAYER_STYLE[${_key}]`, [..._specs]]);
}

// Flat list of all PropSpec entries with readable IDs.
const _ALL_PROP_SPECS: [string, PropSpec][] = _NAMED_SPEC_LISTS.flatMap(([listName, specs]) =>
  specs
    .filter((spec): spec is PropSpec => spec instanceof PropSpec)
    .map((spec): [string, PropSpec] => [`${listName}/${spec.matchName}`, spec]),
);

// Flat list of all specs (both types) with readable IDs.
const _ALL_SPECS: [string, PropSpec | GroupSpec][] = _NAMED_SPEC_LISTS.flatMap(([listName, specs]) =>
  specs.map((spec): [string, PropSpec | GroupSpec] => [`${listName}/${spec.matchName}`, spec]),
);

// Expected dimensions for each PropertyValueType.
const _PVT_EXPECTED_DIMENSIONS: Map<PropertyValueType, number | null> = new Map<PropertyValueType, number | null>([
  [PropertyValueType.COLOR, 4],
  [PropertyValueType.ThreeD_SPATIAL, 3],
  [PropertyValueType.ThreeD, 3],
  [PropertyValueType.TwoD_SPATIAL, 2],
  [PropertyValueType.TwoD, 2],
  [PropertyValueType.MARKER, 0],
]);

// SPATIAL pvt types that require is_spatial=True.
const _SPATIAL_PVTS: ReadonlySet<PropertyValueType> = new Set<PropertyValueType>([
  PropertyValueType.TwoD_SPATIAL,
  PropertyValueType.ThreeD_SPATIAL,
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TestPropSpecFieldConsistency", () => {
  test.each(_ALL_PROP_SPECS)("test_pvt_dimensions_consistency[%#]", (specId: string, spec: PropSpec) => {
    const expected = getOr(_PVT_EXPECTED_DIMENSIONS, spec.pvt);
    if (expected != null) {
      assert(
        spec.dimensions === expected,
        `${specId}: pvt=${PropertyValueType.nameOf(spec.pvt)} requires dimensions=${expected}, got ${spec.dimensions}`,
      );
    }
  });

  test.each(_ALL_PROP_SPECS)("test_color_flag_iff_color_pvt[%#]", (specId: string, spec: PropSpec) => {
    const isColorPvt = spec.pvt === PropertyValueType.COLOR;
    assert(
      spec.color === isColorPvt,
      `${specId}: color=${repr(spec.color)} but pvt=${PropertyValueType.nameOf(spec.pvt)}`,
    );
  });

  test.each(_ALL_PROP_SPECS)("test_spatial_pvt_requires_is_spatial[%#]", (specId: string, spec: PropSpec) => {
    if (_SPATIAL_PVTS.has(spec.pvt)) {
      assert(spec.isSpatial, `${specId}: pvt=${PropertyValueType.nameOf(spec.pvt)} requires is_spatial=True`);
    }
  });

  test.each(_ALL_PROP_SPECS)("test_value_shape_matches_dimensions[%#]", (specId: string, spec: PropSpec) => {
    if (spec.value == null) return;
    if (spec.dimensions > 1) {
      assert(Array.isArray(spec.value), `${specId}: dimensions=${spec.dimensions} but value is not a list`);
      assert(
        len(spec.value) === spec.dimensions,
        `${specId}: dimensions=${spec.dimensions} but value has ${len(spec.value)} elements`,
      );
    } else if (spec.dimensions <= 1) {
      // NOTE(port): same isinstance(int, float) check as Python; only the failure-message type name differs (typeof vs type().__name__).
      assert(
        typeof spec.value === "number",
        `${specId}: dimensions=${spec.dimensions} but value is ${typeof spec.value}, expected scalar`,
      );
    }
  });

  test.each(_ALL_PROP_SPECS)("test_color_specs_have_bounds[%#]", (specId: string, spec: PropSpec) => {
    if (spec.pvt !== PropertyValueType.COLOR) return;
    assert(spec.minValue === _COLOR_MIN, `${specId}: COLOR spec missing min_value=_COLOR_MIN`);
    assert(spec.maxValue === _COLOR_MAX, `${specId}: COLOR spec missing max_value=_COLOR_MAX`);
  });

  test.each(_ALL_PROP_SPECS)("test_min_max_ordering[%#]", (specId: string, spec: PropSpec) => {
    if (spec.minValue != null && spec.maxValue != null) {
      assert(
        spec.minValue <= spec.maxValue,
        `${specId}: min_value=${repr(spec.minValue)} > max_value=${repr(spec.maxValue)}`,
      );
    }
  });
});

describe("TestSpecStringFields", () => {
  test.each(_ALL_SPECS)("test_non_empty_match_name[%#]", (specId: string, spec: PropSpec | GroupSpec) => {
    expect(typeof spec.matchName === "string" && truthy(spec.matchName)).toBe(true);
  });

  test.each(_ALL_SPECS)("test_non_empty_auto_name[%#]", (specId: string, spec: PropSpec | GroupSpec) => {
    // Variable-font axis properties have empty display names in AE
    // (they are populated dynamically from the font's named axes).
    if (spec.matchName.startsWith("ADBE Text VF Axis")) {
      expect(spec.autoName).toBe("");
      return;
    }
    expect(typeof spec.autoName === "string" && truthy(spec.autoName)).toBe(true);
  });
});

describe("TestSpecListUniqueness", () => {
  test.each(_NAMED_SPEC_LISTS)("test_unique_match_names[%#]", (listName: string, specs: (PropSpec | GroupSpec)[]) => {
    const matchNames = specs.map((s) => s.matchName);
    const duplicates = matchNames.filter((mn) => matchNames.filter((x) => x === mn).length > 1);
    assert(!truthy(duplicates), `${listName} has duplicate match_names: ${repr(sorted(new Set(duplicates)))}`);
  });
});

// Known intentional divergences: spec name differs from registry name.
// Specs use the short names shown in the AE timeline; the registry has the
// fully qualified ExtendScript names.
const _KNOWN_DIVERGENCES: Map<string, string> = new Map<string, string>([
  // AE shows "Rotation" on 2D layers; registry has "Z Rotation".
  ["ADBE Rotate Z", "Rotation"],
  // Text animator Rotation: AE shows "Rotation"; registry "Z Rotation".
  ["ADBE Text Rotation", "Rotation"],
  // Vector Transform properties: specs use short names, registry prefixes
  // with "Shape Group Transform".
  ["ADBE Vector Anchor", "Anchor Point"],
  ["ADBE Vector Position", "Position"],
  ["ADBE Vector Scale", "Scale"],
  ["ADBE Vector Skew", "Skew"],
  ["ADBE Vector Skew Axis", "Skew Axis"],
  ["ADBE Vector Rotation", "Rotation"],
  ["ADBE Vector Group Opacity", "Opacity"],
]);

const _REGISTRY_SPECS: [string, PropSpec | GroupSpec][] = _ALL_SPECS.filter(
  ([_sid, s]) => MATCH_NAME_TO_AUTO_NAME.has(s.matchName) && !_KNOWN_DIVERGENCES.has(s.matchName),
);

describe("TestSpecNamesMatchRegistry", () => {
  test.each(_REGISTRY_SPECS)("test_name_matches_registry[%#]", (specId: string, spec: PropSpec | GroupSpec) => {
    const expected = getOrThrow(MATCH_NAME_TO_AUTO_NAME, spec.matchName);
    assert(
      spec.autoName === expected,
      `${specId}: spec auto_name ${repr(spec.autoName)} != registry ${repr(expected)}`,
    );
  });

  /** Guard that allowlisted divergences haven't been fixed without
   * removing the allowlist entry.
   */
  test.each([..._KNOWN_DIVERGENCES.entries()])(
    "test_known_divergences_are_still_divergent[%#]",
    (matchName: string, expectedSpecName: string) => {
      const registryName = getOr(MATCH_NAME_TO_AUTO_NAME, matchName);
      assert(registryName != null, `allowlisted match_name ${repr(matchName)} no longer in registry`);
      assert(
        registryName !== expectedSpecName,
        `divergence for ${repr(matchName)} has been resolved - remove from allowlist`,
      );
    },
  );
});
