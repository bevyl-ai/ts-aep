/** Core single-property parsing and keyframe extraction. */

import { warn } from "../../pyrt/index.ts";
import type { Chunk, ListChunk } from "../binary/chunk.ts";
import type { TdmnChunk } from "../binary/property_chunks.ts";
import { findByListTypeOrNull, findByType, findByTypeOrNull } from "../binary/utils.ts";
import { PropertyValueType } from "../enums/index.ts";
import { _suppressMaterialization } from "../models/descriptors.ts";
import { Keyframe } from "../models/properties/keyframe.ts";
import { Property } from "../models/properties/property.ts";
import type { CompItem } from "../models/items/composition.ts";

export const logger = {
  debug() {},
  info() {},
  warning: (m: string) => warn(m),
};

/**
 * Parse a property.
 *
 * @param tdbs_chunk - The TDBS chunk to parse.
 * @param match_name - A special name for the property used to build unique naming paths. The match
 *   name is not displayed, but you can refer to it in scripts. Every property has a unique
 *   match-name identifier. Match names are stable from version to version regardless of the display
 *   name (the name attribute value) or any changes to the application. Unlike the display name, it
 *   is not localized.
 * @param composition - The parent composition.
 * @param property_depth - The nesting depth of this property (0 = layer level).
 */
export const parseProperty = _suppressMaterialization().decorate(function parse_property(
  tdbsChunk: ListChunk,
  matchName: string,
  composition: CompItem,
  propertyDepth: number,
  tdmn: TdmnChunk,
): Property {
  const tdbsChildChunks = tdbsChunk.chunks;

  const tdsbChunk = findByType(tdbsChildChunks, "tdsb");

  const tdb4Chunk = findByType(tdbsChildChunks, "tdb4");

  // The optional chunks, first of each type (py-aep gathers them in one
  // pass; the typed lookups here keep each chunk's class).
  const cdat = findByTypeOrNull(tdbsChildChunks, "cdat");

  // For LAYER control properties, keep the tdpi chunk reference so the
  // layer index can be resolved lazily (it changes on layer reorder).
  const tdpi = findByTypeOrNull(tdbsChildChunks, "tdpi");
  // AE writes a tdli (the mask's id, resolved lazily by
  // `Property._mask_index`) only for mask-index properties; their tdb4
  // alone reads as OneD (e.g. a text layer's Path).
  let propertyValueType: PropertyValueType | null = null;
  if (findByTypeOrNull(tdbsChildChunks, "tdli") !== null) {
    propertyValueType = PropertyValueType.MASK_INDEX;
  }

  const expressionUtf8 = findByTypeOrNull(tdbsChildChunks, "Utf8");

  const tdum = findByTypeOrNull(tdbsChildChunks, "tdum");
  const tduM = findByTypeOrNull(tdbsChildChunks, "tduM");

  const keyframes = _parseKeyframes(tdbsChildChunks, composition.frameRate);

  // Resolve _name_utf8 from the LIST:tdbs tdsn child.
  const tdsn = findByType(tdbsChildChunks, "tdsn");
  const nameUtf8 = tdsn.utf8;

  const prop = new Property({
    _tdmn: tdmn,
    _tdsb: tdsbChunk,
    _tdb4: tdb4Chunk,
    _expression_utf8: expressionUtf8,
    _name_utf8: nameUtf8,
    _tdbs: tdbsChunk,
    _tdum: tdum,
    _tduM: tduM,
    _cdat: cdat,
    _tdpi: tdpi,
    _composition: composition,
    match_name: matchName,
    property_depth: propertyDepth,
    keyframes,
    // Read lazily from the chunks (`Property._stored_static_value`).
    value: null,
    property_value_type: propertyValueType,
  });

  return prop;
});

/**
 * Parse keyframes from a property's child chunks.
 *
 * @param tdbsChildChunks - The child chunks of the TDBS chunk.
 * @param frameRate - The frame rate of the parent composition.
 */
export function _parseKeyframes(tdbsChildChunks: Chunk[], frameRate: number): Keyframe[] {
  const listChunk = findByListTypeOrNull(tdbsChildChunks, "list");
  if (listChunk === null) return [];

  const ldat = findByTypeOrNull(listChunk.chunks, "ldat");

  if (ldat === null) return [];

  const kfItems = ldat.items;

  return kfItems.map((kf) => new Keyframe({ _ldat_item: kf, _frame_rate: frameRate }));
}
