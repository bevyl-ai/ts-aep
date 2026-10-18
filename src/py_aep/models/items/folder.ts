import { ListChunk, type Chunk } from "../../binary/chunk.ts";
import { IdtaChunk, type CmtaChunk } from "../../binary/item_chunks.ts";
import { SfdtChunk } from "../../binary/misc_chunks.ts";
import { build_item_id_chunks } from "../../binary/mutations.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { auto_name } from "../naming.ts";
import { label_index } from "../preferences.ts";
import { validate_name, validate_string } from "../validators.ts";
import { FootageItem } from "./footage.ts";
import { Item } from "./item.ts";
import type { Project } from "../project.ts";
import type { Viewer } from "../viewer/viewer.ts";
import { ValueError, StopIteration, py_cmp, repr, sorted } from "../../../pyrt/index.ts";
import { CompItem } from "./composition.ts";

/**
 * The `FolderItem` object corresponds to a folder in your Project panel. It
 * can contain various types of items (footage, compositions, solids) as well
 * as other folders.
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const root = app.project.rootFolder;
 * console.log(root.name);
 * for (const item of root) {
 *   // ...
 * }
 * ```
 * @see https://ae-scripting.docsforadobe.dev/item/folderitem/
 */
export class FolderItem extends Item {
  static _auto_name: string = "Untitled";

  /**
   * The items in this folder. Contains only the top-level items in the folder.
   * Read-only.
   */
  declare items: Item[];
  declare _children_container: Chunk[];
  declare _viewers: Viewer[];

  constructor(kw: {
    _idta: IdtaChunk | null;
    _name_utf8: Utf8Chunk | null;
    _cmta: CmtaChunk | null;
    _item_list: ListChunk;
    _gide: ListChunk | null;
    _children_container: Chunk[];
    project: Project;
    parent_folder: FolderItem | null;
  }) {
    const { _idta, _name_utf8, _cmta, _item_list, _gide, _children_container, project, parent_folder } = kw;
    super({
      _idta,
      _name_utf8,
      _cmta,
      _item_list,
      _gide,
      project,
      parent_folder,
      type_name: "Folder",
    });
    this.items = [];
    this._children_container = _children_container;
    this._viewers = [];
  }

  /**
   * Return an iterator over the folder items.
   *
   * Iterates a snapshot so items can be removed while looping.
   */
  [Symbol.iterator](): Iterator<Item> {
    return [...this.items][Symbol.iterator]();
  }

  /** All the compositions in the project. */
  get compositions(): CompItem[] {
    return this.items.filter((item) => item instanceof CompItem);
  }

  /** All the folders in the project. */
  get folders(): FolderItem[] {
    return this.items.filter((item) => item instanceof FolderItem);
  }

  /** All the footages in the project. */
  get footages(): FootageItem[] {
    return this.items.filter((item) => item instanceof FootageItem);
  }

  /** Remove this folder and all its children from the project. */
  remove(): void {
    if (this._parent_folder == null) {
      throw new ValueError("Cannot remove the root folder");
    }
    for (const child of [...this.items]) {
      child.remove();
    }
    super.remove();
  }

  /**
   * Create a new empty folder with backing chunks.
   *
   * @param name - The name of the new folder.
   * @param kw - Options:
   * - `project`: The project that owns this folder.
   * - `parent_folder`: The folder that will contain this folder.
   */
  static _new(
    name: string,
    kw: { project: Project; parent_folder: FolderItem },
  ): FolderItem {
    const { project, parent_folder } = kw;
    validate_string(name);
    const new_id = project._allocate_id();

    // AE labels new folders with the "Folder Label Index 2" preference
    // (factory 2, probed in AE 2026).
    const idta = new IdtaChunk({
      item_type: 1,
      item_id: new_id,
      label: label_index(project._preferences, "Folder Label Index 2", 2),
    });
    const name_utf8 = new Utf8Chunk({ value: name });
    const sfdt = new SfdtChunk({});
    const sfdr = new ListChunk({ list_type: "Sfdr" });

    const item_list = new ListChunk({
      list_type: "Item",
      chunks: [
        ...build_item_id_chunks(new_id, project._head.ae_version_major),
        idta,
        name_utf8,
        sfdt,
        sfdr,
      ],
    });

    const folder = new this({
      _idta: idta,
      _name_utf8: name_utf8,
      _cmta: null,
      _item_list: item_list,
      _gide: null,
      _children_container: sfdr.chunks,
      project,
      parent_folder,
    });
    return folder;
  }

  /**
   * Return the number of items in the folder.
   *
   * **Note:** Equivalent to `len(folder.items)`
   */
  get numItems(): number {
    return this.items.length;
  }

  /**
   * Create a new folder inside this folder.
   *
   * @param name - The name of the new folder. Pass `null` to auto-generate a name (`Untitled 1`,
   *   `Untitled 2`, ...). An empty string is allowed.
   * @returns The newly created {@link FolderItem}.
   */
  addFolder(name: string | null = null): FolderItem {
    if (name == null) {
      const existing = new Set([...this._project.items.values()].map((item) => item.name));
      name = auto_name(FolderItem._auto_name, existing);
    }

    const folder = FolderItem._new(name, {
      project: this._project,
      parent_folder: this,
    });

    // Insert into parent container
    this._children_container.push(folder._item_list);

    // Register in project and parent
    this._project.items.set(folder.id, folder);
    this.items.push(folder);
    return folder;
  }

  /**
   * Create a new composition inside this folder.
   *
   * @param name - The name of the new composition. Pass `null` to auto-generate a name (`Comp 1`,
   *   `Comp 2`, ...). An empty string is allowed.
   * @param width - The width of the composition in pixels.
   * @param height - The height of the composition in pixels.
   * @param pixel_aspect - The pixel aspect ratio (1.0 for square pixels).
   * @param duration - The duration in seconds.
   * @param frame_rate - The frame rate in frames per second.
   * @returns The newly created {@link CompItem}.
   */
  addComp(
    name: string | null,
    width: number,
    height: number,
    pixel_aspect: number,
    duration: number,
    frame_rate: number,
  ): CompItem {
    return this._add_comp(name, width, height, pixel_aspect, duration, frame_rate);
  }

  /**
   * `add_comp` with the smallest width / height to accept (see
   * `CompItem._new`).
   */
  _add_comp(
    name: string | null,
    width: number,
    height: number,
    pixel_aspect: number,
    duration: number,
    frame_rate: number,
    kw: { min_dimension?: number } = {},
  ): CompItem {
    const { min_dimension = 4 } = kw;

    if (name == null) {
      const existing = new Set([...this._project.items.values()].map((item) => item.name));
      name = auto_name(CompItem._auto_name, existing);
    }

    const comp = CompItem._new(
      name,
      width,
      height,
      pixel_aspect,
      duration,
      frame_rate,
      {
        project: this._project,
        parent_folder: this,
        min_dimension,
      },
    );

    // AE places a newly created/imported comp (its Item plus view-data
    // chunks) at the FRONT of the folder - right after the root folder's
    // `fdta` header, or at index 0 in a subfolder's Sfdr (verified in AE
    // 2026 for both script addComp and SVG import). Match that ordering.
    const block = [comp._item_list, ...comp._view_data];
    const container = this._children_container;
    const insert_at = container?.length > 0 && container[0].chunk_type === "fdta" ? 1 : 0;
    container.splice(insert_at, 0, ...block);

    // Register in project and parent
    this._project.items.set(comp.id, comp);
    this.items.unshift(comp);
    return comp;
  }

  /**
   * Create a new composition from a New Composition preset
   * (py_aep extension, not in ExtendScript).
   *
   * Width, height, pixel aspect and frame rate resolve from the named
   * preset in the AE preferences (see
   * {@link Preferences.compositionPresets});
   * presets carry no duration, so it must be given.
   *
   * @param name - The name of the new composition. Pass `null` to auto-generate a name (`Comp 1`,
   *   `Comp 2`, ...).
   * @param preset - Preset name; matched exactly first, then as a unique case-insensitive substring
   *   (full names contain bullet separators, e.g. `HD . 1920x1080 . 25 fps`, so a fragment like
   *   `"1920x1080 . 25"` works).
   * @param duration - The duration in seconds.
   * @returns The newly created {@link CompItem}.
   * @throws {@link ValueError} If no preferences directory was provided, or the preset name does
   *   not resolve to exactly one preset.
   */
  addCompFromPreset(
    name: string | null,
    preset: string,
    duration: number,
  ): CompItem {
    validate_name(preset);
    const presets = this._project._preferences.compositionPresets();
    if (!presets?.length) {
      throw new ValueError(
        "no composition presets available; pass 'ae_preferences_dir' " +
          "to parse()/new() to read them from the AE preferences",
      );
    }
    let matches = presets.filter((p) => p.name === preset);
    if (!matches?.length) {
      const needle = preset.toLowerCase();
      matches = presets.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (matches.length !== 1) {
      const available = presets.map((p) => repr(p.name)).join(", ");
      throw new ValueError(
        `preset ${repr(preset)} matched ${matches.length} presets; ` +
          `available: ${available}`,
      );
    }
    const found = matches[0];
    return this.addComp(
      name,
      found.width,
      found.height,
      found.pixelAspect,
      duration,
      found.frameRate,
    );
  }

  /**
   * Reorder this folder's items case-insensitive alphabetically by name.
   *
   * After Effects stores the `Sfdr` of an imported `<stem> Layers` folder
   * in the Project-panel alphabetical display order (verified against the
   * AE 2026 `grouped_layers`/`layer_bounds` fixtures, whose stored order
   * matches the alphabetical sort, not the document/creation order
   * py_aep builds the items in). This rebuilds both the model `items`
   * list and the backing `Sfdr` chunk blocks to match. Used only by the
   * layered-import path; it does not affect `add_comp`/`add_folder`.
   */
  _sort_children_by_name(): void {
    const [header, blocks] = this._child_chunk_blocks();
    blocks.splice(0, blocks.length, ...sorted(blocks, (b) => b[0].name.toLowerCase()));
    this._children_container.splice(
      0,
      this._children_container.length,
      ...header,
      ...blocks.flatMap(([, chunks]) => chunks),
    );
    this.items.splice(0, this.items.length, ...sorted(this.items, (item) => item.name.toLowerCase()));
  }

  /**
   * Partition `_children_container` into a leading header and one
   * chunk block per child item (the item's chunk list plus any
   * trailing non-item chunks, e.g. view data).
   */
  _child_chunk_blocks(): [Chunk[], [Item, Chunk[]][]] {
    // Keyed by object identity, as Python's `id()` was.
    const by_item_list = new Map<Chunk, Item>(
      this.items.map((item): [Chunk, Item] => [item._item_list, item]),
    );
    const header: Chunk[] = [];
    const blocks: [Item, Chunk[]][] = [];
    for (const chunk of this._children_container) {
      const item = by_item_list.get(chunk) ?? null;
      if (item != null) {
        blocks.push([item, [chunk]]);
      } else if (blocks.length > 0) {
        blocks[blocks.length - 1][1].push(chunk);
      } else {
        header.push(chunk);
      }
    }
    return [header, blocks];
  }

  /**
   * Move one child to its case-insensitive alphabetical position
   * among the current siblings.
   *
   * AE stores folder children in Project-panel display order and
   * inserts a precompose result comp at that position. Unlike
   * `_sort_children_by_name` this moves only `item`, leaving the
   * other children's stored order untouched.
   */
  _reposition_child_sorted(item: Item): void {
    const [header, blocks] = this._child_chunk_blocks();
    const moved = blocks.find((b) => b[0] === item);
    // Python's `next()` without a default raises StopIteration on a miss.
    if (moved == null) {
      throw new StopIteration();
    }
    blocks.splice(blocks.indexOf(moved), 1);
    const key = item.name.toLowerCase();
    let pos = blocks.findIndex((b) => py_cmp(b[0].name.toLowerCase(), key) > 0);
    if (pos === -1) {
      pos = blocks.length;
    }
    blocks.splice(pos, 0, moved);
    this._children_container.splice(
      0,
      this._children_container.length,
      ...header,
      ...blocks.flatMap(([, chunks]) => chunks),
    );
    this.items.splice(0, this.items.length, ...blocks.map((b) => b[0]));
  }
}
