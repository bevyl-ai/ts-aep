/**
 * Marker parsing functions.
 *
 * Extracts composition and layer markers from MRST / Nmrd chunks.
 */

import type { ListChunk } from "../binary/chunk.ts";
import type { TdmnChunk } from "../binary/property_chunks.ts";
import type { Utf8Chunk } from "../binary/scalar_chunks.ts";
import { filterByListType, filterByType, findByListType, findByType } from "../binary/utils.ts";
import { PropertyValueType } from "../enums/index.ts";
import { MarkerValue } from "../models/properties/marker.ts";
import type { Property } from "../models/properties/property.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { Keyframe } from "../models/properties/keyframe.ts";
import { parseProperty } from "./property_value.ts";
import { at } from "../../pyrt/index.ts";

/**
 * Parse markers from an MRST chunk.
 *
 * Returns the underlying {@link Property} (the `tdbs` inside the
 * `mrst` chunk, with keyframes holding marker values).
 *
 * @param mrstChunk - The MRST chunk to parse.
 * @param composition - The parent composition.
 * @param propertyDepth - The nesting depth of this property (default 1).
 */
export function parseMarkers(
  mrstChunk: ListChunk,
  composition: CompItem,
  propertyDepth: number,
  tdmn: TdmnChunk,
): Property {
  const tdbsChunk = findByListType(mrstChunk.chunks, "tdbs");
  const markerProp = parseProperty(
    tdbsChunk,
    "ADBE Marker",
    composition,
    propertyDepth,
    tdmn,
  );
  markerProp._wrapper = mrstChunk;
  // ExtendScript reports MARKER (6420); the tdb4 flags alone would fall
  // back to OneD like any 1-D scalar.
  markerProp._property_value_type = PropertyValueType.MARKER;
  const mrkyChunk = findByListType(mrstChunk.chunks, "mrky");
  markerProp._kf_value_container = mrkyChunk;
  const nmrdChunks = filterByListType(mrkyChunk.chunks, "Nmrd");
  for (const [i, nmrdChunk] of nmrdChunks.entries()) {
    const kf = at(markerProp.keyframes, i);
    kf._cache_value(
      parseMarker(
        nmrdChunk,
        kf,
      ),
    );
  }
  return markerProp;
}

/**
 * Parse a marker.
 *
 * @param nmrdChunk - The NMRD chunk to parse.
 * @param keyframe - The keyframe that holds this marker value.
 * @param frameTime - Fallback time in frames (used when no keyframe ref).
 */
export function parseMarker(
  nmrdChunk: ListChunk,
  keyframe: Keyframe | null = null,
  frameTime = 0,
): MarkerValue {
  const nmhdChunk = findByType(nmrdChunk.chunks, "NmHd");

  const utf8Chunks = filterByType(nmrdChunk.chunks, "Utf8");

  // Collect cue point param Utf8 chunks
  const paramUtf8s: Utf8Chunk[] = utf8Chunks.slice(5);

  return MarkerValue._from_binary({
    _nmhd: nmhdChunk,
    _comment_utf8: at(utf8Chunks, 0),
    _chapter_utf8: at(utf8Chunks, 1),
    _url_utf8: at(utf8Chunks, 2),
    _frame_target_utf8: at(utf8Chunks, 3),
    _cue_point_name_utf8: at(utf8Chunks, 4),
    _keyframe: keyframe,
    frame_time: frameTime,
    _param_utf8s: paramUtf8s,
    _nmrd: nmrdChunk,
  });
}
