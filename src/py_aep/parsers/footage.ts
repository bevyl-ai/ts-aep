import type { Chunk, ListChunk } from "../binary/chunk.ts";
import type { CmtaChunk, IdtaChunk } from "../binary/item_chunks.ts";
import type { Utf8Chunk } from "../binary/scalar_chunks.ts";
import { filterByListType } from "../binary/utils.ts";
import { FootageItem } from "../models/items/footage.ts";
import type { FolderItem } from "../models/items/folder.ts";
import type { FileSource } from "../models/sources/file.ts";
import type { PlaceholderSource } from "../models/sources/placeholder.ts";
import type { SolidSource } from "../models/sources/solid.ts";
import type { Project } from "../models/project.ts";
import { parseSource } from "./source.ts";

/**
 * Parse a footage item.
 *
 * @param childChunks - The footage item child chunks.
 * @param _idta - The idta chunk.
 * @param _nameUtf8 - The Utf8 chunk containing the item name.
 * @param _cmta - The cmta chunk (None if no comment).
 * @param _itemList - The LIST chunk for creating new chunks.
 * @param _gide - The LIST chunk for guides (None if no guides).
 * @param project - The project.
 * @param parentFolder - The item's parent folder.
 */
export function parseFootage(
  childChunks: Chunk[],
  _idta: IdtaChunk,
  _nameUtf8: Utf8Chunk,
  _cmta: CmtaChunk | null,
  _itemList: ListChunk,
  _gide: ListChunk | null,
  project: Project,
  parentFolder: FolderItem,
): FootageItem {
  const pinChunks = filterByListType(childChunks, "Pin ");

  const mainSource = parseSource(pinChunks[0]);
  const proxySource: FileSource | SolidSource | PlaceholderSource | null =
    pinChunks.length > 1 ? parseSource(pinChunks[1]) : null;

  return new FootageItem({
    _idta,
    _nameUtf8: _nameUtf8,
    _cmta,
    _itemList: _itemList,
    _gide,
    _pinChunks: pinChunks,
    project,
    parentFolder: parentFolder,
    mainSource: mainSource,
    proxySource: proxySource,
  });
}
