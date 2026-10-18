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
import { loadExpected, parseProject } from "../conftest.ts";
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
function projectFixture(): Project {
  if (_cache.project === undefined) _cache.project = parseProject(AEP_PATH);
  return _cache.project;
}

/** Load the expected JSON. */
function expectedFixture(): ExpectedProject {
  const expected = _cache.expected ?? loadExpected(BUGS_DIR, "29.97_fps_time_scale_3.125");
  _cache.expected = expected;
  return expected;
}

/** Return the composition with the given id. */
function _compById(project: Project, compId: number): CompItem {
  for (const comp of project.compositions) {
    if (comp.id === compId) return comp;
  }
  throw new ValueError(`Composition with id ${compId} not found`);
}

/** Return the expected JSON block for the given item id. */
function _expectedComp(expected: ExpectedProject, compId: number): ExpectedComp {
  for (const item of expected["items"]) {
    if (item.id === compId && item.typeName === "Composition") return item;
  }
  throw new ValueError(`Expected comp ${compId} not found`);
}

/** Tests for the 29.97fps compositions that use time_scale=3.125 */
describe("TestTimeScale3_125", () => {
  test.each([155, 11516])("test_frame_rate[%#]", (compId) => {
    const project = projectFixture();
    const expected = expectedFixture();
    const comp = _compById(project, compId);
    const exp = _expectedComp(expected, compId);
    expect(isclose(comp.frameRate, exp["frameRate"], 1e-6)).toBe(true);
  });

  test.each([155, 11516])("test_duration[%#]", (compId) => {
    const project = projectFixture();
    const expected = expectedFixture();
    const comp = _compById(project, compId);
    const exp = _expectedComp(expected, compId);
    expect(isclose(comp.duration, exp["duration"], 1e-6)).toBe(true);
  });

  test.each([155, 11516])("test_work_area_duration[%#]", (compId) => {
    const project = projectFixture();
    const expected = expectedFixture();
    const comp = _compById(project, compId);
    const exp = _expectedComp(expected, compId);
    expect(isclose(comp.workAreaDuration, exp["workAreaDuration"], 1e-6)).toBe(true);
  });

  test.each([155, 11516])("test_work_area_start[%#]", (compId) => {
    const project = projectFixture();
    const expected = expectedFixture();
    const comp = _compById(project, compId);
    const exp = _expectedComp(expected, compId);
    // abs_tol=1e-9 with the default rel_tol=1e-9 (Python's math.isclose defaults).
    expect(isclose(comp.workAreaStart, exp["workAreaStart"], 1e-9, 1e-9)).toBe(true);
  });

  test.each([155, 11516])("test_frame_work_area_end_absolute[%#]", (compId) => {
    const project = projectFixture();
    const comp = _compById(project, compId);
    const expectedFrame = comp._cdta.workAreaEndAbsolute * comp.frameRate;
    expect(isclose(comp._cdta.frameWorkAreaEndAbsolute, expectedFrame, 1e-9, 1)).toBe(true);
  });
});

/** Tests for the precomp where work area == full duration (sentinel). */
describe("TestSentinelOutPoint", () => {
  const COMP_ID = 281855;

  /** When out_point is sentinel, work_area_duration must equal duration. */
  test("test_work_area_equals_duration", () => {
    const project = projectFixture();
    const expected = expectedFixture();
    const comp = _compById(project, COMP_ID);
    const exp = _expectedComp(expected, COMP_ID);
    expect(isclose(comp.workAreaDuration, exp["workAreaDuration"], 1e-6)).toBe(true);
    expect(isclose(comp.workAreaDuration, comp.duration, 1e-9)).toBe(true);
  });

  /** Sentinel out_point should resolve to display_start_time + duration. */
  test("test_out_point_equals_duration", () => {
    const project = projectFixture();
    const comp = _compById(project, COMP_ID);
    expect(isclose(comp._cdta.workAreaEndAbsolute, comp.displayStartTime + comp.duration, 1e-9)).toBe(true);
  });

  /** Frame out_point should equal frame_duration for sentinel case. */
  test("test_frame_out_point", () => {
    const project = projectFixture();
    const comp = _compById(project, COMP_ID);
    expect(int(comp._cdta.frameWorkAreaEndAbsolute)).toBe(comp.frameDuration);
  });

  /** This is a very short comp (0.75s = 18 frames at 24fps). */
  test("test_duration_short", () => {
    const project = projectFixture();
    const expected = expectedFixture();
    const comp = _compById(project, COMP_ID);
    const exp = _expectedComp(expected, COMP_ID);
    expect(isclose(comp.duration, exp["duration"], 1e-6)).toBe(true);
    expect(comp.frameDuration).toBe(18);
  });
});

/** Tests for comps with display_start_time > 0 (start frame = 1). */
describe("TestNonZeroDisplayStartTime", () => {
  test.each([12173, 2767])("test_display_start_frame[%#]", (compId) => {
    const project = projectFixture();
    const comp = _compById(project, compId);
    expect(comp.displayStartFrame).toBe(1);
  });

  test.each([12173, 2767])("test_display_start_time[%#]", (compId) => {
    const project = projectFixture();
    const expected = expectedFixture();
    const comp = _compById(project, compId);
    const exp = _expectedComp(expected, compId);
    expect(isclose(comp.displayStartTime, exp["displayStartTime"], 1e-6)).toBe(true);
  });

  /** Comp 2767 has a non-trivial work-area that starts mid-timeline. */
  test("test_work_area_with_offset", () => {
    const project = projectFixture();
    const expected = expectedFixture();
    const comp = _compById(project, 2767);
    const exp = _expectedComp(expected, 2767);
    expect(isclose(comp.workAreaStart, exp["workAreaStart"], 1e-4)).toBe(true);
    expect(isclose(comp.workAreaDuration, exp["workAreaDuration"], 1e-4)).toBe(true);
  });
});
