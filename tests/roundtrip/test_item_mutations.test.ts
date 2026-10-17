/** Tests for item creation and removal mutations. */

import { describe, expect, test } from "bun:test";

import { Path, StopIteration, TypeError_, ValueError, contains, dict_get, getitem, len, py_bool, py_eq } from "../../src/pyrt/index.ts";
import { make_tmp_path, raises, skip } from "../../src/pyrt/pytest.ts";
import { parse as parse_aep, type Application } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { FolderItem } from "../../src/py_aep/models/items/folder.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";
import { PlaceholderSource } from "../../src/py_aep/models/sources/placeholder.ts";
import { SolidSource } from "../../src/py_aep/models/sources/solid.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models");

/** Tests for FolderItem.add_folder(). */
describe("TestAddFolder", () => {
  test("test_add_folder_returns_folder", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const folder = root.add_folder("NewFolder");
    expect(folder.name).toBe("NewFolder");
  });

  test("test_add_folder_adds_to_items", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const n = len(root.items);
    root.add_folder("NewFolder");
    expect(len(root.items)).toBe(n + 1);
  });

  test("test_add_folder_registers_in_project", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const folder = root.add_folder("NewFolder");
    expect(getitem(app.project.items, folder.id) === folder).toBe(true);
  });

  test("test_add_folder_unique_id", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const existing_ids = new Set(app.project.items.keys());
    const folder = root.add_folder("NewFolder");
    expect(existing_ids.has(folder.id)).toBe(false);
  });

  test("test_add_folder_parent_folder", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const folder = root.add_folder("NewFolder");
    expect(folder.parent_folder === root).toBe(true);
  });

  /** Add a folder inside a non-root folder. */
  test("test_add_folder_nested", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const parent = root.add_folder("Parent");
    const child = parent.add_folder("Child");
    expect(child.parent_folder === parent).toBe(true);
    expect(contains(parent.items, child)).toBe(true);
    expect(child.name).toBe("Child");
  });

  test("test_add_folder_empty", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const folder = root.add_folder("EmptyNew");
    expect(folder.num_items).toBe(0);
  });

  test("test_add_folder_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const folder = root.add_folder("RoundTripFolder");
    const folder_id = folder.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));

    expect(app2.project.items.has(folder_id)).toBe(true);
    const found = getitem(app2.project.items, folder_id);
    expect(found.name).toBe("RoundTripFolder");
    expect(found.type_name).toBe("Folder");
  });

  test("test_add_folder_nested_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const parent = root.add_folder("Parent");
    const child = parent.add_folder("Child");
    const parent_id = parent.id;
    const child_id = child.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));

    const parent2 = getitem(app2.project.items, parent_id);
    const child2 = getitem(app2.project.items, child_id);
    expect(parent2.name).toBe("Parent");
    expect(child2.name).toBe("Child");
    expect(child2.parent_folder === parent2).toBe(true);
  });

  test("test_add_multiple_folders", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const n = len(root.items);
    const f1 = root.add_folder("A");
    const f2 = root.add_folder("B");
    const f3 = root.add_folder("C");
    expect(len(root.items)).toBe(n + 3);
    expect(f1.id !== f2.id && f2.id !== f3.id).toBe(true);
  });
});

/** Tests for FolderItem.add_comp(). */
describe("TestAddComp", () => {
  test("test_add_comp_returns_compitem", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("NewComp", 1920, 1080, 1.0, 10.0, 24.0);
    expect(comp instanceof CompItem).toBe(true);
  });

  test("test_add_comp_inserts_at_front", () => {
    // AE 2026 places a new comp at the FRONT of the root folder, right
    // after the `fdta` header (verified via headless script addComp).
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("NewComp", 1920, 1080, 1.0, 10.0, 24.0);
    const container = root._children_container;
    // First chunk is the fdta header; the new comp's Item follows it.
    expect(container[0].chunk_type).toBe("fdta");
    expect(container[1] === comp._item_list).toBe(true);
    expect(root.items[0] === comp).toBe(true);
  });

  test("test_add_comp_name", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("TestComp", 1920, 1080, 1.0, 5.0, 30.0);
    expect(comp.name).toBe("TestComp");
  });

  test("test_add_comp_dimensions", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("DimComp", 3840, 2160, 1.0, 10.0, 24.0);
    expect(comp.width).toBe(3840);
    expect(comp.height).toBe(2160);
  });

  test("test_add_comp_frame_rate", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("FpsComp", 1920, 1080, 1.0, 10.0, 29.97);
    expect(Math.abs(comp.frame_rate - 29.97) < 0.01).toBe(true);
  });

  test("test_add_comp_duration", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("DurComp", 1920, 1080, 1.0, 15.5, 24.0);
    expect(Math.abs(comp.duration - 15.5) < 0.01).toBe(true);
  });

  test("test_add_comp_pixel_aspect", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("PAComp", 720, 480, 0.9091, 10.0, 29.97);
    expect(Math.abs(comp.pixel_aspect - 0.9091) < 0.001).toBe(true);
  });

  test("test_add_comp_no_layers", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("EmptyComp", 1920, 1080, 1.0, 10.0, 24.0);
    expect(len(comp.layers)).toBe(0);
  });

  test("test_add_comp_unique_id", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const existing_ids = new Set(app.project.items.keys());
    const comp = root.add_comp("IDComp", 1920, 1080, 1.0, 10.0, 24.0);
    expect(existing_ids.has(comp.id)).toBe(false);
  });

  test("test_add_comp_parent_folder", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("ParentComp", 1920, 1080, 1.0, 10.0, 24.0);
    expect(comp.parent_folder === root).toBe(true);
  });

  test("test_add_comp_registered_in_project", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("RegComp", 1920, 1080, 1.0, 10.0, 24.0);
    expect(getitem(app.project.items, comp.id) === comp).toBe(true);
    expect(contains(app.project.compositions, comp)).toBe(true);
  });

  test("test_add_comp_in_subfolder", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const folder = root.add_folder("SubFolder");
    const comp = folder.add_comp("SubComp", 1280, 720, 1.0, 5.0, 25.0);
    expect(comp.parent_folder === folder).toBe(true);
    expect(contains(folder.items, comp)).toBe(true);
  });

  test("test_add_comp_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("RTComp", 1920, 1080, 1.0, 10.0, 24.0);
    const comp_id = comp.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));

    expect(app2.project.items.has(comp_id)).toBe(true);
    const comp2 = getitem(app2.project.items, comp_id);
    expect(comp2.name).toBe("RTComp");
    expect(comp2.type_name).toBe("Composition");
  });

  test("test_add_comp_roundtrip_preserves_settings", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("Settings", 3840, 2160, 1.0, 30.0, 60.0);
    const comp_id = comp.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));

    const comp2 = getitem(app2.project.items, comp_id) as CompItem;
    expect(comp2 instanceof CompItem).toBe(true);
    expect(comp2.width).toBe(3840);
    expect(comp2.height).toBe(2160);
    expect(Math.abs(comp2.frame_rate - 60.0) < 0.01).toBe(true);
    expect(Math.abs(comp2.duration - 30.0) < 0.01).toBe(true);
  });

  /** Test add_comp when no existing comp to clone from (folder-only project). */
  test("test_add_comp_from_scratch_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    // Remove all comps from project to force from-scratch path
    for (const comp of [...app.project.compositions]) {
      comp.remove();
    }
    // Now there are no compositions to clone from
    expect(len(app.project.compositions)).toBe(0);

    const comp = root.add_comp("Scratch", 1280, 720, 1.0, 5.0, 25.0);
    const comp_id = comp.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));

    const comp2 = getitem(app2.project.items, comp_id) as CompItem;
    expect(comp2 instanceof CompItem).toBe(true);
    expect(comp2.name).toBe("Scratch");
    expect(comp2.width).toBe(1280);
    expect(comp2.height).toBe(720);
  });
});

/** Tests for Item.remove(). */
describe("TestItemRemove", () => {
  test("test_remove_folder_from_root", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const n = len(root.items);
    // Find the first folder
    const folder = root.items.find((i) => i instanceof FolderItem);
    if (folder === undefined) throw new StopIteration();
    const folder_id = folder.id;
    folder.remove();
    expect(len(root.items)).toBe(n - 1);
    expect(app.project.items.has(folder_id)).toBe(false);
  });

  test("test_remove_root_folder_raises", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    raises(ValueError, () => app.project.root_folder.remove(), "Cannot remove the root folder");
  });

  test("test_remove_comp_from_project", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = app.project.compositions[0];
    const comp_id = comp.id;
    const n_items = len(root.items);
    comp.remove();
    expect(len(root.items)).toBe(n_items - 1);
    expect(app.project.items.has(comp_id)).toBe(false);
  });

  /** Remove a folder that was just added. */
  test("test_remove_added_folder", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const n = len(root.items);
    const folder = root.add_folder("Temp");
    expect(len(root.items)).toBe(n + 1);
    folder.remove();
    expect(len(root.items)).toBe(n);
  });

  /** Removing a folder should recursively remove its children. */
  test("test_remove_folder_recursive", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    // Create nested structure
    const parent = root.add_folder("Parent");
    const child = parent.add_folder("Child");
    const parent_id = parent.id;
    const child_id = child.id;

    parent.remove();
    expect(app.project.items.has(parent_id)).toBe(false);
    expect(app.project.items.has(child_id)).toBe(false);
  });

  /** Removing a comp that is used as a layer source should clean up layers. */
  test("test_remove_comp_cleans_layers", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    // Find a comp that is nested in another comp
    // First check if any comp is used as a layer source
    for (const comp of app.project.compositions) {
      for (const layer of comp.layers) {
        if (layer instanceof AVLayer && py_bool(layer._source_id)) {
          const source_item = dict_get(app.project.items, layer._source_id);
          if (source_item instanceof CompItem) {
            // Found a comp used as a layer source
            const source_id = source_item.id;
            const parent_comp = comp;
            source_item.remove();
            // Layer referencing the removed comp should be gone
            for (const remaining_layer of parent_comp.layers) {
              if (remaining_layer instanceof AVLayer) {
                expect(remaining_layer._source_id !== source_id).toBe(true);
              }
            }
            return;
          }
        }
      }
    }
    return skip("No nested comp found in sample");
  });

  test("test_remove_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    // Add and remove a folder
    const folder = root.add_folder("ToDelete");
    const folder_id = folder.id;
    folder.remove();

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    expect(app2.project.items.has(folder_id)).toBe(false);
  });

  test("test_remove_comp_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const comp = app.project.compositions[0];
    const comp_id = comp.id;
    comp.remove();

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    expect(app2.project.items.has(comp_id)).toBe(false);
    expect(len(app2.project.compositions)).toBe(0);
  });

  /** Add a comp, save, verify it's there, remove it, save again, verify gone. */
  test("test_add_and_remove_comp_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("Ephemeral", 1920, 1080, 1.0, 5.0, 24.0);
    const comp_id = comp.id;

    // Save with the new comp
    app.project.save(tmp_path.div("with_comp.aep"));
    const app2 = parse_aep(tmp_path.div("with_comp.aep"));
    expect(app2.project.items.has(comp_id)).toBe(true);

    // Remove and save again
    getitem(app2.project.items, comp_id).remove();
    app2.project.save(tmp_path.div("without_comp.aep"));
    const app3 = parse_aep(tmp_path.div("without_comp.aep"));
    expect(app3.project.items.has(comp_id)).toBe(false);
  });
});

/** Tests for moving items between folders via parent_folder. */
describe("TestParentFolderSetter", () => {
  function _folders(app: Application): [FolderItem, FolderItem, FolderItem] {
    const root = app.project.root_folder;
    const fwi = root.folders.find((f) => f.name === "FolderWithItems");
    if (fwi === undefined) throw new StopIteration();
    const empty = root.folders.find((f) => f.name === "EmptyFolder");
    if (empty === undefined) throw new StopIteration();
    return [root, fwi, empty];
  }

  test("test_move_updates_parent_folder", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const [, fwi, empty] = _folders(app);
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    comp1.parent_folder = empty;
    expect(comp1.parent_folder === empty).toBe(true);
  });

  test("test_move_removes_from_old_items", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const [, fwi, empty] = _folders(app);
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    comp1.parent_folder = empty;
    expect(contains(fwi.items, comp1)).toBe(false);
  });

  test("test_move_adds_to_new_items", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const [, fwi, empty] = _folders(app);
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    comp1.parent_folder = empty;
    expect(contains(empty.items, comp1)).toBe(true);
  });

  test("test_move_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const [, fwi, empty] = _folders(app);
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    const comp1_id = comp1.id;
    comp1.parent_folder = empty;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));

    const comp1_2 = getitem(app2.project.items, comp1_id);
    const empty2 = app2.project.root_folder.folders.find((f) => f.name === "EmptyFolder");
    if (empty2 === undefined) throw new StopIteration();
    const fwi2 = app2.project.root_folder.folders.find((f) => f.name === "FolderWithItems");
    if (fwi2 === undefined) throw new StopIteration();
    expect(comp1_2.parent_folder === empty2).toBe(true);
    expect(contains(empty2.items, comp1_2)).toBe(true);
    expect(contains(fwi2.items, comp1_2)).toBe(false);
  });

  test("test_move_to_root", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const fwi = root.folders.find((f) => f.name === "FolderWithItems");
    if (fwi === undefined) throw new StopIteration();
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    comp1.parent_folder = root;
    expect(comp1.parent_folder === root).toBe(true);
    expect(contains(root.items, comp1)).toBe(true);
    expect(contains(fwi.items, comp1)).toBe(false);
  });

  /** Moving a folder relocates its whole subtree. */
  test("test_move_subtree_keeps_children", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const root_folder = root.folders.find((f) => f.name === "RootFolder");
    if (root_folder === undefined) throw new StopIteration();
    const level1 = root_folder.folders[0];
    const level2 = level1.folders[0];
    const child_names = level2.folders.map((f) => f.name);

    level2.parent_folder = root;
    expect(contains(root.items, level2)).toBe(true);
    expect(contains(level1.items, level2)).toBe(false);
    expect(py_eq(level2.folders.map((f) => f.name), child_names)).toBe(true);
  });

  test("test_same_parent_noop", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const empty = root.folders.find((f) => f.name === "EmptyFolder");
    if (empty === undefined) throw new StopIteration();
    const n = len(root.items);
    empty.parent_folder = root;
    expect(empty.parent_folder === root).toBe(true);
    expect(len(root.items)).toBe(n);
  });

  test("test_self_move_raises", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const empty = root.folders.find((f) => f.name === "EmptyFolder");
    if (empty === undefined) throw new StopIteration();
    raises(ValueError, () => {
      empty.parent_folder = empty;
    }, "cannot be moved inside itself");
  });

  test("test_move_into_descendant_raises", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const root_folder = root.folders.find((f) => f.name === "RootFolder");
    if (root_folder === undefined) throw new StopIteration();
    const level2 = root_folder.folders[0].folders[0];
    raises(ValueError, () => {
      root_folder.parent_folder = level2;
    }, "cannot be moved inside itself");
  });

  test("test_move_root_raises", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const empty = root.folders.find((f) => f.name === "EmptyFolder");
    if (empty === undefined) throw new StopIteration();
    raises(ValueError, () => {
      root.parent_folder = empty;
    }, "Cannot move the root folder");
  });

  test("test_non_folder_target_raises", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const fwi = root.folders.find((f) => f.name === "FolderWithItems");
    if (fwi === undefined) throw new StopIteration();
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    raises(TypeError_, () => {
      comp1.parent_folder = comp1.id as any;
    }, "must be a FolderItem");
  });

  /** An item's open-panel viewer moves with it between folders. */
  test("test_move_relocates_viewer", () => {
    const app = parse_aep(SAMPLES_DIR.div("composition", "selection_both_layers.aep"));
    const root = app.project.root_folder;
    const comp = root.compositions.find((c) => c._viewer != null && contains(root.items, c));
    if (comp === undefined) throw new StopIteration();
    const viewer = comp._viewer;
    expect(contains(root._viewers, viewer)).toBe(true);

    const folder = root.add_folder("Bin");
    comp.parent_folder = folder;
    expect(contains(root._viewers, viewer)).toBe(false);
    expect(contains(folder._viewers, viewer)).toBe(true);
  });
});

/** Tests for Project.import_placeholder(). */
describe("TestImportPlaceholder", () => {
  test("test_import_placeholder_returns_footage", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder("PH", 1920, 1080, 30.0, 10.0);
    expect(item instanceof FootageItem).toBe(true);
  });

  test("test_import_placeholder_name", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder("MyPlaceholder", 1920, 1080, 30.0, 10.0);
    expect(item.name).toBe("MyPlaceholder");
  });

  test("test_import_placeholder_dimensions", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder("PH", 3840, 2160, 24.0, 5.0);
    expect(item.width).toBe(3840);
    expect(item.height).toBe(2160);
  });

  test("test_import_placeholder_frame_rate", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder("PH", 1920, 1080, 29.97, 10.0);
    expect(Math.abs(item.frame_rate - 29.97) < 0.01).toBe(true);
  });

  test("test_import_placeholder_duration", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder("PH", 1920, 1080, 30.0, 7.5);
    expect(Math.abs(item.duration - 7.5) < 0.01).toBe(true);
  });

  test("test_import_placeholder_is_placeholder", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder("PH", 1920, 1080, 30.0, 10.0);
    expect(item.main_source instanceof PlaceholderSource).toBe(true);
    expect(item.asset_type).toBe("placeholder");
  });

  test("test_import_placeholder_unique_id", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const existing_ids = new Set(app.project.items.keys());
    const item = app.project.import_placeholder("PH", 1920, 1080, 30.0, 10.0);
    expect(existing_ids.has(item.id)).toBe(false);
  });

  test("test_import_placeholder_in_root_folder", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder("PH", 1920, 1080, 30.0, 10.0);
    expect(item.parent_folder === app.project.root_folder).toBe(true);
    expect(contains(app.project.root_folder.items, item)).toBe(true);
  });

  test("test_import_placeholder_registered_in_project", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder("PH", 1920, 1080, 30.0, 10.0);
    expect(getitem(app.project.items, item.id) === item).toBe(true);
    expect(contains(app.project.footages, item)).toBe(true);
  });

  test("test_import_placeholder_invalid_width", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    raises(ValueError, () => app.project.import_placeholder("PH", 2, 1080, 30.0, 10.0), "must be >= 4");
  });

  test("test_import_placeholder_invalid_height", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    raises(ValueError, () => app.project.import_placeholder("PH", 1920, 0, 30.0, 10.0), "must be >= 4");
  });

  test("test_import_placeholder_invalid_frame_rate", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    raises(ValueError, () => app.project.import_placeholder("PH", 1920, 1080, 0.5, 10.0), "must be >= 1");
  });

  test("test_import_placeholder_invalid_duration", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    // A zero duration has no frames; validate_duration rejects it (its
    // minimum is one frame at the maximum 99 fps).
    raises(ValueError, () => app.project.import_placeholder("PH", 1920, 1080, 30.0, 0.0), "must be >=");
  });

  test("test_import_placeholder_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder("RTPH", 1280, 720, 25.0, 8.0);
    const item_id = item.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));

    expect(app2.project.items.has(item_id)).toBe(true);
    const item2 = getitem(app2.project.items, item_id) as FootageItem;
    expect(item2.name).toBe("RTPH");
    expect(item2.width).toBe(1280);
    expect(item2.height).toBe(720);
    expect(Math.abs(item2.duration - 8.0) < 0.01).toBe(true);
  });
});

/** Tests for FootageItem.replace_with_placeholder(). */
describe("TestReplaceWithPlaceholder", () => {
  test("test_replace_with_placeholder", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.replace_with_placeholder("NewPH", 1920, 1080, 30.0, 10.0);
    expect(footage.main_source instanceof PlaceholderSource).toBe(true);
    expect(footage.name).toBe("NewPH");
    expect(footage.width).toBe(1920);
    expect(footage.height).toBe(1080);
  });

  test("test_replace_with_placeholder_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    const footage_id = footage.id;
    footage.replace_with_placeholder("RtPH", 1280, 720, 24.0, 5.0);

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const item2 = getitem(app2.project.items, footage_id) as FootageItem;
    expect(item2.name).toBe("RtPH");
    expect(item2.width).toBe(1280);
    expect(item2.height).toBe(720);
    expect(item2.asset_type).toBe("placeholder");
  });
});

/** Tests for FootageItem.replace_with_solid(). */
describe("TestReplaceWithSolid", () => {
  test("test_replace_with_solid", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "placeholder.aep"));
    const footage = app.project.footages[0];
    footage.replace_with_solid([1.0, 0.0, 0.0], "RedSolid", 1920, 1080, 1.0);
    expect(footage.main_source instanceof SolidSource).toBe(true);
    expect(footage.name).toBe("RedSolid");
    expect(footage.width).toBe(1920);
    expect(footage.height).toBe(1080);
  });

  test("test_replace_with_solid_color", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "placeholder.aep"));
    const footage = app.project.footages[0];
    footage.replace_with_solid([0.5, 0.25, 0.75], "ColorSolid", 1920, 1080, 1.0);
    const color = (footage.main_source as SolidSource).color;
    expect(Math.abs(color[0] - 0.5) < 0.01).toBe(true);
    expect(Math.abs(color[1] - 0.25) < 0.01).toBe(true);
    expect(Math.abs(color[2] - 0.75) < 0.01).toBe(true);
  });

  test("test_replace_with_solid_invalid_color", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "placeholder.aep"));
    const footage = app.project.footages[0];
    raises(ValueError, () => footage.replace_with_solid([1.5, 0.0, 0.0], "Bad", 1920, 1080, 1.0), "must be <= 1");
  });

  test("test_replace_with_solid_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("footage", "placeholder.aep"));
    const footage = app.project.footages[0];
    const footage_id = footage.id;
    footage.replace_with_solid([0.0, 1.0, 0.0], "GreenSolid", 960, 540, 1.0);

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const item2 = getitem(app2.project.items, footage_id) as FootageItem;
    expect(item2.name).toBe("GreenSolid");
    expect(item2.width).toBe(960);
    expect(item2.height).toBe(540);
    expect(item2.asset_type).toBe("solid");
  });
});

/** Tests for AVItem.set_proxy_to_none(). */
describe("TestSetProxyToNone", () => {
  test("test_set_proxy_to_none_removes_proxy", () => {
    const app = parse_aep(SAMPLES_DIR.div("item", "proxy.aep"));
    // Find an item that has a proxy
    const footage = app.project.footages.find((f) => f.proxy_source != null) ?? null;
    if (footage == null) return skip("No item with proxy found in sample");
    footage.set_proxy_to_none();
    expect(footage.proxy_source == null).toBe(true);
  });

  /** Calling set_proxy_to_none when there's no proxy is a no-op. */
  test("test_set_proxy_to_none_noop", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    // Import a placeholder (which has no proxy)
    const item = app.project.import_placeholder("PH", 1920, 1080, 30.0, 10.0);
    item.set_proxy_to_none();
    expect(item.proxy_source == null).toBe(true);
  });

  test("test_set_proxy_to_none_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("item", "proxy.aep"));
    const footage = app.project.footages.find((f) => f.proxy_source != null) ?? null;
    if (footage == null) return skip("No item with proxy found in sample");
    const footage_id = footage.id;
    footage.set_proxy_to_none();

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const item2 = getitem(app2.project.items, footage_id) as FootageItem;
    expect(item2.proxy_source == null).toBe(true);
  });
});

/** Tests for AVItem.set_proxy_with_placeholder(). */
describe("TestSetProxyWithPlaceholder", () => {
  test("test_set_proxy_with_placeholder", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.set_proxy_with_placeholder("ProxyPH", 960, 540, 30.0, 10.0);
    expect(footage.proxy_source instanceof PlaceholderSource).toBe(true);
  });

  test("test_set_proxy_with_placeholder_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    const footage_id = footage.id;
    footage.set_proxy_with_placeholder("ProxyPH", 960, 540, 30.0, 10.0);

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const item2 = getitem(app2.project.items, footage_id) as FootageItem;
    expect(item2.proxy_source != null).toBe(true);
  });

  test("test_set_proxy_replaces_existing", () => {
    const app = parse_aep(SAMPLES_DIR.div("item", "proxy.aep"));
    const footage = app.project.footages.find((f) => f.proxy_source != null) ?? null;
    if (footage == null) return skip("No item with proxy found in sample");
    footage.set_proxy_with_placeholder("NewProxy", 640, 480, 25.0, 5.0);
    expect(footage.proxy_source instanceof PlaceholderSource).toBe(true);
  });
});

/** Tests for AVItem.set_proxy_with_solid(). */
describe("TestSetProxyWithSolid", () => {
  test("test_set_proxy_with_solid", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.set_proxy_with_solid([1.0, 0.0, 0.0], "RedProxy", 960, 540, 1.0);
    expect(footage.proxy_source instanceof SolidSource).toBe(true);
  });

  test("test_set_proxy_with_solid_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    const footage_id = footage.id;
    footage.set_proxy_with_solid([0.0, 0.0, 1.0], "BlueProxy", 960, 540, 1.0);

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const item2 = getitem(app2.project.items, footage_id) as FootageItem;
    expect(item2.proxy_source != null).toBe(true);
  });

  test("test_set_proxy_then_remove", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.set_proxy_with_solid([1.0, 1.0, 0.0], "YProxy", 640, 480, 1.0);
    expect(footage.proxy_source != null).toBe(true);
    footage.set_proxy_to_none();
    expect(footage.proxy_source == null).toBe(true);
  });
});

/** Tests for add_folder with None name. */
describe("TestAutoNameFolder", () => {
  test("test_none_generates_untitled", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const folder = root.add_folder(null);
    expect(folder.name.startsWith("Untitled ")).toBe(true);
  });

  test("test_none_increments", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const f1 = root.add_folder(null);
    const f2 = root.add_folder(null);
    expect(f1.name !== f2.name).toBe(true);
  });

  test("test_none_default_arg", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const folder = root.add_folder();
    expect(folder.name.startsWith("Untitled ")).toBe(true);
  });

  test("test_empty_string_allowed", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const folder = root.add_folder("");
    expect(folder.name).toBe("");
  });
});

/** Tests for add_comp with None name. */
describe("TestAutoNameComp", () => {
  test("test_none_generates_comp", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp(null, 1920, 1080, 1.0, 10.0, 24.0);
    expect(comp.name.startsWith("Comp ")).toBe(true);
  });

  test("test_empty_string_allowed", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.root_folder;
    const comp = root.add_comp("", 1920, 1080, 1.0, 10.0, 24.0);
    expect(comp.name).toBe("");
  });
});

/** Tests for import_placeholder with None/empty name. */
describe("TestAutoNamePlaceholder", () => {
  test("test_none_becomes_missing_name", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder(null, 1920, 1080, 24.0, 10.0);
    expect(item.name).toBe("Missing Name");
  });

  test("test_empty_becomes_placeholder", () => {
    const app = parse_aep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.import_placeholder("", 1920, 1080, 24.0, 10.0);
    expect(item.name).toBe("Placeholder");
  });
});

/** Tests for replace_with_solid with None/empty name. */
describe("TestAutoNameSolid", () => {
  test("test_none_auto_names_from_color", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.replace_with_solid([1.0, 0.0, 0.0], null, 1920, 1080);
    expect(footage.name.includes("Red Solid")).toBe(true);
  });

  test("test_empty_becomes_question_marks", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.replace_with_solid([1.0, 0.0, 0.0], "", 1920, 1080);
    expect(footage.name).toBe("????");
  });

  test("test_replace_with_placeholder_none", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.replace_with_placeholder(null, 1920, 1080, 24.0, 10.0);
    expect(footage.name).toBe("Missing Name");
  });

  test("test_replace_with_placeholder_empty", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.replace_with_placeholder("", 1920, 1080, 24.0, 10.0);
    expect(footage.name).toBe("Placeholder");
  });
});

/** Tests for proxy methods with None/empty name. */
describe("TestAutoNameProxy", () => {
  test("test_proxy_placeholder_none", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.set_proxy_with_placeholder(null, 1920, 1080, 24.0, 10.0);
    expect(footage.proxy_source != null).toBe(true);
  });

  test("test_proxy_placeholder_empty", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.set_proxy_with_placeholder("", 1920, 1080, 24.0, 10.0);
    expect(footage.proxy_source != null).toBe(true);
  });

  test("test_proxy_solid_none", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.set_proxy_with_solid([0.0, 1.0, 0.0], null, 960, 540);
    expect(footage.proxy_source != null).toBe(true);
  });

  test("test_proxy_solid_empty", () => {
    const app = parse_aep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.set_proxy_with_solid([0.0, 1.0, 0.0], "", 960, 540);
    expect(footage.proxy_source != null).toBe(true);
  });
});
