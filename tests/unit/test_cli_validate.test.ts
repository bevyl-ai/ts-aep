/**
 * Tests for the CLI validate module.
 */

import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import "../../src/py_aep/binary/_register.ts";
import { ValidationResult, _getFieldNames, _getPropertyNames, compareMarker, compareValues, getEnumValue, main } from "../../src/py_aep/cli/validate.ts";
import { BlendingMode } from "../../src/py_aep/enums/index.ts";
import { KeyframeEase } from "../../src/py_aep/models/properties/keyframe_ease.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { AssertionError, Path, getOrThrow, len, assert, valueEquals, range, repr, sorted, str, strip } from "../../src/pyrt/index.ts";
import { makeTmpPath, skip } from "../../src/pyrt/pytest.ts";

/** Path(__file__).parent.parent.parent / "samples" */
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples");
const TS_ROOT = new Path(import.meta.path).parent.parent.parent;

describe("TestGetEnumValue", () => {
  /** Tests for get_enum_value(). */

  test("test_enum_returns_value", () => {
    expect(getEnumValue(BlendingMode.ADD)).toBe(BlendingMode.ADD);
  });

  test("test_non_enum_returns_as_is", () => {
    expect(getEnumValue(42)).toBe(42);
    expect(getEnumValue("test")).toBe("test");
    expect(getEnumValue(null)).toBeNull();
  });
});

describe("TestCompareValues", () => {
  /** Tests for compare_values(). */

  test("test_none_both", () => {
    expect(compareValues(null, null)).toBe(true);
  });

  test("test_none_one", () => {
    expect(compareValues(null, 1)).toBe(false);
    expect(compareValues(1, null)).toBe(false);
  });

  test("test_booleans", () => {
    expect(compareValues(true, true)).toBe(true);
    expect(compareValues(false, false)).toBe(true);
    expect(compareValues(true, false)).toBe(false);
  });

  test("test_integers", () => {
    expect(compareValues(1, 1)).toBe(true);
    expect(compareValues(1, 2)).toBe(false);
  });

  test("test_floats_with_tolerance", () => {
    expect(compareValues(1.0, 1.0001)).toBe(true);
    expect(compareValues(1.0, 2.0)).toBe(false);
  });

  test("test_strings", () => {
    expect(compareValues("abc", "abc")).toBe(true);
    expect(compareValues("abc", "def")).toBe(false);
  });

  test("test_lists", () => {
    expect(compareValues([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(compareValues([1, 2], [1, 2, 3])).toBe(false);
    expect(compareValues([1, 2, 3], [1, 2, 4])).toBe(false);
  });

  test("test_nested_lists", () => {
    expect(compareValues([1.0, 2.0], [1.0001, 2.0001])).toBe(true);
  });
});

describe("TestValidationResult", () => {
  /** Tests for ValidationResult class. */

  test("test_empty", () => {
    const result = new ValidationResult();
    expect(len(result)).toBe(0);
    expect(valueEquals(result.differences, [])).toBe(true);
    expect(valueEquals(result.warnings, [])).toBe(true);
  });

  test("test_add_diff", () => {
    const result = new ValidationResult();
    result.addDiff("test.field", 1, 2, "test");
    expect(len(result)).toBe(1);
    expect(result.differences[0].includes("test.field")).toBe(true);
    expect(getOrThrow(result.categories, "test")).toBe(1);
  });

  test("test_add_warning", () => {
    const result = new ValidationResult();
    result.addWarning("some warning");
    expect(len(result.warnings)).toBe(1);
    expect(result.warnings[0]).toBe("some warning");
  });
});

describe("TestCompareMarker", () => {
  /** Tests for compare_marker(). */

  test("test_matching_marker", () => {
    const result = new ValidationResult();
    const expectedMarker = new Map<string, number | string>([
      ["time", 1.0],
      ["comment", "test"],
      ["chapter", ""],
      ["url", ""],
      ["duration", 0],
    ]);
    const parsedMarker = new Map<string, number | string>([
      ["frameTime", 30],
      ["comment", "test"],
      ["chapter", ""],
      ["url", ""],
      ["duration", 0],
    ]);
    compareMarker(expectedMarker, parsedMarker, "Marker[0]", 30.0, result);
    // time=frame_time/fps = 30/30 = 1.0
    const markerDiffs = result.differences.filter((d) => d.includes("Marker"));
    expect(len(markerDiffs)).toBe(0);
  });

  test("test_mismatching_marker_comment", () => {
    const result = new ValidationResult();
    const expectedMarker = new Map<string, string>([["comment", "expected"]]);
    const parsedMarker = new Map<string, string>([["comment", "actual"]]);
    compareMarker(expectedMarker, parsedMarker, "Marker[0]", 30.0, result);
    expect(len(result)).toBeGreaterThanOrEqual(1);
  });
});

describe("TestTraversalOrder", () => {
  /**
   * `to_dict` must walk attributes in a fixed order.
   *
   * Reading a model attribute can realize lazily-parsed children, and
   * `to_dict` memoizes the first result it reaches a shared object by, so
   * an unordered walk let `PYTHONHASHSEED` change the report: two runs
   * over the same project disagreed by 16 differences on whether an
   * effect had all of its parameters.
   */

  test("test_field_names_are_ordered", () => {
    const names = _getFieldNames(new KeyframeEase(0.0, 50.0));
    expect(names != null).toBe(true);
    expect(Array.isArray(names)).toBe(true);
    if (names == null) throw new AssertionError("KeyframeEase has no field names");
    expect(valueEquals([...names], sorted(names))).toBe(true);
  });

  test("test_property_names_are_ordered", () => {
    const names = _getPropertyNames(Property);
    expect(Array.isArray(names)).toBe(true);
    expect(valueEquals([...names], sorted(names))).toBe(true);
  });

  /** The reported differences must not vary between runs. */
  test("test_repeated_validation_is_identical", async () => {
    const aep = SAMPLES_DIR.div("bugs", "29.97_fps_time_scale_3.125.aep");
    const jsonPath = aep.withSuffix(".json");
    if (!aep.exists() || !jsonPath.exists()) return skip("sample not available");
    // Separate interpreters, so each gets its own hash seed.
    // NOTE(port): Python relies on the default per-process random hash seed (no PYTHONHASHSEED set); Bun children are likewise separate processes, same check.
    const script = [
      `import { Path } from ${JSON.stringify(TS_ROOT.div("src", "pyrt", "index.ts").toString())};`,
      `import ${JSON.stringify(TS_ROOT.div("src", "py_aep", "binary", "_register.ts").toString())};`,
      `import { validateAep } from ${JSON.stringify(TS_ROOT.div("src", "py_aep", "cli", "validate.ts").toString())};`,
      `const r = validateAep(new Path(${JSON.stringify(aep.toString())}), new Path(${JSON.stringify(jsonPath.toString())}));`,
      `console.log(r.differences.length);`,
    ].join("\n");
    // The three interpreters run concurrently; check=True: a non-zero exit
    // rejects here, as CalledProcessError raises in Python.
    const runs = await Promise.all([...range(3)].map(() => promisify(execFile)(process.execPath, ["-e", script])));
    const counts = new Set(runs.map((r) => strip(r.stdout)));
    assert(len(counts) === 1, `validate_aep is not deterministic: ${repr([...counts])}`);
 }, 120_000);
});

describe("TestMain", () => {
  /** Tests for the CLI main() entry point. */

  test("test_missing_aep", () => {
    const tmpPath = makeTmpPath();
    const exitCode = main([str(tmpPath.div("nonexistent.aep")), str(tmpPath.div("test.json"))]);
    expect(exitCode).toBe(1);
  });

  test("test_missing_json", () => {
    const tmpPath = makeTmpPath();
    const aepPath = SAMPLES_DIR.div("models", "composition", "bgColor_custom.aep");
    const exitCode = main([str(aepPath), str(tmpPath.div("nonexistent.json"))]);
    expect(exitCode).toBe(1);
  });

  test("test_valid_input", () => {
    const aepPath = SAMPLES_DIR.div("models", "composition", "bgColor_custom.aep");
    const jsonPath = SAMPLES_DIR.div("models", "composition", "bgColor_custom.json");
    const exitCode = main([str(aepPath), str(jsonPath)]);
    // Should return 0 (success) or 1 (differences found), depending on
    // how many fields the parser currently handles.
    expect(typeof exitCode === "number" && Number.isInteger(exitCode)).toBe(true);
    expect([0, 1].includes(exitCode)).toBe(true);
  });
});
