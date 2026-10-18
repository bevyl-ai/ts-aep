/** Tests for parsing AEP files across different AE versions. */

// `from __future__ import annotations` is dropped: no annotation here is
// evaluated at runtime. `Path(__file__)` is `import.meta.dir` in this module,
// so the three `.parent` steps of the Python source become two here.

import { describe, expect, test } from "bun:test";
import { len, Path, skip } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { parseProject } from "../conftest.ts";
import { Project } from "../../src/py_aep/index.ts";

const VERSIONS_DIR = new Path(import.meta.dir).parent.parent.div("samples", "versions");

describe("TestVersionCompatibility", () => {
  /** Cross-version compatibility checks. */

  test.each(["ae2018", "ae2022", "ae2023", "ae2024", "ae2025", "ae2026"])(
    "test_all_versions_parseable[%#]",
    (version: string) => {
      const aepPath = VERSIONS_DIR.div(version, "complete.aep");
      if (!aepPath.exists()) return skip(`${version} sample not found`);
      const project = parseProject(aepPath);
      expect(project instanceof Project).toBe(true);
      expect(len(project.compositions) >= 1).toBe(true);
    },
  );
});
