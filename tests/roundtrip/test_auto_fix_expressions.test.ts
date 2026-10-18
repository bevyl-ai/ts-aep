/**
 * Tests for Project.auto_fix_expressions.
 *
 * AE 2026 semantics (2026-07-14 probe run): quoted references in both quote
 * styles are replaced across enabled expressions - including inside comments
 * of a rewritten expression - and disabled expressions are never touched.
 * py_aep's replacement gate diverges deliberately: AE only rewrites
 * expressions that currently ERROR (runtime state not stored in the file), so
 * py_aep rewrites every enabled expression containing the quoted text. All
 * five AE fixture cases were verified to produce identical results.
 */

import { describe, expect, test } from "bun:test";
import { Path, TypeError_ } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { parse_project_fresh } from "../helpers.ts";
import type { Project } from "../../src/py_aep/index.ts";

// `Path(__file__).parent.parent.parent`: `import.meta.dir` is this file's
// directory (tests/roundtrip), so two `.parent` hops reach the package root.
const SAMPLES_DIR = new Path(import.meta.dir).parent.parent.div("samples", "models", "property");
const SAMPLE = SAMPLES_DIR.div("is_modified_false.aep");

function _opacity(project: Project) {
  return project.compositions[0].layers[0].transform.property("ADBE Opacity");
}

describe("TestAutoFixExpressions", () => {
  test("test_double_quoted_reference_replaced", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const prop = _opacity(project);
    prop.expression = 'thisComp.layer("Ghost").transform.opacity';
    project.auto_fix_expressions("Ghost", "Real");
    expect(prop.expression).toBe('thisComp.layer("Real").transform.opacity');
  });

  test("test_single_quoted_reference_replaced", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const prop = _opacity(project);
    prop.expression = "thisComp.layer('Ghost').transform.opacity / 2";
    project.auto_fix_expressions("Ghost", "Real");
    expect(prop.expression).toBe("thisComp.layer('Real').transform.opacity / 2");
  });

  test("test_disabled_expression_untouched", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const prop = _opacity(project);
    prop.expression = 'thisComp.layer("Ghost").transform.opacity';
    prop.expression_enabled = false;
    project.auto_fix_expressions("Ghost", "Real");
    expect(prop.expression).toBe('thisComp.layer("Ghost").transform.opacity');
    expect(prop.expression_enabled).toBe(false);
  });

  test("test_unquoted_text_untouched", () => {
    // AE parity for the probed comment case: an unquoted mention is
    // not a reference and is never rewritten.
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const prop = _opacity(project);
    prop.expression = "// Ghost mentioned in comment only\n50";
    project.auto_fix_expressions("Ghost", "Real");
    expect(prop.expression).toBe("// Ghost mentioned in comment only\n50");
  });

  test("test_comment_occurrence_in_rewritten_expression", () => {
    // AE replaces plain-text across the whole broken expression,
    // including quoted occurrences inside comments (probed case_c).
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const prop = _opacity(project);
    prop.expression = '// see "Ghost" for details\nthisComp.layer("Ghost").transform.opacity';
    project.auto_fix_expressions("Ghost", "Real");
    expect(prop.expression).toBe('// see "Real" for details\nthisComp.layer("Real").transform.opacity');
  });

  test("test_empty_old_text_is_noop", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const prop = _opacity(project);
    prop.expression = 'thisComp.layer("Ghost").transform.opacity';
    project.auto_fix_expressions("", "Real");
    expect(prop.expression).toBe('thisComp.layer("Ghost").transform.opacity');
  });

  test("test_non_string_raises", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    // @ts-expect-error deliberately passes a non-string to check runtime validation
    raises(TypeError_, () => project.auto_fix_expressions(5, "Real"));
  });

  test("test_fix_survives_save_and_reparse", () => {
    const tmp_path = make_tmp_path();
    const project = parse_project_fresh(SAMPLE);
    const prop = _opacity(project);
    prop.expression = 'thisComp.layer("Ghost").transform.opacity';
    project.auto_fix_expressions("Ghost", "Real");
    const out = tmp_path.div("fixed.aep");
    project.save(out);
    const reparsed = parse_project_fresh(out);
    expect(_opacity(reparsed).expression).toBe('thisComp.layer("Real").transform.opacity');
  });
});
