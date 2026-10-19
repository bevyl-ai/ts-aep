/** Orientation, shape, text document, and gradient property parsers. */

import type { ListChunk } from "../binary/chunk.ts";
import type { TdmnChunk } from "../binary/property_chunks.ts";
import {
  ChunkNotFoundError,
  filterByListType,
  filterByType,
  findByListType,
  findByListTypeOrNull,
  findByType,
  findByTypeOrNull,
} from "../binary/utils.ts";
import { CosParser } from "../cos/index.ts";
import { decodeBtdk } from "../cos/schema.ts";
// Python's builtin `SyntaxError` as raised by `CosParser`.
import { type CosNode } from "../cos/cos.ts";
import { PropertyValueType } from "../enums/index.ts";
import { ORIENTATION_KIND } from "../models/properties/parallel.ts";
import { FeatherPoint, Shape } from "../models/properties/shape.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { Layer } from "../models/layers/layer.ts";
import type { Property } from "../models/properties/property.ts";
import type { Gradient } from "../models/properties/gradient.ts";
import { parseGradientXml } from "./gradient.ts";
import { parseProperty } from "./property_value.ts";
import { parseBtdkCos } from "./text.ts";
import { ByteStream, OverflowError, ValueError, warn, zip, overrides } from "../../pyrt/index.ts";
import { late } from "../models/late.ts";

// `logging.getLogger(__name__)`: only the warning path is wired to pyrt `warn`.
const logger = {
  debug(..._args: string[]) {},
  info(..._args: string[]) {},
  warning: (m: string) => warn(m),
};

/**
 * Parse an orientation property.
 *
 * @param otstChunk - The OTST chunk to parse.
 * @param matchName - A special name for the property used to build unique naming paths. The
 *   match name is not displayed, but you can refer to it in scripts. Every property has a unique
 *   match-name identifier. Match names are stable from version to version regardless of the
 *   display name (the name attribute value) or any changes to the application. Unlike the display
 *   name, it is not localized.
 * @param propertyDepth - The nesting depth of this property (0 = layer level).
 * @param composition - The parent composition.
 */
export function parseOrientation(
  otstChunk: ListChunk,
  matchName: string,
  propertyDepth: number,
  composition: CompItem,
  tdmn: TdmnChunk,
): Property {
  const tdbsChunk = findByListType(otstChunk.chunks, "tdbs");
  const prop = parseProperty(tdbsChunk, matchName, composition, propertyDepth, tdmn);
  prop._wrapper = otstChunk;
  ORIENTATION_KIND.applyModelMetadata(prop);

  // cdat is parameterized with is_le; .value returns the correctly-
  // endian doubles regardless of context.
  const cdat = findByTypeOrNull(tdbsChunk.chunks, "cdat");
  if (cdat === null) {
    prop._cacheValue(null);
  } else {
    const values = [...cdat.values];
    while (values.length < 3) values.push(0.0);
    prop._cacheValue(values.slice(0, 3));
  }

  // Animated orientation keyframes store their 3-component values in
  // otky > otda chunks (one otda per keyframe), a sibling of tdbs inside
  // otst.  The tdbs items carry ease only and no value at all, so each
  // keyframe's value comes from the otda data instead.
  try {
    const otkyChunk = findByListType(otstChunk.chunks, "otky");
    prop._kfValueContainer = otkyChunk;
    const otdaChunks = filterByType(otkyChunk.chunks, "otda");
    for (const [idx, kf] of prop.keyframes.entries()) {
      if (idx < otdaChunks.length) {
        kf._cacheValue([...otdaChunks[idx].values]);
      }
    }
  } catch (e) {
    if (!(e instanceof ChunkNotFoundError)) throw e;
  }

  return prop;
}

/**
 * Parse a single shape path from a `shap` LIST chunk.
 *
 * Each `shap` LIST contains:
 * - `shph` chunk: shape header with closed flag and bounding box
 * - `list` LIST:  contains `lhd3` (point count/size) and `ldat`
 *   (raw normalized bezier points)
 *
 * Points in `ldat` are stored as `(x, y)` pairs,
 * normalized to the `[0, 1]` range of the bounding box.  Every three
 * consecutive points form a cycle:
 * `vertex, out_tangent, in_tangent_of_next_vertex`.
 *
 * Mask shapes use a normalized `[0, 1]` bounding box, so the
 * resulting coordinates must be scaled by the owning LAYER's source
 * size to get pixel values.  Shape-layer paths already have a pixel
 * bounding box.
 *
 * @param shapChunk - A `shap` LIST chunk.
 * @param layer - The owning layer, which a mask shape denormalizes against. Only optional because
 *   a shape-layer path does not need one.
 * @param maskPath - The Mask Path property this shape is a value of (its mask's RotoBezier
 *   switch decides the reported tangents), or `null` for a shape-layer path.
 * @returns A {@link Shape} with absolute coordinates and tangent offsets.
 * @throws {@link ValueError} If a mask shape is parsed without its layer, which would silently
 *   yield raw normalized coordinates.
 */
export function _parseShapeShap(shapChunk: ListChunk, layer: Layer | null, maskPath: Property | null): Shape {
  const isMaskShape = maskPath != null;
  if (isMaskShape && layer == null) {
    throw new ValueError("a mask shape must be parsed with its owning layer");
  }
  const shphChunk = findByType(shapChunk.chunks, "shph");
  const listChunk = findByListType(shapChunk.chunks, "list");

  // An empty path (no vertices) carries only the lhd3 header, no ldat;
  // treat it as zero points so the value is an empty Shape, not None.
  const ldat = findByTypeOrNull(listChunk.chunks, "ldat");
  const points: Parameters<typeof Shape._fromBinary>[0]["_points"] = ldat === null ? [] : ldat.items;

  // Extract variable-width mask feather data from fth5 chunk (if present).
  const fth5 = findByTypeOrNull(shapChunk.chunks, "fth5");
  const featherPoints = fth5 === null ? [] : fth5.points.map((pt) => new FeatherPoint({ _fp: pt }));

  const omtn = findByTypeOrNull(shapChunk.chunks, "omtn");

  return Shape._fromBinary({
    _shph: shphChunk,
    _points: points,
    _isMask: isMaskShape,
    _layer: isMaskShape ? layer : null,
    _omtn: omtn,
    _maskPath: maskPath,
    featherPoints: featherPoints,
  });
}

/**
 * Parse a shape/mask-path property from an `om-s` LIST chunk.
 *
 * An `om-s` LIST contains:
 * - `tdbs` LIST: standard property metadata (timing, keyframes, etc.)
 * - `omks` LIST: shape keyframe values (one `shap` per keyframe,
 *   or one `shap` for static shapes)
 *
 * @param omsChunk - The `om-s` LIST chunk to parse.
 * @param matchName - The property match name.
 * @param propertyDepth - Nesting depth of this property.
 * @param composition - The parent composition.
 * @param layer - The owning layer, required for a mask path (which denormalizes against the
 *   layer, not the composition).
 * @returns A {@link Property} with `propertyValueType` set to
 *   {@link PropertyValueType.SHAPE | SHAPE} and `value` set to a {@link Shape}.
 */
export function parseShape(
  omsChunk: ListChunk,
  matchName: string,
  propertyDepth: number,
  composition: CompItem,
  tdmn: TdmnChunk,
  layer: Layer | null = null,
): Property {
  const tdbsChunk = findByListType(omsChunk.chunks, "tdbs");
  const prop = parseProperty(tdbsChunk, matchName, composition, propertyDepth, tdmn);

  prop._wrapper = omsChunk;
  prop._propertyValueType = PropertyValueType.SHAPE;
  // Shape properties always carry a value (from omks), even though
  // tdb4 may report no_value=True (a static shape's cdat is the empty
  // 4-byte form).
  overrides(prop).set("_noValue", false);

  // Collect shape values from omks > shap LISTs
  let shapeValues: Shape[];
  try {
    const omksChunk = findByListType(omsChunk.chunks, "omks");
    prop._kfValueContainer = omksChunk;
    const maskPath = matchName === "ADBE Mask Shape" ? prop : null;
    shapeValues = filterByListType(omksChunk.chunks, "shap").map((shapChunk) =>
      _parseShapeShap(shapChunk, layer, maskPath),
    );
  } catch (e) {
    if (!(e instanceof ChunkNotFoundError)) throw e;
    logger.debug("Could not parse omks shape data for %s", matchName);
    return prop;
  }

  // Assign static value (first shape).  Set an empty Shape as default
  // so that is_modified detects any real mask path as modified.
  prop.defaultValue = new Shape(null, null, null, { closed: false });
  if (shapeValues.length) {
    prop._cacheValue(shapeValues[0]);
  }

  for (const [idx, kf] of prop.keyframes.entries()) {
    if (idx < shapeValues.length) {
      kf._cacheValue(shapeValues[idx]);
    }
  }

  return prop;
}

/**
 * Parse a text document property.
 *
 * @param btdsChunk - The BTDS chunk to parse.
 * @param matchName - A special name for the property used to build unique naming paths. The
 *   match name is not displayed, but you can refer to it in scripts. Every property has a unique
 *   match-name identifier. Match names are stable from version to version regardless of the
 *   display name (the name attribute value) or any changes to the application. Unlike the display
 *   name, it is not localized.
 * @param propertyDepth - The nesting depth of this property (0 = layer level).
 * @param composition - The parent composition.
 */
export function parseTextDocument(
  btdsChunk: ListChunk,
  matchName: string,
  propertyDepth: number,
  composition: CompItem,
  tdmn: TdmnChunk,
): Property {
  const tdbsChunk = findByListType(btdsChunk.chunks, "tdbs");
  const prop = parseProperty(tdbsChunk, matchName, composition, propertyDepth, tdmn);
  prop._wrapper = btdsChunk;
  prop._propertyValueType = PropertyValueType.TEXT_DOCUMENT;

  let btdkChunk: ListChunk;
  let cosData: CosNode;
  try {
    btdkChunk = findByListType(btdsChunk.chunks, "btdk");
    // btdk is a ListChunk with list_type="btdk"; raw data stored in .data
    const parser = new CosParser(new ByteStream(btdkChunk.data), btdkChunk.data.length);
    cosData = parser.parse();
  } catch (e) {
    if (
      !(
        e instanceof ChunkNotFoundError ||
        e instanceof OverflowError ||
        e instanceof SyntaxError ||
        e instanceof ValueError
      )
    ) {
      throw e;
    }
    logger.debug("Failed to parse btdk COS binary for %s", matchName);
    return prop;
  }

  // The decode boundary: from here on the tree is a typed COS dictionary.
  const tree = decodeBtdk(cosData);
  if (tree == null) {
    logger.debug("Unexpected btdk COS structure for %s", matchName);
    return prop;
  }

  const [textDocuments, _fonts] = parseBtdkCos(tree, btdkChunk);
  // Wire each document to the project head so version-gated attributes
  // (e.g. the box-text setters) can resolve the AE major version, and to
  // the AE preferences, which hold the Character/Paragraph panel defaults
  // the reset methods restore.
  const projectHead = composition._project._head;
  const projectPreferences = composition._project._preferences;
  for (const doc of textDocuments) {
    doc._head = projectHead;
    doc._preferences = projectPreferences;
  }
  if (textDocuments?.length > 0) {
    if (prop.keyframes?.length > 0) {
      for (const [kf, doc] of zip(prop.keyframes, textDocuments)) {
        kf._cacheValue(doc);
      }
    } else {
      prop._cacheValue(textDocuments[0]);
    }
  }

  return prop;
}

/**
 * Parse a gradient color property from a GCst chunk.
 *
 * The GCst chunk contains:
 * - LIST:tdbs with base property metadata
 * - LIST:GCky with Utf8 chunks containing gradient XML per keyframe
 *
 * @param gcstChunk - The GCst LIST chunk to parse.
 * @param matchName - The match name identifier for this property.
 * @param propertyDepth - The nesting depth of this property.
 * @param composition - The parent composition.
 * @param tdmn - The tdmn chunk for this property.
 */
export function parseGradient(
  gcstChunk: ListChunk,
  matchName: string,
  propertyDepth: number,
  composition: CompItem,
  tdmn: TdmnChunk,
): Property {
  const tdbsChunk = findByListType(gcstChunk.chunks, "tdbs");
  const prop = parseProperty(tdbsChunk, matchName, composition, propertyDepth, tdmn);

  prop._wrapper = gcstChunk;
  const gckyChunk = findByListTypeOrNull(gcstChunk.chunks, "GCky");
  if (gckyChunk === null) return prop;

  prop._kfValueContainer = gckyChunk;
  const utf8Chunks = filterByType(gckyChunk.chunks, "Utf8");
  const gradientValues: Gradient[] = [];
  for (const utf8 of utf8Chunks) {
    const gdata = parseGradientXml(utf8);
    if (gdata != null) {
      gradientValues.push(gdata);
    }
  }

  if (gradientValues.length) {
    if (prop.keyframes?.length > 0) {
      for (const [kf, gdata] of zip(prop.keyframes, gradientValues)) {
        kf._cacheValue(gdata);
      }
    } else {
      prop._cacheValue(gradientValues[0]);
    }
  }

  return prop;
}

Object.assign(late, { _parseShapeShap });
