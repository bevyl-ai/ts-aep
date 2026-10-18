/**
 * Tests for parsing AEP files across different AE versions.
 */

import { describe, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { validateAep } from "../../src/py_aep/cli/validate.ts";
import { Path, warn } from "../../src/pyrt/index.ts";
import { skip } from "../support/pytest.ts";


/** Path(__file__).parent.parent.parent / "samples" / "versions" */
const VERSIONS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");

describe("TestAE2025", () => {
  /** Tests specific to After Effects 2025 projects. */

  test("test_validate_against_json", () => {
    /** Validate AE2025 project against ExtendScript JSON export. */
    const aepPath = VERSIONS_DIR.div("ae2025", "complete.aep");
    const jsonPath = VERSIONS_DIR.div("ae2025", "complete.json");
    if (!aepPath.exists() || !jsonPath.exists()) {
      return skip("ae2025 sample or JSON reference not found");
    }
    const result = validateAep(aepPath, jsonPath);
    // Report differences as warnings, not failures
    for (const diff of result.differences) {
      // NOTE(port): stacklevel=1 only selects the reported source location; the warning text and test outcome match Python.
      warn(diff);
    }
  });
});
