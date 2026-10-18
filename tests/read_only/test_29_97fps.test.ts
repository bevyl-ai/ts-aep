/**
 * Edge-case tests for 29.97fps / time_scale=3.125 compositions.
 *
 * This file exercises the cdta binary parser with non-standard time-scale values
 * and sentinel out-point markers.  The sample file contains:
 *
 * - Two 29.97 fps compositions (time_scale=3.125, divisor=23976)
 * - A short 24 fps precomp whose work-area covers the full duration (sentinel
 *   out_point_dividend = 0xFFFFFFFF)
 * - A 24 fps composition with non-zero display_start_time
 * - A 24 fps composition with a custom work-area range
 */

// `from __future__ import annotations` and `TYPE_CHECKING` are dropped: the
// `Project` / `CompItem` names are only used in annotations, so they are
// `import type`. `math.isclose` is the pyrt `isclose` (num.ts); its keyword
// `rel_tol=` / `abs_tol=` become positional arguments in that order.

import { describe, expect, test } from "bun:test";
import { int, isclose, Path, ValueError } from "../../src/pyrt/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { load_expected, parse_project } from "../conftest.ts";
import type { ExpectedComp, ExpectedProject } from "../helpers.ts";
import type { Project } from "../../src/py_aep/index.ts";
import type { CompItem } from "../../src/py_aep/models/items/composition.ts";

// Python `Path(__file__).parent.parent.parent` is the repo root. A TS file's
// `import.meta.dir` is already its directory, so two `.parent` steps reach it.
const BUGS_DIR = new Path(import.meta.dir).parent.parent.div("samples", "bugs");
const AEP_PATH = BUGS_DIR.div("29.97_fps_time_scale_3.125.aep");

// Module-scoped fixtures: parsed once and cached for every test in this file.
const _cache: { project?: Project; expected?: ExpectedProject } = {};

/** Parse the 29.97fps sample once for all tests in this module. */
function project_fixture(): Project {
  if (_cache.project === undefined) _cache.project = parse_project(AEP_PATH);
  return _cache.project;
}

/** Load the expected JSON. */
function expected_fixture(): ExpectedProject {
  const expected = _cache.expected ?? load_expected(BUGS_DIR, "29.97_fps_time_scale_3.125");
  _cache.expected = expected;
  return expected;
}

/** Return the composition with the given id. */
function _comp_by_id(project: Project, comp_id: number): CompItem {
  for (const comp of project.compositions) {
    if (comp.id === comp_id) return comp;
  }
  throw new ValueError(`Composition with id ${comp_id} not found`);
}

/** Return the expected JSON block for the given item id. */
function _expected_comp(expected: ExpectedProject, comp_id: number): ExpectedComp {
  for (const item of expected["items"]) {
    if (item.id === comp_id && item.typeName === "Composition") return item;
  }
  throw new ValueError(`Expected comp ${comp_id} not found`);
}

/** Tests for the 29.97fps compositions that use time_scale=3.125 */
describe("TestTimeScale3_125", () => {
  test.each([155, 11516])("test_frame_rate[%#]", (comp_id) => {
    const project = project_fixture();
    const expected = expected_fixture();
    const comp = _comp_by_id(project, comp_id);
    const exp = _expected_comp(expected, comp_id);
    expect(isclose(comp.frame_rate, exp["frameRate"], 1e-6)).toBe(true);
  });

  test.each([155, 11516])("test_duration[%#]", (comp_id) => {
    const project = project_fixture();
    const expected = expected_fixture();
    const comp = _comp_by_id(project, comp_id);
    const exp = _expected_comp(expected, comp_id);
    expect(isclose(comp.duration, exp["duration"], 1e-6)).toBe(true);
  });

  test.each([155, 11516])("test_work_area_duration[%#]", (comp_id) => {
    const project = project_fixture();
    const expected = expected_fixture();
    const comp = _comp_by_id(project, comp_id);
    const exp = _expected_comp(expected, comp_id);
    expect(isclose(comp.work_area_duration, exp["workAreaDuration"], 1e-6)).toBe(true);
  });

  test.each([155, 11516])("test_work_area_start[%#]", (comp_id) => {
    const project = project_fixture();
    const expected = expected_fixture();
    const comp = _comp_by_id(project, comp_id);
    const exp = _expected_comp(expected, comp_id);
    // abs_tol=1e-9 with the default rel_tol=1e-9 (Python's math.isclose defaults).
    expect(isclose(comp.work_area_start, exp["workAreaStart"], 1e-9, 1e-9)).toBe(true);
  });

  test.each([155, 11516])("test_frame_work_area_end_absolute[%#]", (comp_id) => {
    const project = project_fixture();
    const comp = _comp_by_id(project, comp_id);
    const expected_frame = comp._cdta.work_area_end_absolute * comp.frame_rate;
    expect(isclose(comp._cdta.frame_work_area_end_absolute, expected_frame, 1e-9, 1)).toBe(true);
  });
});

/** Tests for the precomp where work area == full duration (sentinel). */
describe("TestSentinelOutPoint", () => {
  const COMP_ID = 281855;

  /** When out_point is sentinel, work_area_duration must equal duration. */
  test("test_work_area_equals_duration", () => {
    const project = project_fixture();
    const expected = expected_fixture();
    const comp = _comp_by_id(project, COMP_ID);
    const exp = _expected_comp(expected, COMP_ID);
    expect(isclose(comp.work_area_duration, exp["workAreaDuration"], 1e-6)).toBe(true);
    expect(isclose(comp.work_area_duration, comp.duration, 1e-9)).toBe(true);
  });

  /** Sentinel out_point should resolve to display_start_time + duration. */
  test("test_out_point_equals_duration", () => {
    const project = project_fixture();
    const comp = _comp_by_id(project, COMP_ID);
    expect(
      isclose(comp._cdta.work_area_end_absolute, comp.display_start_time + comp.duration, 1e-9),
    ).toBe(true);
  });

  /** Frame out_point should equal frame_duration for sentinel case. */
  test("test_frame_out_point", () => {
    const project = project_fixture();
    const comp = _comp_by_id(project, COMP_ID);
    expect(int(comp._cdta.frame_work_area_end_absolute)).toBe(comp.frame_duration);
  });

  /** This is a very short comp (0.75s = 18 frames at 24fps). */
  test("test_duration_short", () => {
    const project = project_fixture();
    const expected = expected_fixture();
    const comp = _comp_by_id(project, COMP_ID);
    const exp = _expected_comp(expected, COMP_ID);
    expect(isclose(comp.duration, exp["duration"], 1e-6)).toBe(true);
    expect(comp.frame_duration).toBe(18);
  });
});

/** Tests for comps with display_start_time > 0 (start frame = 1). */
describe("TestNonZeroDisplayStartTime", () => {
  test.each([12173, 2767])("test_display_start_frame[%#]", (comp_id) => {
    const project = project_fixture();
    const comp = _comp_by_id(project, comp_id);
    expect(comp.display_start_frame).toBe(1);
  });

  test.each([12173, 2767])("test_display_start_time[%#]", (comp_id) => {
    const project = project_fixture();
    const expected = expected_fixture();
    const comp = _comp_by_id(project, comp_id);
    const exp = _expected_comp(expected, comp_id);
    expect(isclose(comp.display_start_time, exp["displayStartTime"], 1e-6)).toBe(true);
  });

  /** Comp 2767 has a non-trivial work-area that starts mid-timeline. */
  test("test_work_area_with_offset", () => {
    const project = project_fixture();
    const expected = expected_fixture();
    const comp = _comp_by_id(project, 2767);
    const exp = _expected_comp(expected, 2767);
    expect(isclose(comp.work_area_start, exp["workAreaStart"], 1e-4)).toBe(true);
    expect(isclose(comp.work_area_duration, exp["workAreaDuration"], 1e-4)).toBe(true);
  });
});
