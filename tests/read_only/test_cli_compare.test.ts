/**
 * Tests for CLI compare module.
 *
 * These tests verify the aep-compare command line tool functionality,
 * including leaf-only diff output, multi-file comparison, and context display.
 */

import { describe, test, expect } from "bun:test";
import { parse_aep_chunks } from "../../src/py_aep/cli/compare.ts";
import { at, Path, py_assert } from "../../src/pyrt/index.ts";

// Python: Path(__file__).parent.parent.parent / "samples"
const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples");

describe("TestLeafOnlyChunks", () => {
  /** Tests that only leaf chunks appear in parsed output (no LIST dups). */

  test("test_no_list_paths_in_output", () => {
    /** parse_aep_chunks should not include LIST containers as leaves. */
    const aep_path = SAMPLES_DIR.div("versions", "ae2025", "complete.aep");
    const chunks = parse_aep_chunks(aep_path);

    for (const path of chunks.keys()) {
      // The final segment (after last /) should not be a LIST
      const final_segment = at(path.split("/"), -1);
      const base = final_segment.split("[")[0];
      // LIST chunks should only appear as path prefixes, never as
      // the leaf chunk itself (their raw data duplicates children).
      py_assert(!base.startsWith("LIST:"), `LIST chunk found in leaf output: ${path}`);
    }
  });

  test("test_leaf_chunks_have_data", () => {
    /** All leaf chunks should have bytes data (may be empty). */
    const aep_path = SAMPLES_DIR.div("versions", "ae2025", "complete.aep");
    const chunks = parse_aep_chunks(aep_path);
    expect(chunks.size).toBeGreaterThan(0);
    for (const [path, data] of chunks) {
      py_assert(data instanceof Uint8Array, `Non-bytes data for ${path}`);
    }
  });
});
