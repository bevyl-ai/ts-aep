import { ListChunk, type Chunk } from "../../binary/chunk.ts";
import { IdtaChunk, type CmtaChunk } from "../../binary/item_chunks.ts";
import { SfdtChunk } from "../../binary/misc_chunks.ts";
import { buildItemIdChunks } from "../../binary/mutations.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { autoName } from "../naming.ts";
import { labelIndex } from "../preferences.ts";
import { validateName, validateString } from "../validators.ts";
import { FootageItem } from "./footage.ts";
import { Item } from "./item.ts";
import type { Project } from "../project.ts";
import type { Viewer } from "../viewer/viewer.ts";
import { ValueError, StopIteration, compare, repr, sorted } from "../../../pyrt/index.ts";
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
  static _autoName: string = "Untitled";

  /**
   * The items in this folder. Contains only the top-level items in the folder.
   * Read-only.
   */
  declare items: Item[];
  declare _childrenContainer: Chunk[];
  declare _viewers: Viewer[];

  constructor(kw: {
    _idta: IdtaChunk | null;
    _nameUtf8: Utf8Chunk | null;
    _cmta: CmtaChunk | null;
    _itemList: ListChunk;
    _gide: ListChunk | null;
    _childrenContainer: Chunk[];
    project: Project;
    parentFolder: FolderItem | null;
  }) {
    const { _idta, _nameUtf8, _cmta, _itemList, _gide, _childrenContainer, project, parentFolder } = kw;
    super({
      _idta,
      _nameUtf8,
      _cmta,
      _itemList,
      _gide,
      project,
      parentFolder,
      typeName: "Folder",
    });
    this.items = [];
    this._childrenContainer = _childrenContainer;
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
    if (this._parentFolder == null) {
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
   * - `parentFolder`: The folder that will contain this folder.
   */
  static _new(
    name: string,
    kw: { project: Project; parentFolder: FolderItem },
  ): FolderItem {
    const { project, parentFolder } = kw;
    validateString(name);
    const newId = project._allocateId();

    // AE labels new folders with the "Folder Label Index 2" preference
    // (factory 2, probed in AE 2026).
    const idta = new IdtaChunk({
      itemType: 1,
      itemId: newId,
      label: labelIndex(project._preferences, "Folder Label Index 2", 2),
    });
    const nameUtf8 = new Utf8Chunk({ value: name });
    const sfdt = new SfdtChunk({});
    const sfdr = new ListChunk({ listType: "Sfdr" });

    const itemList = new ListChunk({
      listType: "Item",
      chunks: [
        ...buildItemIdChunks(newId, project._head.aeVersionMajor),
        idta,
        nameUtf8,
        sfdt,
        sfdr,
      ],
    });

    const folder = new this({
      _idta: idta,
      _nameUtf8: nameUtf8,
      _cmta: null,
      _itemList: itemList,
      _gide: null,
      _childrenContainer: sfdr.chunks,
      project,
      parentFolder,
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
      name = autoName(FolderItem._autoName, existing);
    }

    const folder = FolderItem._new(name, {
      project: this._project,
      parentFolder: this,
    });

    // Insert into parent container
    this._childrenContainer.push(folder._itemList);

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
   * @param pixelAspect - The pixel aspect ratio (1.0 for square pixels).
   * @param duration - The duration in seconds.
   * @param frameRate - The frame rate in frames per second.
   * @returns The newly created {@link CompItem}.
   */
  addComp(
    name: string | null,
    width: number,
    height: number,
    pixelAspect: number,
    duration: number,
    frameRate: number,
  ): CompItem {
    return this._addComp(name, width, height, pixelAspect, duration, frameRate);
  }

  /**
   * `addComp` with the smallest width / height to accept (see
   * `CompItem._new`).
   */
  _addComp(
    name: string | null,
    width: number,
    height: number,
    pixelAspect: number,
    duration: number,
    frameRate: number,
    kw: { minDimension?: number } = {},
  ): CompItem {
    const { minDimension = 4 } = kw;

    if (name == null) {
      const existing = new Set([...this._project.items.values()].map((item) => item.name));
      name = autoName(CompItem._autoName, existing);
    }

    const comp = CompItem._new(
      name,
      width,
      height,
      pixelAspect,
      duration,
      frameRate,
      {
        project: this._project,
        parentFolder: this,
        minDimension,
      },
    );

    // AE places a newly created/imported comp (its Item plus view-data
    // chunks) at the FRONT of the folder - right after the root folder's
    // `fdta` header, or at index 0 in a subfolder's Sfdr (verified in AE
    // 2026 for both script addComp and SVG import). Match that ordering.
    const block = [comp._itemList, ...comp._viewData];
    const container = this._childrenContainer;
    const insertAt = container?.length > 0 && container[0].chunkType === "fdta" ? 1 : 0;
    container.splice(insertAt, 0, ...block);

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
    validateName(preset);
    const presets = this._project._preferences.compositionPresets();
    if (!presets?.length) {
      throw new ValueError(
        "no composition presets available; pass 'aePreferencesDir' " +
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
   * layered-import path; it does not affect `addComp`/`addFolder`.
   */
  _sortChildrenByName(): void {
    const [header, blocks] = this._childChunkBlocks();
    blocks.splice(0, blocks.length, ...sorted(blocks, (b) => b[0].name.toLowerCase()));
    this._childrenContainer.splice(
      0,
      this._childrenContainer.length,
      ...header,
      ...blocks.flatMap(([, chunks]) => chunks),
    );
    this.items.splice(0, this.items.length, ...sorted(this.items, (item) => item.name.toLowerCase()));
  }

  /**
   * Partition `_childrenContainer` into a leading header and one
   * chunk block per child item (the item's chunk list plus any
   * trailing non-item chunks, e.g. view data).
   */
  _childChunkBlocks(): [Chunk[], [Item, Chunk[]][]] {
    // Keyed by object identity, as Python's `id()` was.
    const byItemList = new Map<Chunk, Item>(
      this.items.map((item): [Chunk, Item] => [item._itemList, item]),
    );
    const header: Chunk[] = [];
    const blocks: [Item, Chunk[]][] = [];
    for (const chunk of this._childrenContainer) {
      const item = byItemList.get(chunk) ?? null;
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
   * `_sortChildrenByName` this moves only `item`, leaving the
   * other children's stored order untouched.
   */
  _repositionChildSorted(item: Item): void {
    const [header, blocks] = this._childChunkBlocks();
    const moved = blocks.find((b) => b[0] === item);
    // Python's `next()` without a default raises StopIteration on a miss.
    if (moved == null) {
      throw new StopIteration();
    }
    blocks.splice(blocks.indexOf(moved), 1);
    const key = item.name.toLowerCase();
    let pos = blocks.findIndex((b) => compare(b[0].name.toLowerCase(), key) > 0);
    if (pos === -1) {
      pos = blocks.length;
    }
    blocks.splice(pos, 0, moved);
    this._childrenContainer.splice(
      0,
      this._childrenContainer.length,
      ...header,
      ...blocks.flatMap(([, chunks]) => chunks),
    );
    this.items.splice(0, this.items.length, ...blocks.map((b) => b[0]));
  }
}
