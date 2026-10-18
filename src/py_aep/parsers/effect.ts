/** Effect and parameter definition parsers. */

import { ListChunk, type Chunk } from "../binary/chunk.ts";
import type { AnglePardChunk, BooleanPardChunk, ColorPardChunk, EnumPardChunk, IntegerPardChunk, PardChunk, ScalarPardChunk, SliderPardChunk, ThreeDPardChunk, TwoDPardChunk } from "../binary/misc_chunks.ts";
import type { TdmnChunk } from "../binary/property_chunks.ts";
import { ChunkNotFoundError, filterByListType, filterByType, findByListType, findByListTypeOrNull, findByType, findByTypeOrNull, indexByIdentity } from "../binary/utils.ts";
import { MATCH_NAME_TO_AUTO_NAME } from "../data/match_names.ts";
import { EFFECT_PARAM_SPATIAL_FLAGS } from "../data/spatial_flags.ts";
import { PropertyControlType, PropertyType, PropertyValueType } from "../enums/index.ts";
import { _suppressMaterialization } from "../models/descriptors.ts";
import { _CANVARY_OVERRIDES, _PROPERTY_DEFAULTS } from "../models/properties/overrides.ts";
import { Property } from "../models/properties/property.ts";
import type { PropertyValue } from "../models/properties/keyframe.ts";
import { PropertyGroup } from "../models/properties/property_group.ts";
import { PropSpec } from "../synthesis/property.ts";
import { getChunksByMatchName, getMatchNameRuns } from "./utils.ts";
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
  propertyControlType: PropertyControlType;
  canVaryOverTime: boolean;
  expressionsDisabled: boolean;
  propertyValueType?: PropertyValueType;
  lastValue?: number | number[];
  defaultValue?: number | number[];
  /** A scalar default that only seeds the value when `defaultValue` is absent. */
  default?: number;
  minValue?: number;
  maxValue?: number;
  sliderMin?: number;
  sliderMax?: number;
  nbOptions?: number;
  unitsText?: "percent";
  /** The ENUM option labels (`pdnm`, split on `|`). */
  propertyParameters?: string[];
  /** The Curves effect's untouched `aRbp` chunk. */
  defaultArbp?: Chunk;
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
 * @param matchName - The property's match name.
 * @param paramDef - The parameter definition from parT parsing.
 * @returns A `PropSpec` suitable for `Property._new()`.
 */
export function _paramDefToSpec(matchName: string, paramDef: ParamDef): PropSpec {
  const pvt = paramDef.propertyValueType ?? PropertyValueType.OneD;
  const controlType = paramDef.propertyControlType;
  const isColor = controlType === PropertyControlType.COLOR;
  const dims = _PVT_DIMENSIONS.get(pvt) ?? 1;
  const isSpatial =
    pvt === PropertyValueType.TwoD_SPATIAL || pvt === PropertyValueType.ThreeD_SPATIAL || isColor;
  const [value, defaultValue] = _resolveEffectValue(matchName, paramDef, controlType);
  // PropSpec is a NamedTuple: positional, in field order. Skipped optional
  // fields are passed as `undefined` so their defaults apply.
  return new PropSpec(
    matchName,
    paramDef.name || matchName,
    value,
    pvt,
    dims,
    isSpatial,
    isColor,
    controlType === PropertyControlType.INTEGER,
    undefined,
    undefined,
    defaultValue,
    controlType !== PropertyControlType.MASK,
    undefined,
    undefined,
    EFFECT_PARAM_SPATIAL_FLAGS.get(controlType) ?? null,
  );
}

/**
 * Resolve value and default_value for a synthesized effect property.
 *
 * Returns pre-rescale values - point defaults stay in percent of the
 * layer size; `_normalize_synthetic_point` stores them as fractions.
 *
 * @param matchName - The property's match name.
 * @param paramDef - The parameter definition from parT parsing.
 * @param controlType - The effect control type.
 * @returns A [value, default_value] pair.
 */
export function _resolveEffectValue(
  matchName: string,
  paramDef: Pick<ParamDef, "defaultValue" | "lastValue" | "default" | "nbOptions">,
  controlType: PropertyControlType,
): [ParamValue, ParamValue] {
  if (controlType === PropertyControlType.ENUM) {
    // An omitted popup holds its pard default (1-based), not the value
    // cached in the definition: ExtendScript reports the default for
    // S_BlurDirectional's Edge Mode (cached 1, default 3). A cached
    // value beyond the choice count is managed by the plug-in (the OCIO
    // transforms keep hashed ids there, which ExtendScript reports) and
    // is kept.
    let value = paramDef.defaultValue ?? null;
    // An ENUM's cached value is its 1-based choice, always a number.
    const last = paramDef.lastValue ?? null;
    if (typeof last === "number" && (value == null || last > (paramDef.nbOptions ?? 0))) {
      value = last;
    }
    return [value, value];
  }
  if (controlType === PropertyControlType.TWO_D || controlType === PropertyControlType.THREE_D) {
    // An omitted point is its pard default, a percentage of the layer
    // size. The cached value is that same percentage or a 16.16-rounded
    // fraction: Path Text's 80 % caches 0.7999878, ExtendScript reports
    // exactly 80 on a 100-pixel layer.
    const value = paramDef.defaultValue ?? null;
    return [value, value];
  }
  // Any other control: AE leaves a parameter at its default out of the
  // effect's tdgp, so an omitted one is at the default its pard declares,
  // then the override table's, then the pard `default` field. The cached
  // `last_value` is not the value: it is the value of whichever instance
  // wrote the definition (another one when the definition is borrowed),
  // or stale - S_BlurDirectional's Bias caches 0 where ExtendScript
  // reports 0.5. It only stands in for a pard that declares no default.
  let value = paramDef.defaultValue ?? null;
  if (value == null) value = _PROPERTY_DEFAULTS.get(matchName) ?? null;
  if (value == null) value = paramDef.default ?? null;
  if (value == null) value = paramDef.lastValue ?? null;
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
 * @param paramDef - The parameter definition.
 */
export function _applyParamDefMetadata(prop: Property, paramDef: ParamDef): void {
  prop.lastValue = paramDef.lastValue ?? null;
  const minVal = paramDef.minValue ?? null;
  if (minVal != null) prop._minValueFallback = minVal;
  const maxVal = paramDef.maxValue ?? null;
  if (maxVal != null) prop._maxValueFallback = maxVal;
  // The pard UI slider range - distinct from the valid range and the
  // source of an Essential Graphics slider controller's Smin/Smax.
  prop._sliderMin = paramDef.sliderMin ?? null;
  prop._sliderMax = paramDef.sliderMax ?? null;
  // Popup-only: written when present, so other properties keep the class
  // default (`null`).
  const nbOptions = paramDef.nbOptions ?? null;
  if (nbOptions != null) prop.nbOptions = nbOptions;
  // Direct write: the public setter has user-write semantics (validation
  // plus pdnm/pard chunk rewrites).
  const propertyParameters = paramDef.propertyParameters ?? null;
  if (propertyParameters != null) prop._propertyParameters = propertyParameters;
  const units = paramDef.unitsText ?? null;
  if (units != null) prop._unitsText = units;
  // The pard param flags carry the authoritative can-vary bit; the
  // residue table keeps the rare params where they disagree with
  // ExtendScript (e.g. the Puppet Engine dropdown).
  if (!_CANVARY_OVERRIDES.has(prop.matchName)) {
    prop._canVaryOverTime = paramDef.canVaryOverTime;
  }
  if (paramDef.expressionsDisabled) {
    prop._expressionsDisabled = true;
  }
}

/**
 * A point parameter's pard default (percent of the layer) as the fraction
 * its `cdat` stores, or `null` when it is not a point.
 */
export function _pointFraction(raw: PropertyValue): number[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  return raw.map((v) => v / 100.0);
}

export function _pointPixels(prop: Property, fraction: number[]): PropertyValue {
  return prop._resolveValue([...fraction]);
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
export function _bindPointDefault(prop: Property, raw: PropertyValue): void {
  const fraction = _pointFraction(raw);
  if (fraction != null) prop._defaultValueSource = () => _pointPixels(prop, fraction);
}

/**
 * Keep a synthesized point as the fraction AE stores, read through the
 * layer's current size, with the default `_bind_point_default` gives.
 */
export function _normalizeSyntheticPoint(prop: Property): void {
  const raw = prop._value;
  const fraction = _pointFraction(raw);
  if (fraction == null || prop._cdat == null) return;
  prop._cdat.values = fraction;
  prop._value = null;
  _bindPointDefault(prop, raw);
}

/**
 * Parse effect parameter definitions from parT chunk.
 *
 * Each effect has a parT LIST containing parameter definitions that
 * describe the control type, default values, and ranges.
 *
 * @param sspcChildChunks - The SSPC chunk's child chunks.
 * @param codePage - The project's system code page (`nnhd`), which older
 *   projects store parameter names in.
 * @returns Map of parameter match names to definition dicts.
 */
export function parseEffectParamDefs(
  sspcChildChunks: Chunk[],
  codePage: number,
): Map<string, ParamDef> {
  const partChunk = findByListType(sspcChildChunks, "parT");
  const paramDefs = new Map<string, ParamDef>();

  const chunksByParameter = getChunksByMatchName(partChunk);
  for (const [index, [matchName, parameterChunks]] of [...chunksByParameter].entries()) {
    // Skip first, it describes parent
    if (index === 0) continue;
    const paramDef = _parseEffectParameterDef(parameterChunks, codePage);
    if (_UNBOUNDED_CHECKBOXES.has(matchName)) {
      delete paramDef.minValue;
      delete paramDef.maxValue;
    }
    paramDefs.set(matchName, paramDef);
  }

  return paramDefs;
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
export function _decodePardName(name: string, codePage: number): string {
  if (!/[\udc80-\udcff]/u.test(name)) return name;
  const codec = _CODE_PAGE_CODECS.get(codePage) ?? `cp${codePage}`;
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
 * @param paramDef - The parameter definition.
 */
export function _mergeParamDef(prop: Property, paramDef: ParamDef): void {
  prop._autoName = paramDef.name || prop._autoName;
  prop._propertyControlType = paramDef.propertyControlType;
  if (prop._arbs != null && paramDef.defaultArbp !== undefined) {
    prop._defaultArbp = paramDef.defaultArbp;
  }
  prop._propertyValueType = paramDef.propertyValueType ?? prop.propertyValueType;
  // Prefer the override table, then the pard default field. For LAYER
  // references, pard stores a meaningless 0 and we have no static
  // override, so leave default_value unset entirely.
  let staticDefault = _PROPERTY_DEFAULTS.get(prop.matchName) ?? null;
  if (staticDefault == null) staticDefault = paramDef.default ?? null;
  if (staticDefault != null) {
    prop.defaultValue = staticDefault;
  } else if (
    paramDef.propertyControlType === PropertyControlType.TWO_D ||
    paramDef.propertyControlType === PropertyControlType.THREE_D
  ) {
    _bindPointDefault(prop, paramDef.defaultValue ?? null);
  } else if (paramDef.propertyControlType !== PropertyControlType.LAYER) {
    prop.defaultValue = paramDef.defaultValue ?? null;
  }
  _applyParamDefMetadata(prop, paramDef);
}

/**
 * Create a default Property from an effect parameter definition.
 *
 * When effect parameters are at their default value, AE omits them from
 * the binary tdgp chunk.  This function builds a Property (or, for group
 * separators, a PropertyGroup) from the parT definition so the parsed
 * output matches what ExtendScript reports.
 *
 * @param matchName - The property's match name.
 * @param paramDef - The parameter definition from parT parsing.
 * @param propertyDepth - The nesting depth for this property.
 * @param kw - Keyword arguments:
 * - `parentProperty`: The effect group that owns the synthesized child.
 * @returns A Property or PropertyGroup with default values.
 */
export function _synthesizeEffectProperty(
  matchName: string,
  paramDef: ParamDef,
  propertyDepth: number,
  kw: { parentProperty: PropertyGroup },
): Property | PropertyGroup {
  const { parentProperty: parent_property } = kw;
  const controlType = paramDef.propertyControlType;
  const pvt = paramDef.propertyValueType ?? PropertyValueType.OneD;

  if (pvt === PropertyValueType.NO_VALUE) {
    const display = paramDef.name || (MATCH_NAME_TO_AUTO_NAME.get(matchName) ?? "");
    return PropertyGroup._new(matchName, display, propertyDepth, {
      parentProperty: parent_property,
      synthetic: true,
    });
  }

  const spec = _paramDefToSpec(matchName, paramDef);
  const prop = Property._new(spec, propertyDepth, {
    parentProperty: parent_property,
    controlType: controlType,
    synthetic: true,
  });
  _applyParamDefMetadata(prop, paramDef);
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
 * @param tdgpChunk - The tdgp chunk containing property data.
 * @param paramDefs - Parameter definitions to merge into properties.
 * @param childDepth - The property depth for parsed child properties.
 * @param composition - The parent composition.
 * @param parentProperty - The effect group that owns the parsed children.
 * @returns List of parsed and merged properties.
 */
export function _parseEffectProperties(
  tdgpChunk: ListChunk,
  paramDefs: Map<string, ParamDef>,
  childDepth: number,
  composition: CompItem,
  parentProperty: PropertyGroup,
  groupMatchName = "",
  layer: Layer | null = null,
): (Property | PropertyGroup)[] {
  // Skip index-0 internal parameters (not exposed in ExtendScript).
  const propertyRuns = [...getMatchNameRuns(tdgpChunk)].filter(
    ([name]) => !name.endsWith("-0000"),
  );

  const parsed = _property().parseProperties(
    propertyRuns,
    childDepth,
    new Map(),
    composition,
    layer,
  );

  // Index parsed children by match_name for O(1) lookup.
  const parsedByMn = new Map<string, Property | PropertyGroup>(
    parsed.map((p): [string, Property | PropertyGroup] => [p.matchName, p]),
  );

  // Single ordered walk over param_defs: merge existing or synthesize
  // missing, producing children in canonical parT order.
  const ordered: (Property | PropertyGroup)[] = [];
  for (const [matchName, paramDef] of paramDefs) {
    const existing = parsedByMn.get(matchName) ?? null;
    if (existing != null) {
      if (existing instanceof Property) {
        _mergeParamDef(existing, paramDef);
      }
      ordered.push(existing);
    } else {
      const synth = _synthesizeEffectProperty(matchName, paramDef, childDepth, {
        parentProperty: parentProperty,
      });
      if (
        synth instanceof Property &&
        (synth._propertyControlType === PropertyControlType.TWO_D ||
          synth._propertyControlType === PropertyControlType.THREE_D)
      ) {
        _normalizeSyntheticPoint(synth);
      }
      ordered.push(synth);
    }
  }

  // Append tail children not in param_defs (e.g. ADBE Effect Built In
  // Params) in their original parsed order.
  for (const child of parsed) {
    if (!paramDefs.has(child.matchName)) ordered.push(child);
  }

  // Synthesize Compositing Options group when absent from the binary.
  // synthesize_children() will fill it from _COMPOSITING_OPTIONS_SPECS.
  if (!ordered.some((c) => c.matchName === "ADBE Effect Built In Params")) {
    ordered.push(
      PropertyGroup._new("ADBE Effect Built In Params", "Compositing Options", childDepth, {
        parentProperty: parentProperty,
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
export function* _effectInstances(chunks: Chunk[]): Generator<[string, ListChunk]> {
  for (const chunk of chunks) {
    if (!(chunk instanceof ListChunk)) continue;
    const listType = chunk.listType;
    if (_ITEM_CONTAINERS.has(listType)) {
      yield* _effectInstances(chunk.chunks);
    } else if (listType === "Layr") {
      const root = filterByListType(chunk.chunks, "tdgp");
      const parade = getChunksByMatchName(at(root, 0)).get("ADBE Effect Parade");
      const effects = filterByListType(parade ?? [], "tdgp");
      if (effects.length === 0) continue;
      for (const [name, run] of getChunksByMatchName(effects[0])) {
        for (const sspc of filterByListType(run, "sspc")) {
          yield [name, sspc];
        }
      }
    }
  }
}

/** The instance's `parT`, if it holds its effect's definitions. */
export function _heldDefinitions(sspc: ListChunk): ListChunk | null {
  const parts = filterByListType(sspc.chunks, "parT");
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
export function _projectParamDefs(composition: CompItem, matchName: string): Map<string, ParamDef> {
  const project = composition._project;
  for (const [name, sspc] of _effectInstances(project._rifx.chunks)) {
    if (name === matchName && _heldDefinitions(sspc) != null) {
      return parseEffectParamDefs(sspc.chunks, project._nnhd._systemCodePage);
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
export function rehomeEffectDefinitions(project: Project, removed: Iterable<[string, ListChunk]>): void {
  const rootChunks = project._rifx.chunks;
  if (filterByListType(rootChunks, "EfdG").length > 0) return;
  const held = new Map<string, ListChunk>();
  for (const [name, sspc] of removed) {
    const part = _heldDefinitions(sspc);
    if (part != null && !held.has(name)) held.set(name, part);
  }
  if (held.size === 0) return;
  for (const [name, sspc] of _effectInstances(rootChunks)) {
    const part = held.get(name) ?? null;
    held.delete(name);
    if (part != null) {
      const parts = filterByListType(sspc.chunks, "parT");
      if (parts.length > 0 && parts[0].chunks.length === 0) {
        sspc.chunks[indexByIdentity(sspc.chunks, parts[0])] = part;
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
export const parseEffect = _suppressMaterialization().decorate(function parse_effect(
  sspcChunk: ListChunk,
  groupMatchName: string,
  propertyDepth: number,
  effectParamDefs: Map<string, Map<string, ParamDef>>,
  composition: CompItem,
  tdmn: TdmnChunk,
  layer: Layer | null = null,
): PropertyGroup {
  const sspcChildChunks = sspcChunk.chunks;
  const fnamChunk = findByType(sspcChildChunks, "fnam");

  // fnam is a ContainerChunk with a Utf8 child
  const fnamUtf8 = findByType(fnamChunk.chunks, "Utf8");
  const tdgpChunk = findByListType(sspcChildChunks, "tdgp");

  let paramDefs: Map<string, ParamDef>;
  try {
    paramDefs = parseEffectParamDefs(
      sspcChildChunks,
      composition._project._nnhd._systemCodePage,
    );
  } catch (e) {
    if (!(e instanceof ChunkNotFoundError)) throw e;
    paramDefs = new Map();
  }

  // Layer-level sspc may have an empty parT when the same effect type
  // is used more than once (AE doesn't duplicate the data).  Fall back
  // to previously cached or project-level EfdG definitions, else to the
  // instance that holds them, whichever layer was built first.
  if (paramDefs.size === 0) {
    let cached = effectParamDefs.get(groupMatchName);
    if (cached === undefined) {
      cached = _projectParamDefs(composition, groupMatchName);
      effectParamDefs.set(groupMatchName, cached);
    }
    paramDefs = cached;
  }

  // Cache successful parT parsing so later instances of the same
  // effect can reuse the definitions.
  if (paramDefs.size > 0 && !((effectParamDefs.get(groupMatchName)?.size ?? 0) > 0)) {
    effectParamDefs.set(groupMatchName, paramDefs);
  }
  // Resolve _name_utf8 from the effect tdgp's tdsn child
  const tdsn = findByType(tdgpChunk.chunks, "tdsn");
  const effectNameUtf8 = tdsn.utf8;

  const effectTdsb = findByTypeOrNull(tdgpChunk.chunks, "tdsb");

  const effectGroup = new PropertyGroup({
    _tdmn: tdmn,
    _tdgp: tdgpChunk,
    _tdsb: effectTdsb,
    _nameUtf8: effectNameUtf8,
    _fnamUtf8: fnamUtf8,
    matchName: groupMatchName,
    propertyDepth: propertyDepth,
    properties: [],
  });
  effectGroup._isEffect = true;
  // An effect group is a NAMED group in After Effects: its parameter list is
  // fixed, so AE rejects duplicate/remove/moveTo on a param ("parent is not
  // an INDEXED_GROUP") while accepting them on the effect itself, whose
  // parent is the indexed Effect Parade. Measured on AE 2026:
  // `effect.propertyType === PropertyType.INDEXED_GROUP` is false, the
  // parade's is true.
  effectGroup._propertyType = PropertyType.NAMED_GROUP;

  const properties = _parseEffectProperties(
    tdgpChunk,
    paramDefs,
    propertyDepth + 1,
    composition,
    effectGroup,
    groupMatchName,
    layer,
  );
  effectGroup._properties = properties;
  for (const child of properties) {
    child._parentProperty = effectGroup;
  }

  return effectGroup;
});

// Method shorthand: each extractor takes the pard variant its control type
// reads as (`_PARD_VARIANTS`), so parameters are checked bivariantly.
export type PardExtractor = { extract(body: PardChunk, result: ParamDef): void }["extract"];

export const _PARD_EXTRACTORS: Map<number, PardExtractor> = new Map();

/** Register a pard field extractor for the given control type(s). */
export function _pardExtractor(
  ...controlTypes: PropertyControlType[]
): (func: PardExtractor) => PardExtractor {
  function decorator(func: PardExtractor): PardExtractor {
    for (const ct of controlTypes) _PARD_EXTRACTORS.set(ct, func);
    return func;
  }
  return decorator;
}

// Python's `@_pard_extractor(...)` decorator is applied as a registration call
// directly after each definition, which keeps the registration order.
export function _extractAngle(body: AnglePardChunk, result: ParamDef): void {
  result.lastValue = body.lastValue;
  if (body.default_ != null) result.default = _intify(body.default_);
  result.propertyValueType = PropertyValueType.OneD;
}
_pardExtractor(PropertyControlType.ANGLE)(_extractAngle);

export function _extractBoolean(body: BooleanPardChunk, result: ParamDef): void {
  result.lastValue = body.lastValue;
  result.defaultValue = body.default_;
  result.minValue = 0;
  result.maxValue = 1;
}
_pardExtractor(PropertyControlType.BOOLEAN)(_extractBoolean);

export function _extractColor(body: ColorPardChunk, result: ParamDef): void {
  // pard stores colors as [A, R, G, B] in 0-255 range;
  // ExtendScript uses [R, G, B, A] in 0-1 range.
  {
    const [a, r, g, b] = body.lastColor;
    result.lastValue = [r / 255.0, g / 255.0, b / 255.0, a / 255.0];
  }
  {
    const [a, r, g, b] = body.defaultColor;
    result.defaultValue = [r / 255.0, g / 255.0, b / 255.0, a / 255.0];
  }
  result.minValue = -3921568.62745098;
  result.maxValue = 3921568.62745098;
  result.propertyValueType = PropertyValueType.COLOR;
}
_pardExtractor(PropertyControlType.COLOR)(_extractColor);

export function _extractEnum(body: EnumPardChunk, result: ParamDef): void {
  result.lastValue = body.lastValue;
  result.nbOptions = body.nbOptions;
  result.defaultValue = body.default_;
  result.minValue = 1;
  result.maxValue = body.nbOptions;
}
_pardExtractor(PropertyControlType.ENUM)(_extractEnum);

/** Return integral floats as int, matching ExtendScript output. */
// NOTE(port): Python returns int for integral floats, else the float; JS numbers carry the same value, and the int/float type is only observable via repr()/type().
export function _intify(value: number): number {
  return Number.isInteger(value) ? int(value) : value;
}

export function _extractInteger(body: IntegerPardChunk, result: ParamDef): void {
  if (body.default_ != null) result.default = body.default_;
  result.minValue = body.validMin;
  result.maxValue = body.validMax;
}
_pardExtractor(PropertyControlType.INTEGER)(_extractInteger);

export function _extractScalar(body: ScalarPardChunk, result: ParamDef): void {
  result.lastValue = body.lastValue;
  if (body.default_ != null) result.default = _intify(body.default_);
  result.minValue = _intify(body.validMin);
  result.maxValue = _intify(body.validMax);
  result.sliderMin = body.sliderMin;
  result.sliderMax = body.sliderMax;
}
_pardExtractor(PropertyControlType.SCALAR)(_extractScalar);

export function _extractSlider(body: SliderPardChunk, result: ParamDef): void {
  result.lastValue = body.lastValue;
  if (body.default_ != null && Number.isFinite(body.default_)) {
    result.default = _intify(body.default_);
  }
  // Non-finite bounds mean the side is unbounded.
  if (Number.isFinite(body.validMin)) result.minValue = _intify(body.validMin);
  if (Number.isFinite(body.validMax)) result.maxValue = _intify(body.validMax);
  if (Number.isFinite(body.sliderMin)) result.sliderMin = body.sliderMin;
  if (Number.isFinite(body.sliderMax)) result.sliderMax = body.sliderMax;
  // PF_ValueDisplayFlag_PERCENT is the only display flag AE serializes
  // reliably for float sliders; it maps to unitsText "percent".
  if (body.displaysPercent) result.unitsText = "percent";
}
_pardExtractor(PropertyControlType.SLIDER)(_extractSlider);

export function _extractThreeD(body: ThreeDPardChunk, result: ParamDef): void {
  result.lastValue = [body.lastValueX, body.lastValueY, body.lastValueZ];
  // Percent of the layer size; `_point_default_pixels` converts it.
  result.defaultValue = body.default_;
  result.propertyValueType = PropertyValueType.ThreeD_SPATIAL;
}
_pardExtractor(PropertyControlType.THREE_D)(_extractThreeD);

export function _extractTwoD(body: TwoDPardChunk, result: ParamDef): void {
  result.lastValue = [body.lastValueX, body.lastValueY];
  result.defaultValue = body.default_;
  result.propertyValueType = PropertyValueType.TwoD_SPATIAL;
}
_pardExtractor(PropertyControlType.TWO_D)(_extractTwoD);

export function _extractLayer(body: PardChunk, result: ParamDef): void {
  result.propertyValueType = PropertyValueType.LAYER_INDEX;
  result.defaultValue = 0;
}
_pardExtractor(PropertyControlType.LAYER)(_extractLayer);

export function _extractMask(body: PardChunk, result: ParamDef): void {
  result.propertyValueType = PropertyValueType.MASK_INDEX;
  result.defaultValue = 0;
}
_pardExtractor(PropertyControlType.MASK)(_extractMask);

export function _extractCurve(body: PardChunk, result: ParamDef): void {
  result.propertyValueType = PropertyValueType.CUSTOM_VALUE;
}
_pardExtractor(PropertyControlType.CURVE)(_extractCurve);

export function _extractNoValue(body: PardChunk, result: ParamDef): void {
  result.propertyValueType = PropertyValueType.NO_VALUE;
}
_pardExtractor(
  PropertyControlType.GROUP,
  PropertyControlType.UNKNOWN,
  PropertyControlType.UNKNOWN_14,
  PropertyControlType.PAINT_GROUP,
)(_extractNoValue);

/** Parse effect parameter definition from pard chunk, returning a map of values. */
export function _parseEffectParameterDef(
  parameterChunks: Chunk[],
  codePage: number,
): ParamDef {
  const pardChunk = findByType(parameterChunks, "pard");

  const controlType = PropertyControlType.of(pardChunk.propertyControlType);

  const result: ParamDef = {
    name: _decodePardName(pardChunk.name, codePage),
    propertyControlType: controlType,
    // PF param flags bit 1 = CANNOT_TIME_VARY (the tdb4 byte is
    // unreliable for effect parameters).
    canVaryOverTime: !and(pardChunk.paramFlags, 0x02),
    expressionsDisabled: pardChunk.expressionsDisabled,
  };

  const extractor = _PARD_EXTRACTORS.get(controlType);
  if (extractor != null) extractor(pardChunk, result);

  // An arbitrary-data parameter's default follows its pard: the Curves
  // effect's untouched curves, byte-identical to an untouched instance's.
  const defaultArbp = filterByType(parameterChunks, "aRbp");
  if (defaultArbp?.length > 0) {
    result.defaultArbp = defaultArbp[0];
  }

  try {
    const pdnmChunk = findByType(parameterChunks, "pdnm");
    // pdnm is a ContainerChunk with a Utf8 child
    const utf8Chunk = findByType(pdnmChunk.chunks, "Utf8");
    const pdnmData = utf8Chunk.value;
    if (controlType === PropertyControlType.ENUM) {
      result.propertyParameters = split(pdnmData, "|");
    } else if (
      pdnmData &&
      controlType === PropertyControlType.BOOLEAN &&
      !strip(result.name)
    ) {
      // A checkbox's pdnm is the label beside its box (a button's, the
      // button text): AE 2026 names the parameter by it only when the
      // pard name is blank (2102 / 2102 such checkboxes, 279 / 279
      // named ones keep the pard name, as do buttons).
      result.name = pdnmData;
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
 * @param rootChunks - The root chunks of the AEP file.
 * @param codePage - The project's system code page (`nnhd`).
 * @returns Map of effect match names to their parameter definitions (effect_match_name -\>
 *   param_match_name -\> param_def).
 */
export function parseEffectDefinitions(
  rootChunks: Chunk[],
  codePage: number,
): Map<string, Map<string, ParamDef>> {
  const efdgChunk = findByListTypeOrNull(rootChunks, "EfdG");
  if (efdgChunk === null) return new Map();

  const effectDefs = new Map<string, Map<string, ParamDef>>();
  const efdfChunks = filterByListType(efdgChunk.chunks, "EfDf");

  for (const efdfChunk of efdfChunks) {
    const efdfChildChunks = efdfChunk.chunks;
    // First tdmn in EfDf contains the effect match name
    const tdmnChunk = findByType(efdfChildChunks, "tdmn");
    const effectMatchName = tdmnChunk.value;

    const sspcChunk = findByListType(efdfChildChunks, "sspc");
    const paramDefs = parseEffectParamDefs(sspcChunk.chunks, codePage);
    effectDefs.set(effectMatchName, paramDefs);
  }

  return effectDefs;
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
export function effectDefinitionEntries(
  rootChunks: Chunk[],
): [string, string, ListChunk][] {
  const efdgChunk = findByListTypeOrNull(rootChunks, "EfdG");
  if (efdgChunk === null) return [];

  const entries: [string, string, ListChunk][] = [];
  for (const efdfChunk of filterByListType(efdgChunk.chunks, "EfDf")) {
    const matchName = findByType(efdfChunk.chunks, "tdmn").value;
    const sspcChunk = findByListType(efdfChunk.chunks, "sspc");
    const fnam = findByType(sspcChunk.chunks, "fnam");
    const display = findByType(fnam.chunks, "Utf8").value;
    entries.push([matchName, display, sspcChunk]);
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
export function matchEffectDefinition(
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
