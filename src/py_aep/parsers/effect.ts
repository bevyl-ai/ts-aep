/** Effect and parameter definition parsers. */

import { ListChunk, type Chunk } from "../binary/chunk.ts";
import type { AnglePardChunk, BooleanPardChunk, ColorPardChunk, EnumPardChunk, IntegerPardChunk, PardChunk, ScalarPardChunk, SliderPardChunk, ThreeDPardChunk, TwoDPardChunk } from "../binary/misc_chunks.ts";
import type { TdmnChunk } from "../binary/property_chunks.ts";
import { ChunkNotFoundError, filter_by_list_type, filter_by_type, find_by_list_type, find_by_list_type_or_null, find_by_type, find_by_type_or_null, index_by_identity } from "../binary/utils.ts";
import { MATCH_NAME_TO_AUTO_NAME } from "../data/match_names.ts";
import { EFFECT_PARAM_SPATIAL_FLAGS } from "../data/spatial_flags.ts";
import { PropertyControlType, PropertyType, PropertyValueType } from "../enums/index.ts";
import { _suppress_materialization } from "../models/descriptors.ts";
import { _CANVARY_OVERRIDES, _PROPERTY_DEFAULTS } from "../models/properties/overrides.ts";
import { Property } from "../models/properties/property.ts";
import type { PropertyValue } from "../models/properties/keyframe.ts";
import { PropertyGroup } from "../models/properties/property_group.ts";
import { PropSpec } from "../synthesis/property.ts";
import { get_chunks_by_match_name, get_match_name_runs } from "./utils.ts";
import type { CompItem } from "../models/items/composition.ts";
import type { Layer } from "../models/layers/layer.ts";
import type { Project } from "../models/project.ts";
import {
  and,
  at,
  deferred,
  int,
  split,
  strip,
  warn,
  decode,
  encode,
  LookupError,
  UnicodeDecodeError,
} from "../../pyrt/index.ts";

const _property = deferred<typeof import("./property.ts")>("py_aep/parsers/property");

// `logging.getLogger(__name__)`: this module logs nothing today, so only the
// warning path is wired to pyrt `warn`.
export const logger = {
  debug() {},
  info() {},
  warning: (m: string) => warn(m),
};

/**
 * A parsed pard parameter definition. The first four fields come from every
 * pard; the rest only from the control types whose extractor sets them.
 */
export interface ParamDef {
  name: string;
  property_control_type: PropertyControlType;
  can_vary_over_time: boolean;
  expressions_disabled: boolean;
  property_value_type?: PropertyValueType;
  last_value?: number | number[];
  default_value?: number | number[];
  /** A scalar default that only seeds the value when `default_value` is absent. */
  default?: number;
  min_value?: number;
  max_value?: number;
  slider_min?: number;
  slider_max?: number;
  nb_options?: number;
  units_text?: "percent";
  /** The ENUM option labels (`pdnm`, split on `|`). */
  property_parameters?: string[];
  /** The Curves effect's untouched `aRbp` chunk. */
  default_arbp?: Chunk;
}

/** A parameter's value or default as its definition gives it. */
export type ParamValue = number | number[] | null;


export const _PVT_DIMENSIONS: Map<number, number> = new Map<number, number>([
  [PropertyValueType.COLOR, 4],
  [PropertyValueType.ThreeD_SPATIAL, 3],
  [PropertyValueType.TwoD_SPATIAL, 2],
]);

/**
 * Convert an effect parameter definition into a `PropSpec`.
 *
 * @param match_name - The property's match name.
 * @param param_def - The parameter definition from parT parsing.
 * @returns A `PropSpec` suitable for `Property._new()`.
 */
export function _param_def_to_spec(match_name: string, param_def: ParamDef): PropSpec {
  const pvt = param_def.property_value_type ?? PropertyValueType.OneD;
  const control_type = param_def.property_control_type;
  const is_color = control_type === PropertyControlType.COLOR;
  const dims = _PVT_DIMENSIONS.get(pvt) ?? 1;
  const is_spatial =
    pvt === PropertyValueType.TwoD_SPATIAL || pvt === PropertyValueType.ThreeD_SPATIAL || is_color;
  const [value, default_value] = _resolve_effect_value(match_name, param_def, control_type);
  // PropSpec is a NamedTuple: positional, in field order. Skipped optional
  // fields are passed as `undefined` so their defaults apply.
  return new PropSpec(
    match_name,
    param_def.name || match_name,
    value,
    pvt,
    dims,
    is_spatial,
    is_color,
    control_type === PropertyControlType.INTEGER,
    undefined,
    undefined,
    default_value,
    control_type !== PropertyControlType.MASK,
    undefined,
    undefined,
    EFFECT_PARAM_SPATIAL_FLAGS.get(control_type) ?? null,
  );
}

/**
 * Resolve value and default_value for a synthesized effect property.
 *
 * Returns pre-rescale values - point defaults stay in percent of the
 * layer size; `_normalize_synthetic_point` stores them as fractions.
 *
 * @param match_name - The property's match name.
 * @param param_def - The parameter definition from parT parsing.
 * @param control_type - The effect control type.
 * @returns A [value, default_value] pair.
 */
export function _resolve_effect_value(
  match_name: string,
  param_def: Pick<ParamDef, "default_value" | "last_value" | "default" | "nb_options">,
  control_type: PropertyControlType,
): [ParamValue, ParamValue] {
  if (control_type === PropertyControlType.ENUM) {
    // An omitted popup holds its pard default (1-based), not the value
    // cached in the definition: ExtendScript reports the default for
    // S_BlurDirectional's Edge Mode (cached 1, default 3). A cached
    // value beyond the choice count is managed by the plug-in (the OCIO
    // transforms keep hashed ids there, which ExtendScript reports) and
    // is kept.
    let value = param_def.default_value ?? null;
    // An ENUM's cached value is its 1-based choice, always a number.
    const last = param_def.last_value ?? null;
    if (typeof last === "number" && (value == null || last > (param_def.nb_options ?? 0))) {
      value = last;
    }
    return [value, value];
  }
  if (control_type === PropertyControlType.TWO_D || control_type === PropertyControlType.THREE_D) {
    // An omitted point is its pard default, a percentage of the layer
    // size. The cached value is that same percentage or a 16.16-rounded
    // fraction: Path Text's 80 % caches 0.7999878, ExtendScript reports
    // exactly 80 on a 100-pixel layer.
    const value = param_def.default_value ?? null;
    return [value, value];
  }
  // Any other control: AE leaves a parameter at its default out of the
  // effect's tdgp, so an omitted one is at the default its pard declares,
  // then the override table's, then the pard `default` field. The cached
  // `last_value` is not the value: it is the value of whichever instance
  // wrote the definition (another one when the definition is borrowed),
  // or stale - S_BlurDirectional's Bias caches 0 where ExtendScript
  // reports 0.5. It only stands in for a pard that declares no default.
  let value = param_def.default_value ?? null;
  if (value == null) value = _PROPERTY_DEFAULTS.get(match_name) ?? null;
  if (value == null) value = param_def.default ?? null;
  if (value == null) value = param_def.last_value ?? null;
  return [value, value];
}

/**
 * Apply parameter definition metadata to a property.
 *
 * Sets last_value, min/max bounds, nb_options, and
 * property_parameters from the parameter definition.  Shared by
 * `_synthesize_effect_property` and `_merge_param_def`.
 *
 * @param prop - The property to update in place.
 * @param param_def - The parameter definition.
 */
export function _apply_param_def_metadata(prop: Property, param_def: ParamDef): void {
  prop.lastValue = param_def.last_value ?? null;
  const min_val = param_def.min_value ?? null;
  if (min_val != null) prop._min_value_fallback = min_val;
  const max_val = param_def.max_value ?? null;
  if (max_val != null) prop._max_value_fallback = max_val;
  // The pard UI slider range - distinct from the valid range and the
  // source of an Essential Graphics slider controller's Smin/Smax.
  prop._slider_min = param_def.slider_min ?? null;
  prop._slider_max = param_def.slider_max ?? null;
  // Popup-only: written when present, so other properties keep the class
  // default (`null`).
  const nb_options = param_def.nb_options ?? null;
  if (nb_options != null) prop.nbOptions = nb_options;
  // Direct write: the public setter has user-write semantics (validation
  // plus pdnm/pard chunk rewrites).
  const property_parameters = param_def.property_parameters ?? null;
  if (property_parameters != null) prop._property_parameters = property_parameters;
  const units = param_def.units_text ?? null;
  if (units != null) prop._units_text = units;
  // The pard param flags carry the authoritative can-vary bit; the
  // residue table keeps the rare params where they disagree with
  // ExtendScript (e.g. the Puppet Engine dropdown).
  if (!_CANVARY_OVERRIDES.has(prop.matchName)) {
    prop._can_vary_over_time = param_def.can_vary_over_time;
  }
  if (param_def.expressions_disabled) {
    prop._expressions_disabled = true;
  }
}

/**
 * A point parameter's pard default (percent of the layer) as the fraction
 * its `cdat` stores, or `null` when it is not a point.
 */
export function _point_fraction(raw: PropertyValue): number[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  return raw.map((v) => v / 100.0);
}

export function _point_pixels(prop: Property, fraction: number[]): PropertyValue {
  return prop._resolve_value([...fraction]);
}

/**
 * Give a point parameter its pard default, read like its stored value.
 *
 * The default is a percentage of the LAYER (the composition for an
 * adjustment layer, `Property._effect_scale`), so it follows the layer's
 * current size as the stored point does. Measured in AE 2026: an untouched
 * Gradient Ramp `End of Ramp` (pard default 50 %, 100 %) reports [100, 100]
 * on a 200x100 layer in an 800x600 comp, and [128, 256] on a 256x256 layer
 * in a 512x512 comp; a fresh Point Control on a 200x100 solid reports
 * [100, 50], then [200, 50] once the solid is 400 wide and [960, 540] once
 * it is an adjustment layer in a 1920x1080 comp - unmodified throughout.
 */
export function _bind_point_default(prop: Property, raw: PropertyValue): void {
  const fraction = _point_fraction(raw);
  if (fraction != null) prop._default_value_source = () => _point_pixels(prop, fraction);
}

/**
 * Keep a synthesized point as the fraction AE stores, read through the
 * layer's current size, with the default `_bind_point_default` gives.
 */
export function _normalize_synthetic_point(prop: Property): void {
  const raw = prop._value;
  const fraction = _point_fraction(raw);
  if (fraction == null || prop._cdat == null) return;
  prop._cdat.values = fraction;
  prop._value = null;
  _bind_point_default(prop, raw);
}

/**
 * Parse effect parameter definitions from parT chunk.
 *
 * Each effect has a parT LIST containing parameter definitions that
 * describe the control type, default values, and ranges.
 *
 * @param sspc_child_chunks - The SSPC chunk's child chunks.
 * @param code_page - The project's system code page (`nnhd`), which older
 *   projects store parameter names in.
 * @returns Map of parameter match names to definition dicts.
 */
export function parse_effect_param_defs(
  sspc_child_chunks: Chunk[],
  code_page: number,
): Map<string, ParamDef> {
  const part_chunk = find_by_list_type(sspc_child_chunks, "parT");
  const param_defs = new Map<string, ParamDef>();

  const chunks_by_parameter = get_chunks_by_match_name(part_chunk);
  for (const [index, [match_name, parameter_chunks]] of [...chunks_by_parameter].entries()) {
    // Skip first, it describes parent
    if (index === 0) continue;
    const param_def = _parse_effect_parameter_def(parameter_chunks, code_page);
    if (_UNBOUNDED_CHECKBOXES.has(match_name)) {
      delete param_def.min_value;
      delete param_def.max_value;
    }
    param_defs.set(match_name, param_def);
  }

  return param_defs;
}

// Checkboxes AE 2026 reports without min / max. Nothing in their pard sets
// them apart: the other 2067 checkboxes of the effect samples, including
// ones with the same flags, are bounded 0-1.
export const _UNBOUNDED_CHECKBOXES: ReadonlySet<string> = new Set<string>([
  "ADBE Paint On Transparent",
  "ADBE FreePin3 On Transparent",
]);

// Codecs of the `nnhd` code pages that are not `cp<number>`.
export const _CODE_PAGE_CODECS: Map<number, string> = new Map<number, string>([
  [0x0100, "mac_roman"],
]);

/**
 * A `pard` name in the project's code page.
 *
 * The chunk decodes the name as UTF-8 (keeping other bytes as surrogates
 * for the round trip), but projects saved before AE 26 store it in the
 * system code page: "Set Red To Source 1's" holds 0x92 in a Windows
 * (1252) project. Names that are valid UTF-8 are returned as they are.
 */
export function _decode_pard_name(name: string, code_page: number): string {
  if (!/[\udc80-\udcff]/u.test(name)) return name;
  const codec = _CODE_PAGE_CODECS.get(code_page) ?? `cp${code_page}`;
  try {
    return decode(encode(name, "utf-8", "surrogateescape"), codec);
  } catch (e) {
    if (!(e instanceof LookupError || e instanceof UnicodeDecodeError)) throw e;
    return name;
  }
}

/**
 * Merge parameter definition values into a parsed property.
 *
 * Overrides auto-detected property attributes with the more precise
 * values from the effect's parameter definition.
 *
 * @param prop - The property to update in place.
 * @param param_def - The parameter definition.
 */
export function _merge_param_def(prop: Property, param_def: ParamDef): void {
  prop._auto_name = param_def.name || prop._auto_name;
  prop._property_control_type = param_def.property_control_type;
  if (prop._arbs != null && param_def.default_arbp !== undefined) {
    prop._default_arbp = param_def.default_arbp;
  }
  prop._property_value_type = param_def.property_value_type ?? prop.propertyValueType;
  // Prefer the override table, then the pard default field. For LAYER
  // references, pard stores a meaningless 0 and we have no static
  // override, so leave default_value unset entirely.
  let static_default = _PROPERTY_DEFAULTS.get(prop.matchName) ?? null;
  if (static_default == null) static_default = param_def.default ?? null;
  if (static_default != null) {
    prop.defaultValue = static_default;
  } else if (
    param_def.property_control_type === PropertyControlType.TWO_D ||
    param_def.property_control_type === PropertyControlType.THREE_D
  ) {
    _bind_point_default(prop, param_def.default_value ?? null);
  } else if (param_def.property_control_type !== PropertyControlType.LAYER) {
    prop.defaultValue = param_def.default_value ?? null;
  }
  _apply_param_def_metadata(prop, param_def);
}

/**
 * Create a default Property from an effect parameter definition.
 *
 * When effect parameters are at their default value, AE omits them from
 * the binary tdgp chunk.  This function builds a Property (or, for group
 * separators, a PropertyGroup) from the parT definition so the parsed
 * output matches what ExtendScript reports.
 *
 * @param match_name - The property's match name.
 * @param param_def - The parameter definition from parT parsing.
 * @param property_depth - The nesting depth for this property.
 * @param kw - Keyword arguments:
 * - `parent_property`: The effect group that owns the synthesized child.
 * @returns A Property or PropertyGroup with default values.
 */
export function _synthesize_effect_property(
  match_name: string,
  param_def: ParamDef,
  property_depth: number,
  kw: { parent_property: PropertyGroup },
): Property | PropertyGroup {
  const { parent_property } = kw;
  const control_type = param_def.property_control_type;
  const pvt = param_def.property_value_type ?? PropertyValueType.OneD;

  if (pvt === PropertyValueType.NO_VALUE) {
    const display = param_def.name || (MATCH_NAME_TO_AUTO_NAME.get(match_name) ?? "");
    return PropertyGroup._new(match_name, display, property_depth, {
      parent_property,
      synthetic: true,
    });
  }

  const spec = _param_def_to_spec(match_name, param_def);
  const prop = Property._new(spec, property_depth, {
    parent_property,
    control_type,
    synthetic: true,
  });
  _apply_param_def_metadata(prop, param_def);
  return prop;
}

/**
 * Parse effect properties and merge with parameter definitions.
 *
 * Walks `param_defs` in canonical order, merging parsed binary
 * properties or synthesizing missing ones in a single pass.  Tail
 * children not in `param_defs` (e.g. Compositing Options) are appended
 * in their original parsed order.
 *
 * @param tdgp_chunk - The tdgp chunk containing property data.
 * @param param_defs - Parameter definitions to merge into properties.
 * @param child_depth - The property depth for parsed child properties.
 * @param composition - The parent composition.
 * @param parent_property - The effect group that owns the parsed children.
 * @returns List of parsed and merged properties.
 */
export function _parse_effect_properties(
  tdgp_chunk: ListChunk,
  param_defs: Map<string, ParamDef>,
  child_depth: number,
  composition: CompItem,
  parent_property: PropertyGroup,
  group_match_name = "",
  layer: Layer | null = null,
): (Property | PropertyGroup)[] {
  // Skip index-0 internal parameters (not exposed in ExtendScript).
  const property_runs = [...get_match_name_runs(tdgp_chunk)].filter(
    ([name]) => !name.endsWith("-0000"),
  );

  const parsed = _property().parse_properties(
    property_runs,
    child_depth,
    new Map(),
    composition,
    layer,
  );

  // Index parsed children by match_name for O(1) lookup.
  const parsed_by_mn = new Map<string, Property | PropertyGroup>(
    parsed.map((p): [string, Property | PropertyGroup] => [p.matchName, p]),
  );

  // Single ordered walk over param_defs: merge existing or synthesize
  // missing, producing children in canonical parT order.
  const ordered: (Property | PropertyGroup)[] = [];
  for (const [match_name, param_def] of param_defs) {
    const existing = parsed_by_mn.get(match_name) ?? null;
    if (existing != null) {
      if (existing instanceof Property) {
        _merge_param_def(existing, param_def);
      }
      ordered.push(existing);
    } else {
      const synth = _synthesize_effect_property(match_name, param_def, child_depth, {
        parent_property,
      });
      if (
        synth instanceof Property &&
        (synth._property_control_type === PropertyControlType.TWO_D ||
          synth._property_control_type === PropertyControlType.THREE_D)
      ) {
        _normalize_synthetic_point(synth);
      }
      ordered.push(synth);
    }
  }

  // Append tail children not in param_defs (e.g. ADBE Effect Built In
  // Params) in their original parsed order.
  for (const child of parsed) {
    if (!param_defs.has(child.matchName)) ordered.push(child);
  }

  // Synthesize Compositing Options group when absent from the binary.
  // synthesize_children() will fill it from _COMPOSITING_OPTIONS_SPECS.
  if (!ordered.some((c) => c.matchName === "ADBE Effect Built In Params")) {
    ordered.push(
      PropertyGroup._new("ADBE Effect Built In Params", "Compositing Options", child_depth, {
        parent_property,
        synthetic: true,
      }),
    );
  }

  return ordered;
}

export const _ITEM_CONTAINERS: ReadonlySet<string> = new Set(["Fold", "Item", "Sfdr"]);

/**
 * Every effect instance under `chunks` (folder, item or layer lists) as
 * `(match name, sspc)`, in file order. Only the layers' Effects groups are
 * decoded.
 */
export function* _effect_instances(chunks: Chunk[]): Generator<[string, ListChunk]> {
  for (const chunk of chunks) {
    if (!(chunk instanceof ListChunk)) continue;
    const list_type = chunk.list_type;
    if (_ITEM_CONTAINERS.has(list_type)) {
      yield* _effect_instances(chunk.chunks);
    } else if (list_type === "Layr") {
      const root = filter_by_list_type(chunk.chunks, "tdgp");
      const parade = get_chunks_by_match_name(at(root, 0)).get("ADBE Effect Parade");
      const effects = filter_by_list_type(parade ?? [], "tdgp");
      if (effects.length === 0) continue;
      for (const [name, run] of get_chunks_by_match_name(effects[0])) {
        for (const sspc of filter_by_list_type(run, "sspc")) {
          yield [name, sspc];
        }
      }
    }
  }
}

/** The instance's `parT`, if it holds its effect's definitions. */
export function _held_definitions(sspc: ListChunk): ListChunk | null {
  const parts = filter_by_list_type(sspc.chunks, "parT");
  return parts.length > 0 && parts[0].chunks.length > 0 ? parts[0] : null;
}

/**
 * The parameter definitions of effect `match_name` from the instance in
 * the project that holds them.
 *
 * AE writes an effect's `parT` in its first instance in file order only and
 * leaves the others' empty (every effect used more than once in samples/,
 * AE 15 to 26); a project saved by an older version (AE 15 in samples/) has
 * no `LIST:EfdG` to hold them instead.
 */
export function _project_param_defs(composition: CompItem, match_name: string): Map<string, ParamDef> {
  const project = composition._project;
  for (const [name, sspc] of _effect_instances(project._rifx.chunks)) {
    if (name === match_name && _held_definitions(sspc) != null) {
      return parse_effect_param_defs(sspc.chunks, project._nnhd._system_code_page);
    }
  }
  return new Map();
}

/**
 * Hand the definitions held by `removed` effect instances to the first
 * remaining instance of each effect, where AE keeps them (see
 * `_project_param_defs`); AE 15 and AE 2026 write them there on their own
 * save. AE rewrites the instance-specific bytes of each `pard` (UI flags
 * such as disabled, last values) when it saves; a moved `parT` keeps the
 * removed instance's, which AE 15 opens with the same parameters.
 *
 * Only a project without `LIST:EfdG` needs it: nothing else holds the
 * definitions there, so the other instances would reopen without them.
 */
export function rehome_effect_definitions(project: Project, removed: Iterable<[string, ListChunk]>): void {
  const root_chunks = project._rifx.chunks;
  if (filter_by_list_type(root_chunks, "EfdG").length > 0) return;
  const held = new Map<string, ListChunk>();
  for (const [name, sspc] of removed) {
    const part = _held_definitions(sspc);
    if (part != null && !held.has(name)) held.set(name, part);
  }
  if (held.size === 0) return;
  for (const [name, sspc] of _effect_instances(root_chunks)) {
    const part = held.get(name) ?? null;
    held.delete(name);
    if (part != null) {
      const parts = filter_by_list_type(sspc.chunks, "parT");
      if (parts.length > 0 && parts[0].chunks.length === 0) {
        sspc.chunks[index_by_identity(sspc.chunks, parts[0])] = part;
      }
    }
    if (held.size === 0) return;
  }
}

/**
 * Parse an effect.
 *
 * @param sspc_chunk - The SSPC chunk to parse.
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
 * @param layer - The layer the effect belongs to, whose pixel size is used to denormalize point
 *   parameters. Optional: during the initial parse the layer does not exist yet and the composition
 *   stands in.
 */
export const parse_effect = _suppress_materialization().decorate(function parse_effect(
  sspc_chunk: ListChunk,
  group_match_name: string,
  property_depth: number,
  effect_param_defs: Map<string, Map<string, ParamDef>>,
  composition: CompItem,
  tdmn: TdmnChunk,
  layer: Layer | null = null,
): PropertyGroup {
  const sspc_child_chunks = sspc_chunk.chunks;
  const fnam_chunk = find_by_type(sspc_child_chunks, "fnam");

  // fnam is a ContainerChunk with a Utf8 child
  const fnam_utf8 = find_by_type(fnam_chunk.chunks, "Utf8");
  const tdgp_chunk = find_by_list_type(sspc_child_chunks, "tdgp");

  let param_defs: Map<string, ParamDef>;
  try {
    param_defs = parse_effect_param_defs(
      sspc_child_chunks,
      composition._project._nnhd._system_code_page,
    );
  } catch (e) {
    if (!(e instanceof ChunkNotFoundError)) throw e;
    param_defs = new Map();
  }

  // Layer-level sspc may have an empty parT when the same effect type
  // is used more than once (AE doesn't duplicate the data).  Fall back
  // to previously cached or project-level EfdG definitions, else to the
  // instance that holds them, whichever layer was built first.
  if (param_defs.size === 0) {
    let cached = effect_param_defs.get(group_match_name);
    if (cached === undefined) {
      cached = _project_param_defs(composition, group_match_name);
      effect_param_defs.set(group_match_name, cached);
    }
    param_defs = cached;
  }

  // Cache successful parT parsing so later instances of the same
  // effect can reuse the definitions.
  if (param_defs.size > 0 && !((effect_param_defs.get(group_match_name)?.size ?? 0) > 0)) {
    effect_param_defs.set(group_match_name, param_defs);
  }
  // Resolve _name_utf8 from the effect tdgp's tdsn child
  const tdsn = find_by_type(tdgp_chunk.chunks, "tdsn");
  const effect_name_utf8 = tdsn.utf8;

  const effect_tdsb = find_by_type_or_null(tdgp_chunk.chunks, "tdsb");

  const effect_group = new PropertyGroup({
    _tdmn: tdmn,
    _tdgp: tdgp_chunk,
    _tdsb: effect_tdsb,
    _name_utf8: effect_name_utf8,
    _fnam_utf8: fnam_utf8,
    match_name: group_match_name,
    property_depth,
    properties: [],
  });
  effect_group._is_effect = true;
  // An effect group is a NAMED group in After Effects: its parameter list is
  // fixed, so AE rejects duplicate/remove/moveTo on a param ("parent is not
  // an INDEXED_GROUP") while accepting them on the effect itself, whose
  // parent is the indexed Effect Parade. Measured on AE 2026:
  // `effect.propertyType === PropertyType.INDEXED_GROUP` is false, the
  // parade's is true.
  effect_group._property_type = PropertyType.NAMED_GROUP;

  const properties = _parse_effect_properties(
    tdgp_chunk,
    param_defs,
    property_depth + 1,
    composition,
    effect_group,
    group_match_name,
    layer,
  );
  effect_group._properties = properties;
  for (const child of properties) {
    child._parent_property = effect_group;
  }

  return effect_group;
});

// Method shorthand: each extractor takes the pard variant its control type
// reads as (`_PARD_VARIANTS`), so parameters are checked bivariantly.
export type PardExtractor = { extract(body: PardChunk, result: ParamDef): void }["extract"];

export const _PARD_EXTRACTORS: Map<number, PardExtractor> = new Map();

/** Register a pard field extractor for the given control type(s). */
export function _pard_extractor(
  ...control_types: PropertyControlType[]
): (func: PardExtractor) => PardExtractor {
  function decorator(func: PardExtractor): PardExtractor {
    for (const ct of control_types) _PARD_EXTRACTORS.set(ct, func);
    return func;
  }
  return decorator;
}

// Python's `@_pard_extractor(...)` decorator is applied as a registration call
// directly after each definition, which keeps the registration order.
export function _extract_angle(body: AnglePardChunk, result: ParamDef): void {
  result.last_value = body.last_value;
  if (body.default_ != null) result.default = _intify(body.default_);
  result.property_value_type = PropertyValueType.OneD;
}
_pard_extractor(PropertyControlType.ANGLE)(_extract_angle);

export function _extract_boolean(body: BooleanPardChunk, result: ParamDef): void {
  result.last_value = body.last_value;
  result.default_value = body.default_;
  result.min_value = 0;
  result.max_value = 1;
}
_pard_extractor(PropertyControlType.BOOLEAN)(_extract_boolean);

export function _extract_color(body: ColorPardChunk, result: ParamDef): void {
  // pard stores colors as [A, R, G, B] in 0-255 range;
  // ExtendScript uses [R, G, B, A] in 0-1 range.
  {
    const [a, r, g, b] = body.last_color;
    result.last_value = [r / 255.0, g / 255.0, b / 255.0, a / 255.0];
  }
  {
    const [a, r, g, b] = body.default_color;
    result.default_value = [r / 255.0, g / 255.0, b / 255.0, a / 255.0];
  }
  result.min_value = -3921568.62745098;
  result.max_value = 3921568.62745098;
  result.property_value_type = PropertyValueType.COLOR;
}
_pard_extractor(PropertyControlType.COLOR)(_extract_color);

export function _extract_enum(body: EnumPardChunk, result: ParamDef): void {
  result.last_value = body.last_value;
  result.nb_options = body.nb_options;
  result.default_value = body.default_;
  result.min_value = 1;
  result.max_value = body.nb_options;
}
_pard_extractor(PropertyControlType.ENUM)(_extract_enum);

/** Return integral floats as int, matching ExtendScript output. */
// NOTE(port): Python returns int for integral floats, else the float; JS numbers carry the same value, and the int/float type is only observable via repr()/type().
export function _intify(value: number): number {
  return Number.isInteger(value) ? int(value) : value;
}

export function _extract_integer(body: IntegerPardChunk, result: ParamDef): void {
  if (body.default_ != null) result.default = body.default_;
  result.min_value = body.valid_min;
  result.max_value = body.valid_max;
}
_pard_extractor(PropertyControlType.INTEGER)(_extract_integer);

export function _extract_scalar(body: ScalarPardChunk, result: ParamDef): void {
  result.last_value = body.last_value;
  if (body.default_ != null) result.default = _intify(body.default_);
  result.min_value = _intify(body.valid_min);
  result.max_value = _intify(body.valid_max);
  result.slider_min = body.slider_min;
  result.slider_max = body.slider_max;
}
_pard_extractor(PropertyControlType.SCALAR)(_extract_scalar);

export function _extract_slider(body: SliderPardChunk, result: ParamDef): void {
  result.last_value = body.last_value;
  if (body.default_ != null && Number.isFinite(body.default_)) {
    result.default = _intify(body.default_);
  }
  // Non-finite bounds mean the side is unbounded.
  if (Number.isFinite(body.valid_min)) result.min_value = _intify(body.valid_min);
  if (Number.isFinite(body.valid_max)) result.max_value = _intify(body.valid_max);
  if (Number.isFinite(body.slider_min)) result.slider_min = body.slider_min;
  if (Number.isFinite(body.slider_max)) result.slider_max = body.slider_max;
  // PF_ValueDisplayFlag_PERCENT is the only display flag AE serializes
  // reliably for float sliders; it maps to unitsText "percent".
  if (body.displays_percent) result.units_text = "percent";
}
_pard_extractor(PropertyControlType.SLIDER)(_extract_slider);

export function _extract_three_d(body: ThreeDPardChunk, result: ParamDef): void {
  result.last_value = [body.last_value_x, body.last_value_y, body.last_value_z];
  // Percent of the layer size; `_point_default_pixels` converts it.
  result.default_value = body.default_;
  result.property_value_type = PropertyValueType.ThreeD_SPATIAL;
}
_pard_extractor(PropertyControlType.THREE_D)(_extract_three_d);

export function _extract_two_d(body: TwoDPardChunk, result: ParamDef): void {
  result.last_value = [body.last_value_x, body.last_value_y];
  result.default_value = body.default_;
  result.property_value_type = PropertyValueType.TwoD_SPATIAL;
}
_pard_extractor(PropertyControlType.TWO_D)(_extract_two_d);

export function _extract_layer(body: PardChunk, result: ParamDef): void {
  result.property_value_type = PropertyValueType.LAYER_INDEX;
  result.default_value = 0;
}
_pard_extractor(PropertyControlType.LAYER)(_extract_layer);

export function _extract_mask(body: PardChunk, result: ParamDef): void {
  result.property_value_type = PropertyValueType.MASK_INDEX;
  result.default_value = 0;
}
_pard_extractor(PropertyControlType.MASK)(_extract_mask);

export function _extract_curve(body: PardChunk, result: ParamDef): void {
  result.property_value_type = PropertyValueType.CUSTOM_VALUE;
}
_pard_extractor(PropertyControlType.CURVE)(_extract_curve);

export function _extract_no_value(body: PardChunk, result: ParamDef): void {
  result.property_value_type = PropertyValueType.NO_VALUE;
}
_pard_extractor(
  PropertyControlType.GROUP,
  PropertyControlType.UNKNOWN,
  PropertyControlType.UNKNOWN_14,
  PropertyControlType.PAINT_GROUP,
)(_extract_no_value);

/** Parse effect parameter definition from pard chunk, returning a map of values. */
export function _parse_effect_parameter_def(
  parameter_chunks: Chunk[],
  code_page: number,
): ParamDef {
  const pard_chunk = find_by_type(parameter_chunks, "pard");

  const control_type = PropertyControlType.of(pard_chunk.property_control_type);

  const result: ParamDef = {
    name: _decode_pard_name(pard_chunk.name, code_page),
    property_control_type: control_type,
    // PF param flags bit 1 = CANNOT_TIME_VARY (the tdb4 byte is
    // unreliable for effect parameters).
    can_vary_over_time: !and(pard_chunk.param_flags, 0x02),
    expressions_disabled: pard_chunk.expressions_disabled,
  };

  const extractor = _PARD_EXTRACTORS.get(control_type);
  if (extractor != null) extractor(pard_chunk, result);

  // An arbitrary-data parameter's default follows its pard: the Curves
  // effect's untouched curves, byte-identical to an untouched instance's.
  const default_arbp = filter_by_type(parameter_chunks, "aRbp");
  if (default_arbp?.length > 0) {
    result.default_arbp = default_arbp[0];
  }

  try {
    const pdnm_chunk = find_by_type(parameter_chunks, "pdnm");
    // pdnm is a ContainerChunk with a Utf8 child
    const utf8_chunk = find_by_type(pdnm_chunk.chunks, "Utf8");
    const pdnm_data = utf8_chunk.value;
    if (control_type === PropertyControlType.ENUM) {
      result.property_parameters = split(pdnm_data, "|");
    } else if (
      pdnm_data &&
      control_type === PropertyControlType.BOOLEAN &&
      !strip(result.name)
    ) {
      // A checkbox's pdnm is the label beside its box (a button's, the
      // button text): AE 2026 names the parameter by it only when the
      // pard name is blank (2102 / 2102 such checkboxes, 279 / 279
      // named ones keep the pard name, as do buttons).
      result.name = pdnm_data;
    }
  } catch (e) {
    if (!(e instanceof ChunkNotFoundError)) throw e;
  }

  return result;
}

/**
 * Parse project-level effect definitions from LIST:EfdG.
 *
 * EfdG contains parameter definitions for every effect type used in the
 * project. Unlike layer-level sspc chunks, the EfdG definitions always
 * include a parT chunk.
 *
 * @param root_chunks - The root chunks of the AEP file.
 * @param code_page - The project's system code page (`nnhd`).
 * @returns Map of effect match names to their parameter definitions (effect_match_name -\>
 *   param_match_name -\> param_def).
 */
export function parse_effect_definitions(
  root_chunks: Chunk[],
  code_page: number,
): Map<string, Map<string, ParamDef>> {
  const efdg_chunk = find_by_list_type_or_null(root_chunks, "EfdG");
  if (efdg_chunk === null) return new Map();

  const effect_defs = new Map<string, Map<string, ParamDef>>();
  const efdf_chunks = filter_by_list_type(efdg_chunk.chunks, "EfDf");

  for (const efdf_chunk of efdf_chunks) {
    const efdf_child_chunks = efdf_chunk.chunks;
    // First tdmn in EfDf contains the effect match name
    const tdmn_chunk = find_by_type(efdf_child_chunks, "tdmn");
    const effect_match_name = tdmn_chunk.value;

    const sspc_chunk = find_by_list_type(efdf_child_chunks, "sspc");
    const param_defs = parse_effect_param_defs(sspc_chunk.chunks, code_page);
    effect_defs.set(effect_match_name, param_defs);
  }

  return effect_defs;
}

/**
 * All effect definitions in `LIST:EfdG` as `(match_name, display, sspc)`.
 *
 * AE stores a complete `LIST:sspc` template (`fnam` + `parT` + value
 * `tdgp` + `pgui`) for every effect type used in the project, so any
 * such effect can be re-applied by cloning that template. Returns `[]`
 * when the project has no `LIST:EfdG`. The walk is project-stable (AE
 * never re-reads it after parse), so callers cache the result rather
 * than re-walking per lookup.
 */
export function effect_definition_entries(
  root_chunks: Chunk[],
): [string, string, ListChunk][] {
  const efdg_chunk = find_by_list_type_or_null(root_chunks, "EfdG");
  if (efdg_chunk === null) return [];

  const entries: [string, string, ListChunk][] = [];
  for (const efdf_chunk of filter_by_list_type(efdg_chunk.chunks, "EfDf")) {
    const match_name = find_by_type(efdf_chunk.chunks, "tdmn").value;
    const sspc_chunk = find_by_list_type(efdf_chunk.chunks, "sspc");
    const fnam = find_by_type(sspc_chunk.chunks, "fnam");
    const display = find_by_type(fnam.chunks, "Utf8").value;
    entries.push([match_name, display, sspc_chunk]);
  }
  return entries;
}

/**
 * Find the definition matching `name` in `entries`.
 *
 * `name` is matched against the effect match name across all entries
 * first, then against the `fnam` display name.
 *
 * @returns `(match_name, display_name, def_sspc)` for the matching definition, or `null`.
 */
export function match_effect_definition(
  entries: [string, string, ListChunk][],
  name: string,
): [string, string, ListChunk] | null {
  for (const entry of entries) {
    if (name === entry[0]) return entry;
  }
  for (const entry of entries) {
    if (name === entry[1]) return entry;
  }
  return null;
}
