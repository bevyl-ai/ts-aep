/** Core single-property parsing and keyframe extraction. */

import { warn } from "../../pyrt/index.ts";
import type { Chunk, ListChunk } from "../binary/chunk.ts";
import type { TdmnChunk } from "../binary/property_chunks.ts";
import { find_by_list_type_or_null, find_by_type, find_by_type_or_null } from "../binary/utils.ts";
import { PropertyValueType } from "../enums/index.ts";
import { _suppress_materialization } from "../models/descriptors.ts";
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
export const parse_property = _suppress_materialization().decorate(function parse_property(
  tdbs_chunk: ListChunk,
  match_name: string,
  composition: CompItem,
  property_depth: number,
  tdmn: TdmnChunk,
): Property {
  const tdbs_child_chunks = tdbs_chunk.chunks;

  const tdsb_chunk = find_by_type(tdbs_child_chunks, "tdsb");

  const tdb4_chunk = find_by_type(tdbs_child_chunks, "tdb4");

  const cdat = find_by_type_or_null(tdbs_child_chunks, "cdat");

  // Static value is read lazily by Property.value from _cdat via
  // _resolve_value.  Only extract here for non-cdat overrides.
  let value: number | null = null;

  // For LAYER control properties, keep the tdpi chunk reference so the
  // layer index can be resolved lazily (it changes on layer reorder).
  // tdli stores the 1-based mask index directly and is stable.
  const tdpi = find_by_type_or_null(tdbs_child_chunks, "tdpi");
  // AE writes a tdli only for mask-index properties; their tdb4 alone reads
  // as OneD (e.g. a text layer's Path).
  let property_value_type: PropertyValueType | null = null;
  const tdli = find_by_type_or_null(tdbs_child_chunks, "tdli");
  if (tdli !== null) {
    value = tdli.value;
    property_value_type = PropertyValueType.MASK_INDEX;
  }

  const expression_utf8 = find_by_type_or_null(tdbs_child_chunks, "Utf8");

  const tdum = find_by_type_or_null(tdbs_child_chunks, "tdum");
  const tduM = find_by_type_or_null(tdbs_child_chunks, "tduM");

  const keyframes = _parse_keyframes(tdbs_child_chunks, composition.frame_rate);

  // Resolve _name_utf8 from the LIST:tdbs tdsn child.
  const tdsn = find_by_type(tdbs_child_chunks, "tdsn");
  const name_utf8 = tdsn.utf8;

  const prop = new Property({
    _tdmn: tdmn,
    _tdsb: tdsb_chunk,
    _tdb4: tdb4_chunk,
    _expression_utf8: expression_utf8,
    _name_utf8: name_utf8,
    _tdbs: tdbs_chunk,
    _tdum: tdum,
    _tduM: tduM,
    _cdat: cdat,
    _tdpi: tdpi,
    _composition: composition,
    match_name,
    property_depth,
    keyframes,
    value,
    property_value_type,
  });

  return prop;
});

/**
 * Parse keyframes from a property's child chunks.
 *
 * @param tdbs_child_chunks - The child chunks of the TDBS chunk.
 * @param frame_rate - The frame rate of the parent composition.
 */
export function _parse_keyframes(tdbs_child_chunks: Chunk[], frame_rate: number): Keyframe[] {
  const list_chunk = find_by_list_type_or_null(tdbs_child_chunks, "list");
  if (list_chunk === null) return [];

  const ldat = find_by_type_or_null(list_chunk.chunks, "ldat");

  if (ldat === null) return [];

  const kf_items = ldat.items;

  return kf_items.map((kf) => new Keyframe({ _ldat_item: kf, _frame_rate: frame_rate }));
}
