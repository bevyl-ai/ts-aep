/** Tests for Project model parsing. */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { parse as parseAep, type Project } from "../../src/py_aep/index.ts";
import { recursiveFind } from "../../src/py_aep/binary/utils.ts";
import { b, FileExistsError, Path, valueEquals } from "../../src/pyrt/index.ts";
import { makeTmpPath, raises } from "../support/pytest.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "project");
const VIEW_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "view");
const VERSIONS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");
const LAYER_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const COMP_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "composition");

/** All ldta layer ids in the project, including viewer pseudo-layers. */
function _allLdtaIds(project: Project): number[] {
  return project.compositions.flatMap((comp) =>
    recursiveFind(comp._itemList.chunks, "ldta").map((ldta) => ldta.layerId),
  );
}

describe("TestAllocateId", () => {
  /**
   * Tests for Project._allocate_id() - AE keeps ONE counter for item
   * ids and layer ids (incl. viewer pseudo-layers), persisted in
   * `head.next_item_id` and trusted on open (probed in AE 2026).
   */

  test("test_first_call_returns_counter_value", (): void => {
    const project = parseAep(LAYER_SAMPLES_DIR.div("type.aep")).project;
    // In an AE-written file next_item_id is already > max(all ids).
    const expected = project._head.nextItemId;
    expect(project._allocateId()).toBe(expected);
    expect(project._head.nextItemId).toBe(expected + 1);
  });

  test("test_successive_calls_increment", (): void => {
    const project = parseAep(LAYER_SAMPLES_DIR.div("type.aep")).project;
    const first = project._allocateId();
    expect(project._allocateId()).toBe(first + 1);
    expect(project._allocateId()).toBe(first + 2);
  });

  test("test_counter_above_all_ids", (): void => {
    // Every id (item ids AND ldta layer ids, incl. viewer
    // pseudo-layers) must stay below the counter.
    const project = parseAep(COMP_SAMPLES_DIR.div("bgColor.aep")).project;
    const allIds = new Set([..._allLdtaIds(project), ...project.items.keys()]);
    expect(project._allocateId()).toBeGreaterThan(Math.max(...allIds));
  });

  test("test_reconciles_drifted_counter", (): void => {
    // Files written by earlier py_aep versions can carry a counter
    // below the live layer ids; the first allocation must reconcile
    // (AE trusts the counter and would mint duplicate ids otherwise).
    const project = parseAep(COMP_SAMPLES_DIR.div("bgColor.aep")).project;
    const allIds = new Set([..._allLdtaIds(project), ...project.items.keys()]);
    project._head.nextItemId = 2; // force drift
    expect(project._allocateId()).toBe(Math.max(...allIds) + 1);
    expect(project._head.nextItemId).toBe(Math.max(...allIds) + 2);
  });

  test("test_new_layer_and_comp_ids_unique_project_wide", (): void => {
    const project = parseAep(COMP_SAMPLES_DIR.div("bgColor.aep")).project;
    project.compositions[0].addNull();
    project.rootFolder.addComp("New", 100, 100, 1.0, 5.0, 25.0);
    const allIds = [..._allLdtaIds(project), ...project.items.keys()];
    expect(allIds.length).toBe(new Set(allIds).size);
    // The persisted counter must remain above every live id.
    expect(project._head.nextItemId).toBeGreaterThan(Math.max(...allIds));
  });
});

describe("TestSaveExistingPath", () => {
  /** Project.save() must refuse to overwrite an existing file. */

  test("test_save_to_existing_path_raises_file_exists", (): void => {
    const tmpPath = makeTmpPath();
    const project = parseAep(LAYER_SAMPLES_DIR.div("type.aep")).project;
    const out = tmpPath.div("out.aep");
    out.writeBytes(b("stub"));
    raises(FileExistsError, () => project.save(out));
    expect(valueEquals(out.readBytes(), b("stub"))).toBe(true);
  });
});
