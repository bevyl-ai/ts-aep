import { requiresVersion } from "../../ae_version.ts";
import type { Chunk, ListChunk } from "../../binary/chunk.ts";
import { CmtaChunk, type IdtaChunk } from "../../binary/item_chunks.ts";
import { LHD3_BLOCK_GUIDES, LdatChunk, LdatItemType, type Lhd3Chunk, setLhd3Count } from "../../binary/ldat_chunks.ts";
import { buildGideList } from "../../binary/mutations.ts";
import type { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { blockSlice, findByListType, findByType, findByTypeOrNull, indexByIdentity } from "../../binary/utils.ts";
import { Label } from "../../enums/index.ts";
import {
  IndexError,
  ValueError,
  descriptor,
  dictPop,
  assert,
  valueEquals,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import { ChunkField } from "../descriptors.ts";
import { Guide } from "../guide.ts";
import { validateName, validateString } from "../validators.ts";
import type { Project } from "../project.ts";
import type { FolderItem } from "./folder.ts";
import type { Viewer } from "../viewer/viewer.ts";
import { late } from "../late.ts";

// NOTE(port): a module-level import in Python; parsers/effect imports the item subclasses, which extend Item.

// NOTE(port): list.remove shim; Python compares with `==` (Item.__eq__ is by
// id), so the match uses py_eq (which dispatches to __eq__) rather than identity.
export function listRemove<T>(xs: T[], x: T): void {
  const i = xs.findIndex((y) => valueEquals(y, x));
  if (i < 0) throw new ValueError("list.remove(x): x not in list");
  xs.splice(i, 1);
}

/**
 * The `Item` object represents an item that can appear in the Project panel.
 *
 * Info:
 *     `Item` is the base class for {@link AVItem} object and for {@link FolderItem}
 *     object, which are in turn the base classes for various other item
 *     types, so `Item` attributes and methods are available when working with
 *     all of these item types.
 *
 * @see https://ae-scripting.docsforadobe.dev/item/item/
 */
// Annotation-only `name` (interface merge so FootageItem may override it with an accessor).
export interface Item {
  name: string;
}
export class Item {
  declare ["constructor"]: ClassAttributes<typeof Item>;
  /**
   * The label color. Colors are represented by their number (0 for None,
   * or 1 to 16 for one of the preset colors in the Labels preferences).
   * Read / Write.
   */
  declare label: Label;

  /** The item unique identifier. Read-only. */
  declare id: number;

  /**
   * The name of the item, as shown in the Project panel.
   * Read / Write.
   */

  declare _idta: IdtaChunk | null;
  declare _nameUtf8: Utf8Chunk | null;
  declare _cmta: CmtaChunk | null;
  declare _itemList: ListChunk;
  declare _gide: ListChunk | null;
  declare _project: Project;
  declare _parentFolder: FolderItem | null;
  declare _typeName: string;
  declare _guides: Guide[];
  declare _inner: ListChunk | null;
  declare _lhd3: Lhd3Chunk | null;
  declare _ldat: LdatChunk | null;

  constructor(kw: {
    _idta: IdtaChunk | null;
    _nameUtf8: Utf8Chunk | null;
    _cmta: CmtaChunk | null;
    _itemList: ListChunk;
    _gide?: ListChunk | null;
    project: Project;
    parentFolder: FolderItem | null;
    typeName: string;
  }) {
    const { _idta, _nameUtf8, _cmta, _itemList, _gide = null, project, parentFolder, typeName } = kw;
    this._idta = _idta;
    this._nameUtf8 = _nameUtf8;
    this._cmta = _cmta;
    this._itemList = _itemList;
    this._gide = _gide;
    this._project = project;
    this._parentFolder = parentFolder;
    this._typeName = typeName;
    this._guides = [];

    if (this._gide == null) {
      this._inner = null;
      this._lhd3 = null;
      this._ldat = null;
    } else {
      this._inner = findByListType(this._gide.chunks, "list");
      this._lhd3 = findByType(this._inner.chunks, "lhd3");
      this._ldat = findByTypeOrNull(this._inner.chunks, "ldat");
    }
  }

  /**
   * A unique and persistent identification number used for the
   * dynamic link, in form of `00000000-0000-0000-0000-000000000000`.
   * Read-only.
   */
  get dynamicLinkGuid(): string {
    return `${this.id.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`;
  }

  /** The item comment. Read / Write. */
  get comment(): string {
    if (this._cmta == null) return "";
    return this._cmta.value;
  }

  set comment(value: string) {
    validateString(value);
    if (this._cmta != null) {
      this._cmta.value = value;
    } else if (value) {
      const chunk = new CmtaChunk({});
      chunk.value = value;
      this._itemList.chunks.push(chunk);
      this._cmta = chunk;
    }
  }

  // Python `__eq__` returns NotImplemented for a non-Item; the reflected
  // comparison then falls back to identity, which is False here.
  equals(other: unknown): boolean {
    if (!(other instanceof Item)) return false;
    return this.id === other.id;
  }

  // NOTE(port): `__hash__` (hash(self.id)) is not carried over; py_aep never
  // uses an Item as a set member or dict key (dicts are keyed by int id).

  /**
   * The parent folder of this item. `null` for the root folder.
   * Read / Write.
   *
   * Setting this moves the item into another folder. The item's binary
   * chunk block is relocated from the old folder's container to the end
   * of the new folder's container, and both folders' `items` lists are
   * updated.
   *
   * @throws {@link ValueError} If this is the root folder, or if moving a folder into itself or one
   *   of its own descendants.
   * @throws {@link TypeError} If the value is not a {@link FolderItem}.
   */
  get parentFolder(): FolderItem | null {
    return this._parentFolder;
  }

  set parentFolder(value: FolderItem | null) {
    const oldParent = this._parentFolder;
    if (oldParent == null) throw new ValueError("Cannot move the root folder");
    if (!(value instanceof Item && value._isFolder())) throw new TypeError("parentFolder must be a FolderItem");
    if (value === oldParent) return;
    // A folder cannot become its own descendant. Walking up from the
    // target also covers value is self and value under the root.
    for (let ancestor: Item | null = value; ancestor != null; ancestor = ancestor._parentFolder) {
      if (ancestor === this) throw new ValueError("a folder cannot be moved inside itself");
    }

    const block = this._removeFromParentChunks();
    value._childrenContainer.push(...block);

    listRemove(oldParent.items, this);
    value.items.push(this);

    // Relocate the item's open-panel viewer (AVItem only).
    const viewer = "_viewer" in this ? (this._viewer as Viewer | null) : null;
    if (viewer != null) {
      listRemove(oldParent._viewers, viewer);
      value._viewers.push(viewer);
    }

    this._parentFolder = value;
  }

  /**
   * When `true`, this item is selected. Read-only.
   *
   * **Note:** Item selection is not stored in the `.aep` binary format; it is a
   * runtime-only state. Parsed projects always report `false`.
   */
  get selected(): boolean {
    return false;
  }

  /**
   * A user-readable name for the item type ("Folder", "Footage" or
   * "Composition"). These names are application locale-dependent, meaning
   * that they are different depending on the application's UI language.
   * Read-only.
   */
  get typeName(): string {
    return this._typeName;
  }

  /**
   * The item's ruler guides. Each guide has an orientation
   * and a pixel position. Read-only.
   */
  get guides(): Guide[] {
    return this._guides;
  }

  /**
   * Adds a new guide to the item.
   *
   * Any `orientationType` value other than 0 (horizontal) or 1 (vertical)
   * defaults to horizontal.
   *
   * @param orientationType - 0 for horizontal, 1 for vertical.
   * @param position - The pixel position of the guide. May be negative or fractional - guides sit
   *   anywhere on the ruler, inside the composition bounds or outside them.
   * @returns The index of the new guide.
   */
  addGuide(orientationType: number, position: number): number {
    this._ensureGuidesContainer();
    assert(this._lhd3 != null);
    assert(this._ldat != null);
    const guide = Guide._new(orientationType, position);
    this._guides.push(guide);
    this._ldat.items.push(guide._guideItem);
    setLhd3Count(this._lhd3, this._ldat.items.length, LHD3_BLOCK_GUIDES);
    return this._lhd3.count - 1;
  }

  /**
   * Removes an existing guide by index.
   *
   * @param guideIndex - The 0-based index of the guide to remove.
   * @throws {@link IndexError} If `guideIndex` is out of range.
   */
  removeGuide(guideIndex: number): void {
    if (this._guides.length === 0) throw new IndexError("No guides to remove");
    if (!(0 <= guideIndex && guideIndex < this._guides.length)) {
      throw new IndexError(
        `Guide index ${guideIndex} out of range [0, ${this._guides.length - 1}]`,
      );
    }
    assert(this._lhd3 != null);
    assert(this._ldat != null);
    this._ldat.items.splice(guideIndex, 1);
    this._guides.splice(guideIndex, 1);
    setLhd3Count(this._lhd3, this._ldat.items.length, LHD3_BLOCK_GUIDES);
    if (this._lhd3.count === 0) this._emptyGuidesContainer();
  }

  /**
   * Remove all guides from the item.
   *
   * Equivalent to calling `removeGuide` for each guide. A no-op
   * when the item has no guides.
   */
  removeAllGuides(): void {
    while (this._guides.length > 0) {
      this.removeGuide(this._guides.length - 1);
    }
  }

  /** Create the guides container if needed. */
  _ensureGuidesContainer(): void {
    if (this._ldat != null) return;
    this._ldat = new LdatChunk({
      items: [],
      itemType: LdatItemType.gide,
      itemSize: 16,
    });
    if (this._lhd3 == null) {
      [this._gide, this._lhd3, this._inner] = buildGideList();
      this._inner.chunks.push(this._ldat);
      this._itemList.chunks.push(this._gide);
    } else {
      assert(this._inner != null);
      this._inner.chunks.push(this._ldat);
    }
  }

  /**
   * Empty the guides container, keeping the (now childless) `LIST:Gide`.
   *
   * After Effects always writes a `LIST:Gide` for an item even with zero
   * guides (its `lhd3` has `count=0` and no `ldat` child); deleting the
   * container entirely leaves the project in a state AE opens but cannot
   * re-save. So we drop only the `ldat` and keep `gide`/`lhd3`/`inner`.
   */
  _emptyGuidesContainer(): void {
    if (this._gide == null) return;
    if (this._ldat != null && this._inner != null) {
      this._inner.chunks.splice(indexByIdentity(this._inner.chunks, this._ldat), 1);
    }
    this._ldat = null;
  }

  /**
   * Remove this item from the project.
   *
   * Subclasses add their own cleanup before calling `super().remove()`:
   *
   * - {@link FolderItem} removes children recursively.
   * - {@link AVItem} removes layers that reference this item as their source
   *   and cleans up viewer references.
   * - {@link CompItem} removes render-queue items targeting this composition.
   *
   * @throws {@link ValueError} If this is the root folder.
   */
  remove(): void {
    // Remove from parent folder's binary chunks
    const removed = this._removeFromParentChunks();
    late.rehomeEffectDefinitions(this._project, late._effectInstances(removed));

    // Remove from model collections
    assert(this._parentFolder != null);
    listRemove(this._parentFolder.items, this);
    dictPop(this._project.items, this.id);
    this._project._clearActiveItem(this);
  }

  /** list_types that mark the start of the next item block. */
  static _ITEM_BOUNDARY_LIST_TYPES: ReadonlySet<string> = new Set(["Item"]);

  /**
   * Detach this item's LIST:Item and trailing view-data chunks.
   *
   * Returns the removed block so callers can relocate it (e.g. the
   * `parentFolder` setter); `remove()` discards it.
   */
  _removeFromParentChunks(): Chunk[] {
    const parent = this._parentFolder;
    assert(parent != null);
    const container = parent._childrenContainer;
    const [start, end] = blockSlice(
      container,
      this._itemList,
      this.constructor._ITEM_BOUNDARY_LIST_TYPES,
    );
    const block = container.slice(start, end);
    container.splice(start, end - start);
    return block;
  }

  /** Whether this is a folder (`FolderItem` answers true). */
  _isFolder(): this is FolderItem {
    return false;
  }

  static {
    // Descriptors for the `declare`d fields above.
    descriptor(this, "label", ChunkField.enum(Label, "_idta", "label", { default: Label.NONE }));
    descriptor(this, "id", new ChunkField("_idta", "itemId", { readOnly: true, default: 0 }));
    descriptor(this, "name", new ChunkField("_nameUtf8", "value", { validate: validateName }));
  }
}

// `@requires_version(16)` on add_guide, remove_guide and remove_all_guides:
// Python applies these decorators while the class body runs; here they wrap
// the finished class.
Item.prototype.addGuide = requiresVersion(16)(Item.prototype.addGuide);
Item.prototype.removeGuide = requiresVersion(16)(Item.prototype.removeGuide);
Item.prototype.removeAllGuides = requiresVersion(16)(Item.prototype.removeAllGuides);
