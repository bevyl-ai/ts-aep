/**
 * Tests for project cleanup mutations: remove_unused_footage, reduce_project,
 * consolidate_footage.
 *
 * Mutation tests use the uncached :func:`py_aep.parse` so each parse is fresh and
 * mutations never leak between tests.
 */

import { describe, expect, test } from "bun:test";
import { getitem, len, Path, py_bool, py_eq, StopIteration } from "../../src/pyrt/index.ts";
import { make_tmp_path } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep } from "../../src/py_aep/index.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import "../../src/py_aep/binary/_register.ts";
import { as_instance } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models");
const FOOTAGE_MISC = SAMPLES_DIR.div("footage", "footage_misc.aep");
const SOLID_COLORS = SAMPLES_DIR.div("footage", "solid_colors.aep");

describe("TestRemoveUnusedFootage", () => {
  test("test_removes_all_unused", () => {
    const project = parse_aep(FOOTAGE_MISC).project;
    expect(len(project.footages)).toBe(7);
    expect(project.footages.every((f) => !py_bool(f.used_in))).toBe(true);

    const removed = project.remove_unused_footage();

    expect(removed).toBe(7);
    expect(py_eq(project.footages, [])).toBe(true);
  });

  test("test_keeps_used_footage", () => {
    const project = parse_aep(SOLID_COLORS).project;
    const used_count = len(project.footages);
    expect(used_count > 0).toBe(true);
    expect(project.footages.every((f) => py_bool(f.used_in))).toBe(true);

    const removed = project.remove_unused_footage();

    expect(removed).toBe(0);
    expect(len(project.footages)).toBe(used_count);
  });

  test("test_removes_only_unused", () => {
    const project = parse_aep(SOLID_COLORS).project;
    const used_ids = new Set(project.footages.map((f) => f.id));
    const placeholder = project.import_placeholder("unused", 100, 100, 25.0, 5.0);

    const removed = project.remove_unused_footage();

    expect(removed).toBe(1);
    expect(project.items.has(placeholder.id)).toBe(false);
    expect(py_eq(new Set(project.footages.map((f) => f.id)), used_ids)).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SOLID_COLORS).project;
    project.import_placeholder("unused", 100, 100, 25.0, 5.0);
    project.remove_unused_footage();

    const out = tmp_path.div("out.aep");
    project.save(out);
    const reparsed = parse_aep(out).project;

    expect(reparsed.footages.every((f) => py_bool(f.used_in))).toBe(true);
  });
});

describe("TestReduceProject", () => {
  test("test_keeps_specified_comp_and_sources", () => {
    const project = parse_aep(SOLID_COLORS).project;
    const comps = project.compositions;
    expect(len(comps)).toBe(4);
    const kept_comp = comps[0];
    const kept_source_ids = kept_comp._source_ids_for_linking();

    const before = new Set(project.items.keys());
    const removed = project.reduce_project([kept_comp]);
    const after = new Set(project.items.keys());

    expect(removed).toBe(len(before) - len(after));
    expect(after.has(kept_comp.id)).toBe(true);
    for (const sid of kept_source_ids) {
      expect(after.has(sid)).toBe(true);
    }
    // The other three comps are gone.
    expect(len(project.compositions)).toBe(1);
  });

  test("test_count_matches_extendscript", () => {
    // ExtendScript reduceProject keeping one comp on solid_colors removes 6
    // items (3 comps + 3 solids), keeping the comp, its solid and the
    // parent folder. Validated against AfterFX 2025.
    const project = parse_aep(SOLID_COLORS).project;
    const kept_comp = project.compositions[0];

    const removed = project.reduce_project([kept_comp]);

    expect(removed).toBe(6);
  });

  test("test_root_always_kept", () => {
    const project = parse_aep(SOLID_COLORS).project;
    const kept_comp = project.compositions[0];

    project.reduce_project([kept_comp]);

    expect(project.items.has(0)).toBe(true);
  });

  test("test_empty_keep_removes_all_but_root", () => {
    const project = parse_aep(SOLID_COLORS).project;

    const removed = project.reduce_project([]);

    expect(removed > 0).toBe(true);
    expect(py_eq(new Set(project.items.keys()), new Set([0]))).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(SOLID_COLORS).project;
    const kept_comp = project.compositions[0];
    const kept_name = kept_comp.name;
    project.reduce_project([kept_comp]);

    const out = tmp_path.div("out.aep");
    project.save(out);
    const reparsed = parse_aep(out).project;

    expect(py_eq(reparsed.compositions.map((c) => c.name), [kept_name])).toBe(true);
  });
});

describe("TestConsolidateFootage", () => {
  test("test_no_duplicates_is_noop", () => {
    const project = parse_aep(FOOTAGE_MISC).project;
    const before = len(project.footages);

    const removed = project.consolidate_footage();

    expect(removed).toBe(0);
    expect(len(project.footages)).toBe(before);
  });

  test("test_merges_identical_sources", () => {
    const project = parse_aep(FOOTAGE_MISC).project;
    // footages 5 and 6 reference the same file and differ only by loop.
    const first = as_instance(getitem(project.items, 5), FootageItem);
    const second = as_instance(getitem(project.items, 6), FootageItem);
    expect(first instanceof FootageItem).toBe(true);
    expect(second instanceof FootageItem).toBe(true);
    first.main_source.loop = second.main_source.loop;
    expect(py_eq(first._consolidation_key(), second._consolidation_key())).toBe(true);
    const before = len(project.footages);

    const removed = project.consolidate_footage();

    expect(removed).toBe(1);
    expect(len(project.footages)).toBe(before - 1);
  });

  test("test_retargets_layers", () => {
    const project = parse_aep(FOOTAGE_MISC).project;
    const first = as_instance(getitem(project.items, 5), FootageItem);
    const second = as_instance(getitem(project.items, 6), FootageItem);
    expect(first instanceof FootageItem).toBe(true);
    expect(second instanceof FootageItem).toBe(true);
    first.main_source.loop = second.main_source.loop;

    const comp = project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    comp.add(first);
    comp.add(second);

    const survivor_id = first.id;
    const removed = project.consolidate_footage();

    expect(removed).toBe(1);
    expect(py_eq(new Set(comp.av_layers.map((layer) => layer._source_id)), new Set([survivor_id]))).toBe(true);
  });

  test("test_retargets_cached_layer_source", () => {
    const project = parse_aep(FOOTAGE_MISC).project;
    const first = as_instance(getitem(project.items, 5), FootageItem);
    const second = as_instance(getitem(project.items, 6), FootageItem);
    expect(first instanceof FootageItem).toBe(true);
    expect(second instanceof FootageItem).toBe(true);
    first.main_source.loop = second.main_source.loop;

    const comp = project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    comp.add(first);
    comp.add(second);
    const dup_layer = comp.av_layers.find((ly) => ly._source_id === second.id);
    if (dup_layer === undefined) throw new StopIteration();
    // Populate the layer's source cache before consolidating.
    expect(dup_layer.source === second).toBe(true);

    project.consolidate_footage();

    expect(dup_layer.source === first).toBe(true);
  });

  test("test_solids_not_consolidated", () => {
    const project = parse_aep(SOLID_COLORS).project;

    const removed = project.consolidate_footage();

    expect(removed).toBe(0);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const project = parse_aep(FOOTAGE_MISC).project;
    const first = as_instance(getitem(project.items, 5), FootageItem);
    const second = as_instance(getitem(project.items, 6), FootageItem);
    expect(first instanceof FootageItem).toBe(true);
    expect(second instanceof FootageItem).toBe(true);
    first.main_source.loop = second.main_source.loop;
    project.consolidate_footage();

    const out = tmp_path.div("out.aep");
    project.save(out);
    const reparsed = parse_aep(out).project;

    expect(len(reparsed.footages)).toBe(6);
  });
});
