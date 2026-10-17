/** Property group and mask parsers with registry-based dispatch. */

import { ListChunk } from "../binary/chunk.ts";
import type { Chunk } from "../binary/chunk.ts";
import type { MkifChunk } from "../binary/misc_chunks.ts";
import type { TdmnChunk, TdsbChunk } from "../binary/property_chunks.ts";
import type { Utf8Chunk } from "../binary/scalar_chunks.ts";
import { ChunkNotFoundError, filter_by_list_type, filter_by_type, find_by_list_type_or_null, find_by_type, find_by_type_or_null } from "../binary/utils.ts";
import { VF_AXIS_PREFIX } from "../data/match_names.ts";
import { _suppress_materialization } from "../models/descriptors.ts";
import { MaskPropertyGroup } from "../models/properties/mask_property_group.ts";
import { PropertyGroup } from "../models/properties/property_group.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { Layer } from "../models/layers/layer.ts";
import { parse_effect } from "./effect.ts";
import type { ParamDef } from "./effect.ts";
import { parse_markers } from "./marker.ts";
import { parse_property } from "./property_value.ts";
import { parse_gradient, parse_orientation, parse_shape, parse_text_document } from "./specialized_properties.ts";
import { get_chunks_by_match_name, get_match_name_runs } from "./utils.ts";
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
  readonly match_name: string;

  /** All chunks of the match-name group (tdmn + bodies + auxiliaries). */
  readonly chunks: Chunk[];

  /** The first LIST chunk of the group (selects the dispatcher). */
  readonly first_chunk: ListChunk;

  readonly child_depth: number;

  readonly effect_param_defs: Map<string, Map<string, ParamDef>>;

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
    match_name: string,
    chunks: Chunk[],
    first_chunk: ListChunk,
    child_depth: number,
    effect_param_defs: Map<string, Map<string, ParamDef>>,
    composition: CompItem,
    layer: Layer | null = null,
  ) {
    this.match_name = match_name;
    this.chunks = chunks;
    this.first_chunk = first_chunk;
    this.child_depth = child_depth;
    this.effect_param_defs = effect_param_defs;
    this.composition = composition;
    this.layer = layer;
  }

  *[Symbol.iterator](): Generator<
    _ParseContext[
      "match_name" | "chunks" | "first_chunk" | "child_depth" | "effect_param_defs" | "composition" | "layer"
    ]
  > {
    yield this.match_name;
    yield this.chunks;
    yield this.first_chunk;
    yield this.child_depth;
    yield this.effect_param_defs;
    yield this.composition;
    yield this.layer;
  }

  /** The group's first match-name chunk. */
  get tdmn(): TdmnChunk {
    return find_by_type(this.chunks, "tdmn");
  }
}

export const _PROPERTY_PARSERS: Map<string, (ctx: _ParseContext) => (Property | PropertyGroup)[]> =
  new Map();

/** Register a property parser for the given LIST subtype. */
export function _property_parser(
  list_type: string,
): (
  func: (ctx: _ParseContext) => (Property | PropertyGroup)[],
) => (ctx: _ParseContext) => (Property | PropertyGroup)[] {
  return function decorator(func) {
    _PROPERTY_PARSERS.set(list_type, func);
    return func;
  };
}

/**
 * Dispatch sub-property chunks into parsed Property/PropertyGroup items.
 *
 * Iterates each match-name run, finds the first LIST chunk, and
 * dispatches to the appropriate parser based on its list type.
 *
 * @param match_name_runs - Sub-property chunks grouped into ordered match-name runs (from
 *   `get_match_name_runs`).
 * @param child_depth - The property depth for parsed child properties.
 * @param effect_param_defs - Project-level effect parameter definitions.
 * @param composition - The parent composition.
 * @param layer - The owning layer, for mask paths and effect point denormalization.
 * @returns Ordered list of parsed properties and property groups.
 */
export function parse_properties(
  match_name_runs: [string, Chunk[]][],
  child_depth: number,
  effect_param_defs: Map<string, Map<string, ParamDef>>,
  composition: CompItem,
  layer: Layer | null = null,
): (Property | PropertyGroup)[] {
  const properties: (Property | PropertyGroup)[] = [];
  for (const [match_name, sub_prop_chunks] of match_name_runs) {
    // Find the first LIST chunk; non-LIST chunks (e.g. mkif for masks)
    // are auxiliary data that we skip when determining the property type.
    let first_chunk: ListChunk | null = null;
    for (const c of sub_prop_chunks) {
      if (c instanceof ListChunk) {
        first_chunk = c;
        break;
      }
    }
    if (first_chunk == null) continue;

    const list_type = first_chunk.list_type;
    const handler = _PROPERTY_PARSERS.get(list_type);
    if (handler != null) {
      properties.push(
        ...handler(
          new _ParseContext(
            match_name,
            sub_prop_chunks,
            first_chunk,
            child_depth,
            effect_param_defs,
            composition,
            layer,
          ),
        ),
      );
    } else {
      logger.warning(
        `Skipping unsupported property list type '${list_type}' (match name '${match_name}')`,
      );
    }
  }

  return properties;
}

export function _dispatch_sspc(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse effect chunks - iterates all sspc LISTs for the match name. */
  const tdmns = filter_by_type(ctx.chunks, "tdmn");
  const sspcs = filter_by_list_type(ctx.chunks, "sspc");
  const results: (Property | PropertyGroup)[] = [];
  for (const [tdmn, sspc] of zip(tdmns, sspcs)) {
    const effect = parse_effect(
      sspc,
      ctx.match_name,
      ctx.child_depth,
      ctx.effect_param_defs,
      ctx.composition,
      tdmn,
      ctx.layer,
    );
    results.push(effect);
  }
  return results;
}
_property_parser("sspc")(_dispatch_sspc);

export function _dispatch_tdgp(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse property group chunks - handles masks and indexed groups. */
  const tdmns = filter_by_type(ctx.chunks, "tdmn");
  if (ctx.match_name === "ADBE Mask Atom") {
    const tdgps = [...filter_by_list_type(ctx.chunks, "tdgp")];
    const mkifs = [...filter_by_type(ctx.chunks, "mkif")];
    const masks: (Property | PropertyGroup)[] = [];
    for (const [i, [tdmn, tdgp_c, mkif_c]] of zip(tdmns, tdgps, mkifs).entries()) {
      const mask = _parse_mask_atom(
        tdgp_c,
        mkif_c,
        ctx.child_depth,
        ctx.effect_param_defs,
        ctx.composition,
        tdmn,
        ctx.layer,
      );
      mask._auto_name = `Mask ${i + 1}`;
      masks.push(mask);
    }
    return masks;
  }
  const tdgps = [...filter_by_list_type(ctx.chunks, "tdgp")];
  const results: (Property | PropertyGroup)[] = [];
  for (const [tdmn, tdgp_c] of zip(tdmns, tdgps)) {
    const group = parse_property_group(
      tdgp_c,
      ctx.match_name,
      ctx.child_depth,
      ctx.effect_param_defs,
      ctx.composition,
      tdmn,
      ctx.layer,
    );
    results.push(group);
  }
  return results;
}
_property_parser("tdgp")(_dispatch_tdgp);

export function _dispatch_tdbs(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse a leaf property from a tdbs chunk. */
  const prop = parse_property(
    ctx.first_chunk,
    ctx.match_name,
    ctx.composition,
    ctx.child_depth,
    ctx.tdmn,
  );
  // A media-replacement slot (`ADBE Layer Source Alternate`) carries blsv/blsi
  // beside its tdbs in the group run; attach them so the Property can decode
  // `can_set_alternate_source` / `alternate_source`. Gated on the match name
  // so the scans do not run for every leaf on the hot parse path.
  if (ctx.match_name === "ADBE Layer Source Alternate") {
    const blsi = filter_by_type(ctx.chunks, "blsi");
    if (blsi?.length > 0) {
      prop._blsi = blsi[0];
      const blsv = filter_by_type(ctx.chunks, "blsv");
      if (blsv?.length > 0) {
        prop._blsv = blsv[0];
      }
    }
  }
  // AE 26+ writes a vfdn sibling (the axis display name from the font)
  // after an active variable-font axis slot's tdbs.
  if (ctx.match_name.startsWith(VF_AXIS_PREFIX)) {
    const vfdn = filter_by_type(ctx.chunks, "vfdn");
    if (vfdn?.length > 0) {
      prop._vfdn = vfdn[0];
    }
  }
  // Curves keeps its curves as the effect's arbitrary data, an aRbp in a
  // LIST:aRbs after the tdbs (whose cdat holds nothing of them): one per
  // keyframe when the curves are keyed.
  if (ctx.match_name === "ADBE CurvesCustom-0001") {
    const arbs = filter_by_list_type(ctx.chunks, "aRbs");
    if (arbs?.length > 0) {
      prop._arbs = arbs[0];
    }
  }
  return [prop];
}
_property_parser("tdbs")(_dispatch_tdbs);

export function _dispatch_otst(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse an orientation property from an otst chunk. */
  const prop = parse_orientation(
    ctx.first_chunk,
    ctx.match_name,
    ctx.child_depth,
    ctx.composition,
    ctx.tdmn,
  );
  return [prop];
}
_property_parser("otst")(_dispatch_otst);

export function _dispatch_btds(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse a text document property from a btds chunk. */
  const prop = parse_text_document(
    ctx.first_chunk,
    ctx.match_name,
    ctx.child_depth,
    ctx.composition,
    ctx.tdmn,
  );
  return [prop];
}
_property_parser("btds")(_dispatch_btds);

export function _dispatch_oms(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse a shape/mask-path property from an om-s chunk. */
  const prop = parse_shape(
    ctx.first_chunk,
    ctx.match_name,
    ctx.child_depth,
    ctx.composition,
    ctx.tdmn,
    ctx.layer,
  );
  return [prop];
}
_property_parser("om-s")(_dispatch_oms);

export function _dispatch_gcst(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse a gradient color property from a GCst chunk. */
  const prop = parse_gradient(
    ctx.first_chunk,
    ctx.match_name,
    ctx.child_depth,
    ctx.composition,
    ctx.tdmn,
  );
  return [prop];
}
_property_parser("GCst")(_dispatch_gcst);

export function _dispatch_mrst(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /** Parse markers from a mrst chunk. */
  const prop = parse_markers(ctx.first_chunk, ctx.composition, ctx.child_depth, ctx.tdmn);
  return [prop];
}
_property_parser("mrst")(_dispatch_mrst);

export function _dispatch_ovg2(ctx: _ParseContext): (Property | PropertyGroup)[] {
  /**
   * Parse the Essential Properties override group ("ADBE Layer Overrides").
   *
   * The match-name run holds the `LIST:OvG2` metadata block (override count +
   * controller UUIDs, already parsed at the layer level into
   * `Layer.essential_property_uuids`) followed by a sibling `LIST:tdgp` that
   * carries the override properties themselves.
   *
   * All override groups are exposed (media replacement and grouped/regular
   * controllers alike). Leaf properties are re-classed to
   * `_EssentialOverrideProperty` so their derived metadata (enabled, bounds,
   * is_modified) reflects the Essential Graphics source property rather than the
   * override leaf's own partial-copy chunks - the leaf's `value` stays its own.
   */
  const tdgps = [...filter_by_list_type(ctx.chunks, "tdgp")];
  if (tdgps.length === 0) return [];
  const group = parse_property_group(
    tdgps[0],
    ctx.match_name,
    ctx.child_depth,
    ctx.effect_param_defs,
    ctx.composition,
    ctx.tdmn,
    ctx.layer,
  );
  _reclass_override_leaves(group);
  return [group];
}
_property_parser("OvG2")(_dispatch_ovg2);

/**
 * Re-class the leaf `Property` children of an override group to
 * `_EssentialOverrideProperty`. Group nodes recurse; any `Property` subclass
 * (e.g. a specialized property) is left as-is - only plain leaves convert.
 */
export function _reclass_override_leaves(group: PropertyGroup): void {
  for (const child of group.properties) {
    if (child instanceof PropertyGroup) {
      _reclass_override_leaves(child);
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
 *   is not localized. An indexed group (`PropertyBase.property_type == PropertyType.indexed_group`)
 *   may not have a name value, but always has a match_name value.
 * @param property_depth - The nesting depth of this group (0 = layer level).
 * @param effect_param_defs - Project-level effect parameter definitions, used as fallback when
 *   layer-level parT chunks are missing.
 * @param composition - The parent composition.
 * @param tdmn - The TDMN chunk for this property group.
 */
export const parse_property_group = _suppress_materialization().decorate(function parse_property_group(
  tdgp_chunk: ListChunk,
  group_match_name: string,
  property_depth: number,
  effect_param_defs: Map<string, Map<string, ParamDef>>,
  composition: CompItem,
  tdmn: TdmnChunk,
  layer: Layer | null = null,
): PropertyGroup {
  const properties = parse_properties(
    get_match_name_runs(tdgp_chunk),
    property_depth + 1,
    effect_param_defs,
    composition,
    layer,
  );

  // Try to read the group-level tdsb chunk.
  // Leaf properties always have a tdsb; groups may or may not.
  const group_tdsb = find_by_type_or_null(tdgp_chunk.chunks, "tdsb");

  // Resolve _name_utf8 from the tdgp's tdsn child
  let name_utf8: Utf8Chunk | null;
  try {
    const tdsn = find_by_type(tdgp_chunk.chunks, "tdsn");
    name_utf8 = tdsn.utf8;
  } catch (e) {
    if (!(e instanceof ChunkNotFoundError)) throw e;
    name_utf8 = null;
  }

  const prop_group = new PropertyGroup({
    _tdmn: tdmn,
    _tdgp: tdgp_chunk,
    _tdsb: group_tdsb,
    _name_utf8: name_utf8,
    match_name: group_match_name,
    property_depth,
    properties,
  });

  return prop_group;
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
export const _parse_mask_atom = _suppress_materialization().decorate(function _parse_mask_atom(
  tdgp_chunk: ListChunk,
  mkif_chunk: MkifChunk,
  property_depth: number,
  effect_param_defs: Map<string, Map<string, ParamDef>>,
  composition: CompItem,
  tdmn: TdmnChunk,
  layer: Layer | null = null,
): MaskPropertyGroup {
  const base = parse_property_group(
    tdgp_chunk,
    "ADBE Mask Atom",
    property_depth,
    effect_param_defs,
    composition,
    tdmn,
    layer,
  );

  // Extract the mask shape's tdsb for the roto_bezier descriptor.
  let mask_shape_tdsb: TdsbChunk | null = null;
  const chunks_by_mn = get_chunks_by_match_name(tdgp_chunk);
  const mask_shape_chunks = chunks_by_mn.get("ADBE Mask Shape") ?? [];
  for (const chunk of mask_shape_chunks) {
    if (chunk instanceof ListChunk && chunk.list_type === "om-s") {
      const tdbs = find_by_list_type_or_null(chunk.chunks, "tdbs");
      const tdsb = tdbs === null ? null : find_by_type_or_null(tdbs.chunks, "tdsb");
      if (tdsb !== null) mask_shape_tdsb = tdsb;
      break;
    }
  }

  const mask_group = new MaskPropertyGroup({
    _tdmn: tdmn,
    _tdgp: tdgp_chunk,
    _tdsb: base._tdsb,
    _name_utf8: base._name_utf8,
    _mkif: mkif_chunk,
    _mask_shape_tdsb: mask_shape_tdsb,
    match_name: base.match_name,
    property_depth: base.property_depth,
    properties: base.properties,
  });
  mask_group._property_type = base.property_type;
  mask_group._is_mask = true;
  return mask_group;
});
