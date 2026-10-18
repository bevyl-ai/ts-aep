/** Tests for the CLI validate module. */

import { describe, expect, test } from "bun:test";
import { loadExpected, parseProject } from "../conftest.ts";
import {
  type Dict,
  ValidationResult,
  compareLayer,
  compareProjectLevel,
  compareProperty,
  toDict,
  validateAep,
} from "../../src/py_aep/cli/validate.ts";
import { BlendingMode } from "../../src/py_aep/enums/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { Path, contains, getOr, getOrThrow, len, truthy, valueEquals } from "../../src/pyrt/index.ts";

/**
 * NOTE(port): Python `json.load` dicts are Maps in this port (rulebook §3); `load_expected` yields
 * plain objects, so convert recursively. Same data, same key order.
 */
function _jsonToDicts(x: object): Dict {
  return new Map(Object.entries(x).map(([k, v]) => [k, _jsonValueToDicts(v)]));
}

function _jsonValueToDicts(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(_jsonValueToDicts);
  if (x !== null && typeof x === "object" && !(x instanceof Map)) return _jsonToDicts(x);
  return x;
}

// `Path(__file__).parent.parent.parent / "samples"` from the Python file: the
// file's directory is `import.meta.dir`, so two `.parent` reach the package root.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples");

describe("TestToDict", () => {
  /** Tests for to_dict() serialization. */

  test("test_project_to_dict", () => {
    const aepPath = SAMPLES_DIR.div("models", "composition", "bgColor_custom.aep");
    const project = parseProject(aepPath);
    const result = toDict(project);
    expect(result instanceof Map).toBe(true);
    expect(contains(result, "items")).toBe(true);
  });

  test("test_enum_to_dict", () => {
    const result = toDict(BlendingMode.NORMAL);
    expect(result).toBe(BlendingMode.NORMAL);
  });

  test("test_list_to_dict", () => {
    const result = toDict([1, 2, 3]);
    expect(valueEquals(result, [1, 2, 3])).toBe(true);
  });

  test("test_dict_to_dict", () => {
    const result = toDict(new Map([["a", 1]]));
    expect(valueEquals(result, new Map([["a", 1]]))).toBe(true);
  });

  test("test_plain_value", () => {
    expect(toDict(42)).toBe(42);
    expect(toDict("hello")).toBe("hello");
    expect(toDict(null) == null).toBe(true);
  });
});

describe("TestCompareProjectLevel", () => {
  /** Tests for compare_project_level(). */

  test("test_matching_project", () => {
    const aepPath = SAMPLES_DIR.div("models", "composition", "bgColor_custom.aep");
    const project = parseProject(aepPath);
    const parsed = toDict(project);
    const expected = _jsonToDicts(loadExpected(SAMPLES_DIR.div("models", "composition"), "bgColor_custom"));
    const result = new ValidationResult();
    compareProjectLevel(expected, parsed, result);
    // Project-level fields should match (or have no differences)
    expect(result instanceof ValidationResult).toBe(true);
  });

  test("test_mismatching_field", () => {
    const result = new ValidationResult();
    const expected = new Map([["bitsPerChannel", 16]]);
    const parsed = new Map([["bitsPerChannel", 8]]);
    compareProjectLevel(expected, parsed, result);
    expect(len(result)).toBe(1);
  });
});

describe("TestCompareLayer", () => {
  /** Tests for compare_layer(). */

  test("test_full_layer_comparison", () => {
    const aepPath = SAMPLES_DIR.div("models", "layer", "enabled_false.aep");
    const project = parseProject(aepPath);
    const parsed = toDict(project);
    const expected = _jsonToDicts(loadExpected(SAMPLES_DIR.div("models", "layer"), "enabled_false"));
    // Find matching comp and layers
    for (const item of getOrThrow(expected, "items")) {
      if (contains(item, "layers") && len(getOrThrow(item, "layers")) > 0) {
        const expLayer = getOrThrow<string, Dict[]>(item, "layers")[0];
        // Get parsed comp layers
        const parsedComps = getOr(parsed, "_compositions", []);
        if (truthy(parsedComps)) {
          const parsedLayers = getOr<string, Dict[], Dict[]>(parsedComps[0], "layers", []);
          if (truthy(parsedLayers)) {
            const result = new ValidationResult();
            compareLayer(expLayer, parsedLayers[0], "Layer[0]", 30.0, 24.0, result);
            expect(result instanceof ValidationResult).toBe(true);
          }
        }
      }
    }
  });
});

describe("TestValidateAep", () => {
  /** Tests for validate_aep() integration. */

  test("test_validate_sample", () => {
    const aepPath = SAMPLES_DIR.div("models", "composition", "bgColor_custom.aep");
    const jsonPath = SAMPLES_DIR.div("models", "composition", "bgColor_custom.json");
    const result = validateAep(aepPath, jsonPath);
    expect(result instanceof ValidationResult).toBe(true);
  });

  test("test_media_replacement_fully_validates", () => {
    // Guards the alternateSource/essentialPropertySource object comparison
    // against the regenerated ground-truth JSON (the override leaf carries
    // both keys).
    const eg = SAMPLES_DIR.div("models", "essential_graphics");
    const result = validateAep(eg.div("media_replacement.aep"), eg.div("media_replacement.json"));
    expect(len(result)).toBe(0);
  });
});

describe("TestComparePropertyMediaReplacement", () => {
  /** Tests for the media-replacement object comparisons in compare_property(). */

  test("test_matching_object_sources_no_diff", () => {
    const expected = new Map<string, Map<string, number | string>>([
      [
        "alternateSource",
        new Map<string, number | string>([
          ["id", 30],
          ["name", "wrapper"],
        ]),
      ],
      [
        "essentialPropertySource",
        new Map<string, number | string>([
          ["sourceType", "AVLayer"],
          ["name", "src_layer"],
          ["index", 1],
        ]),
      ],
    ]);
    // Parsed index is 0-based; the AVItem/AVLayer serialize id/name/index.
    const parsed = new Map<string, Map<string, number | string>>([
      [
        "alternateSource",
        new Map<string, number | string>([
          ["id", 30],
          ["name", "wrapper"],
        ]),
      ],
      [
        "essentialPropertySource",
        new Map<string, number | string>([
          ["name", "src_layer"],
          ["index", 0],
        ]),
      ],
    ]);
    const result = new ValidationResult();
    compareProperty(expected, parsed, "P", result);
    expect(len(result)).toBe(0);
  });

  test("test_id_and_index_mismatches_flagged", () => {
    const expected = new Map<string, Map<string, number | string>>([
      [
        "alternateSource",
        new Map<string, number | string>([
          ["id", 30],
          ["name", "wrapper"],
        ]),
      ],
      [
        "essentialPropertySource",
        new Map<string, number | string>([
          ["sourceType", "AVLayer"],
          ["name", "src_layer"],
          ["index", 1],
        ]),
      ],
    ]);
    const parsed = new Map<string, Map<string, number | string>>([
      // id mismatch
      [
        "alternateSource",
        new Map<string, number | string>([
          ["id", 99],
          ["name", "wrapper"],
        ]),
      ],
      // 5+1 != 1
      [
        "essentialPropertySource",
        new Map<string, number | string>([
          ["name", "src_layer"],
          ["index", 5],
        ]),
      ],
    ]);
    const result = new ValidationResult();
    compareProperty(expected, parsed, "P", result);
    expect(len(result)).toBe(2);
  });

  test("test_property_source_matchname_compared", () => {
    const expected = new Map<string, Map<string, number | string>>([
      [
        "essentialPropertySource",
        new Map<string, number | string>([
          ["sourceType", "Property"],
          ["matchName", "ADBE Opacity"],
        ]),
      ],
    ]);
    const result = new ValidationResult();
    compareProperty(
      expected,
      new Map([["essentialPropertySource", new Map([["matchName", "ADBE Fill"]])]]),
      "P",
      result,
    );
    expect(len(result)).toBe(1);
  });
});
