/** Tests for Project model parsing. */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import { parse as parse_aep, type Project } from "../../src/py_aep/index.ts";
import { recursive_find } from "../../src/py_aep/binary/utils.ts";
import { b, FileExistsError, Path, py_eq } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises } from "../../src/pyrt/pytest.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "project");
const VIEW_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "view");
const VERSIONS_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "versions");
const LAYER_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models", "layer");
const COMP_SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div(
  "samples",
  "models",
  "composition",
);

/** All ldta layer ids in the project, including viewer pseudo-layers. */
function _all_ldta_ids(project: Project): number[] {
  return project.compositions.flatMap((comp) =>
    recursive_find(comp._item_list.chunks, "ldta").map((ldta) => ldta.layer_id),
  );
}

describe("TestAllocateId", () => {
  /**
   * Tests for Project._allocate_id() - AE keeps ONE counter for item
   * ids and layer ids (incl. viewer pseudo-layers), persisted in
   * `head.next_item_id` and trusted on open (probed in AE 2026).
   */

  test("test_first_call_returns_counter_value", (): void => {
    const project = parse_aep(LAYER_SAMPLES_DIR.div("type.aep")).project;
    // In an AE-written file next_item_id is already > max(all ids).
    const expected = project._head.next_item_id;
    expect(project._allocate_id()).toBe(expected);
    expect(project._head.next_item_id).toBe(expected + 1);
  });

  test("test_successive_calls_increment", (): void => {
    const project = parse_aep(LAYER_SAMPLES_DIR.div("type.aep")).project;
    const first = project._allocate_id();
    expect(project._allocate_id()).toBe(first + 1);
    expect(project._allocate_id()).toBe(first + 2);
  });

  test("test_counter_above_all_ids", (): void => {
    // Every id (item ids AND ldta layer ids, incl. viewer
    // pseudo-layers) must stay below the counter.
    const project = parse_aep(COMP_SAMPLES_DIR.div("bgColor.aep")).project;
    const all_ids = new Set([..._all_ldta_ids(project), ...project.items.keys()]);
    expect(project._allocate_id()).toBeGreaterThan(Math.max(...all_ids));
  });

  test("test_reconciles_drifted_counter", (): void => {
    // Files written by earlier py_aep versions can carry a counter
    // below the live layer ids; the first allocation must reconcile
    // (AE trusts the counter and would mint duplicate ids otherwise).
    const project = parse_aep(COMP_SAMPLES_DIR.div("bgColor.aep")).project;
    const all_ids = new Set([..._all_ldta_ids(project), ...project.items.keys()]);
    project._head.next_item_id = 2; // force drift
    expect(project._allocate_id()).toBe(Math.max(...all_ids) + 1);
    expect(project._head.next_item_id).toBe(Math.max(...all_ids) + 2);
  });

  test("test_new_layer_and_comp_ids_unique_project_wide", (): void => {
    const project = parse_aep(COMP_SAMPLES_DIR.div("bgColor.aep")).project;
    project.compositions[0].add_null();
    project.root_folder.add_comp("New", 100, 100, 1.0, 5.0, 25.0);
    const all_ids = [..._all_ldta_ids(project), ...project.items.keys()];
    expect(all_ids.length).toBe(new Set(all_ids).size);
    // The persisted counter must remain above every live id.
    expect(project._head.next_item_id).toBeGreaterThan(Math.max(...all_ids));
  });
});

describe("TestSaveExistingPath", () => {
  /** Project.save() must refuse to overwrite an existing file. */

  test("test_save_to_existing_path_raises_file_exists", (): void => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(LAYER_SAMPLES_DIR.div("type.aep")).project;
    const out = tmp_path.div("out.aep");
    out.write_bytes(b("stub"));
    raises(FileExistsError, () => project.save(out));
    expect(py_eq(out.read_bytes(), b("stub"))).toBe(true);
  });
});
