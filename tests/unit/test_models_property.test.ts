/** Tests for Property model parsing with strengthened assertions. */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { ListChunk } from "../../src/py_aep/binary/chunk.ts";
import { TdmnChunk, TdsnChunk } from "../../src/py_aep/binary/property_chunks.ts";
import { PropertyControlType } from "../../src/py_aep/enums/index.ts";
import { _resolveEffectValue, type ParamDef } from "../../src/py_aep/parsers/effect.ts";
import { parsePropertyGroup } from "../../src/py_aep/parsers/property.ts";
import { Path, valueEquals } from "../../src/pyrt/index.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");
const BUGS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "bugs");
const LAYER_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
// NOTE(port): Python assigns LAYER_SAMPLES_DIR twice with the same value; the redundant redeclaration is dropped (no observable difference).
const VERSIONS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");
const PROPERTY_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "property");

describe("TestResolveEffectValue", () => {
  /** Tests for _resolve_effect_value pure helper. */

  // Each row: [id] is the pytest param id, kept as a trailing comment.
  test.each([
    // enum_default_is_1_based
    [{ propertyControlType: PropertyControlType.ENUM, defaultValue: 1 }, PropertyControlType.ENUM, [1, 1]],
    // enum_default_over_cached_value
    // S_BlurDirectional Edge Mode: ExtendScript reports 3.
    [
      { propertyControlType: PropertyControlType.ENUM, defaultValue: 3, lastValue: 1, nbOptions: 3 },
      PropertyControlType.ENUM,
      [3, 3],
    ],
    // enum_cached_value_beyond_choices
    // OCIO Look Transform: a plug-in-managed id, which
    // ExtendScript reports.
    [
      { propertyControlType: PropertyControlType.ENUM, defaultValue: 1, lastValue: 459, nbOptions: 1 },
      PropertyControlType.ENUM,
      [459, 459],
    ],
    // boolean_default_value
    [{ propertyControlType: PropertyControlType.BOOLEAN, defaultValue: 1 }, PropertyControlType.BOOLEAN, [1, 1]],
    // boolean_falls_back_to_last_value
    [{ propertyControlType: PropertyControlType.BOOLEAN, lastValue: 0 }, PropertyControlType.BOOLEAN, [0, 0]],
    // general_prefers_the_default
    [
      { propertyControlType: PropertyControlType.SCALAR, lastValue: 42.0, defaultValue: 10.0 },
      PropertyControlType.SCALAR,
      [10.0, 10.0],
    ],
    // general_falls_back_to_default
    [{ propertyControlType: PropertyControlType.SCALAR, defaultValue: 10.0 }, PropertyControlType.SCALAR, [10.0, 10.0]],
    // general_no_values_returns_none
    [{ propertyControlType: PropertyControlType.SCALAR }, PropertyControlType.SCALAR, [null, null]],
    // general_last_value_only_without_a_default
    [{ propertyControlType: PropertyControlType.SCALAR, lastValue: 7.0 }, PropertyControlType.SCALAR, [7.0, 7.0]],
  ])(
    "test_resolve_effect_value[%#]",
    (paramDef: Partial<ParamDef>, controlType: PropertyControlType, expected: unknown) => {
      const result = _resolveEffectValue("TEST-0001", paramDef, controlType);
      expect(valueEquals(result, expected)).toBe(true);
    },
  );
});

describe("TestTdsnWithoutUtf8", () => {
  /**
   * A tdsn missing its Utf8 child degrades to the auto-name.
   *
   * Regression: `TdsnChunk.utf8` raised ValueError, escaping
   * `parse_property_group`'s ChunkNotFoundError handler and failing
   * the whole parse instead of falling back to the auto-name.
   */

  test("test_property_group_falls_back_to_auto_name", () => {
    const tdgp = new ListChunk({
      listType: "tdgp",
      chunks: [new TdsnChunk({ chunks: [] })], // no Utf8 child
    });
    const group = parsePropertyGroup(
      tdgp,
      "ADBE Transform Group",
      1,
      new Map(),
      // @ts-expect-error Python passes `cast(Any, None)`: this parse never reads the composition
      null,
      new TdmnChunk({ value: "ADBE Transform Group" }),
    );
    expect(group._nameUtf8 == null).toBe(true);
    expect(group.name).toBe("Transform");
  });
});
