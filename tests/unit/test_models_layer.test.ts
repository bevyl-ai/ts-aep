/** Tests for Layer model parsing. */

import { describe, expect, test } from "bun:test";

import { autoName } from "../../src/py_aep/models/naming.ts";
import { Path } from "../../src/pyrt/index.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const BUGS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "bugs");
const VERSIONS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");

describe("TestAutoName", () => {
  /** Tests for auto_name helper. */

  test("test_trailing_number", () => {
    expect(autoName("Light 1", new Set<string>())).toBe("Light 1");
    expect(autoName("Layer 99", new Set<string>())).toBe("Layer 1");
    expect(autoName("abc3", new Set<string>())).toBe("abc1");
  });

  test("test_no_trailing_number", () => {
    expect(autoName("MyLayer", new Set<string>())).toBe("MyLayer 1");
    expect(autoName("Solid", new Set<string>())).toBe("Solid 1");
    expect(autoName("Solid", new Set(["Solid"]))).toBe("Solid 2");
  });

  test("test_only_number", () => {
    expect(autoName("42", new Set<string>())).toBe("1");
  });

  test("test_skips_existing_names", () => {
    const existing = new Set(["layer1", "layer2", "layer3"]);
    expect(autoName("layer1", existing)).toBe("layer4");
  });

  test("test_skips_existing_no_trailing_number", () => {
    const existing = new Set(["Solid", "Solid 2", "Solid 3"]);
    expect(autoName("Solid", existing)).toBe("Solid 4");
    expect(autoName("Solid 1", existing)).toBe("Solid 4");
  });

  test("test_uses_max_suffix", () => {
    const existing = new Set(["Comp 1", "Comp 4"]);
    expect(autoName("Comp 1", existing)).toBe("Comp 5");
  });

  test("test_gap_not_filled", () => {
    const existing = new Set(["Layer 1", "Layer 5"]);
    expect(autoName("Layer 1", existing)).toBe("Layer 6");
  });
});
