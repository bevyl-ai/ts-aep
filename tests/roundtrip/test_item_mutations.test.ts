/** Tests for item creation and removal mutations. */

import { describe, expect, test } from "bun:test";

import { Path, StopIteration, TypeError_, ValueError, contains, dictGet, getitem, len, pyBool, pyEq } from "../../src/pyrt/index.ts";
import { makeTmpPath, raises, skip } from "../../src/pyrt/pytest.ts";
import { parse as parseAep, type Application } from "../../src/py_aep/index.ts";
import "../../src/py_aep/binary/_register.ts";
import { CompItem } from "../../src/py_aep/models/items/composition.ts";
import { FolderItem } from "../../src/py_aep/models/items/folder.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";
import { PlaceholderSource } from "../../src/py_aep/models/sources/placeholder.ts";
import { SolidSource } from "../../src/py_aep/models/sources/solid.ts";
import { asInstance } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models");

/** Tests for FolderItem.addFolder(). */
describe("TestAddFolder", () => {
  test("test_add_folder_returns_folder", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const folder = root.addFolder("NewFolder");
    expect(folder.name).toBe("NewFolder");
  });

  test("test_add_folder_adds_to_items", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const n = len(root.items);
    root.addFolder("NewFolder");
    expect(len(root.items)).toBe(n + 1);
  });

  test("test_add_folder_registers_in_project", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const folder = root.addFolder("NewFolder");
    expect(getitem(app.project.items, folder.id) === folder).toBe(true);
  });

  test("test_add_folder_unique_id", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const existingIds = new Set(app.project.items.keys());
    const folder = root.addFolder("NewFolder");
    expect(existingIds.has(folder.id)).toBe(false);
  });

  test("test_add_folder_parent_folder", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const folder = root.addFolder("NewFolder");
    expect(folder.parentFolder === root).toBe(true);
  });

  /** Add a folder inside a non-root folder. */
  test("test_add_folder_nested", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const parent = root.addFolder("Parent");
    const child = parent.addFolder("Child");
    expect(child.parentFolder === parent).toBe(true);
    expect(contains(parent.items, child)).toBe(true);
    expect(child.name).toBe("Child");
  });

  test("test_add_folder_empty", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const folder = root.addFolder("EmptyNew");
    expect(folder.numItems).toBe(0);
  });

  test("test_add_folder_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const folder = root.addFolder("RoundTripFolder");
    const folderId = folder.id;

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));

    expect(app2.project.items.has(folderId)).toBe(true);
    const found = getitem(app2.project.items, folderId);
    expect(found.name).toBe("RoundTripFolder");
    expect(found.typeName).toBe("Folder");
  });

  test("test_add_folder_nested_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const parent = root.addFolder("Parent");
    const child = parent.addFolder("Child");
    const parentId = parent.id;
    const childId = child.id;

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));

    const parent2 = getitem(app2.project.items, parentId);
    const child2 = getitem(app2.project.items, childId);
    expect(parent2.name).toBe("Parent");
    expect(child2.name).toBe("Child");
    expect(child2.parentFolder === parent2).toBe(true);
  });

  test("test_add_multiple_folders", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const n = len(root.items);
    const f1 = root.addFolder("A");
    const f2 = root.addFolder("B");
    const f3 = root.addFolder("C");
    expect(len(root.items)).toBe(n + 3);
    expect(f1.id !== f2.id && f2.id !== f3.id).toBe(true);
  });
});

/** Tests for FolderItem.addComp(). */
describe("TestAddComp", () => {
  test("test_add_comp_returns_compitem", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("NewComp", 1920, 1080, 1.0, 10.0, 24.0);
    expect(comp instanceof CompItem).toBe(true);
  });

  test("test_add_comp_inserts_at_front", () => {
    // AE 2026 places a new comp at the FRONT of the root folder, right
    // after the `fdta` header (verified via headless script addComp).
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("NewComp", 1920, 1080, 1.0, 10.0, 24.0);
    const container = root._childrenContainer;
    // First chunk is the fdta header; the new comp's Item follows it.
    expect(container[0].chunkType).toBe("fdta");
    expect(container[1] === comp._itemList).toBe(true);
    expect(root.items[0] === comp).toBe(true);
  });

  test("test_add_comp_name", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("TestComp", 1920, 1080, 1.0, 5.0, 30.0);
    expect(comp.name).toBe("TestComp");
  });

  test("test_add_comp_dimensions", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("DimComp", 3840, 2160, 1.0, 10.0, 24.0);
    expect(comp.width).toBe(3840);
    expect(comp.height).toBe(2160);
  });

  test("test_add_comp_frame_rate", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("FpsComp", 1920, 1080, 1.0, 10.0, 29.97);
    expect(Math.abs(comp.frameRate - 29.97) < 0.01).toBe(true);
  });

  test("test_add_comp_duration", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("DurComp", 1920, 1080, 1.0, 15.5, 24.0);
    expect(Math.abs(comp.duration - 15.5) < 0.01).toBe(true);
  });

  test("test_add_comp_pixel_aspect", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("PAComp", 720, 480, 0.9091, 10.0, 29.97);
    expect(Math.abs(comp.pixelAspect - 0.9091) < 0.001).toBe(true);
  });

  test("test_add_comp_no_layers", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("EmptyComp", 1920, 1080, 1.0, 10.0, 24.0);
    expect(len(comp.layers)).toBe(0);
  });

  test("test_add_comp_unique_id", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const existingIds = new Set(app.project.items.keys());
    const comp = root.addComp("IDComp", 1920, 1080, 1.0, 10.0, 24.0);
    expect(existingIds.has(comp.id)).toBe(false);
  });

  test("test_add_comp_parent_folder", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("ParentComp", 1920, 1080, 1.0, 10.0, 24.0);
    expect(comp.parentFolder === root).toBe(true);
  });

  test("test_add_comp_registered_in_project", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("RegComp", 1920, 1080, 1.0, 10.0, 24.0);
    expect(getitem(app.project.items, comp.id) === comp).toBe(true);
    expect(contains(app.project.compositions, comp)).toBe(true);
  });

  test("test_add_comp_in_subfolder", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const folder = root.addFolder("SubFolder");
    const comp = folder.addComp("SubComp", 1280, 720, 1.0, 5.0, 25.0);
    expect(comp.parentFolder === folder).toBe(true);
    expect(contains(folder.items, comp)).toBe(true);
  });

  test("test_add_comp_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("RTComp", 1920, 1080, 1.0, 10.0, 24.0);
    const compId = comp.id;

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));

    expect(app2.project.items.has(compId)).toBe(true);
    const comp2 = getitem(app2.project.items, compId);
    expect(comp2.name).toBe("RTComp");
    expect(comp2.typeName).toBe("Composition");
  });

  test("test_add_comp_roundtrip_preserves_settings", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("Settings", 3840, 2160, 1.0, 30.0, 60.0);
    const compId = comp.id;

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));

    const comp2 = asInstance(getitem(app2.project.items, compId), CompItem);
    expect(comp2 instanceof CompItem).toBe(true);
    expect(comp2.width).toBe(3840);
    expect(comp2.height).toBe(2160);
    expect(Math.abs(comp2.frameRate - 60.0) < 0.01).toBe(true);
    expect(Math.abs(comp2.duration - 30.0) < 0.01).toBe(true);
  });

  /** Test add_comp when no existing comp to clone from (folder-only project). */
  test("test_add_comp_from_scratch_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    // Remove all comps from project to force from-scratch path
    for (const comp of [...app.project.compositions]) {
      comp.remove();
    }
    // Now there are no compositions to clone from
    expect(len(app.project.compositions)).toBe(0);

    const comp = root.addComp("Scratch", 1280, 720, 1.0, 5.0, 25.0);
    const compId = comp.id;

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));

    const comp2 = asInstance(getitem(app2.project.items, compId), CompItem);
    expect(comp2 instanceof CompItem).toBe(true);
    expect(comp2.name).toBe("Scratch");
    expect(comp2.width).toBe(1280);
    expect(comp2.height).toBe(720);
  });
});

/** Tests for Item.remove(). */
describe("TestItemRemove", () => {
  test("test_remove_folder_from_root", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const n = len(root.items);
    // Find the first folder
    const folder = root.items.find((i) => i instanceof FolderItem);
    if (folder === undefined) throw new StopIteration();
    const folderId = folder.id;
    folder.remove();
    expect(len(root.items)).toBe(n - 1);
    expect(app.project.items.has(folderId)).toBe(false);
  });

  test("test_remove_root_folder_raises", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    raises(ValueError, () => app.project.rootFolder.remove(), "Cannot remove the root folder");
  });

  test("test_remove_comp_from_project", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = app.project.compositions[0];
    const compId = comp.id;
    const nItems = len(root.items);
    comp.remove();
    expect(len(root.items)).toBe(nItems - 1);
    expect(app.project.items.has(compId)).toBe(false);
  });

  /** Remove a folder that was just added. */
  test("test_remove_added_folder", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const n = len(root.items);
    const folder = root.addFolder("Temp");
    expect(len(root.items)).toBe(n + 1);
    folder.remove();
    expect(len(root.items)).toBe(n);
  });

  /** Removing a folder should recursively remove its children. */
  test("test_remove_folder_recursive", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    // Create nested structure
    const parent = root.addFolder("Parent");
    const child = parent.addFolder("Child");
    const parentId = parent.id;
    const childId = child.id;

    parent.remove();
    expect(app.project.items.has(parentId)).toBe(false);
    expect(app.project.items.has(childId)).toBe(false);
  });

  /** Removing a comp that is used as a layer source should clean up layers. */
  test("test_remove_comp_cleans_layers", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    // Find a comp that is nested in another comp
    // First check if any comp is used as a layer source
    for (const comp of app.project.compositions) {
      for (const layer of comp.layers) {
        if (layer instanceof AVLayer && pyBool(layer._sourceId)) {
          const sourceItem = dictGet(app.project.items, layer._sourceId);
          if (sourceItem instanceof CompItem) {
            // Found a comp used as a layer source
            const sourceId = sourceItem.id;
            const parentComp = comp;
            sourceItem.remove();
            // Layer referencing the removed comp should be gone
            for (const remainingLayer of parentComp.layers) {
              if (remainingLayer instanceof AVLayer) {
                expect(remainingLayer._sourceId !== sourceId).toBe(true);
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
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    // Add and remove a folder
    const folder = root.addFolder("ToDelete");
    const folderId = folder.id;
    folder.remove();

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    expect(app2.project.items.has(folderId)).toBe(false);
  });

  test("test_remove_comp_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const comp = app.project.compositions[0];
    const compId = comp.id;
    comp.remove();

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    expect(app2.project.items.has(compId)).toBe(false);
    expect(len(app2.project.compositions)).toBe(0);
  });

  /** Add a comp, save, verify it's there, remove it, save again, verify gone. */
  test("test_add_and_remove_comp_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("composition", "bgColor_custom.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("Ephemeral", 1920, 1080, 1.0, 5.0, 24.0);
    const compId = comp.id;

    // Save with the new comp
    app.project.save(tmpPath.div("with_comp.aep"));
    const app2 = parseAep(tmpPath.div("with_comp.aep"));
    expect(app2.project.items.has(compId)).toBe(true);

    // Remove and save again
    getitem(app2.project.items, compId).remove();
    app2.project.save(tmpPath.div("without_comp.aep"));
    const app3 = parseAep(tmpPath.div("without_comp.aep"));
    expect(app3.project.items.has(compId)).toBe(false);
  });
});

/** Tests for moving items between folders via parent_folder. */
describe("TestParentFolderSetter", () => {
  function _folders(app: Application): [FolderItem, FolderItem, FolderItem] {
    const root = app.project.rootFolder;
    const fwi = root.folders.find((f) => f.name === "FolderWithItems");
    if (fwi === undefined) throw new StopIteration();
    const empty = root.folders.find((f) => f.name === "EmptyFolder");
    if (empty === undefined) throw new StopIteration();
    return [root, fwi, empty];
  }

  test("test_move_updates_parent_folder", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const [, fwi, empty] = _folders(app);
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    comp1.parentFolder = empty;
    expect(comp1.parentFolder === empty).toBe(true);
  });

  test("test_move_removes_from_old_items", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const [, fwi, empty] = _folders(app);
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    comp1.parentFolder = empty;
    expect(contains(fwi.items, comp1)).toBe(false);
  });

  test("test_move_adds_to_new_items", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const [, fwi, empty] = _folders(app);
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    comp1.parentFolder = empty;
    expect(contains(empty.items, comp1)).toBe(true);
  });

  test("test_move_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const [, fwi, empty] = _folders(app);
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    const comp1Id = comp1.id;
    comp1.parentFolder = empty;

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));

    const comp12 = getitem(app2.project.items, comp1Id);
    const empty2 = app2.project.rootFolder.folders.find((f) => f.name === "EmptyFolder");
    if (empty2 === undefined) throw new StopIteration();
    const fwi2 = app2.project.rootFolder.folders.find((f) => f.name === "FolderWithItems");
    if (fwi2 === undefined) throw new StopIteration();
    expect(comp12.parentFolder === empty2).toBe(true);
    expect(contains(empty2.items, comp12)).toBe(true);
    expect(contains(fwi2.items, comp12)).toBe(false);
  });

  test("test_move_to_root", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const fwi = root.folders.find((f) => f.name === "FolderWithItems");
    if (fwi === undefined) throw new StopIteration();
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    comp1.parentFolder = root;
    expect(comp1.parentFolder === root).toBe(true);
    expect(contains(root.items, comp1)).toBe(true);
    expect(contains(fwi.items, comp1)).toBe(false);
  });

  /** Moving a folder relocates its whole subtree. */
  test("test_move_subtree_keeps_children", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const rootFolder = root.folders.find((f) => f.name === "RootFolder");
    if (rootFolder === undefined) throw new StopIteration();
    const level1 = rootFolder.folders[0];
    const level2 = level1.folders[0];
    const childNames = level2.folders.map((f) => f.name);

    level2.parentFolder = root;
    expect(contains(root.items, level2)).toBe(true);
    expect(contains(level1.items, level2)).toBe(false);
    expect(pyEq(level2.folders.map((f) => f.name), childNames)).toBe(true);
  });

  test("test_same_parent_noop", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const empty = root.folders.find((f) => f.name === "EmptyFolder");
    if (empty === undefined) throw new StopIteration();
    const n = len(root.items);
    empty.parentFolder = root;
    expect(empty.parentFolder === root).toBe(true);
    expect(len(root.items)).toBe(n);
  });

  test("test_self_move_raises", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const empty = root.folders.find((f) => f.name === "EmptyFolder");
    if (empty === undefined) throw new StopIteration();
    raises(ValueError, () => {
      empty.parentFolder = empty;
    }, "cannot be moved inside itself");
  });

  test("test_move_into_descendant_raises", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const rootFolder = root.folders.find((f) => f.name === "RootFolder");
    if (rootFolder === undefined) throw new StopIteration();
    const level2 = rootFolder.folders[0].folders[0];
    raises(ValueError, () => {
      rootFolder.parentFolder = level2;
    }, "cannot be moved inside itself");
  });

  test("test_move_root_raises", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const empty = root.folders.find((f) => f.name === "EmptyFolder");
    if (empty === undefined) throw new StopIteration();
    raises(ValueError, () => {
      root.parentFolder = empty;
    }, "Cannot move the root folder");
  });

  test("test_non_folder_target_raises", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const fwi = root.folders.find((f) => f.name === "FolderWithItems");
    if (fwi === undefined) throw new StopIteration();
    const comp1 = fwi.items.find((i) => i.name === "Comp1");
    if (comp1 === undefined) throw new StopIteration();
    raises(TypeError_, () => {
      // @ts-expect-error deliberately assigns an item id instead of a FolderItem
      comp1.parentFolder = comp1.id;
    }, "must be a FolderItem");
  });

  /** An item's open-panel viewer moves with it between folders. */
  test("test_move_relocates_viewer", () => {
    const app = parseAep(SAMPLES_DIR.div("composition", "selection_both_layers.aep"));
    const root = app.project.rootFolder;
    const comp = root.compositions.find((c) => c._viewer != null && contains(root.items, c));
    if (comp === undefined) throw new StopIteration();
    const viewer = comp._viewer;
    expect(contains(root._viewers, viewer)).toBe(true);

    const folder = root.addFolder("Bin");
    comp.parentFolder = folder;
    expect(contains(root._viewers, viewer)).toBe(false);
    expect(contains(folder._viewers, viewer)).toBe(true);
  });
});

/** Tests for Project.importPlaceholder(). */
describe("TestImportPlaceholder", () => {
  test("test_import_placeholder_returns_footage", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder("PH", 1920, 1080, 30.0, 10.0);
    expect(item instanceof FootageItem).toBe(true);
  });

  test("test_import_placeholder_name", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder("MyPlaceholder", 1920, 1080, 30.0, 10.0);
    expect(item.name).toBe("MyPlaceholder");
  });

  test("test_import_placeholder_dimensions", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder("PH", 3840, 2160, 24.0, 5.0);
    expect(item.width).toBe(3840);
    expect(item.height).toBe(2160);
  });

  test("test_import_placeholder_frame_rate", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder("PH", 1920, 1080, 29.97, 10.0);
    expect(Math.abs(item.frameRate - 29.97) < 0.01).toBe(true);
  });

  test("test_import_placeholder_duration", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder("PH", 1920, 1080, 30.0, 7.5);
    expect(Math.abs(item.duration - 7.5) < 0.01).toBe(true);
  });

  test("test_import_placeholder_is_placeholder", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder("PH", 1920, 1080, 30.0, 10.0);
    expect(item.mainSource instanceof PlaceholderSource).toBe(true);
    expect(item.assetType).toBe("placeholder");
  });

  test("test_import_placeholder_unique_id", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const existingIds = new Set(app.project.items.keys());
    const item = app.project.importPlaceholder("PH", 1920, 1080, 30.0, 10.0);
    expect(existingIds.has(item.id)).toBe(false);
  });

  test("test_import_placeholder_in_root_folder", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder("PH", 1920, 1080, 30.0, 10.0);
    expect(item.parentFolder === app.project.rootFolder).toBe(true);
    expect(contains(app.project.rootFolder.items, item)).toBe(true);
  });

  test("test_import_placeholder_registered_in_project", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder("PH", 1920, 1080, 30.0, 10.0);
    expect(getitem(app.project.items, item.id) === item).toBe(true);
    expect(contains(app.project.footages, item)).toBe(true);
  });

  test("test_import_placeholder_invalid_width", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    raises(ValueError, () => app.project.importPlaceholder("PH", 2, 1080, 30.0, 10.0), "must be >= 4");
  });

  test("test_import_placeholder_invalid_height", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    raises(ValueError, () => app.project.importPlaceholder("PH", 1920, 0, 30.0, 10.0), "must be >= 4");
  });

  test("test_import_placeholder_invalid_frame_rate", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    raises(ValueError, () => app.project.importPlaceholder("PH", 1920, 1080, 0.5, 10.0), "must be >= 1");
  });

  test("test_import_placeholder_invalid_duration", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    // A zero duration has no frames; validate_duration rejects it (its
    // minimum is one frame at the maximum 99 fps).
    raises(ValueError, () => app.project.importPlaceholder("PH", 1920, 1080, 30.0, 0.0), "must be >=");
  });

  test("test_import_placeholder_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder("RTPH", 1280, 720, 25.0, 8.0);
    const itemId = item.id;

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));

    expect(app2.project.items.has(itemId)).toBe(true);
    const item2 = asInstance(getitem(app2.project.items, itemId), FootageItem);
    expect(item2.name).toBe("RTPH");
    expect(item2.width).toBe(1280);
    expect(item2.height).toBe(720);
    expect(Math.abs(item2.duration - 8.0) < 0.01).toBe(true);
  });
});

/** Tests for FootageItem.replaceWithPlaceholder(). */
describe("TestReplaceWithPlaceholder", () => {
  test("test_replace_with_placeholder", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.replaceWithPlaceholder("NewPH", 1920, 1080, 30.0, 10.0);
    expect(footage.mainSource instanceof PlaceholderSource).toBe(true);
    expect(footage.name).toBe("NewPH");
    expect(footage.width).toBe(1920);
    expect(footage.height).toBe(1080);
  });

  test("test_replace_with_placeholder_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    const footageId = footage.id;
    footage.replaceWithPlaceholder("RtPH", 1280, 720, 24.0, 5.0);

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    const item2 = asInstance(getitem(app2.project.items, footageId), FootageItem);
    expect(item2.name).toBe("RtPH");
    expect(item2.width).toBe(1280);
    expect(item2.height).toBe(720);
    expect(item2.assetType).toBe("placeholder");
  });
});

/** Tests for FootageItem.replaceWithSolid(). */
describe("TestReplaceWithSolid", () => {
  test("test_replace_with_solid", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "placeholder.aep"));
    const footage = app.project.footages[0];
    footage.replaceWithSolid([1.0, 0.0, 0.0], "RedSolid", 1920, 1080, 1.0);
    expect(footage.mainSource instanceof SolidSource).toBe(true);
    expect(footage.name).toBe("RedSolid");
    expect(footage.width).toBe(1920);
    expect(footage.height).toBe(1080);
  });

  test("test_replace_with_solid_color", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "placeholder.aep"));
    const footage = app.project.footages[0];
    footage.replaceWithSolid([0.5, 0.25, 0.75], "ColorSolid", 1920, 1080, 1.0);
    const color = asInstance(footage.mainSource, SolidSource).color;
    expect(Math.abs(color[0] - 0.5) < 0.01).toBe(true);
    expect(Math.abs(color[1] - 0.25) < 0.01).toBe(true);
    expect(Math.abs(color[2] - 0.75) < 0.01).toBe(true);
  });

  test("test_replace_with_solid_invalid_color", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "placeholder.aep"));
    const footage = app.project.footages[0];
    raises(ValueError, () => footage.replaceWithSolid([1.5, 0.0, 0.0], "Bad", 1920, 1080, 1.0), "must be <= 1");
  });

  test("test_replace_with_solid_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("footage", "placeholder.aep"));
    const footage = app.project.footages[0];
    const footageId = footage.id;
    footage.replaceWithSolid([0.0, 1.0, 0.0], "GreenSolid", 960, 540, 1.0);

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    const item2 = asInstance(getitem(app2.project.items, footageId), FootageItem);
    expect(item2.name).toBe("GreenSolid");
    expect(item2.width).toBe(960);
    expect(item2.height).toBe(540);
    expect(item2.assetType).toBe("solid");
  });
});

/** Tests for AVItem.setProxyToNone(). */
describe("TestSetProxyToNone", () => {
  test("test_set_proxy_to_none_removes_proxy", () => {
    const app = parseAep(SAMPLES_DIR.div("item", "proxy.aep"));
    // Find an item that has a proxy
    const footage = app.project.footages.find((f) => f.proxySource != null) ?? null;
    if (footage == null) return skip("No item with proxy found in sample");
    footage.setProxyToNone();
    expect(footage.proxySource == null).toBe(true);
  });

  /** Calling set_proxy_to_none when there's no proxy is a no-op. */
  test("test_set_proxy_to_none_noop", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    // Import a placeholder (which has no proxy)
    const item = app.project.importPlaceholder("PH", 1920, 1080, 30.0, 10.0);
    item.setProxyToNone();
    expect(item.proxySource == null).toBe(true);
  });

  test("test_set_proxy_to_none_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("item", "proxy.aep"));
    const footage = app.project.footages.find((f) => f.proxySource != null) ?? null;
    if (footage == null) return skip("No item with proxy found in sample");
    const footageId = footage.id;
    footage.setProxyToNone();

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    const item2 = asInstance(getitem(app2.project.items, footageId), FootageItem);
    expect(item2.proxySource == null).toBe(true);
  });
});

/** Tests for AVItem.setProxyWithPlaceholder(). */
describe("TestSetProxyWithPlaceholder", () => {
  test("test_set_proxy_with_placeholder", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.setProxyWithPlaceholder("ProxyPH", 960, 540, 30.0, 10.0);
    expect(footage.proxySource instanceof PlaceholderSource).toBe(true);
  });

  test("test_set_proxy_with_placeholder_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    const footageId = footage.id;
    footage.setProxyWithPlaceholder("ProxyPH", 960, 540, 30.0, 10.0);

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    const item2 = asInstance(getitem(app2.project.items, footageId), FootageItem);
    expect(item2.proxySource != null).toBe(true);
  });

  test("test_set_proxy_replaces_existing", () => {
    const app = parseAep(SAMPLES_DIR.div("item", "proxy.aep"));
    const footage = app.project.footages.find((f) => f.proxySource != null) ?? null;
    if (footage == null) return skip("No item with proxy found in sample");
    footage.setProxyWithPlaceholder("NewProxy", 640, 480, 25.0, 5.0);
    expect(footage.proxySource instanceof PlaceholderSource).toBe(true);
  });
});

/** Tests for AVItem.setProxyWithSolid(). */
describe("TestSetProxyWithSolid", () => {
  test("test_set_proxy_with_solid", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.setProxyWithSolid([1.0, 0.0, 0.0], "RedProxy", 960, 540, 1.0);
    expect(footage.proxySource instanceof SolidSource).toBe(true);
  });

  test("test_set_proxy_with_solid_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    const footageId = footage.id;
    footage.setProxyWithSolid([0.0, 0.0, 1.0], "BlueProxy", 960, 540, 1.0);

    app.project.save(tmpPath.div("out.aep"));
    const app2 = parseAep(tmpPath.div("out.aep"));
    const item2 = asInstance(getitem(app2.project.items, footageId), FootageItem);
    expect(item2.proxySource != null).toBe(true);
  });

  test("test_set_proxy_then_remove", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.setProxyWithSolid([1.0, 1.0, 0.0], "YProxy", 640, 480, 1.0);
    expect(footage.proxySource != null).toBe(true);
    footage.setProxyToNone();
    expect(footage.proxySource == null).toBe(true);
  });
});

/** Tests for add_folder with None name. */
describe("TestAutoNameFolder", () => {
  test("test_none_generates_untitled", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const folder = root.addFolder(null);
    expect(folder.name.startsWith("Untitled ")).toBe(true);
  });

  test("test_none_increments", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const f1 = root.addFolder(null);
    const f2 = root.addFolder(null);
    expect(f1.name !== f2.name).toBe(true);
  });

  test("test_none_default_arg", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const folder = root.addFolder();
    expect(folder.name.startsWith("Untitled ")).toBe(true);
  });

  test("test_empty_string_allowed", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const folder = root.addFolder("");
    expect(folder.name).toBe("");
  });
});

/** Tests for add_comp with None name. */
describe("TestAutoNameComp", () => {
  test("test_none_generates_comp", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp(null, 1920, 1080, 1.0, 10.0, 24.0);
    expect(comp.name.startsWith("Comp ")).toBe(true);
  });

  test("test_empty_string_allowed", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const root = app.project.rootFolder;
    const comp = root.addComp("", 1920, 1080, 1.0, 10.0, 24.0);
    expect(comp.name).toBe("");
  });
});

/** Tests for import_placeholder with None/empty name. */
describe("TestAutoNamePlaceholder", () => {
  test("test_none_becomes_missing_name", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder(null, 1920, 1080, 24.0, 10.0);
    expect(item.name).toBe("Missing Name");
  });

  test("test_empty_becomes_placeholder", () => {
    const app = parseAep(SAMPLES_DIR.div("folder", "folder.aep"));
    const item = app.project.importPlaceholder("", 1920, 1080, 24.0, 10.0);
    expect(item.name).toBe("Placeholder");
  });
});

/** Tests for replace_with_solid with None/empty name. */
describe("TestAutoNameSolid", () => {
  test("test_none_auto_names_from_color", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.replaceWithSolid([1.0, 0.0, 0.0], null, 1920, 1080);
    expect(footage.name.includes("Red Solid")).toBe(true);
  });

  test("test_empty_becomes_question_marks", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.replaceWithSolid([1.0, 0.0, 0.0], "", 1920, 1080);
    expect(footage.name).toBe("????");
  });

  test("test_replace_with_placeholder_none", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.replaceWithPlaceholder(null, 1920, 1080, 24.0, 10.0);
    expect(footage.name).toBe("Missing Name");
  });

  test("test_replace_with_placeholder_empty", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.replaceWithPlaceholder("", 1920, 1080, 24.0, 10.0);
    expect(footage.name).toBe("Placeholder");
  });
});

/** Tests for proxy methods with None/empty name. */
describe("TestAutoNameProxy", () => {
  test("test_proxy_placeholder_none", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.setProxyWithPlaceholder(null, 1920, 1080, 24.0, 10.0);
    expect(footage.proxySource != null).toBe(true);
  });

  test("test_proxy_placeholder_empty", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.setProxyWithPlaceholder("", 1920, 1080, 24.0, 10.0);
    expect(footage.proxySource != null).toBe(true);
  });

  test("test_proxy_solid_none", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.setProxyWithSolid([0.0, 1.0, 0.0], null, 960, 540);
    expect(footage.proxySource != null).toBe(true);
  });

  test("test_proxy_solid_empty", () => {
    const app = parseAep(SAMPLES_DIR.div("footage", "solid_colors.aep"));
    const footage = app.project.footages[0];
    footage.setProxyWithSolid([0.0, 1.0, 0.0], "", 960, 540);
    expect(footage.proxySource != null).toBe(true);
  });
});
