/**
 * Tests for project cleanup mutations: remove_unused_footage, reduce_project,
 * consolidate_footage.
 *
 * Mutation tests use the uncached :func:`py_aep.parse` so each parse is fresh and
 * mutations never leak between tests.
 */

import { describe, expect, test } from "bun:test";
import { getOrThrow, len, Path, truthy, valueEquals, StopIteration } from "../../src/pyrt/index.ts";

import { parse as parseAep } from "../../src/py_aep/index.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import "../../src/py_aep/binary/_register.ts";
import { asInstance } from "../helpers.ts";
import { makeTmpPath } from "../support/pytest.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models");
const FOOTAGE_MISC = SAMPLES_DIR.div("footage", "footage_misc.aep");
const SOLID_COLORS = SAMPLES_DIR.div("footage", "solid_colors.aep");

describe("TestRemoveUnusedFootage", () => {
  test("test_removes_all_unused", () => {
    const project = parseAep(FOOTAGE_MISC).project;
    expect(len(project.footages)).toBe(7);
    expect(project.footages.every((f) => !truthy(f.usedIn))).toBe(true);

    const removed = project.removeUnusedFootage();

    expect(removed).toBe(7);
    expect(valueEquals(project.footages, [])).toBe(true);
  });

  test("test_keeps_used_footage", () => {
    const project = parseAep(SOLID_COLORS).project;
    const usedCount = len(project.footages);
    expect(usedCount > 0).toBe(true);
    expect(project.footages.every((f) => truthy(f.usedIn))).toBe(true);

    const removed = project.removeUnusedFootage();

    expect(removed).toBe(0);
    expect(len(project.footages)).toBe(usedCount);
  });

  test("test_removes_only_unused", () => {
    const project = parseAep(SOLID_COLORS).project;
    const usedIds = new Set(project.footages.map((f) => f.id));
    const placeholder = project.importPlaceholder("unused", 100, 100, 25.0, 5.0);

    const removed = project.removeUnusedFootage();

    expect(removed).toBe(1);
    expect(project.items.has(placeholder.id)).toBe(false);
    expect(valueEquals(new Set(project.footages.map((f) => f.id)), usedIds)).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SOLID_COLORS).project;
    project.importPlaceholder("unused", 100, 100, 25.0, 5.0);
    project.removeUnusedFootage();

    const out = tmpPath.div("out.aep");
    project.save(out);
    const reparsed = parseAep(out).project;

    expect(reparsed.footages.every((f) => truthy(f.usedIn))).toBe(true);
  });
});

describe("TestReduceProject", () => {
  test("test_keeps_specified_comp_and_sources", () => {
    const project = parseAep(SOLID_COLORS).project;
    const comps = project.compositions;
    expect(len(comps)).toBe(4);
    const keptComp = comps[0];
    const keptSourceIds = keptComp._sourceIdsForLinking();

    const before = new Set(project.items.keys());
    const removed = project.reduceProject([keptComp]);
    const after = new Set(project.items.keys());

    expect(removed).toBe(len(before) - len(after));
    expect(after.has(keptComp.id)).toBe(true);
    for (const sid of keptSourceIds) {
      expect(after.has(sid)).toBe(true);
    }
    // The other three comps are gone.
    expect(len(project.compositions)).toBe(1);
  });

  test("test_count_matches_extendscript", () => {
    // ExtendScript reduceProject keeping one comp on solid_colors removes 6
    // items (3 comps + 3 solids), keeping the comp, its solid and the
    // parent folder. Validated against AfterFX 2025.
    const project = parseAep(SOLID_COLORS).project;
    const keptComp = project.compositions[0];

    const removed = project.reduceProject([keptComp]);

    expect(removed).toBe(6);
  });

  test("test_root_always_kept", () => {
    const project = parseAep(SOLID_COLORS).project;
    const keptComp = project.compositions[0];

    project.reduceProject([keptComp]);

    expect(project.items.has(0)).toBe(true);
  });

  test("test_empty_keep_removes_all_but_root", () => {
    const project = parseAep(SOLID_COLORS).project;

    const removed = project.reduceProject([]);

    expect(removed > 0).toBe(true);
    expect(valueEquals(new Set(project.items.keys()), new Set([0]))).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(SOLID_COLORS).project;
    const keptComp = project.compositions[0];
    const keptName = keptComp.name;
    project.reduceProject([keptComp]);

    const out = tmpPath.div("out.aep");
    project.save(out);
    const reparsed = parseAep(out).project;

    expect(
      valueEquals(
        reparsed.compositions.map((c) => c.name),
        [keptName],
      ),
    ).toBe(true);
  });
});

describe("TestConsolidateFootage", () => {
  test("test_no_duplicates_is_noop", () => {
    const project = parseAep(FOOTAGE_MISC).project;
    const before = len(project.footages);

    const removed = project.consolidateFootage();

    expect(removed).toBe(0);
    expect(len(project.footages)).toBe(before);
  });

  test("test_merges_identical_sources", () => {
    const project = parseAep(FOOTAGE_MISC).project;
    // footages 5 and 6 reference the same file and differ only by loop.
    const first = asInstance(getOrThrow(project.items, 5), FootageItem);
    const second = asInstance(getOrThrow(project.items, 6), FootageItem);
    expect(first instanceof FootageItem).toBe(true);
    expect(second instanceof FootageItem).toBe(true);
    first.mainSource.loop = second.mainSource.loop;
    expect(valueEquals(first._consolidationKey(), second._consolidationKey())).toBe(true);
    const before = len(project.footages);

    const removed = project.consolidateFootage();

    expect(removed).toBe(1);
    expect(len(project.footages)).toBe(before - 1);
  });

  test("test_retargets_layers", () => {
    const project = parseAep(FOOTAGE_MISC).project;
    const first = asInstance(getOrThrow(project.items, 5), FootageItem);
    const second = asInstance(getOrThrow(project.items, 6), FootageItem);
    expect(first instanceof FootageItem).toBe(true);
    expect(second instanceof FootageItem).toBe(true);
    first.mainSource.loop = second.mainSource.loop;

    const comp = project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    comp.add(first);
    comp.add(second);

    const survivorId = first.id;
    const removed = project.consolidateFootage();

    expect(removed).toBe(1);
    expect(valueEquals(new Set(comp.avLayers.map((layer) => layer._sourceId)), new Set([survivorId]))).toBe(true);
  });

  test("test_retargets_cached_layer_source", () => {
    const project = parseAep(FOOTAGE_MISC).project;
    const first = asInstance(getOrThrow(project.items, 5), FootageItem);
    const second = asInstance(getOrThrow(project.items, 6), FootageItem);
    expect(first instanceof FootageItem).toBe(true);
    expect(second instanceof FootageItem).toBe(true);
    first.mainSource.loop = second.mainSource.loop;

    const comp = project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    comp.add(first);
    comp.add(second);
    const dupLayer = comp.avLayers.find((ly) => ly._sourceId === second.id);
    if (dupLayer === undefined) throw new StopIteration();
    // Populate the layer's source cache before consolidating.
    expect(dupLayer.source === second).toBe(true);

    project.consolidateFootage();

    expect(dupLayer.source === first).toBe(true);
  });

  test("test_solids_not_consolidated", () => {
    const project = parseAep(SOLID_COLORS).project;

    const removed = project.consolidateFootage();

    expect(removed).toBe(0);
  });

  test("test_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const project = parseAep(FOOTAGE_MISC).project;
    const first = asInstance(getOrThrow(project.items, 5), FootageItem);
    const second = asInstance(getOrThrow(project.items, 6), FootageItem);
    expect(first instanceof FootageItem).toBe(true);
    expect(second instanceof FootageItem).toBe(true);
    first.mainSource.loop = second.mainSource.loop;
    project.consolidateFootage();

    const out = tmpPath.div("out.aep");
    project.save(out);
    const reparsed = parseAep(out).project;

    expect(len(reparsed.footages)).toBe(6);
  });
});
