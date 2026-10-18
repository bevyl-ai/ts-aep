/**
 * Tests for CLI visualize module.
 *
 * These tests verify the aep-visualize command line tool functionality.
 */

import { describe, expect, test } from "bun:test";
import { parseApp } from "../conftest.ts";

import type { Application } from "../../src/py_aep/index.ts";
import { buildProjectNode, formatDot, formatJson, formatMermaid, formatText, type Node } from "../../src/py_aep/cli/visualize.ts";
import { Path, len, StringIO } from "../../src/pyrt/index.ts";

// Python: Path(__file__).parent.parent.parent / "samples"
// (`import.meta.dir` is already the directory of this file, so two parents reach the package root.)
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples");

/**
 * Parse the AE2025 complete sample once for all tests in this module.
 *
 * The Python module-scoped fixture is served by `parse_app`, which is already
 * lru-cached in `tests/helpers.ts`, so each call here returns the same parse.
 */
function sampleApp(): Application {
  const aepPath = SAMPLES_DIR.div("versions", "ae2025", "complete.aep");
  return parseApp(aepPath);
}

describe("TestBuildProjectNode", () => {
  /** Tests for build_project_node function. */

  /** Test that project node is built with correct structure. */
  test("test_builds_project_structure", () => {
    const app = sampleApp();
    // Use include_properties=False to avoid PropertyGroup/Property type mismatch
    const node = buildProjectNode(app, false);

    expect(node["type"]).toBe("Project");
    expect("name" in node).toBe(true);
    expect("attrs" in node).toBe(true);
    expect("children" in node).toBe(true);
    expect(node["attrs"].has("version")).toBe(true);
  });

  /** Test building project node without layer properties. */
  test("test_project_node_without_properties", () => {
    const app = sampleApp();
    const node = buildProjectNode(app, false);

    expect(node["type"]).toBe("Project");

    // Check that no property nodes exist in the tree
    function hasPropertyNode(n: Node): boolean {
      if (n["type"] === "Property") return true;
      for (const child of n["children"] ?? []) {
        if (hasPropertyNode(child)) return true;
      }
      return false;
    }

    expect(hasPropertyNode(node)).toBe(false);
  });
});

describe("TestFormatText", () => {
  /** Tests for format_text function. */

  /** Test that text output produces content. */
  test("test_text_output_not_empty", () => {
    const app = sampleApp();
    const node = buildProjectNode(app, false);

    const output = new StringIO();
    formatText(node, output);

    const result = output.getvalue();
    expect(len(result) > 0).toBe(true);
    expect(result.includes("Project") || result.includes(node["name"])).toBe(true);
  });

  /** Test that depth limit reduces output. */
  test("test_text_output_with_depth_limit", () => {
    const app = sampleApp();
    const node = buildProjectNode(app, false);

    const outputFull = new StringIO();
    // Python: format_text(node, output_full, max_depth=None); prefix and is_last are skipped.
    formatText(node, outputFull, undefined, undefined, null);

    const outputLimited = new StringIO();
    // Python: format_text(node, output_limited, max_depth=1)
    formatText(node, outputLimited, undefined, undefined, 1);

    // Limited depth should produce less or equal output
    // Python len(str) counts code points; spreading a string iterates code points.
    expect([...outputLimited.getvalue()].length <= [...outputFull.getvalue()].length).toBe(true);
  });
});

describe("TestFormatJson", () => {
  /** Tests for format_json function. */

  /** Test that JSON output is valid JSON. */
  test("test_json_output_valid", () => {
    const app = sampleApp();
    const node = buildProjectNode(app, false);

    const output = new StringIO();
    formatJson(node, output);

    const result = output.getvalue();
    // Should be valid JSON
    const parsed = JSON.parse(result);
    expect(parsed["type"]).toBe("Project");
    expect("children" in parsed).toBe(true);
  });

  /** Test that JSON respects depth limit. */
  test("test_json_output_with_depth_limit", () => {
    const app = sampleApp();
    const node = buildProjectNode(app, false);

    const output = new StringIO();
    formatJson(node, output, 1);

    const result = output.getvalue();
    const parsed = JSON.parse(result);

    // Children at depth 1 should have truncated children (string like "[N children omitted]")
    for (const child of parsed["children"] ?? []) {
      const children = child["children"];
      // Either no children, empty list, or a truncation message string
      expect(children == null || (Array.isArray(children) && children.length === 0) || typeof children === "string").toBe(true);
    }
  });
});

describe("TestFormatDot", () => {
  /** Tests for format_dot function. */

  /** Test that DOT output has valid Graphviz structure. */
  test("test_dot_output_valid_structure", () => {
    const app = sampleApp();
    const node = buildProjectNode(app, false);

    const output = new StringIO();
    formatDot(node, output);

    const result = output.getvalue();
    expect(result.includes("digraph")).toBe(true);
    expect(result.includes("{")).toBe(true);
    expect(result.includes("}")).toBe(true);
  });
});

describe("TestFormatMermaid", () => {
  /** Tests for format_mermaid function. */

  /** Test that Mermaid output has valid flowchart structure. */
  test("test_mermaid_output_valid_structure", () => {
    const app = sampleApp();
    const node = buildProjectNode(app, false);

    const output = new StringIO();
    formatMermaid(node, output);

    const result = output.getvalue();
    expect(result.includes("flowchart") || result.includes("graph")).toBe(true);
  });
});
