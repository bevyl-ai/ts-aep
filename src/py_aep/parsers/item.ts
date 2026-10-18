import { ValueError } from "../../pyrt/index.ts";
import type { ListChunk } from "../binary/chunk.ts";
import type { CmtaChunk, IdtaChunk } from "../binary/item_chunks.ts";
import type { Utf8Chunk } from "../binary/scalar_chunks.ts";
import { filterByListType, findByListType, findByListTypeOrNull, findByType, findByTypeOrNull } from "../binary/utils.ts";
import { ItemType } from "../enums/index.ts";
import { Guide } from "../models/guide.ts";
import { FolderItem } from "../models/items/folder.ts";
import { parseComposition } from "./composition.ts";
import { parseFootage } from "./footage.ts";
import { parseViewers } from "./view.ts";
import type { Chunk } from "../binary/chunk.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { FootageItem } from "../models/items/footage.ts";
import type { Project } from "../models/project.ts";

/**
 * Parse an item (composition, footage or folder).
 *
 * @param itemChunk - The LIST chunk to parse.
 * @param project - The project.
 * @param parentFolder - The parent folder.
 */
export function parseItem(
  itemChunk: ListChunk,
  project: Project,
  parentFolder: FolderItem,
): CompItem | FolderItem | FootageItem {
  const childChunks = itemChunk.chunks;

  const idta = findByType(childChunks, "idta");
  const nameUtf8 = findByType(childChunks, "Utf8");
  const cmta = findByTypeOrNull(childChunks, "cmta");

  const gide = findByListTypeOrNull(itemChunk.chunks, "Gide");

  const itemType = idta.item_type;

  let item: FolderItem | FootageItem | CompItem;
  if (itemType === ItemType.FOLDER) {
    item = parseFolder(
      false,
      childChunks,
      project,
      idta,
      nameUtf8,
      cmta,
      itemChunk,
      gide,
      parentFolder,
    );
  } else if (itemType === ItemType.FOOTAGE) {
    item = parseFootage(
      childChunks,
      idta,
      nameUtf8,
      cmta,
      itemChunk,
      gide,
      project,
      parentFolder,
    );
  } else if (itemType === ItemType.COMPOSITION) {
    item = parseComposition(
      childChunks,
      idta,
      nameUtf8,
      cmta,
      itemChunk,
      gide,
      project,
      parentFolder,
      project._effectParamDefs,
    );
  } else {
    throw new ValueError(`Unknown item type: ${itemType}`);
  }

  item._guides = _parseGuides(childChunks);
  project.items.set(item.id, item);

  return item;
}

/**
 * Parse a folder item.
 *
 * @param isRoot - Whether the folder is the root folder (ID 0).
 * @param childChunks - child chunks of the folder LIST chunk.
 * @param project - The project.
 * @param _idta - The idta chunk (None for the root folder).
 * @param _nameUtf8 - The Utf8 chunk containing the folder name.
 * @param _cmta - The cmta chunk (None if no comment).
 * @param _itemList - The LIST chunk for creating new chunks.
 * @param _gide - The LIST chunk for guides (None if no guides).
 * @param parentFolder - The folder's parent folder.
 */
export function parseFolder(
  isRoot: boolean,
  childChunks: Chunk[],
  project: Project,
  _idta: IdtaChunk | null,
  _nameUtf8: Utf8Chunk | null,
  _cmta: CmtaChunk | null,
  _itemList: ListChunk,
  _gide: ListChunk | null,
  parentFolder: FolderItem | null,
): FolderItem {
  let folderChunks: Chunk[];
  let childrenContainer: Chunk[];
  if (isRoot) {
    folderChunks = childChunks;
    childrenContainer = _itemList.chunks;
  } else {
    const sfdrChunk = findByListType(childChunks, "Sfdr");
    folderChunks = sfdrChunk.chunks;
    childrenContainer = sfdrChunk.chunks;
  }

  const folder = new FolderItem({
    _idta,
    _nameUtf8: _nameUtf8,
    _cmta,
    _itemList: _itemList,
    _gide,
    _childrenContainer: childrenContainer,
    project,
    parentFolder: parentFolder,
  });
  if (isRoot) {
    // Avoid mutating chunk fields
    // Python writes folder.__dict__["name"] to bypass the property; defining an own
    // property on the instance does the same.
    Object.defineProperty(folder, "name", {
      value: "root",
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  const childItemChunks = filterByListType(folderChunks, "Item");
  for (const childItemChunk of childItemChunks) {
    const childItem = parseItem(childItemChunk, project, folder);
    folder.items.push(childItem);
  }

  folder._viewers = parseViewers(folderChunks, folder.items);

  return folder;
}

/**
 * Parse composition guides from the LIST:Gide chunk.
 *
 * @param childChunks - child chunks of the item LIST chunk.
 * @returns List of Guide objects, empty if no guides are defined.
 */
export function _parseGuides(childChunks: Chunk[]): Guide[] {
  const gideList = findByListTypeOrNull(childChunks, "Gide");
  if (gideList === null) return [];

  const listChunk = findByListType(gideList.chunks, "list");
  const lhd3 = findByType(listChunk.chunks, "lhd3");
  if (lhd3.count === 0) {
    return [];
  }

  const ldat = findByType(listChunk.chunks, "ldat");
  return ldat.items.map((item) => new Guide(item));
}
