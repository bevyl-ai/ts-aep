import type { Chunk, ListChunk } from "../binary/chunk.ts";
import type { CmtaChunk, IdtaChunk } from "../binary/item_chunks.ts";
import type { Utf8Chunk } from "../binary/scalar_chunks.ts";
import { filterByListType, findByListType } from "../binary/utils.ts";
import { CompItem } from "../models/items/composition.ts";
import type { FolderItem } from "../models/items/folder.ts";
import type { Project } from "../models/project.ts";
import type { MarkerValue } from "../models/properties/marker.ts";
import type { Property } from "../models/properties/property.ts";
import type { ParamDef } from "./effect.ts";
import { parseLayer } from "./layer.ts";
import { parseSource } from "./source.ts";

/**
 * Parse a composition item.
 *
 * @param childChunks - child chunks of the composition LIST chunk.
 * @param _idta - The idta chunk.
 * @param _nameUtf8 - The Utf8 chunk containing the composition name.
 * @param _cmta - The cmta chunk (null if no comment).
 * @param _itemList - The LIST chunk for creating new chunks.
 * @param _gide - The LIST chunk for guides (null if no guides).
 * @param project - The project.
 * @param parentFolder - The composition's parent folder.
 * @param effectParamDefs - Project-level effect parameter definitions, used as fallback when
 *   layer-level parT chunks are missing.
 */
export function parseComposition(
  childChunks: Chunk[],
  _idta: IdtaChunk,
  _nameUtf8: Utf8Chunk,
  _cmta: CmtaChunk | null,
  _itemList: ListChunk,
  _gide: ListChunk | null,
  project: Project,
  parentFolder: FolderItem,
  effectParamDefs: Map<string, Map<string, ParamDef>>,
): CompItem {
  const pinChunks = filterByListType(childChunks, "Pin ");
  const proxySource = pinChunks?.length > 0 ? parseSource(pinChunks[0]) : null;

  return new CompItem({
    _child_chunks: childChunks,
    _cmta,
    _idta,
    _item_list: _itemList,
    _gide,
    _pin_chunks: pinChunks,
    _name_utf8: _nameUtf8,
    project,
    parent_folder: parentFolder,
    effect_param_defs: effectParamDefs,
    proxy_source: proxySource,
  });
}

/**
 * Get the composition markers.
 *
 * Marker keyframe times in the binary format are stored in absolute
 * composition time (not relative to the SecL layer's start time).
 *
 * @param childChunks - child chunks of the composition LIST chunk.
 * @param composition - The parent composition.
 */
export function _getMarkers(childChunks: Chunk[], composition: CompItem): Property<MarkerValue | null> | null {
  const markersLayerChunk = findByListType(childChunks, "SecL");
  const markersLayer = parseLayer(markersLayerChunk, composition, new Map());
  if (markersLayer.marker == null) return null;

  return markersLayer.marker;
}
