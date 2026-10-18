/** Property group and mask parsers with registry-based dispatch. */

import { ListChunk } from "../binary/chunk.ts";
import type { Chunk } from "../binary/chunk.ts";
import type { MkifChunk } from "../binary/misc_chunks.ts";
import type { TdmnChunk, TdsbChunk } from "../binary/property_chunks.ts";
import type { Utf8Chunk } from "../binary/scalar_chunks.ts";
import { ChunkNotFoundError, filterByListType, filterByType, findByListTypeOrNull, findByType, findByTypeOrNull } from "../binary/utils.ts";
import { VF_AXIS_PREFIX } from "../data/match_names.ts";
import { _suppressMaterialization } from "../models/descriptors.ts";
import { MaskPropertyGroup } from "../models/properties/mask_property_group.ts";
import { PropertyGroup } from "../models/properties/property_group.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { Layer } from "../models/layers/layer.ts";
import { parseEffect } from "./effect.ts";
import type { ParamDef } from "./effect.ts";
import { parseMarkers } from "./marker.ts";
import { parseProperty } from "./property_value.ts";
import { parseGradient, parseOrientation, parseShape, parseTextDocument } from "./specialized_properties.ts";
import { getChunksByMatchName, getMatchNameRuns } from "./utils.ts";
import { warn, zip } from "../../pyrt/index.ts";
import { Property, _EssentialOverrideProperty } from "../models/properties/property.ts";

// `logging.getLogger(__name__)`: this module logs nothing today, so only the
// warning path is wired to pyrt `warn`.
export const logger = {
  debug() {},
  info() {},
  warning: (m: string) => warn(m),
};

/**
 * Per-match-name context threaded through the property dispatchers.
 *
 * NamedTuple: fields are positional, in declaration order.
 */
export class _ParseContext {
  /** The match name shared by every chunk in the group. */
  readonly matchName: string;

  /** All chunks of the match-name group (tdmn + bodies + auxiliaries). */
  readonly chunks: Chunk[];

  /** The first LIST chunk of the group (selects the dispatcher). */
  readonly firstChunk: ListChunk;

  readonly childDepth: number;

  readonly effectParamDefs: Map<string, Map<string, ParamDef>>;

  readonly composition: CompItem;

  /**
   * The layer these properties belong to.
   *
   * A mask path and an effect point parameter both normalize against the
   * layer, not the composition, so the layer has to travel with the
   * parse. It is the layer itself rather than its size so the size stays
   * lazy - a mask `Shape` reads it back at value-read time, and so
   * follows the layer if its source is later replaced. `null` only where
   * there is genuinely no layer (a project-level parse).
   */
  readonly layer: Layer | null;

  constructor(
    matchName: string,
    chunks: Chunk[],
    firstChunk: ListChunk,
    childDepth: number,
    effectParamDefs: Map<string, Map<string, ParamDef>>,
    composition: CompItem,
    layer: Layer | null = null,
  ) {
    this.matchName = matchName;
    this.chunks = chunks;
    this.firstChunk = firstChunk;
    this.childDepth = childDepth;
    this.effectParamDefs = effectParamDefs;
    this.composition = composition;
    this.layer = layer;
  }

  *[Symbol.iterator](): Generator<
    _ParseContext[
      "matchName" | "chunks" | "firstChunk" | "childDepth" | "effectParamDefs" | "composition" | "layer"
    ]
  > {
    yield this.matchName;
    yield this.chunks;
    yield this.firstChunk;
    yield this.childDepth;
    yield this.effectParamDefs;
    yield this.composition;
    yield this.layer;
  }

  /** The group's first match-name chunk. */
  get tdmn(): TdmnChunk {
    return findByType(this.chunks, "tdmn");
  }
}

export const _PROPERTY_PARSERS: Map<string, (ctx: _ParseContext) => (Property | PropertyGroup)[]> =
  new Map();

/** Register a property parser for the given LIST subtype. */
export function _propertyParser(
  listType: string,
): (
  func: (ctx: _ParseContext) => (Property | PropertyGroup)[],
) => (ctx: _ParseContext) => (Property | PropertyGroup)[] {
  return function decorator(func) {
    _PROPERTY_PARSERS.set(listType, func);
    return func;
  };
}

/**
 * Dispatch sub-property chunks into parsed Property/PropertyGroup items.
 *
 * Iterates each match-name run, finds the first LIST chunk, and
 * dispatches to the appropriate parser based on its list type.
 *
 * @param matchNameRuns - Sub-property chunks grouped into ordered match-name runs (from
 *   `get_match_name_runs`).
 * @param childDepth - The property depth for parsed child properties.
 * @param effectParamDefs - Project-level effect parameter definitions.
 * @param composition - The parent composition.
 * @param layer - The owning layer, for mask paths and effect point denormalization.
 * @returns Ordered list of parsed properties and property groups.
 */
export function parseProperties(
  matchNameRuns: [string, Chunk[]][],
  childDepth: number,
  effectParamDefs: Map<string, Map<string, ParamDef>>,
  composition: CompItem,
  layer: Layer | null = null,
): (Property | PropertyGroup)[] {
  const properties: (Property | PropertyGroup)[] = [];
  for (const [matchName, subPropChunks] of matchNameRuns) {
    // Find the first LIST chunk; non-LIST chunks (e.g. mkif for masks)
    // are auxiliary data that we skip when determining the property type.
    let firstChunk: ListChunk | null = null;
    for (const c of subPropChunks) {
      if (c instanceof ListChunk) {
        firstChunk = c;
        break;
      }
    }
    if (firstChunk == null) continue;

    const listType = firstChunk.listType;
    const handler = _PROPERTY_PARSERS.get(listType);
    if (handler != null) {
      properties.push(
        ...handler(
          new _ParseContext(
            matchName,
            subPropChunks,
            firstChunk,
            childDepth,
            effectParamDefs,
            composition,
            layer,
          ),
        ),
      );
    } else {
      logger.warning(
        `Skipping unsupported property list type '${listType}' (match name '${matchName}')`,
      );
    }
  }

  return properties;
}

export function _dispatchSspc(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse effect chunks - iterates all sspc LISTs for the match name. */
  const tdmns = filterByType(ctx.chunks, "tdmn");
  const sspcs = filterByListType(ctx.chunks, "sspc");
  const results: (Property | PropertyGroup)[] = [];
  for (const [tdmn, sspc] of zip(tdmns, sspcs)) {
    const effect = parseEffect(
      sspc,
      ctx.matchName,
      ctx.childDepth,
      ctx.effectParamDefs,
      ctx.composition,
      tdmn,
      ctx.layer,
    );
    results.push(effect);
  }
  return results;
}
_propertyParser("sspc")(_dispatchSspc);

export function _dispatchTdgp(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse property group chunks - handles masks and indexed groups. */
  const tdmns = filterByType(ctx.chunks, "tdmn");
  if (ctx.matchName === "ADBE Mask Atom") {
    const tdgps = [...filterByListType(ctx.chunks, "tdgp")];
    const mkifs = [...filterByType(ctx.chunks, "mkif")];
    const masks: (Property | PropertyGroup)[] = [];
    for (const [i, [tdmn, tdgpC, mkifC]] of zip(tdmns, tdgps, mkifs).entries()) {
      const mask = _parseMaskAtom(
        tdgpC,
        mkifC,
        ctx.childDepth,
        ctx.effectParamDefs,
        ctx.composition,
        tdmn,
        ctx.layer,
      );
      mask._autoName = `Mask ${i + 1}`;
      masks.push(mask);
    }
    return masks;
  }
  const tdgps = [...filterByListType(ctx.chunks, "tdgp")];
  const results: (Property | PropertyGroup)[] = [];
  for (const [tdmn, tdgpC] of zip(tdmns, tdgps)) {
    const group = parsePropertyGroup(
      tdgpC,
      ctx.matchName,
      ctx.childDepth,
      ctx.effectParamDefs,
      ctx.composition,
      tdmn,
      ctx.layer,
    );
    results.push(group);
  }
  return results;
}
_propertyParser("tdgp")(_dispatchTdgp);

export function _dispatchTdbs(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse a leaf property from a tdbs chunk. */
  const prop = parseProperty(
    ctx.firstChunk,
    ctx.matchName,
    ctx.composition,
    ctx.childDepth,
    ctx.tdmn,
  );
  // A media-replacement slot (`ADBE Layer Source Alternate`) carries blsv/blsi
  // beside its tdbs in the group run; attach them so the Property can decode
  // `can_set_alternate_source` / `alternate_source`. Gated on the match name
  // so the scans do not run for every leaf on the hot parse path.
  if (ctx.matchName === "ADBE Layer Source Alternate") {
    const blsi = filterByType(ctx.chunks, "blsi");
    if (blsi?.length > 0) {
      prop._blsi = blsi[0];
      const blsv = filterByType(ctx.chunks, "blsv");
      if (blsv?.length > 0) {
        prop._blsv = blsv[0];
      }
    }
  }
  // AE 26+ writes a vfdn sibling (the axis display name from the font)
  // after an active variable-font axis slot's tdbs.
  if (ctx.matchName.startsWith(VF_AXIS_PREFIX)) {
    const vfdn = filterByType(ctx.chunks, "vfdn");
    if (vfdn?.length > 0) {
      prop._vfdn = vfdn[0];
    }
  }
  // Curves keeps its curves as the effect's arbitrary data, an aRbp in a
  // LIST:aRbs after the tdbs (whose cdat holds nothing of them): one per
  // keyframe when the curves are keyed.
  if (ctx.matchName === "ADBE CurvesCustom-0001") {
    const arbs = filterByListType(ctx.chunks, "aRbs");
    if (arbs?.length > 0) {
      prop._arbs = arbs[0];
    }
  }
  return [prop];
}
_propertyParser("tdbs")(_dispatchTdbs);

export function _dispatchOtst(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse an orientation property from an otst chunk. */
  const prop = parseOrientation(
    ctx.firstChunk,
    ctx.matchName,
    ctx.childDepth,
    ctx.composition,
    ctx.tdmn,
  );
  return [prop];
}
_propertyParser("otst")(_dispatchOtst);

export function _dispatchBtds(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse a text document property from a btds chunk. */
  const prop = parseTextDocument(
    ctx.firstChunk,
    ctx.matchName,
    ctx.childDepth,
    ctx.composition,
    ctx.tdmn,
  );
  return [prop];
}
_propertyParser("btds")(_dispatchBtds);

export function _dispatchOms(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse a shape/mask-path property from an om-s chunk. */
  const prop = parseShape(
    ctx.firstChunk,
    ctx.matchName,
    ctx.childDepth,
    ctx.composition,
    ctx.tdmn,
    ctx.layer,
  );
  return [prop];
}
_propertyParser("om-s")(_dispatchOms);

export function _dispatchGcst(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse a gradient color property from a GCst chunk. */
  const prop = parseGradient(
    ctx.firstChunk,
    ctx.matchName,
    ctx.childDepth,
    ctx.composition,
    ctx.tdmn,
  );
  return [prop];
}
_propertyParser("GCst")(_dispatchGcst);

export function _dispatchMrst(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse markers from a mrst chunk. */
  const prop = parseMarkers(ctx.firstChunk, ctx.composition, ctx.childDepth, ctx.tdmn);
  return [prop];
}
_propertyParser("mrst")(_dispatchMrst);

export function _dispatchOvg2(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /**
   * Parse the Essential Properties override group ("ADBE Layer Overrides").
   *
   * The match-name run holds the `LIST:OvG2` metadata block (override count +
   * controller UUIDs, already parsed at the layer level into
   * `Layer.essentialPropertyUuids`) followed by a sibling `LIST:tdgp` that
   * carries the override properties themselves.
   *
   * All override groups are exposed (media replacement and grouped/regular
   * controllers alike). Leaf properties are re-classed to
   * `_EssentialOverrideProperty` so their derived metadata (enabled, bounds,
   * is_modified) reflects the Essential Graphics source property rather than the
   * override leaf's own partial-copy chunks - the leaf's `value` stays its own.
   */
  const tdgps = [...filterByListType(ctx.chunks, "tdgp")];
  if (tdgps.length === 0) return [];
  const group = parsePropertyGroup(
    tdgps[0],
    ctx.matchName,
    ctx.childDepth,
    ctx.effectParamDefs,
    ctx.composition,
    ctx.tdmn,
    ctx.layer,
  );
  _reclassOverrideLeaves(group);
  return [group];
}
_propertyParser("OvG2")(_dispatchOvg2);

/**
 * Re-class the leaf `Property` children of an override group to
 * `_EssentialOverrideProperty`. Group nodes recurse; any `Property` subclass
 * (e.g. a specialized property) is left as-is - only plain leaves convert.
 */
export function _reclassOverrideLeaves(group: PropertyGroup): void {
  for (const child of group.properties) {
    if (child instanceof PropertyGroup) {
      _reclassOverrideLeaves(child);
    } else if (child.constructor === Property) {
      // NOTE(port): setPrototypeOf is the JS twin of `child.__class__ = ...`; same semantics, only a V8 perf cost.
      Object.setPrototypeOf(child, _EssentialOverrideProperty.prototype);
    }
  }
}

/**
 * Parse a property group.
 *
 * @param tdgp_chunk - The TDGP chunk to parse.
 * @param group_match_name - A special name for the property used to build unique naming paths. The
 *   match name is not displayed, but you can refer to it in scripts. Every property has a unique
 *   match-name identifier. Match names are stable from version to version regardless of the display
 *   name (the name attribute value) or any changes to the application. Unlike the display name, it
 *   is not localized. An indexed group (`PropertyBase.propertyType == PropertyType.indexed_group`)
 *   may not have a name value, but always has a match_name value.
 * @param property_depth - The nesting depth of this group (0 = layer level).
 * @param effect_param_defs - Project-level effect parameter definitions, used as fallback when
 *   layer-level parT chunks are missing.
 * @param composition - The parent composition.
 * @param tdmn - The TDMN chunk for this property group.
 */
export const parsePropertyGroup = _suppressMaterialization().decorate(function parse_property_group(
  tdgpChunk: ListChunk,
  groupMatchName: string,
  propertyDepth: number,
  effectParamDefs: Map<string, Map<string, ParamDef>>,
  composition: CompItem,
  tdmn: TdmnChunk,
  layer: Layer | null = null,
): PropertyGroup {
  const properties = parseProperties(
    getMatchNameRuns(tdgpChunk),
    propertyDepth + 1,
    effectParamDefs,
    composition,
    layer,
  );

  // Try to read the group-level tdsb chunk.
  // Leaf properties always have a tdsb; groups may or may not.
  const groupTdsb = findByTypeOrNull(tdgpChunk.chunks, "tdsb");

  // Resolve _name_utf8 from the tdgp's tdsn child
  let nameUtf8: Utf8Chunk | null;
  try {
    const tdsn = findByType(tdgpChunk.chunks, "tdsn");
    nameUtf8 = tdsn.utf8;
  } catch (e) {
    if (!(e instanceof ChunkNotFoundError)) throw e;
    nameUtf8 = null;
  }

  const propGroup = new PropertyGroup({
    _tdmn: tdmn,
    _tdgp: tdgpChunk,
    _tdsb: groupTdsb,
    _nameUtf8: nameUtf8,
    matchName: groupMatchName,
    propertyDepth: propertyDepth,
    properties,
  });

  return propGroup;
});

/**
 * Parse a mask atom into a MaskPropertyGroup.
 *
 * Combines the child properties from the tdgp chunk with the mask-specific
 * attributes (inverted, locked, mask_mode, color, mask_feather_falloff,
 * mask_motion_blur) parsed from the mkif chunk, and the rotoBezier flag
 * from the ADBE Mask Shape tdsb chunk.
 *
 * @param tdgp_chunk - The tdgp chunk for this mask atom.
 * @param mkif_chunk - The mkif (mask info) chunk containing mask attributes.
 * @param property_depth - The nesting depth of this group.
 * @param effect_param_defs - Project-level effect parameter definitions.
 * @param composition - The parent composition.
 * @param tdmn - The TDMN chunk for this mask atom.
 */
export const _parseMaskAtom = _suppressMaterialization().decorate(function _parse_mask_atom(
  tdgpChunk: ListChunk,
  mkifChunk: MkifChunk,
  propertyDepth: number,
  effectParamDefs: Map<string, Map<string, ParamDef>>,
  composition: CompItem,
  tdmn: TdmnChunk,
  layer: Layer | null = null,
): MaskPropertyGroup {
  const base = parsePropertyGroup(
    tdgpChunk,
    "ADBE Mask Atom",
    propertyDepth,
    effectParamDefs,
    composition,
    tdmn,
    layer,
  );

  // Extract the mask shape's tdsb for the roto_bezier descriptor.
  let maskShapeTdsb: TdsbChunk | null = null;
  const chunksByMn = getChunksByMatchName(tdgpChunk);
  const maskShapeChunks = chunksByMn.get("ADBE Mask Shape") ?? [];
  for (const chunk of maskShapeChunks) {
    if (chunk instanceof ListChunk && chunk.listType === "om-s") {
      const tdbs = findByListTypeOrNull(chunk.chunks, "tdbs");
      const tdsb = tdbs === null ? null : findByTypeOrNull(tdbs.chunks, "tdsb");
      if (tdsb !== null) maskShapeTdsb = tdsb;
      break;
    }
  }

  const maskGroup = new MaskPropertyGroup({
    _tdmn: tdmn,
    _tdgp: tdgpChunk,
    _tdsb: base._tdsb,
    _nameUtf8: base._nameUtf8,
    _mkif: mkifChunk,
    _maskShapeTdsb: maskShapeTdsb,
    matchName: base.matchName,
    propertyDepth: base.propertyDepth,
    properties: base.properties,
  });
  maskGroup._propertyType = base.propertyType;
  maskGroup._isMask = true;
  return maskGroup;
});
