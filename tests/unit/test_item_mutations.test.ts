/**
 * Tests for item creation and removal mutations.
 */

import { describe, expect, test } from "bun:test";
import "../../src/py_aep/binary/_register.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { auto_name } from "../../src/py_aep/models/naming.ts";
import { Path, getitem, py_eq } from "../../src/pyrt/index.ts";

const SAMPLES_DIR = new Path(import.meta.path).parent.parent.parent.div("samples", "models");

/** Tests for the auto_name naming helper. */
describe("TestAutoName", () => {
  test("test_first_name", () => {
    expect(auto_name("Comp", new Set<string>())).toBe("Comp 1");
  });

  test("test_skips_to_2_when_base_exists", () => {
    expect(auto_name("Comp", new Set(["Comp"]))).toBe("Comp 2");
  });

  test("test_skips_to_2_when_base_0_exists", () => {
    expect(auto_name("Comp", new Set(["Comp 0"]))).toBe("Comp 2");
  });

  test("test_skips_existing", () => {
    const existing = new Set(["Comp 1", "Comp 2"]);
    expect(auto_name("Comp", existing)).toBe("Comp 3");
  });

  test("test_skips_existing_with_base", () => {
    const existing = new Set(["Comp", "Comp 2", "Comp 3"]);
    expect(auto_name("Comp", existing)).toBe("Comp 4");
  });

  test("test_uses_max_suffix", () => {
    const existing = new Set(["Comp 4"]);
    expect(auto_name("Comp", existing)).toBe("Comp 5");
  });

  test("test_gap_not_filled", () => {
    const existing = new Set(["Comp 1", "Comp 5"]);
    expect(auto_name("Comp", existing)).toBe("Comp 6");
  });
});

/** FolderItem._sort_children_by_name (used by the layered-import path). */
describe("TestSortChildrenByName", () => {
  test("test_orders_items_and_sfdr_blocks_alphabetically", () => {
    const folder = py_aep.new().project.rootFolder.addFolder("Layers");
    // add_comp front-inserts, so document order != stored order; mixed case
    // and a non-alphabetical sequence exercise the case-insensitive sort.
    for (const name of ["zebra", "alpha", "Mango", "beta"]) {
      folder.addComp(name, 100, 100, 1.0, 1.0, 30.0);
    }

    folder._sort_children_by_name();

    const expected = ["alpha", "beta", "Mango", "zebra"];
    expect(py_eq(folder.items.map((item) => item.name), expected)).toBe(true);
    // The backing Sfdr item_list chunks are reordered to match.
    // id() keys are object identity, so the Map is keyed by the chunk objects.
    const id_to_name = new Map<object, string>(folder.items.map((item): [object, string] => [item._item_list, item.name]));
    const chunk_order = folder._children_container
      .filter((chunk) => id_to_name.has(chunk))
      .map((chunk) => getitem(id_to_name, chunk));
    expect(py_eq(chunk_order, expected)).toBe(true);
  });
});
