import { requires_version } from "../../ae_version.ts";
import type { Chunk, ListChunk } from "../../binary/chunk.ts";
import { CmtaChunk, type IdtaChunk } from "../../binary/item_chunks.ts";
import { LHD3_BLOCK_GUIDES, LdatChunk, LdatItemType, type Lhd3Chunk, set_lhd3_count } from "../../binary/ldat_chunks.ts";
import { build_gide_list } from "../../binary/mutations.ts";
import type { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { block_slice, find_by_list_type, find_by_type, find_by_type_or_null, index_by_identity } from "../../binary/utils.ts";
import { Label } from "../../enums/index.ts";
import {
  IndexError,
  TypeError_,
  ValueError,
  deferred,
  descriptor,
  dict_pop,
  format,
  getattr,
  py_assert,
  py_eq,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import { ChunkField } from "../descriptors.ts";
import { Guide } from "../guide.ts";
import { validate_name, validate_string } from "../validators.ts";
import type { Project } from "../project.ts";
import type { FolderItem } from "./folder.ts";

const _folder = deferred<typeof import("./folder.ts")>("py_aep/models/items/folder");

// NOTE(port): list.remove shim; Python compares with `==` (Item.__eq__ is by
// id), so the match uses py_eq (which dispatches to __eq__) rather than identity.
export function list_remove<T>(xs: T[], x: T): void {
  const i = xs.findIndex((y) => py_eq(y, x));
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
  declare _name_utf8: Utf8Chunk | null;
  declare _cmta: CmtaChunk | null;
  declare _item_list: ListChunk;
  declare _gide: ListChunk | null;
  declare _project: Project;
  declare _parent_folder: FolderItem | null;
  declare _type_name: string;
  declare _guides: Guide[];
  declare _inner: ListChunk | null;
  declare _lhd3: Lhd3Chunk | null;
  declare _ldat: LdatChunk | null;

  constructor(kw: {
    _idta: IdtaChunk | null;
    _name_utf8: Utf8Chunk | null;
    _cmta: CmtaChunk | null;
    _item_list: ListChunk;
    _gide?: ListChunk | null;
    project: Project;
    parent_folder: FolderItem | null;
    type_name: string;
  }) {
    const { _idta, _name_utf8, _cmta, _item_list, _gide = null, project, parent_folder, type_name } = kw;
    this._idta = _idta;
    this._name_utf8 = _name_utf8;
    this._cmta = _cmta;
    this._item_list = _item_list;
    this._gide = _gide;
    this._project = project;
    this._parent_folder = parent_folder;
    this._type_name = type_name;
    this._guides = [];

    if (this._gide == null) {
      this._inner = null;
      this._lhd3 = null;
      this._ldat = null;
    } else {
      this._inner = find_by_list_type(this._gide.chunks, "list");
      this._lhd3 = find_by_type(this._inner.chunks, "lhd3");
      this._ldat = find_by_type_or_null(this._inner.chunks, "ldat");
    }
  }

  /**
   * A unique and persistent identification number used for the
   * dynamic link, in form of `00000000-0000-0000-0000-000000000000`.
   * Read-only.
   */
  get dynamic_link_guid(): string {
    return `${format(this.id, "08x")}-0000-0000-0000-000000000000`;
  }

  /** The item comment. Read / Write. */
  get comment(): string {
    if (this._cmta == null) return "";
    return this._cmta.value;
  }

  set comment(value: string) {
    validate_string(value);
    if (this._cmta != null) {
      this._cmta.value = value;
    } else if (value) {
      const chunk = new CmtaChunk({});
      chunk.value = value;
      this._item_list.chunks.push(chunk);
      this._cmta = chunk;
    }
  }

  // Python `__eq__` returns NotImplemented for a non-Item; the reflected
  // comparison then falls back to identity, which is False here.
  __eq__(other: unknown): boolean {
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
  get parent_folder(): FolderItem | null {
    return this._parent_folder;
  }

  set parent_folder(value: FolderItem | null) {
    const old_parent = this._parent_folder;
    if (old_parent == null) throw new ValueError("Cannot move the root folder");
    if (!(value instanceof _folder().FolderItem)) throw new TypeError_("parent_folder must be a FolderItem");
    if (value === old_parent) return;
    // A folder cannot become its own descendant. Walking up from the
    // target also covers value is self and value under the root.
    for (let ancestor: Item | null = value; ancestor != null; ancestor = ancestor._parent_folder) {
      if (ancestor === this) throw new ValueError("a folder cannot be moved inside itself");
    }

    const block = this._remove_from_parent_chunks();
    value._children_container.push(...block);

    list_remove(old_parent.items, this);
    value.items.push(this);

    // Relocate the item's open-panel viewer (AVItem only).
    const viewer = getattr(this, "_viewer", null);
    if (viewer != null) {
      list_remove(old_parent._viewers, viewer);
      value._viewers.push(viewer);
    }

    this._parent_folder = value;
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
  get type_name(): string {
    return this._type_name;
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
   * Any `orientation_type` value other than 0 (horizontal) or 1 (vertical)
   * defaults to horizontal.
   *
   * @param orientation_type - 0 for horizontal, 1 for vertical.
   * @param position - The pixel position of the guide. May be negative or fractional - guides sit
   *   anywhere on the ruler, inside the composition bounds or outside them.
   * @returns The index of the new guide.
   */
  add_guide(orientation_type: number, position: number): number {
    this._ensure_guides_container();
    py_assert(this._lhd3 != null);
    py_assert(this._ldat != null);
    const guide = Guide._new(orientation_type, position);
    this._guides.push(guide);
    this._ldat.items.push(guide._guide_item);
    set_lhd3_count(this._lhd3, this._ldat.items.length, LHD3_BLOCK_GUIDES);
    return this._lhd3.count - 1;
  }

  /**
   * Removes an existing guide by index.
   *
   * @param guide_index - The 0-based index of the guide to remove.
   * @throws {@link IndexError} If `guide_index` is out of range.
   */
  remove_guide(guide_index: number): void {
    if (this._guides.length === 0) throw new IndexError("No guides to remove");
    if (!(0 <= guide_index && guide_index < this._guides.length)) {
      throw new IndexError(
        `Guide index ${guide_index} out of range [0, ${this._guides.length - 1}]`,
      );
    }
    py_assert(this._lhd3 != null);
    py_assert(this._ldat != null);
    this._ldat.items.splice(guide_index, 1);
    this._guides.splice(guide_index, 1);
    set_lhd3_count(this._lhd3, this._ldat.items.length, LHD3_BLOCK_GUIDES);
    if (this._lhd3.count === 0) this._empty_guides_container();
  }

  /**
   * Remove all guides from the item.
   *
   * Equivalent to calling `remove_guide` for each guide. A no-op
   * when the item has no guides.
   */
  remove_all_guides(): void {
    while (this._guides.length > 0) {
      this.remove_guide(this._guides.length - 1);
    }
  }

  /** Create the guides container if needed. */
  _ensure_guides_container(): void {
    if (this._ldat != null) return;
    this._ldat = new LdatChunk({
      items: [],
      item_type: LdatItemType.gide,
      item_size: 16,
    });
    if (this._lhd3 == null) {
      [this._gide, this._lhd3, this._inner] = build_gide_list();
      this._inner.chunks.push(this._ldat);
      this._item_list.chunks.push(this._gide);
    } else {
      py_assert(this._inner != null);
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
  _empty_guides_container(): void {
    if (this._gide == null) return;
    if (this._ldat != null && this._inner != null) {
      this._inner.chunks.splice(index_by_identity(this._inner.chunks, this._ldat), 1);
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
    this._remove_from_parent_chunks();

    // Remove from model collections
    py_assert(this._parent_folder != null);
    list_remove(this._parent_folder.items, this);
    dict_pop(this._project.items, this.id);
    this._project._clear_active_item(this);
  }

  /** list_types that mark the start of the next item block. */
  static _ITEM_BOUNDARY_LIST_TYPES: ReadonlySet<string> = new Set(["Item"]);

  /**
   * Detach this item's LIST:Item and trailing view-data chunks.
   *
   * Returns the removed block so callers can relocate it (e.g. the
   * `parent_folder` setter); `remove()` discards it.
   */
  _remove_from_parent_chunks(): Chunk[] {
    const parent = this._parent_folder;
    py_assert(parent != null);
    const container = parent._children_container;
    const [start, end] = block_slice(
      container,
      this._item_list,
      this.constructor._ITEM_BOUNDARY_LIST_TYPES,
    );
    const block = container.slice(start, end);
    container.splice(start, end - start);
    return block;
  }
}

// Descriptors assigned in the class body (`label = ChunkField.enum(...)`) are
// installed on the prototype after the class is defined.
descriptor(
  Item,
  "label",
  ChunkField.enum(Label, "_idta", "label", { default: Label.NONE }),
);
descriptor(Item, "id", new ChunkField("_idta", "item_id", { read_only: true, default: 0 }));
descriptor(Item, "name", new ChunkField("_name_utf8", "value", { validate: validate_name }));

// `@requires_version(16)` on add_guide, remove_guide and remove_all_guides:
// Python applies these decorators while the class body runs; here they wrap
// the finished class.
Item.prototype.add_guide = requires_version(16)(Item.prototype.add_guide);
Item.prototype.remove_guide = requires_version(16)(Item.prototype.remove_guide);
Item.prototype.remove_all_guides = requires_version(16)(Item.prototype.remove_all_guides);
