import { KeyframeInterpolationType, LayerType, PropertyControlType, PropertyType, PropertyValueType } from "../../enums/index.ts";
import { cos_get } from "../../cos/index.ts";
import type { CosNode } from "../../cos/cos.ts";
import { cos_at, cos_insert, cos_len, cos_pop_at } from "../../cos/kinds.ts";
import { resolve_can_set_expression } from "../../resolvers/can_set_expression.ts";
import { _DEFAULT_INFLUENCE, NORMALIZED_ARC_ACCURACY, ArcMetric, _tangents_are_zero, color_distance, interpolate_keyframes, motion_path_direction, motion_path_length, roving_keyframe_times, segment_value_slope, spatial_location, split_segment_influences, split_spatial_path } from "../../resolvers/interpolation.ts";
import { Chunk, ContainerChunk, ListChunk } from "../../binary/chunk.ts";
import { layer_timebase } from "../../binary/composition_chunks.ts";
import { LHD3_BLOCK_KEYFRAMES, KfPosition, LdatItemType, ShapePoint, set_lhd3_count, LdatChunk, LdatItem, Lhd3Chunk } from "../../binary/ldat_chunks.ts";
import { EnumPardChunk } from "../../binary/misc_chunks.ts";
import { ITEM_SIZE_BY_TYPE, build_keyframe_list, build_kf_data, build_ldat_item, build_parallel_ldat_item, build_shap } from "../../binary/mutations.ts";
import { TDSN_SENTINEL, CdatChunk, CurvesArbpChunk, Tdb4Chunk, TdmnChunk, TdsbChunk, TdsnChunk, TdumChunk, VfdnChunk, tdb4_apply_animated_template, tdb4_apply_static_template, tdb4_clear_keyframe_record } from "../../binary/property_chunks.ts";
import { S4Chunk, Utf8Chunk, U4Chunk } from "../../binary/scalar_chunks.ts";
import { ChunkNotFoundError, find_by_list_type_or_null, find_by_type, index_by_identity } from "../../binary/utils.ts";
import { VF_AXIS_PREFIX } from "../../data/match_names.ts";
import { UNITS_TEXT_MAP } from "../../data/units.ts";
import { can_add_property } from "../../resolvers/motion_graphics.ts";
import { _USE_VALUE, PropSpec } from "../../synthesis/property.ts";
import { ChunkField } from "../descriptors.ts";
import { TextDocument } from "../text/text_document.ts";
import { _validate_number, validate_bool, validate_enum, validate_f8, validate_name, validate_number, validate_sequence, validate_text } from "../validators.ts";
import type { FolderItem } from "../items/folder.ts";
import type { CompItem } from "../items/composition.ts";
import type { AVLayer } from "../layers/av_layer.ts";
import type { Project } from "../project.ts";
import { Curves } from "./curves.ts";
import type { Gradient } from "./gradient.ts";
import { Keyframe, _check_time_units, _timebase_units } from "./keyframe.ts";
import type { KeyframeValue, PropertyValue, _ValueType } from "./keyframe.ts";
import { KeyframeEase } from "./keyframe_ease.ts";
import type { MarkerValue } from "./marker.ts";
import { _ALWAYS_MODIFIED, _CANVARY_OVERRIDES, _ISSPATIAL_OVERRIDES, _NAME_OVERRIDES, _PLACEHOLDER_UNBOUNDED, _UNBOUNDED_MATCH_NAMES } from "./overrides.ts";
import { _EMPTY_CDAT_PAD, GRADIENT_KIND, MARKER_KIND, ORIENTATION_KIND, SHAPE_KIND, TEXT_KIND, type ParallelKind } from "./parallel.ts";
import { PropertyBase } from "./property_base.ts";
import { Shape } from "./shape.ts";
import type { PropertyGroup } from "./property_group.ts";
import { deferred, deepcopy, getitem, isclose, py_eq, sorted, warn, int, round, floordiv, TypeError_, ValueError, IndexError, AttributeError, NotImplementedError, StopIteration, py_assert, repr, hasattr, getattr, min, max, zip, float, lshift, rshift, and, or, b, descriptor, list_mul, type_name, type ClassAttributes, py_or } from "../../../pyrt/index.ts";

const _property_group = deferred<typeof import("./property_group.ts")>("py_aep/models/properties/property_group");
import { AVItem } from "../items/av_item.ts";
import { FootageItem } from "../items/footage.ts";
import { resolve_essential_property_controller, resolve_essential_property_source } from "../../resolvers/essential_properties.ts";
const _folder = deferred<typeof import("../items/folder.ts")>("py_aep/models/items/folder");
const _av_layer = deferred<typeof import("../layers/av_layer.ts")>("py_aep/models/layers/av_layer");
const _mask_property_group = deferred<typeof import("./mask_property_group.ts")>("py_aep/models/properties/mask_property_group");

export const logger = {
  debug(_m: string) {},
  info(_m: string) {},
  warning: (m: string) => warn(m),
};

// A PARSED complex property is identified by the wrapper LIST the
// specialized parsers record on it - structure, not a decoded value type.
// Measured over every sample (1.98M properties): no parsed complex
// property lacks a wrapper, and no wrapper ever disagrees with the kind.
export const _WRAPPER_KINDS: Map<string, ParallelKind> = new Map(
  [ORIENTATION_KIND, MARKER_KIND, SHAPE_KIND, GRADIENT_KIND, TEXT_KIND].map((kind) => [kind.wrapper_type, kind] as const),
);

// A SYNTHESIZED one has no wrapper yet (AE omits it for pristine state)
// and its seeded value type does not identify the kind - a mask path is
// seeded CUSTOM_VALUE, a Layer Styles gradient NO_VALUE. Only the match
// name is left. Every entry here is reachable only before the property is
// materialized; afterwards the wrapper above answers first.
export const _SYNTHESIZED_KINDS: Map<string, ParallelKind> = new Map<string, ParallelKind>([
  ["ADBE Orientation", ORIENTATION_KIND],
  ["ADBE Marker", MARKER_KIND],
  ["ADBE Mask Shape", SHAPE_KIND],
  ["ADBE Text Document", TEXT_KIND],
  ["ADBE EP Text Document", TEXT_KIND],
  ["ADBE Vector Grad Colors", GRADIENT_KIND],
  ["outerGlow/gradient", GRADIENT_KIND],
  ["innerGlow/gradient", GRADIENT_KIND],
  ["gradientFill/gradient", GRADIENT_KIND],
]);

export const _UNSET: unique symbol = Symbol("_UNSET"); // sentinel for unset min/max fallback

// Match names whose binary values are stored as 0-1 fractions but
// ExtendScript reports as 0-100 percentages.
export const _PERCENT_MATCH_NAMES: Set<string> = new Set(["ADBE Opacity", "ADBE Scale", "ADBE Mask Opacity"]);

export const _SEPARATION_LEADER = "ADBE Position";
export const _SEPARATION_FOLLOWERS: readonly string[] & readonly ["ADBE Position_0", "ADBE Position_1", "ADBE Position_2"] = [
  "ADBE Position_0",
  "ADBE Position_1",
  "ADBE Position_2",
];

export function _get_max(prop: Property): number | null {
  const v = prop.max_value;
  if (typeof v !== "number") return null;
  // A max of exactly 0.0 is, across the whole sample corpus, always AE's
  // [0.0] placeholder for an unbounded/runtime-grown bound (Time Remapping,
  // and Light/Camera props that carry a [0.0] tduM) - never a genuine
  // enforceable maximum. So do not enforce it on the value setter. (A
  // hypothetical effect param with a real max of 0 is unsampled.)
  if (v === 0.0) return null;
  return v;
}

export function _get_min(prop: Property): number | null {
  const v = prop.min_value;
  return typeof v === "number" ? v : null;
}

export const _NUMERIC_VALUE_TYPES: Set<PropertyValueType> = new Set<PropertyValueType>([
  PropertyValueType.OneD,
  PropertyValueType.TwoD,
  PropertyValueType.TwoD_SPATIAL,
  PropertyValueType.ThreeD,
  PropertyValueType.ThreeD_SPATIAL,
  PropertyValueType.COLOR,
]);

export function _get_dimensions(prop: Property): number {
  const d: number = prop.dimensions;
  // Color properties use dimensions=1 but store 4-element lists.
  if (prop._color) return 4;
  return d;
}

export const _validate_scalar = _validate_number({ min: _get_min, max: _get_max });
export const _validate_list = validate_sequence({ length: _get_dimensions, min: _get_min, max: _get_max });

export function _same_path(a: Shape, b: unknown): boolean {
  // Whether two path values draw the same featherless path (vertices,
  // stored handles and closed flag; a path with feather points never
  // matches).
  return (
    b instanceof Shape &&
    a.closed == b.closed &&
    py_eq(a.vertices, b.vertices) &&
    py_eq(a._stored_tangents(-1), b._stored_tangents(-1)) &&
    py_eq(a._stored_tangents(1), b._stored_tangents(1)) &&
    !a.feather_points?.length &&
    !b.feather_points?.length
  );
}

export function _validate_value(prop: Property, value: unknown): void {
  // Validate type, length and bounds of a property value.
  // A mask or shape-layer path only holds a Shape: AE 2026 refuses any other
  // value ("Array is not of the correct type"), and the numeric write path
  // it would otherwise take leaves the file untouched while the model
  // reports the stray value.
  if (prop._parallel_kind() === SHAPE_KIND && !(value instanceof Shape)) {
    throw new TypeError_(`${repr(prop.match_name)} takes a Shape, got ${type_name(value)}`);
  }
  if (value == null) return;
  // Variable-font axis properties are 2-dimensional in the binary
  // ([value, tag]) but scalar in ExtendScript. They carry the
  // VARIABLE_FONT_AXIS value type, which is NOT in _NUMERIC_VALUE_TYPES,
  // so this must run BEFORE the numeric-type gate below - otherwise the
  // gate returns early and axis values skip finite/range validation
  // entirely (a NaN/inf or out-of-[min,max] weight would be written).
  if (prop._is_vf_axis && (typeof value === "number" || typeof value === "boolean")) {
    _validate_scalar(value, prop);
    return;
  }
  if (!_NUMERIC_VALUE_TYPES.has(prop.property_value_type)) return;
  const expects_list = prop.dimensions > 1 || prop._color;
  if (expects_list) _validate_list(value, prop);
  else _validate_scalar(value, prop);
}

export function _validate_key_value(prop: Property, value: unknown): void {
  // Validate a keyframe value: `_validate_value`, after refusing `None` for
  // a numeric keyframe, which always holds a number (storing `None` only in
  // the model left the file at whatever the slot held, 0).
  if (value == null && prop._parallel_kind() == null && !prop._no_value) {
    throw new TypeError_(`${repr(prop.match_name)} keyframe value cannot be None`);
  }
  _validate_value(prop, value);
}

// Standard OpenType design-axis display names (AE shows the axis name from
// the font itself; these cover the registered tags, custom tags fall back
// to the raw tag).
export const _VF_AXIS_STANDARD_NAMES = new Map<string, string>([
  ["wght", "Weight"],
  ["wdth", "Width"],
  ["slnt", "Slant"],
  ["ital", "Italic"],
  ["opsz", "Optical Size"],
]);

export function _vf_tag_to_str(raw: number): string | null {
  // Decode a variable-font axis tag stored as a 4CC number.
  //
  // The axis property's second dimension holds the tag packed big-endian
  // (e.g. 2003265652.0 = 0x77676874 = `wght`). Returns `None` for values
  // that do not decode to four printable ASCII characters.
  const n = int(raw);
  if (n <= 0 || n > 0xffffffff) return null;
  const chars = [24, 16, 8, 0].map((shift) => and(rshift(n, shift), 0xff));
  if (chars.some((c) => c < 0x20 || c > 0x7e)) return null;
  return chars.map((c) => String.fromCodePoint(c)).join("");
}

export function _vf_tag_from_str(tag: string): number {
  // Encode a 4-character axis tag to its packed 4CC number.
  let n = 0;
  for (const c of tag) n = or(lshift(n, 8), c.codePointAt(0)!);
  return n;
}

export function _values_equal(a: unknown, b: unknown): boolean {
  // Compare two property values with float tolerance.
  //
  // Handles scalars, arrays, booleans, and null.
  // Uses [math.isclose][] for numeric comparisons.
  if (a == null || b == null) return a == b;
  if (typeof a === "boolean" || typeof b === "boolean") return py_eq(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => _values_equal(x, b[i]));
  }
  if (typeof a === "number" && typeof b === "number") return isclose(a, b, 1e-9, 1e-6);
  return py_eq(a, b);
}


/**
 * The `Property` object contains value, keyframe, and expression information
 * about a particular AE property of a layer. An AE property is a value,
 * often animatable, of an effect, mask, or transform within an individual
 * layer.
 *
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const prop = comp.layers[0].transform.property("ADBE Position");
 * console.log(prop.value);
 * ```
 *
 * Info:
 * `Property` is a subclass of {@link PropertyBase}. All methods and attributes
 * of {@link PropertyBase} are available when working with `Property`.
 *
 * @typeParam V - The type of {@link Property.value | value}. A well-known match
 *   name looked up on a group gives it (`"ADBE Position"` is `Property<number[]>`);
 *   a property of unknown kind is `Property`, whose value is dynamic.
 * @example
 * @see https://ae-scripting.docsforadobe.dev/property/property/
 */
export class Property<V extends PropertyValue = any> extends PropertyBase {
  declare ["constructor"]: ClassAttributes<typeof Property>;
  /** The list of keyframes for this property. Read-only. */
  declare keyframes: Keyframe<KeyframeValue<V>>[];

  /** The number of dimensions in the property value (1, 2, 3, or 4). Read-only. */
  declare dimensions: number;

  /**
   * Contains the error, if any, generated by evaluation of the string
   * most recently set in {@link expression}. If no expression string has been
   * specified, or if the last expression string evaluated without error,
   * contains the empty string (`""`).
   *
   * **Warning:** 
   * The parser cannot evaluate expressions, so this attribute is
   * always an empty string. After Effects computes expression errors
   * at runtime when it evaluates the expression engine; this
   * information is not stored in the binary `.aep` file.
   * Read-only.
   */
  declare expression_error: string;

  /** The last value of the property (before animation). */
  declare last_value: PropertyValue;

  /** The number of options in a dropdown property. */
  declare nb_options: number | null;

  declare _animated: boolean;

  declare _color: boolean;

  declare _integer: boolean;

  declare _no_value: boolean;

  declare _vector: boolean;

  /**
   * When `true`, the property's X/Y ratio is locked (the constrain
   * proportions switch of a Scale or Mask Feather; `true` on any property
   * without one). Read-only.
   */
  declare locked_ratio: boolean;

  declare _is_spatial_raw: boolean;

  /**
   * When `true`, the named property defines a spatial value.
   *
   * Examples are position and effect point controls. Read-only.
   */
  get is_spatial(): boolean {
    const override = _ISSPATIAL_OVERRIDES.get(this.match_name) ?? null;
    if (override != null) return override;
    if (this._color) {
      // ExtendScript reports every color property as spatial, but AE
      // leaves the tdb4 spatial bit clear on them (an edited effect
      // color writes `_spatial_static_flags` 0x07, measured in AE
      // 2026), so the raw bit would say otherwise.
      return true;
    }
    return !!this._is_spatial_raw;
  }

  /**
   * Whether the property interpolates along a spatial motion path.
   *
   * `is_spatial` also reports `true` for colors, to match what
   * ExtendScript says; a color has no motion path, so the keyframe
   * binary (the ldat item's key flags and layout), the speed math and
   * the roving guard ask this instead.
   */
  get _has_motion_path(): boolean {
    return this.is_spatial && !this._color;
  }

  /** Display name of the property. Read / Write. */
  get name(): string {
    const override = _NAME_OVERRIDES.get(this.match_name) ?? null;
    if (override != null) return override;
    // Active variable-font axes display as e.g. "Font Axis Weight".
    // AE stores the name (from the font's axis name table) in a vfdn
    // sibling chunk; fall back to mapping the registered OpenType
    // tags, with custom tags showing the raw tag.
    if (this._is_vf_axis) {
      if (this._vfdn != null) {
        try {
          return this._vfdn.utf8.value;
        } catch (e) {
          if (!(e instanceof ChunkNotFoundError)) throw e;
        }
      }
      const tag = this.axis_tag;
      if (tag != null) return "Font Axis " + (_VF_AXIS_STANDARD_NAMES.get(tag) ?? tag);
    }
    const base_name = super.name;
    // NO_VALUE effect properties that store the match_name in tdsn
    // are unnamed separators/group headers - ExtendScript returns "".
    if (this.property_value_type === PropertyValueType.NO_VALUE && base_name === this.match_name && this._is_in_effect()) {
      return "";
    }
    return base_name;
  }

  set name(value: string) {
    Reflect.set(PropertyBase.prototype, "name", value, this);
  }

  /**
   * Create a Property from a `PropSpec`.
   *
   * Used to synthesize properties expected by ExtendScript but absent
   * from the binary.
   *
   * spec: The property specification describing the property.
   * property_depth: The depth of the property in the tree.
   * parent_property: The container that owns the synthesized property.
   * value: Override for the property value. When omitted, uses
   * `spec.value`.
   * default_value: Override for the default value. When omitted,
   * uses the spec's `default_value` logic.
   * synthetic: If True, mark backing chunks as synthetic
   * (skipped during serialization).
   * control_type: Override for the property control type. When
   * omitted, defaults to `PropertyControlType.UNKNOWN`.
   */
  static _new(
    spec: PropSpec,
    property_depth: number,
    kw: {
      parent_property: PropertyGroup;
      value?: PropertyValue | typeof _USE_VALUE;
      default_value?: PropertyValue | typeof _USE_VALUE;
      synthetic?: boolean;
      control_type?: PropertyControlType | null;
    },
  ): Property {
    const { parent_property, value = _USE_VALUE, default_value = _USE_VALUE, synthetic = false, control_type = null } = kw;
    const final_value = value === _USE_VALUE ? spec.value : value;
    const no_value = spec.pvt === PropertyValueType.NO_VALUE;
    let can_vary: boolean;
    if (spec.can_vary_over_time != null) {
      can_vary = spec.can_vary_over_time;
    } else {
      can_vary = !no_value;
    }

    const _tdsb = new TdsbChunk({ synthetic });

    const _tdb4 = new Tdb4Chunk({ synthetic, dimensions: spec.dimensions });
    if (spec.has_time_base) {
      const binary_nv = no_value || (spec.is_spatial && !spec.color);
      _tdb4._time_base = 0x7800;
      _tdb4._spatial_marker = spec.is_spatial;
      _tdb4.no_value = binary_nv;
      if (spec.spatial_flags != null) _tdb4._spatial_static_flags = spec.spatial_flags;
      if (spec.integer) {
        _tdb4.integer = true;
        _tdb4._cvot_flags = spec.cvot ?? 0x04;
        _tdb4._property_category = 0x04;
        _tdb4._value_hint_type = spec.value_hint_type ?? 0xffff;
      } else if (spec.color) {
        _tdb4.color = true;
        _tdb4._cvot_flags = spec.cvot ?? 0xff;
        _tdb4._property_category = 0x01;
        _tdb4._value_hint_type = spec.value_hint_type ?? 1;
        _tdb4._value_hint_flag = 0xff;
      } else if (binary_nv) {
        _tdb4._type_flags = spec.is_spatial ? 0x18 : 0x08;
        _tdb4._cvot_flags = spec.cvot ?? 0x04;
        _tdb4._value_hint_type = spec.value_hint_type ?? 1;
      } else {
        _tdb4.vector = true;
        _tdb4._cvot_flags = spec.cvot ?? 0xff;
        _tdb4._property_category = 0x09;
        _tdb4._value_hint_type = spec.value_hint_type ?? 1;
        _tdb4._value_hint_flag = 0xff;
      }
    } else {
      if (spec.spatial_flags != null) {
        _tdb4._spatial_static_flags = spec.spatial_flags;
      } else {
        _tdb4.is_spatial = spec.is_spatial;
      }
      _tdb4.no_value = no_value;
      _tdb4.color = spec.color;
      _tdb4.integer = spec.integer;
      _tdb4.vector = spec.dimensions > 1;
      _tdb4.can_vary_over_time = can_vary;
    }

    if (spec.property_category != null) _tdb4._property_category = spec.property_category;
    if (spec.pad2a != null) _tdb4._pad2a = spec.pad2a;

    // AE writes the unnamed sentinel; the display name resolves
    // from auto_name on the model.
    const tdsn = TdsnChunk.new_(TDSN_SENTINEL, { synthetic });
    const name_utf8 = tdsn.utf8;
    const _tdbs = new ListChunk({
      list_type: "tdbs",
      chunks: [_tdsb, tdsn, _tdb4],
      synthetic,
    });

    // Pre-create cdat for numeric values so _ensure_materialized
    // only needs to flip synthetic flags.
    let _cdat: CdatChunk | null = null;
    if (final_value != null && (typeof final_value === "number" || typeof final_value === "boolean" || Array.isArray(final_value))) {
      let raw_vals: number[];
      if (Array.isArray(final_value)) {
        raw_vals = final_value;
      } else {
        raw_vals = [final_value];
      }
      _cdat = new CdatChunk({ values: raw_vals, synthetic });
      _tdbs.chunks.push(_cdat);
    }

    // Insert into parent's chunk tree (before parent's group end).
    const _tdmn = new TdmnChunk({
      value: spec.match_name,
      synthetic,
    });
    const tdgp = parent_property._tdgp;
    if (tdgp != null) {
      _property_group()._insert_before_group_end(tdgp, _tdmn);
      _property_group()._insert_before_group_end(tdgp, _tdbs);
    }

    const prop = new this({
      _tdmn,
      _tdsb,
      _tdb4,
      _tdbs,
      _name_utf8: name_utf8,
      _cdat,
      keyframes: [],
      match_name: spec.match_name,
      auto_name: spec.auto_name,
      parent_property,
      property_control_type: control_type || PropertyControlType.UNKNOWN,
      property_depth,
      property_value_type: spec.pvt,
      value: final_value,
      can_vary_over_time: spec.can_vary_over_time,
      units_text: spec.units_text,
    });
    if (default_value !== _USE_VALUE) {
      prop.default_value = default_value;
    } else {
      prop.default_value = spec.default_value === _USE_VALUE ? final_value : spec.default_value;
    }
    if (spec.chunk_bounds_are_hints) {
      // tdum/tduM hold UI slider hints, not real bounds: the spec is
      // authoritative (None = unbounded).
      prop._min_value_fallback = spec.min_value;
      prop._max_value_fallback = spec.max_value;
    } else {
      if (spec.min_value != null) prop._min_value_fallback = spec.min_value;
      if (spec.max_value != null) prop._max_value_fallback = spec.max_value;
    }
    if (spec.hint_bounds != null) prop._hint_bounds = spec.hint_bounds;
    if (spec.bound_chunks != null) {
      prop._bound_chunks_hint = spec.bound_chunks;
    } else {
      prop._bound_chunks_hint =
        (spec.min_value != null || spec.max_value != null) && !spec.integer && !spec.color && !spec.is_spatial;
    }

    return prop;
  }

  declare _tdmn: TdmnChunk;
  declare _tdb4: Tdb4Chunk;
  declare _expression_utf8: Utf8Chunk | null;
  declare _tdbs: ListChunk;
  declare _tdum: TdumChunk | null;
  declare _tduM: TdumChunk | null;
  declare _cdat: CdatChunk | null;
  declare _tdpi: S4Chunk | null;
  declare _composition: CompItem | null;
  declare _bound_chunks_hint: boolean;
  declare _kf_value_container: ListChunk | null;
  declare _wrapper: ListChunk | null;
  declare _blsv: U4Chunk | null;
  declare _blsi: U4Chunk | null;
  declare _can_vary_over_time: boolean | null;
  declare _expressions_disabled: boolean;
  declare _dimensions_separated: boolean | null;
  declare _expression_enabled: boolean | null;
  declare _expression: string | null;
  declare _property_control_type: PropertyControlType | null;
  declare _property_value_type: PropertyValueType | null;
  declare _value: PropertyValue;
  declare _units_text: string | null;
  declare _default_value_source: (() => V) | null;
  declare _default_value: V | null;
  declare _keyframe_positions: Map<Keyframe, number> | null;
  declare _types_memo: [unknown[], [PropertyControlType, PropertyValueType]] | null;
  declare _effect_scale_dict: { value: number[] | null } | null;
  declare _min_value_fallback: number | null | typeof _UNSET;
  declare _max_value_fallback: number | null | typeof _UNSET;
  declare _slider_min: number | null;
  declare _slider_max: number | null;
  declare _scale_z_override: number | null;
  declare _property_parameters: string[] | null;
  declare _property_type: PropertyType;
  declare _vf_tag_cache: number | null;
  declare _vfdn: VfdnChunk | null;
  declare _arbs: ListChunk | null;
  declare _curves: Curves | null;
  declare _default_arbp: Chunk | null;

  constructor(kw: {
    _tdmn: TdmnChunk;
    _tdsb: TdsbChunk;
    _tdb4: Tdb4Chunk;
    _expression_utf8?: Utf8Chunk | null;
    _name_utf8: Utf8Chunk;
    _tdbs: ListChunk;
    _tdum?: TdumChunk | null;
    _tduM?: TdumChunk | null;
    _cdat?: CdatChunk | null;
    _tdpi?: S4Chunk | null;
    _composition?: CompItem | null;
    parent_property?: PropertyGroup | null;
    match_name: string;
    property_depth: number;
    auto_name?: string | null;
    keyframes: Keyframe<KeyframeValue<NoInfer<V>>>[];
    value: PropertyValue;
    expression_enabled?: boolean | null;
    expression?: string | null;
    property_control_type?: PropertyControlType | null;
    property_value_type?: PropertyValueType | null;
    dimensions_separated?: boolean | null;
    units_text?: string | null;
    can_vary_over_time?: boolean | null;
  }) {
    const {
      _tdmn,
      _tdsb,
      _tdb4,
      _expression_utf8 = null,
      _name_utf8,
      _tdbs,
      _tdum = null,
      _tduM = null,
      _cdat = null,
      _tdpi = null,
      _composition = null,
      parent_property = null,
      match_name,
      property_depth,
      auto_name = null,
      keyframes,
      value,
      expression_enabled = null,
      expression = null,
      property_control_type = null,
      property_value_type = null,
      dimensions_separated = null,
      units_text = null,
      can_vary_over_time = null,
    } = kw;
    super({
      _tdsb,
      _name_utf8,
      parent_property,
      match_name,
      auto_name,
      property_depth,
    });
    this._tdmn = _tdmn;
    this._tdb4 = _tdb4;
    this._expression_utf8 = _expression_utf8;
    this._tdbs = _tdbs;
    this._tdum = _tdum;
    this._tduM = _tduM;
    this._cdat = _cdat;
    this._tdpi = _tdpi;
    this._composition = _composition;

    // Whether AE writes tdum/tduM placeholder bounds for this property
    // when materialized. Set from the synthesis spec in `_new`.
    this._bound_chunks_hint = false;

    // Parallel per-keyframe value container for complex value types
    // (otky / mrky / omks / GCky). Set by the specialized parsers.
    // Holds one value chunk per keyframe, aligned with `keyframes`.
    this._kf_value_container = null;

    // The wrapper LIST holding this property's tdbs + value container
    // (otst / mrst / om-s / GCst / btds). Set by the specialized
    // parsers; None for ordinary numeric properties and for complex
    // properties whose pristine state stores a bare tdbs.
    this._wrapper = null;

    // Media-replacement slot chunks (blsv/blsi), siblings of this leaf's
    // tdbs inside an `ADBE Layer Source Alternate` group run. Set by the
    // tdbs dispatcher only for that match name; None otherwise. `blsi` is
    // the alternate-source item id (0 = no replacement set).
    this._blsv = null;
    this._blsi = null;

    this._can_vary_over_time = can_vary_over_time;

    // Expressions can never be set on this parameter (from the pard
    // definition header flag; set by _apply_param_def_metadata).
    this._expressions_disabled = false;

    this._dimensions_separated = dimensions_separated;

    this._expression_enabled = expression_enabled;
    this._expression = expression;

    this.keyframes = keyframes;
    this._link_keyframes();

    this._property_control_type = property_control_type;

    this._property_value_type = property_value_type;

    this._value = value;

    this._units_text = units_text;

    // A default that follows other state (a camera's Position follows its
    // Zoom) reads from this callable instead of `_default_value`.
    this._default_value_source = null;
    this.default_value = null;

    this.expression_error = "";

    this.last_value = null;

    this._min_value_fallback = _UNSET;
    this._max_value_fallback = _UNSET;
    // The pard UI slider range (effect params only; None elsewhere).
    this._slider_min = null;
    this._slider_max = null;
    this._scale_z_override = null;

    this.nb_options = null;

    this._property_parameters = null;

    this._property_type = PropertyType.PROPERTY;

    // Cached raw axis-tag number for variable-font axis properties;
    // survives de-animation (the tag lives in the value data, which
    // keyframe removal deletes before `_deanimate` re-writes it).
    this._vf_tag_cache = null;

    // The axis display-name container AE writes after an active
    // variable-font axis slot's tdbs (set by the parser).
    this._vfdn = null;

    // The Curves effect's curves, its arbitrary data (set by the
    // parser): a LIST:aRbs of one aRbp, or of one per keyframe when keyed,
    // in key order. `value` decodes them as [Curves][].
    this._arbs = null;

    // The static aRbp decoded, on first read.
    this._curves = null;

    // The Curves effect's default curves, from its parT (set by the
    // parser).
    this._default_arbp = null;
  }

  /** `true` for a variable-font axis slot property. */
  get _is_vf_axis(): boolean {
    return this.match_name.startsWith(VF_AXIS_PREFIX);
  }

  /**
   * The raw 4CC tag number of an ACTIVE axis property, else `null`.
   *
   * Read from the static value's second dimension or the first
   * keyframe's, then cached (see `_vf_tag_cache`).
   */
  _vf_axis_tag_raw(): number | null {
    if (!this._is_vf_axis) return null;
    if (this._vf_tag_cache != null) return this._vf_tag_cache;
    let raw: number | null = null;
    if (this._cdat != null && this._cdat.values.length >= 2) {
      raw = this._cdat.values[1];
    } else if (this.keyframes?.length > 0) {
      const kf_raw = this.keyframes[0]._extract_raw_value();
      if (Array.isArray(kf_raw) && kf_raw.length >= 2) raw = kf_raw[1];
    }
    if (raw != null && raw !== 0) {
      this._vf_tag_cache = raw;
      return raw;
    }
    return null;
  }

  /**
   * The 4-character variable-font axis tag (e.g. `wght`) bound to
   * this `ADBE Text VF Axis` property. `null` for non-axis properties
   * and for unused axis slots. Read-only.
   *
   * **Warning:** 
   * `axis_tag` does not exist in the ExtendScript API. It has
   * been added for convenience (ExtendScript surfaces the tag
   * only through the property's display name).
   */
  get axis_tag(): string | null {
    const raw = this._vf_axis_tag_raw();
    if (raw == null) return null;
    return _vf_tag_to_str(raw);
  }

  /** Speed unit factor for ease objects: 100 for percent properties. */
  get _speed_factor(): number {
    if (_PERCENT_MATCH_NAMES.has(this.match_name)) return 100.0;
    return 1.0;
  }

  /**
   * Speed unit factor for an effect point's ease, or `null`.
   *
   * AE stores an effect point's ease speed normalized against the
   * composition height, and ExtendScript reports it in pixel units. The
   * same scalar applies to both the in and out directions and is
   * independent of the width - verified in AE 2026 on 300x300, 400x300,
   * 800x200 and 1920x1080 comps, which all report an identical speed for
   * identical eases. A footage layer's `ADBE Anchor Point` is stored the
   * same way (AE 2026: an ease of 900 px/s on a 3000x200 solid stores
   * 4.5, one of 114.6 px/s on a 200x100 solid 1.146).
   *
   * Resolved when the ease is read rather than pushed onto every
   * keyframe: `_effect_scale` is unavailable while the property is still
   * being constructed, and re-deriving it per value read used to rescan
   * every keyframe, which is quadratic in the keyframe count.
   */
  get _effect_point_speed_factor(): number | null {
    const scale = this._effect_scale;
    if (scale == null || scale[1] === 0) return null;
    return scale[1];
  }

  /**
   * Set back-references on keyframes after construction.
   *
   * Each keyframe gets a reference to its owning property and to its
   * prev/next neighbours for lazy ease computation.
   */
  _link_keyframes(): void {
    // Assign None explicitly at the boundaries: after a removal or a
    // reorder the previous links are stale, and boundary keyframes
    // must read prev/next as None (ease resolution depends on it).
    for (const [i, kf] of this.keyframes.entries()) {
      kf._bind_property(this);
      kf._prev = i > 0 ? this.keyframes[i - 1] : null;
      kf._next = i < this.keyframes.length - 1 ? this.keyframes[i + 1] : null;
    }
  }

  /**
   * `keyframe`'s position in `keyframes`, `null` once it is removed.
   *
   * Cached by identity and checked on every read, so after any change
   * to the list a stale entry is rebuilt (once) rather than trusted: an
   * ease read on a long track no longer scans every keyframe.
   */
  _keyframe_index(keyframe: Keyframe): number | null {
    const keyframes = this.keyframes;
    let positions: Map<Keyframe, number> = this._keyframe_positions || new Map();
    let index = positions.get(keyframe) ?? null;
    if (index == null || index >= keyframes.length || keyframes[index] !== keyframe) {
      positions = new Map(keyframes.map((kf, i) => [kf, i] as const));
      this._keyframe_positions = positions;
      index = positions.get(keyframe) ?? null;
    }
    return index;
  }

  /**
   * Re-link only the keyframe inserted at `idx` and its neighbours.
   *
   * Equivalent to `_link_keyframes` after a single insertion, but O(1)
   * so bulk additions (`set_values_at_times`) stay linear.
   */
  _link_inserted_key(idx: number): void {
    const kf = this.keyframes[idx];
    if (idx > 0) {
      kf._prev = this.keyframes[idx - 1];
      this.keyframes[idx - 1]._next = kf;
    }
    if (idx + 1 < this.keyframes.length) {
      kf._next = this.keyframes[idx + 1];
      this.keyframes[idx + 1]._prev = kf;
    }
  }

  /**
   * Reject moving `kf` onto another keyframe's exact time.
   *
   * Compares raw timebase units rather than frame indices: two
   * keyframes can legitimately share a frame while sitting at
   * different sub-frame times, and rounding would reject that as a
   * collision.
   *
   * Only applies to a keyframe already in `keyframes`: during
   * `add_key` construction the time is assigned before insertion, and
   * landing on an existing time legitimately returns that keyframe's
   * index instead.
   */
  _guard_keyframe_move(kf: Keyframe, new_units: number): void {
    try {
      index_by_identity(this.keyframes, kf);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return;
    }
    if (this.keyframes.some((k) => k !== kf && k.time_units === new_units)) {
      throw new ValueError(`another keyframe already exists at time ${new_units} units`);
    }
  }

  /**
   * Restore sorted keyframe order after `kf`'s time changed.
   *
   * The binary and the model pair several structures positionally
   * with `keyframes`: the ldat header items, the parallel value
   * container's chunks (otda / Nmrd / shap / Utf8) and a text
   * property's COS document array. Moving a keyframe past a
   * neighbour must move all of them together and re-link the
   * prev/next chain (LINEAR ease speeds and `value_at_time` read
   * neighbours by order). No-op for a keyframe not (yet) in
   * `keyframes` or whose sorted position is unchanged.
   */
  _reposition_keyframe(kf: Keyframe): void {
    let old: number;
    try {
      old = index_by_identity(this.keyframes, kf);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return;
    }
    const new_units = kf.time_units;
    const new_ = this.keyframes.filter((k) => k !== kf && k.time_units < new_units).length;
    if (new_ === old) return;
    const [_lhd3, ldat] = this._ensure_animated();
    this.keyframes.splice(new_, 0, ...this.keyframes.splice(old, 1));
    ldat.items.splice(new_, 0, ...ldat.items.splice(old, 1));
    const container = this._kf_value_container;
    if (container != null && old < container.chunks.length) {
      container.chunks.splice(new_, 0, ...container.chunks.splice(old, 1));
    }
    if (this._arbs != null && old < this._arbs.chunks.length) {
      // The Curves effect's curves, one aRbp per key: AE pairs them by
      // position, so a key's curves move with it.
      this._arbs.chunks.splice(new_, 0, ...this._arbs.chunks.splice(old, 1));
    }
    if (this._parallel_kind() === TEXT_KIND) {
      const td = kf.value;
      if (td instanceof TextDocument) {
        const doc_array = cos_get(td._cos_data, "1", "1");
        if (old < cos_len(doc_array)) {
          cos_insert(doc_array, new_, cos_pop_at(doc_array, old));
        }
        td._propagate_cos();
      }
    }
    this._link_keyframes();
  }

  /**
   * Re-derive every roving keyframe's time from the spatial path.
   *
   * Called after any mutation that can reshape a roving run: a value
   * edit (the path changed), a bounding keyframe's time moving (the
   * span changed), or a roving flag flip. Writes directly to the
   * backing time field to avoid recursion through `_set_time_units`.
   */
  _redistribute_roving_keyframes(): void {
    if (!this._has_motion_path) return;
    // Orientation is spatial-valued but inert under roving: AE's
    // menu accepts the command (26.3x87) yet the keyframe keeps its
    // time and ease unchanged.
    if (this.match_name === "ADBE Orientation") return;
    const keyframes = this.keyframes;
    if (keyframes.length < 3) return;
    // This runs on every value, time and tangent write, so a property
    // with no roving keyframes must not pay for a full pass. The flag is
    // read off the chunk rather than through the `roving` descriptor:
    // that hop was four fifths of the cost.
    if (!keyframes.some((kf) => kf._ldat_item.roving)) return;
    const targets = roving_keyframe_times(keyframes, this._arc_metric);
    if (!targets?.size) return;
    // Units count layer time, so there is no composition-time offset or
    // stretch to undo here. Converting scaled the run by the stretch
    // factor and displaced it by the layer's start time, pushing roving
    // keys outside their own anchors (AE 2026: a run bounded at comp 2
    // and 8 on a 200 % layer put a roving key at -0.017).
    const holders = new Map<number, number>(keyframes.map((kf, i) => [kf.time_units, i] as const));
    for (const [index, target] of targets) {
      const kf = keyframes[index];
      let units = target;
      // A degenerate path (coincident keyframes) can map a key onto a
      // unit another key holds; AE steps it away from that key's
      // side, one unit at a time, for at most ten tries per keyframe.
      for (let j = 0, n = 10 * keyframes.length; j < n; j++) {
        const holder = holders.get(units) ?? null;
        if (holder == null || holder === index) break;
        units += holder > index ? -1 : 1;
      }
      // Still taken once the tries run out (wedged between two keys):
      // leave it where it is rather than stack two keys on one unit.
      if (units === kf.time_units || (holders.get(units) ?? index) !== index) continue;
      holders.delete(kf.time_units);
      holders.set(units, index);
      kf._ldat_item.time_units = units;
    }
  }

  /**
   * Flip synthetic flags so backing chunks become visible to write_aep().
   *
   * Called automatically by `ChunkField.__set__` on first end-user write
   * to a synthesized property. After this method, the property is
   * indistinguishable from one that was parsed from binary.
   */
  _ensure_materialized(): void {
    py_assert(this._tdsb != null);
    if (!this._tdsb.synthetic) return;

    const parent = this.parent_property;
    if (this.match_name === "ADBE Mask Shape" && parent != null && parent._is_mask && parent instanceof _mask_property_group().MaskPropertyGroup) {
      // A path-less mask stores no path. Whatever first writes its
      // Mask Path (a value, a key, an expression) makes AE write the
      // default full-frame rectangle it stands for; a bare placeholder
      // instead is "file is damaged" (AE 2026). The builder replaces
      // the placeholder in place and rebinds this property to it.
      parent._materialize_mask_shape();
      return;
    }
    if (parent != null) parent._ensure_materialized();

    this._set_subtree_synthetic(false);

    this._ensure_time_base();
    this._complete_static_value_chunks();
    this._reposition_canonically();
    this._ensure_bound_chunks();
    this._materialize_static_orientation();
    this._ensure_mask_index_chunks();
  }

  /**
   * Flip the synthetic flag on `tdmn` and the whole `tdbs` subtree.
   *
   * `write_aep` skips synthetic chunks, so this is what hides a
   * property from the writer or reveals it: `false` materializes,
   * `true` un-materializes (see `_revert_to_synthetic`).
   */
  _set_subtree_synthetic(value: boolean): void {
    if (this._tdmn != null) this._tdmn.synthetic = value;
    this._tdbs.synthetic = value;
    for (const chunk of this._tdbs.chunks) {
      chunk.synthetic = value;
      if (hasattr(chunk, "chunks") && (chunk instanceof ListChunk || chunk instanceof ContainerChunk)) {
        for (const nested of chunk.chunks) nested.synthetic = value;
      }
    }
  }

  /**
   * Append the `tdli` index chunk AE requires for a materialized
   * MASK_INDEX effect param (e.g. a Path Text path selector).
   *
   * AE stores a mask-index param's value in a `tdli` (S4Chunk) after the
   * cdat (the cdat itself stays all-zeros, see
   * `_complete_static_value_chunks`), and rejects a materialized tdbs
   * lacking it with "missing data in file".
   */
  _ensure_mask_index_chunks(): void {
    if (this.property_value_type !== PropertyValueType.MASK_INDEX) return;
    if (this._tdbs.chunks.some((c) => ("chunk_type" in c ? c.chunk_type : "") === "tdli")) return;
    const index = (typeof this._value === "number" && Number.isInteger(this._value)) || typeof this._value === "boolean" ? this._value : 0;
    this._tdbs.chunks.push(new S4Chunk({ chunk_type: "tdli", value: index }));
  }

  /**
   * Stamp the containing comp's timebase into a py-created tdb4.
   *
   * AE writes `cdta.internal_timebase` (e.g. 24576 for 24 fps) into
   * every layer-level tdb4 and rejects the file with "zero denominator
   * converting ratio denominators" when the field is 0. Synthesized
   * tdb4 chunks start at 0 (or the 30 fps placeholder 0x7800), so fix
   * them up the moment they become visible to `write_aep`. Chunks
   * parsed from a real file never reach this method (the synthetic
   * early-return above), preserving byte identity.
   */
  _ensure_time_base(): void {
    if (this._tdb4 == null) return;
    const comp = this._owning_comp();
    if (comp != null) {
      // The layer's own base, not the comp's: a stretched layer counts
      // its keyframe ticks against `internal_timebase * |stretch|`.
      this._tdb4._time_base = int(this._layer_timebase || comp._cdta.internal_timebase);
      if (this._tdb4._spatial_marker && !this._tdb4.color && !this._tdb4.no_value && this._effect_scale == null) {
        // AE writes the comp's pixel aspect into a layer's spatial
        // point tdb4s (not orientation / color). A point stored
        // normalized to its layer is measured otherwise, stamped
        // when keyed (`_stamp_normalized_arc_metric`).
        this._tdb4.pixel_aspect = comp._cdta.pixel_aspect;
      }
    }
  }

  /**
   * Stamp how AE measures a newly keyed normalized point's path.
   *
   * A point stored as a fraction of its layer (an effect point, a
   * footage layer's Anchor Point) is measured in layer heights: AE
   * stamps the layer's display aspect (source width * pixel aspect /
   * height) as the X multiplier and fits to `NORMALIZED_ARC_ACCURACY`
   * when the point is first keyed, and keeps both once its keys are
   * removed. A never-keyed point holds 1.0 / 1e-4. AE evaluates the
   * stored values (AE 2026: 15.0 on a 3000x200 solid, 3.556 on a 640x360
   * one with 2:1 pixels; a point keyed with 1.0 plays up to 3 px off).
   */
  _stamp_normalized_arc_metric(): void {
    const scale = this._effect_scale;
    if (scale == null || scale[1] === 0 || !this._has_motion_path) return;
    const layer = this._containing_layer;
    const source: AVLayer["source"] | null = getattr(layer, "source", null);
    const pixel_aspect = source != null ? source.pixel_aspect : layer.containing_comp.pixel_aspect;
    this._tdb4.pixel_aspect = (scale[0] * pixel_aspect) / scale[1];
    this._tdb4._arc_accuracy = NORMALIZED_ARC_ACCURACY;
  }

  /**
   * Append the `tdum`/`tduM` min/max chunks AE requires for
   * multi-dimensional non-spatial vector properties (e.g. Scale) and
   * for bounded scalar properties (percentage coefficients, position
   * followers, time remap).
   *
   * After Effects writes these `[0.0]` placeholder bounds for such
   * properties and rejects the materialized property ("missing data
   * in file") when they are absent. Spatial (Position, Anchor Point),
   * unbounded 1D (Rotation), integer and color properties do not
   * need them.
   */
  _ensure_bound_chunks(): void {
    if (this._tdum != null || this._tduM != null) return;
    if (this._hint_bounds != null) {
      // Layer Styles scalars: AE writes the UI slider hints (not the
      // real clamp) as the bound values (psd_layer_styles fixtures).
      const [low, high] = this._hint_bounds;
      this._tdbs.chunks.push(new TdumChunk({ chunk_type: "tdum", values: [low] }));
      this._tdbs.chunks.push(new TdumChunk({ chunk_type: "tduM", values: [high] }));
      return;
    }
    // Synthetic EFFECT params: AE writes tdum/tduM for SCALAR /
    // INTEGER / SLIDER control types (RE'd vs AE 2026) regardless of
    // can_vary, and omits them for ANGLE / POINT / 3D / COLOR / BOOLEAN /
    // ENUM / LAYER. This bypasses the can_vary / fallback gating below,
    // which only governs layer/shape props.
    const effect_bounded =
      this._is_in_effect() && this.constructor._EFFECT_BOUNDED_CONTROL_TYPES.has(this._property_control_type);
    if (!effect_bounded) {
      // AE writes [0.0] bounds only on ANIMATABLE bounded leaves; it omits
      // them on bounded menu/dropdown leaves (Line Cap, Fill Rule, Grad
      // Type, ...) which report can_vary_over_time=False. Match that.
      if (this._can_vary_over_time === false) return;
      const multi_dim_vector = !this._color && !this.is_spatial && this._vector && this.dimensions > 1;
      const fallback_bounded =
        (this._min_value_fallback !== _UNSET || this._max_value_fallback !== _UNSET) &&
        !this._color &&
        !this.is_spatial &&
        !this._tdb4.integer &&
        !this._is_in_effect();
      // AE persists the [0.0] placeholder tdum/tduM for the props in
      // _PLACEHOLDER_UNBOUNDED (e.g. Light Intensity) even though
      // ExtendScript reports hasMin/hasMax=False, and rejects a
      // materialized one that lacks them ("missing data in file").
      const placeholder_unbounded = _PLACEHOLDER_UNBOUNDED.has(this.match_name);
      if (!multi_dim_vector && !this._bound_chunks_hint && !fallback_bounded && !placeholder_unbounded) {
        return;
      }
    }
    if (this._tdbs.chunks.some((c) => c.chunk_type === "tdum" || c.chunk_type === "tduM")) return;
    // AE writes doubles whatever the tdb4 integer flag says (all 47652
    // integer-flagged bounds in the sample corpus are 8 bytes), holding an
    // effect param's UI slider range (24594 of the corpus's 24676 effect
    // bounds, and AE 2026 materializing a Slider Control writes 0 / 100).
    // AE reads neither back: the bounds ExtendScript reports come from
    // the effect's definition.
    const slider_low = effect_bounded ? this._slider_min : null;
    const slider_high = effect_bounded ? this._slider_max : null;
    this._tdbs.chunks.push(
      new TdumChunk({
        chunk_type: "tdum",
        values: [slider_low == null ? 0.0 : slider_low],
      }),
    );
    this._tdbs.chunks.push(
      new TdumChunk({
        chunk_type: "tduM",
        values: [slider_high == null ? 0.0 : slider_high],
      }),
    );
  }

  // The tdum/tduM values AE writes for this property at materialization
  // (UI slider hints); set from `PropSpec.hint_bounds` in `_new`, `None`
  // (the class default, covering parsed properties) keeps the family
  // behavior in `_ensure_bound_chunks`.
  _hint_bounds: [number, number] | null = null;

  // Numeric value types whose binary value is a cdat run.
  static _NUMERIC_PVTS: ReadonlySet<PropertyValueType> = new Set<PropertyValueType>([
    PropertyValueType.OneD,
    PropertyValueType.TwoD,
    PropertyValueType.ThreeD,
    PropertyValueType.TwoD_SPATIAL,
    PropertyValueType.ThreeD_SPATIAL,
    PropertyValueType.COLOR,
    PropertyValueType.NO_VALUE,
  ]);

  // Effect-param control types AE writes tdum/tduM bounds for when a
  // synthesized param is materialized (RE'd vs AE 2026 references; see
  // scripts/_tmp_a6re). The other control types (ANGLE / POINT / 3D / COLOR /
  // BOOLEAN / ENUM / LAYER) get no bounds. A SCALAR / INTEGER / SLIDER effect
  // param materialized WITHOUT these placeholders is rejected by AE ("missing
  // data in file"). AE's full per-control-type tdb4 canon is NOT reproduced -
  // AE tolerates the synthesis-default flags on open, and matching the canon's
  // integer bit would wrongly flip can_set_expression for point/scalar params.
  static _EFFECT_BOUNDED_CONTROL_TYPES: ReadonlySet<PropertyControlType | null> = new Set<PropertyControlType>([
    PropertyControlType.SCALAR,
    PropertyControlType.INTEGER,
    PropertyControlType.SLIDER,
  ]);

  /**
   * Give a materialized property the `cdat` AE writes: present,
   * padded to AE's canonical length, and in raw binary units.
   *
   * AE pads cdat to `5 * dims` doubles for scalar / vector
   * properties and `3 * dims` for color and spatial ones, and
   * refuses materialized properties without a value chunk
   * ("missing data in file"). Complex kinds (orientation, marker,
   * shape, gradient, text) manage their own value containers.
   */
  _complete_static_value_chunks(): void {
    if (this._parallel_kind() != null || this._tdb4 == null) return;
    if (this.property_value_type === PropertyValueType.MASK_INDEX) {
      // MASK_INDEX cdat is 5 zero doubles (like OneD); the index value
      // lives in a separate `tdli` chunk (see _ensure_mask_index_chunks),
      // NOT in the cdat, which stays all-zeros.
      if (this._cdat == null) {
        const cdat = new CdatChunk({ values: list_mul([0.0], 5) });
        this._tdbs.chunks.splice(index_by_identity(this._tdbs.chunks, this._tdb4) + 1, 0, cdat);
        this._cdat = cdat;
      } else if (this._cdat.values.length < 5) {
        this._cdat.values = list_mul([0.0], 5);
      }
      return;
    }
    if (!this.constructor._NUMERIC_PVTS.has(this.property_value_type)) return;
    if (this._tdb4.no_value) {
      // No-value properties (e.g. Layer Source Alternate) carry a
      // 4-zero-byte empty cdat; a padded double block makes AE fail
      // with "chunk in file too big".
      if (this._cdat == null) {
        const cdat = new CdatChunk({ pad: b("\x00\x00\x00\x00") });
        this._tdbs.chunks.splice(index_by_identity(this._tdbs.chunks, this._tdb4) + 1, 0, cdat);
        this._cdat = cdat;
      }
      return;
    }
    if (this.match_name === "ADBE Anchor Point" || this.match_name === "ADBE Position") {
      // AE writes static transform spatials with vector-style flags
      // (measured on addCamera / addLight output, AE 2026).
      this._tdb4._spatial_static_flags = 0x0f;
      this._tdb4._value_hint_type = 0xffff;
      this._tdb4._value_hint_flag = 0xff;
      this._tdb4._cvot_flags = 0xff;
      this._tdb4._type_flags = 0x08;
      this._tdb4._property_category = 0x09;
      this._tdb4._spatial_marker = true;
    } else if (
      [
        "ADBE Vector Position",
        "ADBE Vector Anchor",
        "ADBE Vector Grad Start Pt",
        "ADBE Vector Grad End Pt",
      ].includes(this.match_name)
    ) {
      // Static shape spatials (measured on an AE 2026 SVG-cropped
      // import: group transform Position/Anchor + gradient-fill
      // Start/End points share one canon). Same vector-style flags as
      // a layer transform plus pad2a=3; without them AE silently
      // ignores the materialized value (reads 0,0).
      this._tdb4._spatial_static_flags = 0x0f;
      this._tdb4._pad2a = 3;
      this._tdb4._value_hint_type = 0xffff;
      this._tdb4._value_hint_flag = 0xff;
      this._tdb4._cvot_flags = 0xff;
      this._tdb4._type_flags = 0x08;
      this._tdb4._property_category = 0x09;
      this._tdb4._spatial_marker = true;
    } else if (this._color && !this._is_in_effect() && this._tdb4._value_hint_type === 0) {
      // Static color canon (measured on a script-modified vector
      // fill color, AE 2026); with the synthesis-default flags AE
      // silently ignores the materialized value.
      this._tdb4._spatial_static_flags = 0x07;
      this._tdb4._value_hint_type = 2;
      this._tdb4._value_hint_flag = 0xff;
      this._tdb4._cvot_flags = 0xff;
      this._tdb4._type_flags = 0x01;
      this._tdb4._property_category = 0x01;
      this._tdb4._spatial_marker = true;
    } else if (
      !this._color &&
      !this.is_spatial &&
      !this._tdb4.integer &&
      !this._is_in_effect() &&
      this._tdb4._value_hint_type === 0 &&
      this._tdb4._property_category === 0
    ) {
      // Plain numeric properties synthesized without a time base
      // carry default flag bytes; AE writes them with the standard
      // vector canon (Scale, Rotate Z, Opacity, Z Position...).
      this._tdb4._value_hint_type = 1;
      this._tdb4._value_hint_flag = 0xff;
      this._tdb4._cvot_flags = 0xff;
      this._tdb4._type_flags |= 0x08;
      this._tdb4._property_category = 0x09;
    }
    const dims = this._tdb4.dimensions;
    let value = this._value;
    if (!(typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) value = this.default_value;
    if (!(typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) {
      value = dims <= 1 ? 0.0 : list_mul([0.0], dims);
    }
    const mult = this._color || this.is_spatial ? 3 : 5;
    const target = dims * mult;
    if (this._cdat == null) {
      const cdat = new CdatChunk({ values: list_mul([0.0], target) });
      this._tdbs.chunks.splice(index_by_identity(this._tdbs.chunks, this._tdb4) + 1, 0, cdat);
      this._cdat = cdat;
    } else if (this._cdat.values.length < target) {
      this._cdat.values = [...this._cdat.values, ...list_mul([0.0], target - this._cdat.values.length)];
    }
    this._write_cdat(value);
  }

  /**
   * Wrap a materialized static Orientation in the `otst` subtree
   * AE writes: `otst[tdbs(cdat le) + otky[otda]]` with a 1-dim tdb4.
   *
   * AE rejects a bare big-endian Orientation tdbs with "missing data
   * in file".
   */
  _materialize_static_orientation(): void {
    const kind = this._parallel_kind();
    if (kind == null || kind.name !== "orientation") return;
    if (this._wrapper != null || this.keyframes?.length > 0) return;
    let value = this._value;
    if (!Array.isArray(value)) {
      value = Array.isArray(this.default_value) ? this.default_value : [0.0, 0.0, 0.0];
    }
    const container = this._materialize_parallel_container(kind);
    container.chunks.push(kind.build_value_chunk(this, value));
    const new_cdat = kind.static_cdat(value);
    if (this._cdat != null && this._tdbs.chunks.some((c) => c === this._cdat)) {
      this._tdbs.chunks[index_by_identity(this._tdbs.chunks, this._cdat)] = new_cdat;
    } else {
      this._tdbs.chunks.splice(index_by_identity(this._tdbs.chunks, this._tdb4) + 1, 0, new_cdat);
    }
    this._cdat = new_cdat;
  }

  _chunk_body(): ListChunk | null {
    return this._tdbs;
  }

  /**
   * `true` when this property's tdum/tduM is an all-zero `[0.0]`
   * placeholder that ExtendScript reports as no bound.
   *
   * AE writes `[0.0]` bound chunks for Scale and the separated-Position
   * followers even though ExtendScript reports no min/max; the bytes are
   * kept on disk for round-trip but must not surface as a real bound.
   * Scoped to `_PLACEHOLDER_UNBOUNDED` so genuinely-bounded props (and
   * Time Remapping, whose `maxValue=0` ExtendScript does report) are
   * untouched.
   */
  _is_placeholder_bound(body: TdumChunk): boolean {
    return _PLACEHOLDER_UNBOUNDED.has(this.match_name) && body.values.every((v) => v === 0.0);
  }

  /** Extract value from a tdum/tduM chunk body. */
  static _read_tdum(body: TdumChunk): number | number[] {
    if (body.is_color) return [...body.values];
    if (body.is_integer) return int(body.values[0]);
    if (body.values.length === 1) return body.values[0];
    return [...body.values];
  }

  /**
   * Read the raw value from the cdat chunk body.
   *
   * Returns a scalar for 1D non-color properties, an array for
   * multi-dimensional or color properties, or `null` when the
   * chunk has no data.
   */
  _read_cdat_raw(): number | number[] | null {
    if (this._cdat == null) return null;
    const values = this._cdat.values.slice(0, this.dimensions);
    if (values.length === 0) return null;
    if (this.dimensions === 1 && !this._color) return values[0];
    return values;
  }

  /**
   * Forward-transform a raw binary value to user-facing units.
   *
   * Applied in order: percent scaling, color conversion, effect point
   * denormalization.
   */
  _resolve_value(raw: number[] | number | null): number[] | number | null {
    if (raw == null) return null;
    // 0. Variable-font axis: the binary stores [value, tag4cc] but
    //    ExtendScript exposes only the scalar axis value.
    if (this._is_vf_axis && Array.isArray(raw) && raw.length >= 2) {
      if (this._vf_tag_cache == null && raw[1] !== 0) this._vf_tag_cache = raw[1];
      return raw[0];
    }
    // 1. Percent scaling (0-1 fraction -> 0-100 percentage)
    if (_PERCENT_MATCH_NAMES.has(this.match_name)) {
      if (typeof raw === "number" || typeof raw === "boolean") {
        raw = raw * 100.0;
      } else if (Array.isArray(raw)) {
        raw = raw.map((v) => v * 100.0);
      }
      // For 2D layers, Z-Scale is stored as 0.01 in the binary
      // (irrelevant axis). ES always normalizes it to 100.
      if (this._scale_z_override != null && Array.isArray(raw) && raw.length >= 3) {
        raw[2] = this._scale_z_override;
      }
    }
    // 2. Color (ARGB 0-255 -> RGBA 0-1)
    if (this._color) {
      if (Array.isArray(raw) && raw.length === 4) {
        const [a, r, g, b_] = raw;
        raw = [r / 255.0, g / 255.0, b_ / 255.0, a / 255.0];
      }
    }
    // 3. Effect point (0-1 fraction -> pixel coordinates)
    if (this._effect_scale != null) {
      if (Array.isArray(raw) && raw.length >= 2) {
        raw = this._apply_effect_scale(raw);
      }
    }
    return raw;
  }

  /**
   * Reverse-transform a user-facing value to raw binary units.
   *
   * Applied in reverse order: effect point normalization, color
   * conversion, then percent scaling.
   */
  _unresolve_value(value: number | number[]): number | number[];
  _unresolve_value(value: _ValueType | boolean): _ValueType | boolean;
  _unresolve_value(value: _ValueType | boolean): _ValueType | boolean {
    if (value == null) return null;
    if (!(typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) return value;
    if (Array.isArray(value) && value?.length > 0 && !(typeof value[0] === "number" || typeof value[0] === "boolean")) return value;
    // 0. Variable-font axis: re-attach the tag dimension to a scalar
    //    ExtendScript-style value (raw 2-dim lists pass through).
    if (this._is_vf_axis && (typeof value === "number" || typeof value === "boolean")) {
      const tag = this._vf_axis_tag_raw();
      if (tag != null) return [float(value), tag];
      return value;
    }
    // 3. Reverse effect point (pixel coordinates -> 0-1 fraction)
    if (this._effect_scale != null) {
      if (Array.isArray(value) && value.length >= 2) {
        value = this._apply_effect_scale(value, { invert: true });
      }
    }
    // 2. Reverse color (RGBA 0-1 -> ARGB 0-255)
    if (this._color) {
      if (Array.isArray(value) && value.length === 4) {
        const [r, g, b_, a] = value;
        value = [a * 255.0, r * 255.0, g * 255.0, b_ * 255.0];
      }
    }
    // 1. Reverse percent (0-100 -> 0-1 fraction)
    if (_PERCENT_MATCH_NAMES.has(this.match_name)) {
      if (typeof value === "number" || typeof value === "boolean") {
        value = Number(value) / 100.0;
      } else if (Array.isArray(value)) {
        value = value.map((v) => v / 100.0);
      }
    }
    return value;
  }

  /**
   * Write a user-facing value to the cdat chunk body.
   *
   * Applies `_unresolve_value` to convert back to raw binary units
   * before writing.
   */
  _write_cdat(value: PropertyValue): void {
    if (this._cdat == null) return;
    if (!(typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) return;
    if (Array.isArray(value) && value?.length > 0 && !(typeof value[0] === "number" || typeof value[0] === "boolean")) return;
    const raw_value = this._unresolve_value(value);
    const raw = [...this._cdat.values];
    if (Array.isArray(raw_value)) {
      // `raw[:len(raw_value)] = raw_value` - a slice assignment.
      raw.splice(0, Math.min(raw_value.length, raw.length), ...raw_value);
    } else if (typeof raw_value === "number" || typeof raw_value === "boolean") {
      raw[0] = raw_value as number;
    }
    this._cdat.values = raw;
  }

  /**
   * The leader's value composed from its followers, or `null`.
   *
   * While `dimensions_separated` is on, the leader's own `cdat` is dead:
   * AE resets it to the comp-centre default on separate and drives the
   * layer from the X / Y / Z followers instead. Reading the stored value
   * reports that default - `keyframe_separated_dimensions.aep` stores
   * `[100, 100, 0]` on a 200x200 comp where AE reports `[0, 200, 0]`.
   *
   * With a `time`, each follower is sampled there instead: the leader
   * holds no keyframes while separated, so `value_at_time` would
   * otherwise report the same frozen value for the whole timeline.
   */
  _separated_value(time: number | null = null): number[] | null {
    const followers = this._separation_followers();
    if (followers == null) return null;
    const composed: number[] = [];
    for (const follower of followers) {
      const component = time == null ? follower.value : follower.value_at_time(time);
      if (!(typeof component === "number" || typeof component === "boolean")) return null;
      composed.push(component);
    }
    return composed;
  }

  /**
   * This leader's X / Y / Z followers while dimensions are separated.
   *
   * `null` when the property is not a separated leader, and while the
   * followers have not been synthesized yet - they are created after
   * the leader, so the leader is briefly separated with nothing to
   * drive.
   */
  _separation_followers(): Property<number>[] | null {
    if (!this.is_separation_leader || !this.dimensions_separated) return null;
    const followers = Array.from({ length: 3 }, (_, dim) => this.get_separation_follower(dim));
    if (!followers.every((follower) => follower != null)) return null;
    return followers;
  }

  /** The Curves effect's static curves, decoded from its aRbp. */
  _static_curves(): Curves {
    py_assert(this._arbs != null);
    if (this._curves == null) {
      const arbp = this._arbs.chunks[0];
      this._curves = Curves._from_binary(CurvesArbpChunk.from_arbp(arbp));
    }
    return this._curves;
  }

  /**
   * A keyed Curves effect's curves at `keyframe`, from its own aRbp.
   *
   * `null` when the aRbs does not hold one aRbp per keyframe.
   */
  _keyframe_curves(keyframe: Keyframe): Curves | null {
    py_assert(this._arbs != null);
    const arbps = this._arbs.chunks;
    if (arbps.length !== this.keyframes.length) {
      return null;
    }
    const arbp = arbps[index_by_identity(this.keyframes, keyframe)];
    return Curves._from_binary(CurvesArbpChunk.from_arbp(arbp));
  }

  /**
   * Reset the Curves effect's curves to a new instance's: static, with
   * the effect's default curves.
   *
   * AE 2026's `addProperty("ADBE CurvesCustom")` writes an untouched
   * instance's bytes (a never-animated tdb4, the empty cdat, the parT's
   * default aRbp), whatever the project's stored definition of the
   * effect holds.
   */
  _reset_curves(): void {
    py_assert(this._arbs != null && this._default_arbp != null);
    const inner = this._keyframe_inner();
    if (inner != null) {
      const cdat = new CdatChunk({ pad: _EMPTY_CDAT_PAD });
      const chunks = this._tdbs.chunks;
      chunks[index_by_identity(chunks, inner)] = cdat;
      this._cdat = cdat;
      this.keyframes.length = 0;
      tdb4_apply_static_template(this._tdb4, { in_interpolation: 0, out_interpolation: 0, spatial_flags: 0 });
    }
    this._arbs.chunks.splice(0, this._arbs.chunks.length, new Chunk({ chunk_type: "aRbp", data: this._default_arbp.data }));
    this._curves = null;
  }

  /**
   * A keyed Curves effect's curves at composition `time`.
   *
   * A key's own curves at the key, and until the next one after a Hold
   * key; the first key's before it and the last key's after it. AE
   * interpolates between linear keys in a way ExtendScript cannot read
   * (reading a Curves key's value aborts the script), so between them
   * this is `null` rather than a guess.
   */
  _keyed_curves_at(time: number): Curves | null {
    const keys = this.keyframes;
    if (time <= keys[0].time) return this._keyframe_curves(keys[0]);
    if (time >= keys[keys.length - 1].time) return this._keyframe_curves(keys[keys.length - 1]);
    const previous = [...keys].reverse().find((k) => k.time <= time);
    if (previous === undefined) throw new StopIteration();
    if (isclose(previous.time, time, 0.0, 1e-9) || previous.out_interpolation_type === KeyframeInterpolationType.HOLD) {
      return this._keyframe_curves(previous);
    }
    return null;
  }

  /**
   * Refuse a write to the Curves effect's curves, which py-aep only reads.
   *
   * ValueError: If this property holds a Curves effect's curves.
   */
  _reject_curves_write(): void {
    if (this._arbs != null) {
      throw new ValueError(
        `${repr(this.match_name)} holds the Curves effect's curves, which ` +
          "are read-only: py-aep does not write them back",
      );
    }
  }

  /** The default value of the property. */
  get default_value(): V | null {
    if (this._default_value_source != null) return this._default_value_source();
    return this._default_value;
  }

  set default_value(value: V | null) {
    this._default_value = value;
    this._default_value_source = null;
  }

  /**
   * The value of the named property at the current time.
   *
   * If `expression_enabled` is `true`, returns the evaluated expression
   * value. If there are keyframes, returns the keyframed value at the
   * current time. Otherwise, returns the static value. Read / Write.
   *
   * The type depends on `property_value_type`:
   * `number[]`, `number`, {@link Curves}, {@link Gradient},
   * {@link MarkerValue}, {@link Shape}, {@link TextDocument}, or `null`.
   *
   * Mutations on complex value types (TextDocument, Shape,
   * MarkerValue, Gradient) write through to the backing chunks
   * automatically, so re-assignment is not needed:
   *
   * ```ts
   * import { parse, type Property } from "@bevyl-ai/ts-aep";
   *
   * const app = parse("project.aep");
   * const prop = app.project.compositions[0].layers[0].transform.property("ADBE Position") as Property;
   * const text_doc = prop.value;
   * text_doc.font_size = 72; // persists automatically
   * // prop.value = text_doc; // unnecessary - same object
   * ```
   */
  get value(): V {
    return this._declared(this._mask_inert_z(this._stored_static_value()));
  }

  set value(value: V) {
    this._reject_curves_write();
    if (this._separation_followers() != null) {
      throw new ValueError(
        `cannot set the value of ${repr(this.match_name)} while its ` +
          "dimensions are separated; write its X / Y / Z followers " +
          "instead (get_separation_follower)",
      );
    }
    this._set_own_value(value);
  }

  /** {@link Property.value | value} before a 2-D layer's Z is reported as 0. */
  _stored_static_value(): PropertyValue {
    if (this._tdpi != null && this._composition != null) {
      const layer_id = this._tdpi.value;
      if (layer_id === 0) return 0;
      return (this._composition._layer_id_to_index.get(layer_id) ?? -1) + 1;
    }
    const separated = this._separated_value();
    if (separated != null) return separated;
    if (this._arbs != null && !this.keyframes?.length) return this._static_curves();
    if (this._value != null) return this._wire_text_version(this._value);
    if (this.keyframes?.length > 0) return this._stored_value_at(0);
    if (this._cdat != null) return this._resolve_value(this._read_cdat_raw());
    if (this.match_name === "ADBE Mask Shape") {
      // A mask AE never needed a path for stores none; AE reports the
      // rectangle bounding the layer's mask space, the path it writes
      // once one is needed. Built on every read, not cached, so it
      // follows the layer's source and a read, edited and re-assigned
      // value is still written.
      const layer = this._containing_layer;
      if (!(layer instanceof _av_layer().AVLayer)) throw new AttributeError("_mask_scale");
      const [w, h] = layer._mask_scale;
      return new Shape([
        [0.0, 0.0],
        [0.0, h],
        [w, h],
        [w, 0.0],
      ]);
    }
    return null;
  }

  /**
   * Write a separated leader's value through its X / Y / Z followers.
   *
   * Not reachable from the public setter, which rejects a separated
   * leader as After Effects does. This is the path AE takes *itself*
   * when it reparents a layer: it compensates the followers even though
   * `setValue` on the leader errors. `Layer.parent` is the caller.
   *
   * While `dimensions_separated` is on the leader's own `cdat` is dead -
   * AE drives the layer from the followers - so a write that landed
   * there would read back as the stale default and never reach what AE
   * renders. This is the write-side counterpart of `_separated_value`.
   *
   * Only components that actually change are written, which leaves an
   * untouched Z follower synthetic on a 2D layer (as AE does) and
   * avoids materializing it for nothing.
   */
  _set_separated_value(value: _ValueType, followers: Property<number>[]): void {
    _validate_value(this, value);
    if (!Array.isArray(value)) {
      throw new ValueError(
        "a dimension-separated property's value must be a sequence " + `of ${followers.length} numbers`,
      );
    }
    for (const [follower, component] of zip(followers, value)) {
      if (follower.value !== component) follower.value = component;
    }
  }

  /**
   * Whether this is the Mask Path of a mask AE has written no path for
   * (a fresh mask, which reports the default rectangle).
   */
  _unstored_mask_path(): boolean {
    return this.match_name === "ADBE Mask Shape" && this._kf_value_container == null;
  }

  /**
   * Write this property's own value, bypassing any separation fan-out.
   *
   * The raw path under the `value` setter, for the deliberate "park the
   * leader on its default" writes in `_separate_static` /
   * `_separate_animated`, which target the dead leader on purpose.
   */
  _set_own_value(value: _ValueType): void {
    // Re-assigning the identical complex value object (TextDocument,
    // Shape, MarkerValue, Gradient) is a no-op: those types write through
    // to the backing chunks via their own descriptors. Plain numeric/list
    // values have no write-through, so a value read, mutated in place, and
    // re-assigned must still be written to the cdat chunk.
    if (value == null && this._parallel_kind() === SHAPE_KIND) {
      // A fresh mask caches no value, so the identity shortcut below
      // would swallow `None` instead of rejecting it.
      _validate_value(this, value);
    }
    if (value === this._value && !(typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) return;
    if (this.keyframes?.length > 0) {
      // ExtendScript: "Can not call setValue() on a property with
      // keyframes." Writing a static value alongside keyframe data
      // produces a file AE refuses to open.
      throw new ValueError("Cannot set value on a property with keyframes. " + "Use set_value_at_time() instead.");
    }
    _validate_value(this, value);
    if (this._unstored_mask_path() && _same_path(value as Shape, this.value)) {
      // AE 2026 writes no path for a fresh mask set to the rectangle it
      // already reports (`maskPath.setValue(maskPath.value)` saves the
      // bare mask atom), so the default stays implicit here too.
      return;
    }
    const complex_value = !(typeof value === "number" || typeof value === "boolean" || Array.isArray(value) || value == null);
    // Arbitrary-data params (CUSTOM_VALUE, e.g. an effect's Curves /
    // ARBITRARY_DATA leaf) store their data in a separate blob, not the
    // numeric cdat. Writing a scalar/list into the cdat overflows it
    // (AE: "chunk in file too big") or crashes on the empty buffer; reject
    // it. Complex value objects take the write-through path below and are
    // unaffected.
    if (!complex_value && this.property_value_type === PropertyValueType.CUSTOM_VALUE) {
      throw new ValueError(
        "Cannot set a numeric value on a CUSTOM_VALUE (arbitrary-data) " +
          "property; its data is not stored in the numeric value chunk.",
      );
    }
    this._ensure_materialized();
    if (complex_value) {
      // A new complex value object (Shape, Gradient, TextDocument,
      // MarkerValue) assigned to a static property: `_write_cdat`
      // only writes numeric values, so the static value container
      // must be rebuilt.
      this._value = this._write_static_complex_value(value);
      return;
    }
    if (this.property_value_type === PropertyValueType.MASK_INDEX) {
      // The mask index lives in the `tdli` chunk, not the cdat (which
      // stays all-zeros); _ensure_materialized has appended one.
      const index = typeof value === "number" || typeof value === "boolean" ? int(value) : 0;
      for (const chunk of this._tdbs.chunks) {
        if (("chunk_type" in chunk ? chunk.chunk_type : "") === "tdli" && chunk instanceof S4Chunk) {
          chunk.value = index;
          break;
        }
      }
      this._value = value;
      return;
    }
    this._write_cdat(value);
    this._value = value;
  }

  /**
   * Cache a value decoded from chunks (parser-only).
   *
   * Unlike the public `value` setter this never rebuilds value
   * containers, never enforces the keyframe guard, and skips
   * validation: the value comes from the file and the chunks
   * already hold it. `_write_cdat` keeps the numeric path
   * byte-faithful (a no-op write-back of the values just read).
   */
  _cache_value(value: _ValueType): void {
    this._write_cdat(value);
    this._value = value;
  }

  /**
   * Rebuild a static complex property's value container chunk.
   *
   * Static shapes / gradients store their single value chunk as the
   * only entry of the parallel container (omks / GCky); rebuild it
   * from `value` and return the model rebound to the inserted chunk
   * (so later in-place edits reach the serialized form, not the
   * caller's chunk). Orientation stores its value in the
   * (little-endian) cdat, which `_write_cdat` handles, so it is left
   * to the numeric path. Text (byte-format-sensitive btdk COS) and
   * markers (no static value) have no clean from-scratch container
   * build and are rejected.
   */
  _write_static_complex_value(value: PropertyValue): PropertyValue {
    const kind = this._parallel_kind();
    if (kind == null || kind.name === "orientation") {
      this._write_cdat(value);
      return value;
    }
    if (kind.name === "text") {
      throw new ValueError(
        "Cannot replace a static text value with a new TextDocument. " +
          "Mutate the existing prop.value in place (e.g. prop.value.text = ...).",
      );
    }
    if (kind.name === "marker") throw new ValueError("Markers have no static value to set.");
    let container = this._kf_value_container;
    if (container == null) {
      // A synthesized complex property (e.g. a freshly added gradient
      // fill) has no wrapper/container yet; build it the same way
      // animating would, then seed the static value.
      if (!kind.can_materialize_wrapper) {
        throw new ValueError(`static ${repr(this.match_name)} property has no value ` + "container to update");
      }
      container = this._materialize_parallel_container(kind);
      // AE keeps an (empty) cdat in the static tdbs; a synthesized
      // gradient leaf has none, which AE rejects as "missing data".
      if (this._cdat == null && this._tdbs != null && this._tdb4 != null) {
        const cdat = kind.static_cdat(value);
        this._tdbs.chunks.splice(index_by_identity(this._tdbs.chunks, this._tdb4) + 1, 0, cdat);
        this._cdat = cdat;
      }
    }
    const value_chunk = kind.build_value_chunk(this, value);
    if (container.chunks?.length > 0) {
      container.chunks[0] = value_chunk;
    } else {
      container.chunks.push(value_chunk);
    }
    const wrapped = kind.wrap_value_chunk(this, value_chunk);
    return wrapped ?? value;
  }

  /**
   * Give a {@link TextDocument} value a path to the project head so its
   * version-gated attributes can resolve the AE major version. No-op for
   * other value types or when the containing comp is unknown.
   */
  _wire_text_version<T extends _ValueType>(value: T): T {
    if (value instanceof TextDocument && this._composition != null) {
      value._head = this._composition._project._head;
    }
    return value;
  }

  /**
   * The minimum permitted value of the named property. Only valid if
   * `has_min` is `true`. Read-only.
   */
  get min_value(): number | number[] | null {
    if (_UNBOUNDED_MATCH_NAMES.has(this.match_name)) return null;
    if (this._min_value_fallback !== _UNSET) return this._min_value_fallback;
    if (this._tdum != null) {
      if (this._is_placeholder_bound(this._tdum)) return null;
      return this.constructor._read_tdum(this._tdum);
    }
    return null;
  }

  /**
   * The maximum permitted value of the named property. Only valid if
   * `has_max` is `true`. Read-only.
   */
  get max_value(): number | number[] | null {
    if (_UNBOUNDED_MATCH_NAMES.has(this.match_name)) return null;
    if (this._max_value_fallback !== _UNSET) return this._max_value_fallback;
    if (this._tduM != null) {
      if (this._is_placeholder_bound(this._tduM)) return null;
      return this.constructor._read_tdum(this._tduM);
    }
    return null;
  }

  /**
   * The text description of the units in which the value is expressed.
   *
   * Common values include `"pixels"`, `"degrees"`, `"percent"`,
   * `"seconds"`, and `"dB"`. An empty string indicates the property
   * has no specific unit. Read-only.
   */
  get units_text(): string {
    if (this._units_text != null) return this._units_text;
    if (this._property_control_type === PropertyControlType.ANGLE) return "degrees";
    // The map holds the spatial-valued exceptions (e.g. ADBE Orientation
    // is 3D-spatial but degrees), so it must win over the pixels heuristic.
    const mapped = UNITS_TEXT_MAP.get(this.match_name) ?? null;
    if (mapped != null) return mapped;
    const value_type = this._property_value_type;
    if (value_type === PropertyValueType.TwoD_SPATIAL || value_type === PropertyValueType.ThreeD_SPATIAL) {
      return "pixels";
    }
    return "";
  }

  /**
   * The text string of the currently-selected item in a dropdown
   * menu property.
   *
   * Only custom dropdown menus are supported (the `Menu` property of
   * a Dropdown Menu Control, whose item strings are stored in the
   * project file); returns `null` for every other property.
   * ExtendScript additionally covers built-in dropdowns, but their
   * item strings are application resources absent from the file.
   * Read-only.
   *
   * **Note:** 
   * This functionality was added in After Effects 26.0.
   */
  get value_text(): string | null {
    const params = this.property_parameters;
    if (!params?.length) return null;
    const value = this.value;
    if (typeof value !== "number" && typeof value !== "boolean") return null;
    // Dropdown values are 1-based indices into the menu strings.
    const index = int(value) - 1;
    if (0 <= index && index < params.length) return params[index];
    return null;
  }

  /**
   * An array of all item strings in a dropdown menu property. This
   * attribute applies to dropdown menu properties of effects and
   * layers, including custom strings in the Menu property of the
   * Dropdown Menu Control. Read / Write.
   *
   * Writing is only supported on the Menu property of a Dropdown
   * Menu Control (see `is_dropdown_effect`; mirrors ExtendScript
   * `Property.setPropertyParameters()`): the new items replace the
   * existing menu entries in the project file. Items must be
   * non-empty unique strings without `\\` or `|` characters; the
   * string `(-` inserts a separator line (and may repeat).
   */
  get property_parameters(): string[] | null {
    return this._property_parameters;
  }

  set property_parameters(items: string[]) {
    const effect = this._parent_property;
    if (!(this.is_dropdown_effect && effect != null && effect.match_name.startsWith("Pseudo/"))) {
      throw new ValueError(
        "property_parameters can only be set on the Menu property " + "of a Dropdown Menu Control.",
      );
    }
    if (!Array.isArray(items) || !items?.length) {
      throw new ValueError("items must be a non-empty list of strings.");
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item !== "string" || !item) {
        throw new ValueError("menu items must be non-empty strings.");
      }
      // The items are stored pipe-delimited, so "|" is as
      // unencodable as ExtendScript's forbidden "\".
      if (item.includes("\\") || item.includes("|")) {
        throw new ValueError("menu items must not contain the '\\' or '|' characters.");
      }
      if (item !== "(-") {
        if (seen.has(item)) throw new ValueError(`duplicate menu item ${repr(item)}.`);
        seen.add(item);
      }
    }
    items = [...items];
    this._write_dropdown_items(items);
    this._property_parameters = items;
    this.nb_options = items.length;
    this._max_value_fallback = items.length;
  }

  /**
   * The `parT` containers holding this Menu param's definition.
   *
   * A dropdown's parameter definition lives in the owning effect's
   * layer-level `sspc` and is mirrored in the project-level
   * `LIST:EfdG`; both copies must stay in sync when the menu items
   * change.
   */
  _dropdown_param_defs(): ListChunk[] {
    const effect = this._parent_property;
    py_assert(effect != null);
    const parts: ListChunk[] = [];
    const parade = effect._parent_property;
    if (parade != null) {
      if (parade._tdgp != null) {
        const sspc = effect._backing_list_chunk(parade._tdgp);
        if (sspc.list_type === "sspc") {
          const part = find_by_list_type_or_null(sspc.chunks, "parT");
          if (part !== null) parts.push(part);
        }
      }
      // The project-level EfdG mirror, via the parade's cached
      // definitions lookup. Effect params can parse without a
      // composition ref, leaving the project unreachable.
      let entry: ReturnType<PropertyGroup["_installed_effect_def"]>;
      try {
        entry = parade._installed_effect_def(effect.match_name);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        entry = null;
      }
      if (entry != null) {
        const part = find_by_list_type_or_null(entry[2].chunks, "parT");
        if (part !== null) parts.push(part);
      }
    }
    return parts;
  }

  /** Write new menu items into every copy of this param's definition. */
  _write_dropdown_items(items: string[]): void {
    const joined = items.join("|");
    let written = false;
    for (const part of this._dropdown_param_defs()) {
      let current: string | null = null;
      for (const chunk of part.chunks) {
        if (chunk.chunk_type === "tdmn" && chunk instanceof TdmnChunk) {
          current = chunk.value;
        } else if (current === this.match_name) {
          if (chunk instanceof EnumPardChunk) {
            // AE keeps the default choice unchanged.
            chunk.nb_options = items.length;
          } else if (chunk.chunk_type === "pdnm" && chunk instanceof ContainerChunk) {
            const utf8 = find_by_type(chunk.chunks, "Utf8");
            utf8.value = joined;
            written = true;
          }
        }
      }
    }
    if (!written) {
      throw new ValueError("No stored menu definition (pdnm) found for this property.");
    }
    // Keep the synthesis-side parameter definitions in sync. Effect
    // params parse without a composition ref; reach the project
    // through the owning layer instead.
    const effect = this._parent_property;
    py_assert(effect != null);
    let comp = this._composition;
    if (comp == null) {
      try {
        comp = this._containing_layer.containing_comp;
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        comp = null;
      }
    }
    if (comp != null) {
      const param_def = comp._project._effect_param_defs.get(effect.match_name)?.get(this.match_name);
      if (param_def != null) {
        param_def.property_parameters = [...items];
        param_def.nb_options = items.length;
        param_def.max_value = items.length;
      }
    }
  }

  /**
   * When `true`, the named property can vary over time - that is, keyframe
   * values or expressions can be written to this property.
   *
   * **Note:** 
   * A small subset of effect dropdown / menu parameters may report
   * `can_vary_over_time` as `false` in the binary even though After
   * Effects allows keyframing them.
   * Read-only.
   */
  get can_vary_over_time(): boolean {
    // The residue table first: a synthesized effect parameter carries its
    // pard's verdict in `_can_vary_over_time`, and the Puppet Engine's
    // pard claims it varies where AE says it does not.
    const override = _CANVARY_OVERRIDES.get(this.match_name);
    if (override !== undefined) return override;
    if (this._can_vary_over_time != null) return this._can_vary_over_time;
    // NO_VALUE properties always report canVaryOverTime=True in AE,
    // even though the binary byte says otherwise.
    return !!(this._tdb4.can_vary_over_time || this._no_value);
  }

  /**
   * When `true`, the property's dimensions are represented as separate
   * properties. For example, if the layer's position is represented as X
   * Position and Y Position properties in the Timeline panel, the Position
   * property has this attribute set to `true`. This attribute applies only
   * when the property is a "separation leader" (a multidimensional property
   * that can be separated). Read / Write.
   */
  get dimensions_separated(): boolean {
    if (this._dimensions_separated != null) return this._dimensions_separated;
    if (this.match_name === "ADBE Position") {
      // Camera and Light positions separate like any other 3-D layer's:
      // AE 2026 reports `dimensionsSeparated` false on a fresh one,
      // accepts the write, and reads back true with the position intact.
      //
      py_assert(this._tdsb != null);
      return !!this._tdsb.dimensions_separated;
    }
    return false;
  }

  set dimensions_separated(value: boolean) {
    validate_bool(value);
    if (!this.is_separation_leader) {
      // AE silently ignores this on a non-leader; raising keeps a
      // caller's mistake visible instead of swallowing the write.
      throw new ValueError(
        `dimensions_separated is only settable on the separation ` + `leader, not ${repr(this.match_name)}`,
      );
    }
    if (value === this.dimensions_separated) {
      // AE's dimensionsSeparated is idempotent. Re-running the transfer
      // would re-seed the followers from a leader that the first call
      // already reset to its default, destroying the separated values.
      return;
    }

    const followers = Array.from({ length: 3 }, (_, dim) => this.get_separation_follower(dim));
    if (!followers.every((follower) => follower != null)) {
      throw new ValueError(`${repr(this.match_name)} has no separation followers to transfer to`);
    }
    const live = followers;
    const animated = this.keyframes?.length > 0 || live.some((follower) => follower.keyframes?.length > 0);
    if (value) {
      if (animated) {
        this._separate_animated(live);
      } else {
        this._separate_static(live);
      }
    } else if (animated) {
      this._recombine_animated(live);
    } else {
      this._recombine_static(live);
    }
  }

  /**
   * Flag the leader separated or recombined in its own `tdsb`.
   *
   * AE hides the leader in the Timeline while the followers drive the
   * layer (enable byte 0x3, lock byte 0x8 on every separated position it
   * authored) and shows it again once recombined (enable byte 0x1).
   */
  _set_separated_flags(separated: boolean): void {
    this._ensure_materialized();
    py_assert(this._tdsb != null);
    this._tdsb.dimensions_separated = separated;
    this._tdsb.hidden = separated;
    this._dimensions_separated = separated;
  }

  /**
   * Hand the leader's components to its followers.
   *
   * AE seeds X / Y / Z from the leader, materializes them, and resets the
   * leader's own `cdat` to the property default - while separated the
   * leader is dead and the followers drive the layer. Z is materialized
   * only on a 3D layer, matching AE (`transform_separated.aep` leaves it
   * synthetic on a 2D one).
   */
  _separate_static(followers: Property<number>[]): void {
    const components = this.value as number[];
    const default_ = this.default_value as number[];
    this._set_separated_flags(true);
    const three_d = this._containing_layer.is_3d;
    for (const [dimension, follower] of followers.entries()) {
      if (dimension === 2 && !three_d) continue;
      follower.value = components[dimension];
    }
    // The leader keeps a value AE never reads again; AE parks it on the
    // default rather than leaving the old position there.
    this._set_own_value([...default_]);
  }

  /**
   * Fold the followers back into the leader.
   *
   * AE writes the composed value onto the leader and reverts the
   * followers to their dead, unserialized state.
   */
  _recombine_static(followers: Property<number>[]): void {
    const composed = followers.map((follower) => follower.value);
    this._set_separated_flags(false);
    this._set_own_value(composed);
    for (const follower of followers) _deactivate_follower(follower);
  }

  /** Incoming and outgoing segment durations for each keyframe. */
  static _segment_spans(times: number[]): [number[], number[]] {
    const incoming = [0.0, ...Array.from({ length: times.length - 1 }, (_, i) => times[i + 1] - times[i])];
    const outgoing = [...Array.from({ length: times.length - 1 }, (_, i) => times[i + 1] - times[i]), 0.0];
    return [incoming, outgoing];
  }

  /**
   * Move the leader's keyframes onto its followers.
   *
   * AE turns each spatial tangent into a per-dimension temporal ease:
   * `speed = |tangent| * 100` and `influence = 1 / dt` percent, where
   * `dt` is that side's segment duration. Measured on AE 2026 over
   * segment durations of 0.5, 2.5, 5 and 12 s - 16 components, all
   * matching. The in-side tangent points backwards, so its speed takes
   * the opposite sign.
   *
   * Interpolation types are copied across rather than derived from
   * whether a tangent is non-zero, which is what AE does: AE flattens a
   * HOLD keyframe to LINEAR here, and this project prefers not to mirror
   * that loss.
   */
  _separate_animated(followers: Property<number>[]): void {
    const keyframes = [...this.keyframes];
    const times = keyframes.map((keyframe) => keyframe.time);
    const values = keyframes.map((keyframe) => keyframe.value as number[]);
    const in_tangents = keyframes.map((keyframe) => py_or(keyframe.in_spatial_tangent, []));
    const out_tangents = keyframes.map((keyframe) => py_or(keyframe.out_spatial_tangent, []));
    const interpolation = keyframes.map(
      (keyframe) => [keyframe.in_interpolation_type, keyframe.out_interpolation_type] as const,
    );
    const [incoming, outgoing] = this.constructor._segment_spans(times);

    this.remove_all_keys();
    this._set_separated_flags(true);
    this._set_own_value([...(this.default_value as number[])]);

    const three_d = this._containing_layer.is_3d;
    for (const [dimension, follower] of followers.entries()) {
      if (dimension === 2 && !three_d) continue;
      for (const [index, time] of times.entries()) {
        const added = follower._add_key(time, values[index][dimension]);
        const keyframe = follower.keyframes[added];
        keyframe.in_interpolation_type = interpolation[index][0];
        keyframe.out_interpolation_type = interpolation[index][1];
        // Before the ease, not after: the continuity flag ties the
        // out speed to the in speed, and AE's own separated keyframes
        // carry tC=True with *different* speeds on each side.
        keyframe.temporal_continuous = true;
        for (const [direction, tangents, spans] of [
          ["in", in_tangents, incoming],
          ["out", out_tangents, outgoing],
        ] as const) {
          const span = spans[index];
          const tangent = tangents[index];
          if (span <= 0 || dimension >= tangent.length) {
            // An outer side has no segment to ease along; AE
            // parks it on zero speed and the default influence.
            keyframe._apply_ease([new KeyframeEase(0.0, _DEFAULT_INFLUENCE)], direction);
            continue;
          }
          let speed = tangent[dimension] * 100.0;
          if (direction === "in") speed = -speed;
          // Clamped: influence is a percentage, and a segment
          // shorter than 0.01 s (sub-frame keys, or one frame of a
          // very high frame rate) drives `1/dt` past the 100% the
          // field can mean.
          keyframe._apply_ease([new KeyframeEase(speed, Math.min(1.0 / span, 100.0))], direction);
        }
      }
    }
  }

  /**
   * Fold the followers' keyframes back into the leader.
   *
   * The inverse of `_separate_animated`: a tangent component is
   * `speed * (influence / 100) * dt`, which round-tripped exactly in the
   * AE probe.
   *
   * The leader gets a keyframe at the union of the followers' times, not
   * at one follower's: separation exists so each axis can be keyed on its
   * own, and pairing the lists positionally wrote X's second value beside
   * Y's second value however far apart in time they sat. A dimension with
   * no keyframe of its own at a given time contributes its interpolated
   * value there, and no tangent.
   */
  _recombine_animated(followers: Property<number>[]): void {
    if (!followers.some((follower) => follower.keyframes?.length > 0)) {
      this._recombine_static(followers);
      return;
    }
    const keys_at: Map<number, Keyframe<number>>[] = followers.map(
      (follower) => new Map(follower.keyframes.map((kf) => [kf.time, kf] as const)),
    );
    const times = sorted([...new Set(keys_at.flatMap((per_dimension) => [...per_dimension.keys()]))]);
    const [incoming, outgoing] = this.constructor._segment_spans(times);
    const dimensions = followers.length;
    const composed = times.map(() => list_mul([0.0], dimensions));
    const in_tangents = times.map(() => list_mul([0.0], dimensions));
    const out_tangents = times.map(() => list_mul([0.0], dimensions));
    // Interpolation is per keyframe, not per dimension: take it from the
    // first dimension that has a keyframe at that time.
    const interpolation = times.map((time) => {
      for (const per_dimension of keys_at) {
        const kf = per_dimension.get(time);
        if (kf !== undefined) {
          return [kf.in_interpolation_type, kf.out_interpolation_type] as const;
        }
      }
      return [KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR] as const;
    });

    for (const [dimension, follower] of followers.entries()) {
      for (const [index, time] of times.entries()) {
        const keyframe = keys_at[dimension].get(time);
        if (keyframe == null) {
          const sampled = follower.value_at_time(time);
          composed[index][dimension] = typeof sampled === "number" ? sampled : 0.0;
          continue;
        }
        composed[index][dimension] = keyframe.value;
        for (const [direction, target, spans] of [
          ["in", in_tangents, incoming],
          ["out", out_tangents, outgoing],
        ] as const) {
          const span = spans[index];
          if (span <= 0) continue;
          const ease = direction === "in" ? keyframe.in_temporal_ease : keyframe.out_temporal_ease;
          if (!ease?.length) continue;
          const magnitude = ease[0].speed * (ease[0].influence / 100.0) * span;
          target[index][dimension] = direction === "in" ? -magnitude : magnitude;
        }
      }
    }

    for (const follower of followers) _deactivate_follower(follower);

    this._set_separated_flags(false);
    for (const [index, time] of times.entries()) {
      this._add_key(time, composed[index]);
    }
    for (const [index, keyframe] of this.keyframes.entries()) {
      if (index >= times.length) break;
      keyframe.in_interpolation_type = interpolation[index][0];
      keyframe.out_interpolation_type = interpolation[index][1];
      if (keyframe.in_spatial_tangent != null) {
        keyframe.in_spatial_tangent = in_tangents[index].slice(0, keyframe.in_spatial_tangent.length);
      }
      if (keyframe.out_spatial_tangent != null) {
        keyframe.out_spatial_tangent = out_tangents[index].slice(0, keyframe.out_spatial_tangent.length);
      }
    }
  }

  /**
   * Hide this property's chunks from `write_aep` again.
   *
   * The inverse of `_ensure_materialized`'s flag flip, for a property AE
   * un-materializes - a separation follower once its leader is
   * recombined. Chunk order is left alone: synthetic chunks are skipped
   * on write, and `_reposition_canonically` runs again if the property is
   * ever materialized anew.
   */
  _revert_to_synthetic(): void {
    if (this._tdsb == null || this._tdsb.synthetic) return;
    this._set_subtree_synthetic(true);
  }

  /**
   * The expression for the named property. Writeable only when
   * `can_set_expression` for the named property is `true`.
   * Read / Write.
   */
  get expression(): string {
    if (this._expression != null) return this._expression;
    if (this._expression_utf8 != null) return this._expression_utf8.value;
    return "";
  }

  set expression(value: string) {
    if (value && !this.can_set_expression) {
      throw new AttributeError(`expression cannot be set on property ${repr(this.match_name)}`);
    }
    // A NUL ends the expression for AE 2026, which keeps only the text
    // before it, both when a script sets it and when it reads the file.
    validate_text(value);
    if (!value) {
      // Empty string clears the expression (chunk + tdb4 markers).
      this._clear_expression();
      return;
    }
    this._ensure_materialized();
    if (this._expression_utf8 != null) {
      this._expression_utf8.value = value;
    } else {
      const chunk = new Utf8Chunk({ value });
      // AE stores the expression Utf8 immediately after the value
      // container (cdat or the keyframe LIST:list), BEFORE any
      // tdum/tduM bounds - the order is positional, so appending at
      // the tail makes AE reject the file ("missing data in file").
      const chunks = this._tdbs.chunks;
      const anchor = this._cdat ?? this._keyframe_inner();
      if (anchor != null) {
        chunks.splice(index_by_identity(chunks, anchor) + 1, 0, chunk);
      } else {
        chunks.splice(index_by_identity(chunks, this._tdb4) + 1, 0, chunk);
      }
      this._expression_utf8 = chunk;
    }
    this._expression = value;
    // Assigning an expression enables it (AE semantics): clear any stale
    // disabled state so the cache recomputes True (mirrors _clear_expression).
    this._expression_enabled = null;
    if (this._tdb4 != null) {
      // AE marks an expression-bearing parameter in tdb4._pad10; the
      // inverse of _clear_expression so a created expression round-trips.
      this._tdb4.has_expression = true;
      this._tdb4._expr_flags = 0;
    }
  }

  /**
   * When `true`, the named property uses its associated expression to
   * generate a value. When `false`, the keyframe information or static
   * value of the property is used. Read / Write.
   */
  get expression_enabled(): boolean {
    if (this._expression_enabled != null) return this._expression_enabled;
    const disabled = "expression_disabled" in this._tdb4 ? this._tdb4.expression_disabled : true;
    return !disabled && !!this.expression;
  }

  set expression_enabled(value: boolean) {
    validate_bool(value);
    if (value && !this.can_set_expression) {
      // AE refuses the same write: "Can not set expression with this
      // property, because the property or a parent property is
      // hidden." Without the guard the write also materializes the
      // property, which for MARKER / NO_VALUE kinds emits chunks AE
      // rejects.
      throw new ValueError(`property ${repr(this.match_name)} cannot take an expression`);
    }
    if (value && !this.expression) {
      // AE silently no-ops here, leaving expressionEnabled false. Doing
      // the same would clear the tdb4 disabled bit for an expression
      // that does not exist - a byte AE never writes, which the getter
      // then masks behind `bool(self.expression)`. Raising instead of
      // mirroring the no-op keeps the caller's mistake visible.
      throw new ValueError(`property ${repr(this.match_name)} has no expression to enable`);
    }
    if (!value && !this.expression && this._unstored_mask_path()) {
      // Nothing to disable: AE 2026 saves a fresh mask given
      // `expressionEnabled = false` as the bare atom, with no path.
      return;
    }
    this._ensure_materialized();
    this._expression_enabled = value;
    this._tdb4.expression_disabled = !value;
  }

  /** When `true`, an expression can be set for the named property. Read-only. */
  get can_set_expression(): boolean {
    return resolve_can_set_expression(this);
  }

  /** The control type of the property (e.g., scalar, color, boolean). Read-only. */
  get property_control_type(): PropertyControlType {
    if (this._property_control_type != null) return this._property_control_type;
    const [pct] = this._determine_property_types();
    return pct;
  }

  /**
   * The type of value stored in the named property. Each type of data is
   * stored and retrieved in a different kind of structure. For example,
   * a 3D spatial property (such as a layer's position) is stored as an
   * array of three floating-point values. Read-only.
   */
  get property_value_type(): PropertyValueType {
    if (this._property_value_type != null) return this._property_value_type;
    const [, pvt] = this._determine_property_types();
    return pvt;
  }

  /**
   * Determine property control and value types from tdb4 flags.
   *
   * Memoized on the tdb4 bytes the inference actually reads, so every
   * write that could change the answer - animating, de-animating,
   * materializing a synthesized property, activating a VF axis -
   * invalidates it for free, with no invalidation hook to keep in sync.
   *
   * The `__dict__` overrides of `_no_value` / `_color` / `_vector` /
   * `dimensions` are not in the key. They are set once at parse or
   * synthesis time before any read, and `ChunkField.__set__` pops them
   * on a real write, so they cannot change under a live memo.
   *
   * Uncached this ran on every `property_value_type` and
   * `property_control_type` read - 15 times per `value_at_time` on an
   * animated Opacity, since `_effect_scale` alone consults the control
   * type ten times.
   */
  _determine_property_types(): [PropertyControlType, PropertyValueType] {
    const tdb4 = this._tdb4;
    let key: unknown[] | null;
    if (tdb4 != null) {
      key = [tdb4.dimensions, tdb4._type_flags, tdb4._spatial_static_flags, tdb4._no_value_flags];
      const memo = this._types_memo;
      if (memo != null && py_eq(memo[0], key)) {
        return memo[1];
      }
    } else {
      key = null;
    }
    const result = this._compute_property_types();
    if (key != null) {
      this._types_memo = [key, result];
    }
    return result;
  }

  /** Derive the control and value types from the tdb4 flags. */
  _compute_property_types(): [PropertyControlType, PropertyValueType] {
    let pct: PropertyControlType = PropertyControlType.UNKNOWN;
    let pvt: PropertyValueType = PropertyValueType.UNKNOWN;

    if (this._no_value) pvt = PropertyValueType.NO_VALUE;
    if (this._color) {
      pct = PropertyControlType.COLOR;
      pvt = PropertyValueType.COLOR;
    } else if (this._integer && this.dimensions <= 1) {
      pct = PropertyControlType.BOOLEAN;
      pvt = PropertyValueType.OneD;
    } else if (this._vector || (this._integer && this.dimensions > 1)) {
      if (this.dimensions === 1) {
        pct = PropertyControlType.SCALAR;
        pvt = PropertyValueType.OneD;
      } else if (this.dimensions === 2) {
        pct = PropertyControlType.TWO_D;
        pvt = this.is_spatial ? PropertyValueType.TwoD_SPATIAL : PropertyValueType.TwoD;
      } else if (this.dimensions === 3) {
        pct = PropertyControlType.THREE_D;
        pvt = this.is_spatial ? PropertyValueType.ThreeD_SPATIAL : PropertyValueType.ThreeD;
      }
    } else if (this.dimensions === 1) {
      // A plain 1-D scalar: AE clears the tdb4 vector bit for single
      // value properties (Opacity, Rotation, the last separation
      // follower, effect sliders), so they miss the vector branch
      // above. They are still OneD scalars.
      pct = PropertyControlType.SCALAR;
      pvt = PropertyValueType.OneD;
    }

    // Flag-based inference is a fallback for when the authoritative type
    // is not cached (e.g. transiently during synthesis, before the parser
    // populates it). Types that tdb4 flags cannot express - markers,
    // custom-value slots - come from the parser instead, so a miss here is
    // expected and not user-actionable: log at debug, not warning.
    if (pct === PropertyControlType.UNKNOWN) {
      logger.debug(
        `Could not determine type for property ${this.match_name}` +
          ` | dimensions: ${this.dimensions}` +
          ` | integer: ${this._integer}` +
          ` | is_spatial: ${this.is_spatial}` +
          ` | vector: ${this._vector}` +
          ` | no_value: ${this._no_value}` +
          ` | color: ${this._color}`,
      );
    }

    return [pct, pvt];
  }

  /**
   * `true` if the property is a multidimensional property that
   * can be separated.
   */
  get is_separation_leader(): boolean {
    return this.match_name === _SEPARATION_LEADER;
  }

  /**
   * `true` if the property is a component of a separated
   * multidimensional property (e.g. X Position, Y Position,
   * Z Position).
   */
  get is_separation_follower(): boolean {
    return _SEPARATION_FOLLOWERS.includes(this.match_name);
  }

  /**
   * For a separated follower, the dimension it represents.
   *
   * Returns 0, 1, or 2 for X, Y, or Z. Returns `null` for
   * properties that are not separation followers.
   */
  get separation_dimension(): number | null {
    if (!this.is_separation_follower) return null;
    return _SEPARATION_FOLLOWERS.indexOf(this.match_name);
  }

  /**
   * For a separation follower, the leader property.
   *
   * Returns the {@link Property} that acts as the separation leader
   * (e.g. Position) for this follower (e.g. X Position).
   * Returns `null` when this property is not a follower or the
   * leader cannot be found.
   */
  get separation_leader(): Property<number[]> | null {
    if (!_SEPARATION_FOLLOWERS.includes(this.match_name)) return null;
    const parent = this.parent_property;
    if (parent == null || !hasattr(parent, "properties")) return null;
    return parent.property(_SEPARATION_LEADER);
  }

  /**
   * Retrieve a specific follower property for a separated,
   * multidimensional property.
   *
   * For example, you can use this method on the Position property
   * to access the separated X Position and Y Position properties.
   *
   * dim: The dimension number (starting at 0).
   */
  get_separation_follower(dim: number): Property<number> | null {
    if (!this.is_separation_leader) return null;
    const parent = this.parent_property;
    if (parent == null || !hasattr(parent, "properties")) return null;
    if (dim < 0 || dim >= _SEPARATION_FOLLOWERS.length) {
      throw new ValueError(`dim must be in range [0, ${_SEPARATION_FOLLOWERS.length - 1}], got ${dim}`);
    }
    const match_name = _SEPARATION_FOLLOWERS[dim];
    // A separated leader on a 2D layer genuinely has no Z follower.
    return parent._child_or_null(match_name);
  }

  /**
   * Returns the index of the keyframe nearest to the specified time.
   *
   * time: The time in seconds; a floating-point value. The beginning
   * of the composition is 0.
   */
  nearest_key_index(time: number): number {
    return min(Array.from({ length: this.keyframes.length }, (_, i) => i), (i: number) => Math.abs(this.keyframes[i].time - time));
  }

  /**
   * Returns the keyframe nearest to the specified time.
   *
   * time: The time in seconds; a floating-point value. The beginning
   * of the composition is 0.
   */
  nearest_key(time: number): Keyframe<KeyframeValue<V>> {
    const index = this.nearest_key_index(time);
    return this.keyframes[index];
  }

  /**
   * `true` if the property value differs from its default.
   *
   * A property is considered modified when it has keyframes, has an
   * expression (enabled or disabled), or when its current value
   * differs from `default_value`.
   */
  get is_modified(): boolean {
    if (this._animated) return true;
    if (this.expression) return true;
    // A separation follower of an UNSEPARATED leader (e.g. Z Position
    // while Position is not dimension-separated) is an inactive
    // placeholder whose stored value is a meaningless 0. AE still reports
    // the Z follower as modified on camera and light layers, which are
    // always positioned in depth (probed AE 2026: camera/light Z follower
    // is True; regular layers are False). X/Y followers and every regular
    // layer fall through to the value/default comparison below, which
    // already matches AE for their comp-centered defaults.
    if (this.is_separation_follower && this.separation_dimension === 2) {
      const leader = this.separation_leader;
      if (leader != null && !leader.dimensions_separated) {
        const layer = this._containing_layer;
        const layer_type = layer._ldta.layer_type;
        if (layer_type === LayerType.CAMERA || layer_type === LayerType.LIGHT) return true;
      }
    }
    // Source Text has no meaningful default - always modified when it
    // has a value (text is always user-authored).
    if (this.match_name === "ADBE Text Document" && this.value != null) return true;
    // NO_VALUE (button/separator/group header) properties inside effects
    // are always reported as modified in ExtendScript.
    if (this.property_value_type === PropertyValueType.NO_VALUE) return this._is_in_effect();
    // Mask reference properties that exist in the binary are always
    // modified - their presence indicates user interaction even when
    // the value is 0 (no mask).  Synthesized default slots (synthetic)
    // remain unmodified.
    if (
      this.property_value_type === PropertyValueType.MASK_INDEX &&
      this._is_in_effect() &&
      this._tdsb != null &&
      !this._tdsb.synthetic
    ) {
      return true;
    }
    // The Curves effect's default curves are an aRbp in its parT; an
    // untouched instance's is byte-identical to it. The curves are
    // compared, not the bytes, which carry stale points and junk.
    if (this._arbs != null) {
      const curves = this._static_curves();
      if (this._default_arbp == null) return !curves.is_identity;
      const default_ = CurvesArbpChunk.from_arbp(this._default_arbp);
      return !curves._same_curves(Curves._from_binary(default_));
    }
    if (_ALWAYS_MODIFIED.has(this.match_name)) return true;
    if (this.default_value != null) return !_values_equal(this.value, this.default_value);
    // Effect properties with no known default are considered modified
    // when they have a value - ExtendScript treats the absence of a
    // default as "always modified". LAYER_INDEX is excluded because
    // its binary default (0 = "None" layer) is not stored in pard;
    // layer references should report False when unset.
    if (
      this.value != null &&
      this._is_in_effect() &&
      this.property_value_type !== PropertyValueType.LAYER_INDEX
    ) {
      return true;
    }
    return false;
  }

  /**
   * `true` if this is an Essential Property that supports Media
   * Replacement (its alternate source can be set). Read-only.
   *
   * Decoded from the `blsi` chunk beside an `ADBE Layer Source Alternate`
   * slot: a non-zero item id means a replacement source is configured.
   */
  get can_set_alternate_source(): boolean {
    return this._blsi != null && this._blsi.value !== 0;
  }

  /**
   * The alternate source item set for a Media Replacement slot, or
   * `null` when unset / unsupported. Read / Write.
   *
   * After Effects wraps the replacement footage in a composition, so this
   * resolves to that wrapper item (the `blsi` item id).
   */
  get alternate_source(): AVItem | null {
    if (this._blsi == null || this._blsi.value === 0 || this._composition == null) return null;
    return (this._composition._project.items.get(this._blsi.value) ?? null) as AVItem | null;
  }

  /**
   * Set the alternate (replacement) source for a Media Replacement
   * slot.
   *
   * `source` must be an item already in the project, and must itself be
   * media-replacement compatible - AE requires both sides: "The Property
   * object and the input parameters for the AVItem that is being called
   * needs to be Media Replacement compatible for the action to go
   * through." When `source` is a `FootageItem`, After Effects wraps it in
   * a composition - placed in a root-level `Media Replacement Comps`
   * folder and sized to the host comp - and points the slot at that
   * wrapper; py_aep matches this. A `CompItem` is used directly (it is
   * assumed to already be a wrapper).
   *
   * Raises `ValueError` when this property is not a media-replacement slot
   * (`can_set_alternate_source` is `false`), when `source` is not in the
   * project, or when `source.is_media_replacement_compatible` is `false`,
   * and `TypeError` when `source` is not an `AVItem`.
   */
  set alternate_source(source: AVItem) {
    if (!this.can_set_alternate_source || this._blsi == null) {
      throw new ValueError(
        "This property does not support media replacement " + "(can_set_alternate_source is False).",
      );
    }
    if (!(source instanceof AVItem)) {
      throw new TypeError_(`alternate source must be an AVItem, not ${type_name(source)}`);
    }
    if (this._composition == null || !this._composition._project.items.has(source.id)) {
      throw new ValueError(`Item ${repr(source.name)} (id=${source.id}) is not in the project.`);
    }
    // Checked on the passed item, not the wrapper: wrapping an audio-only
    // footage in a comp would make the slot look compatible.
    if (!source.is_media_replacement_compatible) {
      throw new ValueError(
        `Item ${repr(source.name)} (id=${source.id}) cannot be used as an ` +
          "alternate source (is_media_replacement_compatible is False).",
      );
    }
    if (source instanceof FootageItem) {
      this._blsi.value = this._build_replacement_wrapper(source).id;
    } else {
      this._blsi.value = source.id;
    }
  }

  /**
   * Build the AE-faithful wrapper `CompItem` for a footage media
   * replacement: a host-sized comp in a root-level `Media Replacement Comps`
   * folder holding `footage` as its single layer, named
   * `{this property's name}_{unique footage basename}`.
   */
  _build_replacement_wrapper(footage: FootageItem): CompItem {
    const host = this._composition;
    py_assert(host != null); // guarded by the caller's project check
    const project = host._project;
    const folder = _find_or_create_wrapper_folder(project);
    const name = `${this.name}_${_unique_wrapper_suffix(footage, project)}`;
    const wrapper = folder.add_comp(
      name,
      host.width,
      host.height,
      host.pixel_aspect,
      host.duration,
      host.frame_rate,
    );
    // AE's wrapper comp shares the host comp's cdta exactly (timebase,
    // shutter phase, work area) - `add_comp`'s fresh skeleton diverges on
    // time_divisor/work_area_start_divisor/shutter_phase, so clone the host
    // cdta over it. idta/iide (the item ids) are separate chunks and stay
    // the wrapper's own.
    const new_cdta = deepcopy(host._cdta);
    const chunks = wrapper._item_list.chunks;
    // Python `chunks.index(...)` compares by attrs equality (first equal chunk).
    const cdta_index = chunks.findIndex((c: Chunk) => py_eq(c, wrapper._cdta));
    if (cdta_index < 0) throw new ValueError("list.index(x): x not in list");
    chunks[cdta_index] = new_cdta;
    wrapper._cdta = new_cdta;
    wrapper.add(footage);
    return wrapper;
  }

  /**
   * The originating source an Essential Property points at - a
   * `Property`/`PropertyGroup` (created from a Property) or an `AVLayer`
   * (Media Replacement Footage), or `null`. Read-only.
   *
   * Media-replacement overrides resolve to the source composition's
   * `AVLayer` (matched by the controller's `CCId`/`CLId`). Property-source
   * essential properties resolve to the source `Property` (or
   * `PropertyGroup` for a grouped controller) by walking the controller's
   * source-property path by match name.
   */
  get essential_property_source(): Property | PropertyGroup | AVLayer | null {
    return resolve_essential_property_source(this);
  }

  /** `true` if the property is the Menu property of a Dropdown Menu Control effect. */
  get is_dropdown_effect(): boolean {
    return this._property_control_type === PropertyControlType.ENUM;
  }

  /** `true` if the named property has keyframes or an enabled expression. */
  get is_time_varying(): boolean {
    return !!((this.expression && this.expression_enabled) || this._animated);
  }

  /** `true` if there is a maximum permitted value for the named property. */
  get has_max(): boolean {
    return this.max_value != null;
  }

  /** `true` if there is a minimum permitted value for the named property. */
  get has_min(): boolean {
    return this.min_value != null;
  }

  /**
   * Get the value of the named property at the given time.
   *
   * If the property has keyframes, the value is computed by
   * interpolating between surrounding keyframes using the stored
   * interpolation type and temporal ease.
   *
   * If the property is not animated, returns the static
   * {@link Property.value | value}.
   *
   * time: The composition time in seconds at which to evaluate
   * the property.
   * pre_expression: When `true` the value is evaluated before
   * any expression is applied (the only mode supported by
   * the parser).
   *
   * ValueError: If `time` is NaN.
   * NotImplementedError: If `pre_expression` is `false`,
   * because the parser cannot evaluate expressions.
   */
  value_at_time(time: number, pre_expression = true): V {
    if (!pre_expression) {
      throw new NotImplementedError("Expression evaluation is not supported by the parser.");
    }
    if (typeof time !== "number") {
      throw new TypeError_(`time must be a number, got ${type_name(time)}`);
    }
    if (Number.isNaN(time)) {
      // AE 2026: "Unable to call valueAtTime because of parameter 1.
      // NaN is not a number." Infinity IS accepted (it evaluates to the
      // last keyframe's value), so only NaN is rejected here.
      throw new ValueError("time must be a number, got NaN");
    }
    return this._declared(this._mask_inert_z(this._stored_value_at(time)));
  }

  /**
   * {@link value_at_time} before a 2-D layer's Z is reported as 0: what
   * AE stores in a key added at `time` (measured on AE 2026: `addKey`
   * between keys at Z 40 and -30 stores Z 5.0005).
   */
  _stored_value_at(time: number): PropertyValue {
    if (!this.keyframes?.length) {
      const separated = this._separated_value(time);
      if (separated != null) return separated;
      return this._stored_static_value();
    }
    if (this._arbs != null) return this._keyed_curves_at(time);

    const kind = this._parallel_kind();
    const has_motion_path = this._has_motion_path;
    const result = interpolate_keyframes(
      this._evaluated_layer_time(time),
      this.keyframes,
      has_motion_path,
      this._inert_dimensions(),
      kind,
      has_motion_path ? this._arc_metric : new ArcMetric(),
      !!this._color,
    );
    return this._clamp_to_range(result);
  }

  /**
   * A stored value as this property's declared value type. `V` comes from
   * the match name a group lookup was typed by (`"ADBE Position"` is
   * `Property<number[]>`), which the parser guarantees but the compiler
   * cannot see, so this is the one place the value type is asserted.
   */
  _declared(value: PropertyValue): V {
    return value as V;
  }

  /**
   * Report a 2-D layer's Position / Anchor Point Z as 0.
   *
   * A 2-D layer ignores Z, and AE reports it as 0 in `value`,
   * `keyValue` and `valueAtTime` whatever is stored, while the stored Z
   * still counts in the motion path's length, so in its timing and ease
   * speeds (measured on AE 2026: a static [100, 120, 40] and keys at Z
   * 40 / -30 on a 2-D layer read Z = 0 and keep the 40 in the file).
   */
  _mask_inert_z(value: PropertyValue): PropertyValue {
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      (this.match_name === "ADBE Position" || this.match_name === "ADBE Anchor Point") &&
      !getattr(this._containing_layer, "three_d_layer", true)
    ) {
      return [value[0], value[1], 0.0];
    }
    return value;
  }

  /**
   * The layer time AE evaluates a composition `time` at.
   *
   * AE snaps the time to the layer's tick grid twice: the composition
   * time to `1 / layer timebase`, then the layer time it maps to
   * (measured on AE 2026, every one of 1614 dense samples across 100,
   * 50, 150, 200, -100 and -150 % stretch, with and without a start
   * offset). Off the grid, the exact time is up to half a tick away.
   */
  _evaluated_layer_time(time: number): number {
    const base = this._layer_timebase;
    if (base === 0 || !Number.isFinite(time)) return this._layer_time_from_comp(time);
    const snapped = Math.floor(time * base + 0.5) / base;
    const layer = this._layer_time_from_comp(snapped);
    return Math.floor(layer * base + 0.5) / base;
  }

  /**
   * Clamp an evaluated numeric value to the property's range.
   *
   * AE evaluates an eased overshoot clamped to the range the property
   * accepts (measured on AE 2026: Opacity, Mask Opacity, Mask Feather,
   * Mask Expansion, Stroke Width and a Slider all read their bound,
   * never past it).
   */
  _clamp_to_range(value: PropertyValue): PropertyValue {
    const lo = _get_min(this);
    const hi = _get_max(this);
    if (lo == null && hi == null) return value;

    const clamp = (component: number): number => {
      if (lo != null && component < lo) return lo;
      if (hi != null && component > hi) return hi;
      return component;
    };

    if (Array.isArray(value)) {
      return value.map((component) => (typeof component === "number" ? clamp(component) : component));
    }
    return typeof value === "number" ? clamp(value) : value;
  }

  /**
   * How AE measures this property's motion path, from its `tdb4`.
   *
   * A normalized point (an effect point, a footage layer's Anchor Point)
   * is measured in its stored fractions of the layer, so its reported
   * pixels and ease speeds are divided back first.
   */
  get _arc_metric(): ArcMetric {
    const tdb4 = this._tdb4;
    const scale = this._effect_scale;
    return new ArcMetric(
      tdb4._arc_accuracy,
      [tdb4.pixel_aspect, tdb4._arc_multiplier_y, tdb4._arc_multiplier_z, tdb4._arc_multiplier_w],
      scale != null ? [...scale] : null,
      // `_effect_point_speed_factor`, from the scale already in hand.
      scale != null && scale[1] !== 0 ? scale[1] : 1.0,
    );
  }

  /**
   * Composition seconds to the owning layer's own seconds.
   *
   * The inverse of the mapping {@link Keyframe.time | Keyframe.time}
   * applies. Interpolation runs on this axis because AE's ease speeds
   * are per layer second and a negatively stretched layer's keyframes
   * only ascend here.
   */
  _layer_time_from_comp(time: number): number {
    return (time - this._start_time_offset) / this._time_stretch;
  }

  /**
   * Value indices the owning layer ignores.
   *
   * A 2-D layer's Scale still carries a Z component, and AE holds it
   * flat across a segment whose X and Y bow - it will not even store a
   * Z other than 100 there.
   */
  _inert_dimensions(): ReadonlySet<number> {
    if (this.match_name !== "ADBE Scale") return new Set<number>();
    const layer = this._containing_layer;
    if (layer == null || getattr(layer, "three_d_layer", false)) return new Set<number>();
    return new Set<number>([2]);
  }

  /**
   * Returns `true` if the named property can be interpolated using
   * the specified keyframe interpolation type.
   *
   * `KeyframeInterpolationType.HOLD` is valid for every property that
   * can vary over time. `LINEAR` and `BEZIER` are additionally invalid
   * for hold-only properties: markers, text documents, and
   * checkbox/dropdown effect parameters. When the property cannot vary
   * over time (e.g. a Layer Control parameter), every type is invalid.
   * (Truth table probed against AE 2026; integer effect sliders DO
   * accept all three types.)
   *
   * type: A `KeyframeInterpolationType` value.
   *
   * ValueError: If `type` is not a `KeyframeInterpolationType`
   * member (After Effects raises a parameter error rather than
   * returning `false`).
   */
  is_interpolation_type_valid(type: number): boolean {
    validate_enum(KeyframeInterpolationType)(type);
    const interp = KeyframeInterpolationType.of(type);
    if (!this.can_vary_over_time) return false;
    if (interp === KeyframeInterpolationType.HOLD) return true;
    const value_type = this.property_value_type;
    if (value_type === PropertyValueType.MARKER || value_type === PropertyValueType.TEXT_DOCUMENT) {
      return false;
    }
    // Only the pard-derived control type is authoritative for the
    // checkbox/dropdown test: the tdb4 flag fallback in
    // _determine_property_types maps any 1-D integer scalar to BOOLEAN,
    // but integer sliders (e.g. Mosaic blocks) interpolate in AE.
    const control_type = this._property_control_type;
    return !(control_type === PropertyControlType.BOOLEAN || control_type === PropertyControlType.ENUM);
  }

  // -- Keyframe mutation -------------------------------------------------

  /** The frame rate keyframe times convert with. */
  _keyframe_frame_rate(): number {
    if (this.keyframes?.length > 0) return this.keyframes[0]._frame_rate;
    let comp = this._composition;
    if (comp == null) comp = this._containing_layer.containing_comp;
    return comp.frame_rate;
  }

  /** The `LIST:list` holding the keyframe header chunks, or None. */
  _keyframe_inner(): ListChunk | null {
    return find_by_list_type_or_null(this._tdbs.chunks, "list");
  }

  /**
   * The complex-value kind storing keyframe values in a parallel
   * container, or `null` for ordinary numeric properties.
   */
  _parallel_kind(): ParallelKind | null {
    const wrapper = this._wrapper;
    if (wrapper != null) {
      // `_materialize_parallel_container` can adopt an arbitrary
      // sibling LIST as the wrapper, so an unknown type falls through
      // to the match name rather than deciding the answer is None.
      const kind = _WRAPPER_KINDS.get(wrapper.list_type) ?? null;
      if (kind != null) return kind;
    }
    return _SYNTHESIZED_KINDS.get(this.match_name) ?? null;
  }

  /** The `LdatItemType` for this property's keyframe header data. */
  _keyframe_item_type(): LdatItemType {
    const kind = this._parallel_kind();
    if (kind != null) return kind.header_item_type;
    if (this._color) return LdatItemType.color;
    if (this._no_value) return LdatItemType.no_value;
    const dims = this.dimensions;
    if (dims >= 3) {
      return this.is_spatial ? LdatItemType.three_d_spatial : LdatItemType.three_d;
    }
    if (dims === 2) return this.is_spatial ? LdatItemType.two_d_spatial : LdatItemType.two_d;
    return LdatItemType.one_d;
  }

  /**
   * Set tdb4 metadata to AE's animated-property state.
   *
   * Static and animated properties differ in several `tdb4` fields, not
   * just the `animated` bit; After Effects rejects (drops) the layer when
   * they are inconsistent. Values were reverse-engineered from AE 2026
   * output across 1D / 2D / 3D / spatial / color properties.
   *
   * Complex (parallel-container) properties keep their value-hint
   * metadata as-is: AE only flips the static / animated / spatial-marker
   * fields (verified against AE 2026 static-vs-one-keyframe pairs for
   * text / shape / orientation / marker / gradient).
   */
  _animate_tdb4(): void {
    const t = this._tdb4;
    if (this._parallel_kind() != null) {
      t.static = false;
      t.animated = true;
      t._spatial_marker = false;
      // AE clears the opaque interpolation residue it leaves in these
      // fields when a complex property went static (bytes 0x49-0x4E).
      t._reserved_48 = and(t._reserved_48, 0xff000000);
      t._reserved_4c = t._reserved_4d = t._pad_4e = 0;
      return;
    }
    // AE keeps a variable-font axis's value-hint flag, cvot flags
    // and time base unchanged across the static<->animated
    // transition (verified against the variable_font_axis_animated
    // AE 2026 fixture).
    const preserved = this._is_vf_axis ? [t._value_hint_flag, t._cvot_flags, t._time_base] : null;
    tdb4_apply_animated_template(t, { color: !!this._color, spatial: this._has_motion_path });
    // The template cannot know the comp's timebase or pixel aspect.
    // `_ensure_materialized` stamps them, but only for a synthesized
    // property - one parsed from a real file returns early there, so
    // animating it needs the stamp applied here too.
    this._ensure_time_base();
    this._stamp_normalized_arc_metric();
    // After the stamp, which reads the record's 0x4F to spot a static
    // spatial point.
    tdb4_clear_keyframe_record(t);
    if (preserved != null) {
      [t._value_hint_flag, t._cvot_flags, t._time_base] = preserved;
    }
  }

  /**
   * Return the keyframe `(lhd3, ldat)`, creating them if static.
   *
   * Transitioning a static property to animated replaces its `cdat`
   * with a `LIST:list` keyframe container and rewrites the `tdb4`
   * metadata to AE's animated state.
   */
  _ensure_animated(): [Lhd3Chunk, LdatChunk] {
    let inner = this._keyframe_inner();
    if (inner == null) {
      const item_type = this._keyframe_item_type();
      let lhd3: Lhd3Chunk;
      let ldat: LdatChunk;
      [inner, lhd3, ldat] = build_keyframe_list(item_type, getitem(ITEM_SIZE_BY_TYPE, item_type));
      this._animate_tdb4();
      const chunks = this._tdbs.chunks;
      if (this._cdat != null) {
        chunks[index_by_identity(chunks, this._cdat)] = inner;
        this._cdat = null;
      } else {
        chunks.splice(index_by_identity(chunks, this._tdb4) + 1, 0, inner);
      }
      return [lhd3, ldat];
    }
    const lhd3 = find_by_type(inner.chunks, "lhd3");
    const ldat = find_by_type(inner.chunks, "ldat");
    return [lhd3, ldat];
  }

  /**
   * Locate `time_units` among the keyframes.
   *
   * Returns `(index, exists)`: when a keyframe already sits at
   * `time_units`, `exists` is True and `index` is its position;
   * otherwise `exists` is False and `index` is the sorted insertion
   * point. Keyed on raw units rather than frame indices so two
   * sub-frame keyframes inside one frame stay distinct.
   */
  _keyframe_insert_index(time_units: number): [number, boolean] {
    for (const [i, kf] of this.keyframes.entries()) {
      const units = kf.time_units;
      if (units === time_units) return [i, true];
      if (units > time_units) return [i, false];
    }
    return [this.keyframes.length, false];
  }

  /**
   * Layer-relative keyframe units for a composition `time` in seconds.
   *
   * Where AE puts a key added at `time`: the layer tick it evaluates
   * `time` at (`_evaluated_layer_time`), not the nearest tick to the
   * exact layer time. Measured on AE 2026: 584 of 585 `setValueAtTime`
   * keys over 8 frame rates and stretches from -500 to 9900 % (the
   * one-step rounding missed 10, each by one tick).
   */
  _keyframe_units_at(time: number): number {
    let timebase: number = this._layer_timebase;
    if (timebase !== 0) return round(this._evaluated_layer_time(time) * timebase);
    timebase = _timebase_units(this._keyframe_frame_rate());
    return round(((time - this._start_time_offset) / this._time_stretch) * timebase);
  }

  /**
   * Test whether this property can be added to `comp`'s Essential
   * Graphics panel (a Motion Graphics template).
   *
   * Gates on what py_aep can produce: the supported control types are
   * Checkbox, Color, single-value numeric Slider and Source Text (a
   * Dropdown param reports `false` - AE would build a type-13 Dropdown
   * controller, which py_aep does not). Paths through indexed groups -
   * effects, masks, shape contents, text animators - are addressed by AE's
   * child index (validated against AE 2026 output), so their children are
   * addable, including on duplicate siblings. Reports `false` for an effect
   * param whose parT definitions are unavailable, children of `ADBE Effect Built In Params`, a by-name node ambiguous among its siblings, a
   * property already exposed, or a layer not in `comp`.
   *
   * comp: The composition whose Essential Graphics panel to test.
   */
  can_add_to_motion_graphics_template(comp: CompItem): boolean {
    return can_add_property(this, comp);
  }

  /**
   * Add this property to `comp`'s Essential Graphics panel, using the
   * property's own name for the controller.
   *
   * Returns `true` on success, or `false` when the property cannot be added
   * (see `can_add_to_motion_graphics_template`).
   *
   * comp: The composition to add the property to.
   */
  add_to_motion_graphics_template(comp: CompItem): boolean {
    return comp._add_property_controller(this, null);
  }

  /**
   * Add this property to `comp`'s Essential Graphics panel with an
   * explicit controller `name`.
   *
   * Returns `true` on success, or `false` when the property cannot be
   * added (see `can_add_to_motion_graphics_template`).
   *
   * comp: The composition to add the property to.
   * name: The controller name to show in the Essential Graphics panel.
   */
  add_to_motion_graphics_template_as(comp: CompItem, name: string): boolean {
    validate_name(name);
    return comp._add_property_controller(this, name);
  }

  /**
   * Add a keyframe at the given time and return its 0-based index.
   *
   * The new keyframe takes the property's value at `time` (the
   * interpolated value when already animated, or the static value
   * otherwise), matching ExtendScript `Property.addKey()`. Adding the
   * first keyframe converts a static property to an animated one.
   *
   * time: The composition time, in seconds.
   *
   * ValueError: If the property cannot vary over time, or has no
   * value to keyframe.
   */
  add_key(time: number): number {
    this._reject_curves_write();
    return this._add_key(time);
  }

  /**
   * Add a keyframe at `time`, seeding its value when supplied.
   *
   * When `value` is omitted, the keyframe takes the property's value at
   * `time` (interpolated when animated, the static value otherwise).
   */
  _add_key(time: number, value: _ValueType | typeof _USE_VALUE = _USE_VALUE): number {
    validate_number(time);
    if (!this.can_vary_over_time) {
      throw new ValueError(`property ${repr(this.match_name)} cannot vary over time`);
    }
    const kind = this._parallel_kind();
    if (kind != null) return this._add_parallel_key(time, kind, value);
    // A no-value numeric property has no value slot to keyframe; building
    // a numeric keyframe item for it produces a wrong-size ldat item.
    // (Complex kinds above store their value in a sibling container and
    // legitimately report no_value=True, so this only guards the numeric
    // path.)
    if (this._no_value) {
      throw new ValueError(`property ${repr(this.match_name)} has no value to keyframe`);
    }
    const frame_rate = this._keyframe_frame_rate();

    const item_type = this._keyframe_item_type();
    const kf_data = build_kf_data(item_type, this.dimensions);
    const ldat_item = build_ldat_item(kf_data, { spatial: this._has_motion_path });

    const kf = new Keyframe<KeyframeValue<V>>({
      _ldat_item: ldat_item,
      _frame_rate: frame_rate,
    });
    kf._bind_property(this);
    // Before any mutation: `time` can be far enough out that its tick
    // count overflows the 32-bit field, and animating first left the
    // property marked animated with no keyframes and its static value
    // gone (issue #228). `_add_parallel_key` orders itself the same way.
    kf._set_time_units(this._keyframe_units_at(time));

    const [idx, exists] = this._keyframe_insert_index(kf.time_units);
    if (exists) return idx;
    // At the key's own time, which is `time` rounded to whole units: the
    // value has to be where the curve is when the key sits, or it kinks
    // the motion path at the split.
    const new_value = value === _USE_VALUE ? this._stored_value_at(kf.time) : value;
    // Written into the detached keyframe first: the setter validates the
    // value (type, length, finiteness, range), and a rejected one must
    // leave the property exactly as it was rather than holding a new key
    // at 0.
    kf.value = new_value;
    this._ensure_materialized();
    const [lhd3, ldat] = this._ensure_animated();
    ldat.items.splice(idx, 0, ldat_item);
    this.keyframes.splice(idx, 0, kf);
    set_lhd3_count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    this._link_inserted_key(idx);
    this._preserve_curve_on_insert(idx, value !== _USE_VALUE);
    this._redistribute_roving_keyframes();
    // The static value is now dead: `value` reads the keyframes, but its
    // cache short-circuits ahead of that check, so animating a property
    // that had been read (or written) statically kept reporting the old
    // number. Complex kinds keep their cached object - callers rely on
    // mutating it in place - and they animate through other paths.
    if (typeof this._value === "number" || typeof this._value === "boolean" || Array.isArray(this._value)) {
      this._value = null;
    }
    return idx;
  }

  /**
   * Give a freshly inserted keyframe the interpolation AE gives it.
   *
   * `addKey` must not change the animation: AE inserts the key with the
   * surrounding segment's interpolation type and the ease that keeps the
   * curve identical (measured on AE 2026 - every sampled `valueAtTime`
   * is unchanged across BEZIER, LINEAR and HOLD segments). Without this
   * the key lands LINEAR with a default ease and silently reshapes the
   * animation.
   *
   * Rules, one per segment type:
   *
   * - BEZIER: the new key takes the curve's slope at that time, and the
   * influences come from a De Casteljau split of the time handles
   * (a 5 s 0-\>100 segment eased 0/75 both sides, split at 2.5 s, gives
   * speed 80 and influences 75 / 12.5 / 12.5 / 75).
   * - LINEAR: the new key and both facing neighbour handles take the
   * segment's slope with AE's default influence.
   * - HOLD: speed 0 with the default influence; the value is held either
   * way.
   * - LINEAR on one side, BEZIER on the other: AE turns the LINEAR side
   * into the BEZIER handle it already is (the segment slope at the
   * default influence) and splits the segment as BEZIER, so the new
   * key and both facing sides come out BEZIER and the curve is kept
   * (measured on AE 2026 in both orders).
   *
   * `set_value` is for `set_value_at_time`, which seeds a value of its
   * own: AE leaves a key it adds that way into a LINEAR segment with a
   * blank (0 / 0) ease, where `addKey` writes the slope (AE 2026).
   */
  _preserve_curve_on_insert(idx: number, set_value = false): void {
    if (idx <= 0 || idx >= this.keyframes.length - 1) {
      // Outside the keyed range there is no segment to preserve.
      return;
    }
    const kf = this.keyframes[idx];
    const prev_kf = this.keyframes[idx - 1];
    const next_kf = this.keyframes[idx + 1];

    const components = _segment_components(prev_kf, next_kf);
    if (components == null) return;
    let [pairs, dims] = components;

    let out_type = prev_kf.out_interpolation_type;
    let in_type = next_kf.in_interpolation_type;
    // Either side holding makes the whole segment hold, so the inserted
    // key has to hold on both sides to leave the value where it was.
    if (out_type === KeyframeInterpolationType.HOLD || in_type === KeyframeInterpolationType.HOLD) {
      out_type = in_type = KeyframeInterpolationType.HOLD;
    }
    const mixed =
      !set_value &&
      ((out_type === KeyframeInterpolationType.LINEAR && in_type === KeyframeInterpolationType.BEZIER) ||
        (out_type === KeyframeInterpolationType.BEZIER && in_type === KeyframeInterpolationType.LINEAR));
    const linear_out = out_type === KeyframeInterpolationType.LINEAR;
    if (mixed) {
      out_type = in_type = KeyframeInterpolationType.BEZIER;
    }
    kf.in_interpolation_type = out_type;
    kf.out_interpolation_type = in_type;

    // Layer time: the speeds synthesized below are stored per layer
    // second, and on a reversed layer only this axis ascends.
    const t0 = prev_kf._layer_time;
    const t1 = next_kf._layer_time;
    const t = kf._layer_time;
    if (!(t0 < t && t < t1)) return;
    if (set_value && out_type === KeyframeInterpolationType.LINEAR) return;

    // Read while the neighbours still have their own types: a LINEAR
    // side resolves to its segment slope at the default influence.
    const prev_out = [...prev_kf.out_temporal_ease];
    const next_in = [...next_kf.in_temporal_ease];
    if (mixed) {
      prev_kf.out_interpolation_type = KeyframeInterpolationType.BEZIER;
      next_kf.in_interpolation_type = KeyframeInterpolationType.BEZIER;
    }
    const new_in: KeyframeEase[] = [];
    const new_out: KeyframeEase[] = [];
    const left_out: KeyframeEase[] = [];
    const right_in: KeyframeEase[] = [];

    // A spatial property stores ONE ease for the whole vector (its speed
    // is along the path), where a plain vector stores one per dimension.
    const n_ease = Math.min(prev_out.length, next_in.length) || 1;
    const spatial = n_ease === 1 && dims > 1;
    let split_at: number | null = null;
    if (this._color) {
      // One ease along the colour line: split it as one quantity, the
      // colour distance in the units its speeds use.
      pairs = [[0.0, color_distance(prev_kf.value as number[], next_kf.value as number[])]];
    } else if (spatial) {
      // A spatial ease's speed is measured along the PATH, so the split
      // runs once over the segment's arc length - the chord would be
      // short wherever the tangents bow the curve.
      pairs = [[0.0, this._segment_arc_length(prev_kf, next_kf)]];
      // Read before the eases below change: the new key has to sit
      // where the path was at its time.
      split_at = this._motion_path_parameter(idx, t);
    }

    for (let d = 0; d < n_ease; d++) {
      const [v0, v1] = d < pairs.length ? pairs[d] : pairs[0];
      let o_ease = d < prev_out.length ? prev_out[d] : prev_out[0];
      let i_ease = d < next_in.length ? next_in[d] : next_in[0];
      if (mixed) {
        // The LINEAR side as the BEZIER handle it is: the slope of
        // the whole segment (not of its first half - the new key is
        // already linked) at the default influence.
        const as_bezier = new KeyframeEase((v1 - v0) / (t1 - t0), _DEFAULT_INFLUENCE);
        if (linear_out) {
          o_ease = as_bezier;
        } else {
          i_ease = as_bezier;
        }
      }
      let slope: number;
      let infl: number[];
      let infl_next: number;
      let o_speed: number;
      let i_speed: number;
      if (out_type === KeyframeInterpolationType.HOLD) {
        slope = 0.0;
        infl = [o_ease.influence, _DEFAULT_INFLUENCE, _DEFAULT_INFLUENCE];
        infl_next = i_ease.influence;
        o_speed = o_ease.speed;
        i_speed = i_ease.speed;
      } else if (out_type === KeyframeInterpolationType.LINEAR) {
        slope = (v1 - v0) / (t1 - t0);
        infl = [_DEFAULT_INFLUENCE, _DEFAULT_INFLUENCE, _DEFAULT_INFLUENCE];
        infl_next = _DEFAULT_INFLUENCE;
        o_speed = slope;
        i_speed = slope;
      } else {
        slope = segment_value_slope(t0, t1, v0, v1, o_ease, i_ease, t);
        const [lo, ni, no, ri] = split_segment_influences(t0, t1, v0, v1, o_ease, i_ease, t);
        infl = [lo, ni, no];
        infl_next = ri;
        o_speed = o_ease.speed;
        i_speed = i_ease.speed;
      }
      left_out.push(new KeyframeEase(o_speed, infl[0]));
      new_in.push(new KeyframeEase(slope, infl[1]));
      new_out.push(new KeyframeEase(slope, infl[2]));
      right_in.push(new KeyframeEase(i_speed, infl_next));
    }

    kf._apply_ease(new_in, "in");
    kf._apply_ease(new_out, "out");
    prev_kf._apply_ease(left_out, "out");
    next_kf._apply_ease(right_in, "in");

    if (split_at != null) {
      this._split_motion_path(prev_kf, kf, next_kf, split_at);
    }
  }

  /**
   * Arc length of the motion path between two keyframes.
   *
   * In the units the property's ease speeds are reported in.
   */
  _segment_arc_length(prev_kf: Keyframe, next_kf: Keyframe): number {
    const v0 = prev_kf._stored_value;
    const v1 = next_kf._stored_value;
    if (!Array.isArray(v0) || !Array.isArray(v1)) return 0.0;
    const ndim = v0.length;
    const out_tangent = py_or(prev_kf.out_spatial_tangent, list_mul([0.0], ndim));
    const in_tangent = py_or(next_kf.in_spatial_tangent, list_mul([0.0], ndim));
    return motion_path_length(v0, v1, out_tangent, in_tangent, this._arc_metric);
  }

  /** The direction this property's motion path heads at comp `time`. */
  _motion_direction_at(time: number): number[] | null {
    return motion_path_direction(this._layer_time_from_comp(time), this.keyframes, this._arc_metric);
  }

  /**
   * The curve parameter the motion path was at, at `time` in layer time.
   *
   * Located on the path as it was before the keyframe at `idx` was
   * inserted, which is what the inserted key's value was read from.
   * `null` when the time falls on another segment of a roving run.
   */
  _motion_path_parameter(idx: number, time: number): number | null {
    const before = [...this.keyframes.slice(0, idx), ...this.keyframes.slice(idx + 1)];
    if (!before.every((kf) => Array.isArray(kf.value))) return null;
    const [segment, u] = spatial_location(time, before, idx - 1, this._arc_metric);
    return segment === idx - 1 ? u : null;
  }

  /**
   * Split the motion path at curve parameter `u` so the inserted key
   * does not reshape it.
   *
   * Without this the new keyframe carries no spatial tangents and the
   * single curve becomes two straight-ish halves.
   */
  _split_motion_path(prev_kf: Keyframe, kf: Keyframe, next_kf: Keyframe, u: number): void {
    const v0 = prev_kf._stored_value;
    const v1 = next_kf._stored_value;
    if (!Array.isArray(v0) || !Array.isArray(v1)) return;
    const ndim = v0.length;
    const out_tangent = py_or(prev_kf.out_spatial_tangent, list_mul([0.0], ndim));
    const in_tangent = py_or(next_kf.in_spatial_tangent, list_mul([0.0], ndim));
    if (_tangents_are_zero(out_tangent) && _tangents_are_zero(in_tangent)) return;
    const [left_out, new_in, _split, new_out, right_in] = split_spatial_path(v0, v1, out_tangent, in_tangent, u);
    prev_kf.out_spatial_tangent = left_out;
    kf.in_spatial_tangent = new_in;
    kf.out_spatial_tangent = new_out;
    next_kf.in_spatial_tangent = right_in;
  }

  /**
   * Remove the keyframe at `key_index` (0-based).
   *
   * Removing the last remaining keyframe reverts the property to a
   * static value (the removed keyframe's value), matching ExtendScript
   * `Property.removeKey()`. Markers have no static value: removing the
   * last marker leaves the property empty.
   *
   * key_index: The 0-based index of the keyframe to remove.
   *
   * IndexError: If the property has no keyframes.
   * ValueError: If `key_index` is out of range.
   */
  remove_key(key_index: number): void {
    this._reject_curves_write();
    if (!this.keyframes?.length) throw new IndexError("property has no keyframes");
    _validate_number({ integer: true, min: 0, max: this.keyframes.length - 1 })(key_index);
    const kind = this._parallel_kind();
    if (kind != null) {
      if (this.keyframes.length === 1) {
        this._deanimate_parallel(kind);
        return;
      }
      this._remove_parallel_key(key_index, kind);
      return;
    }
    this._ensure_materialized();
    const [lhd3, ldat] = this._ensure_animated();
    const removed = this.keyframes[key_index];
    const removed_value = removed._stored_value;
    ldat.items.splice(key_index, 1);
    this.keyframes.splice(key_index, 1);
    set_lhd3_count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    this._link_keyframes();
    if (!this.keyframes?.length) {
      this._deanimate(removed_value, removed._ldat_item);
      return;
    }
    // The run a removed anchor bounded now spans to the next anchor: AE
    // re-times its roving keys along it (AE 2026).
    this._redistribute_roving_keyframes();
  }

  /**
   * Remove every keyframe from this property.
   *
   * Equivalent to calling `remove_key` for each keyframe: the
   * property reverts to a static value (the first keyframe's value).
   * Markers have no static value: the property is left empty. A
   * no-op when the property has no keyframes.
   */
  remove_all_keys(): void {
    if (this.keyframes?.length > 0) this._reject_curves_write();
    if (this._parallel_kind() != null) {
      while (this.keyframes?.length > 0) this.remove_key(this.keyframes.length - 1);
      return;
    }
    if (!this.keyframes?.length) return;
    // Bulk path: clearing key-by-key would re-link the remaining
    // keyframes after every removal (quadratic) and decode values
    // that are thrown away.
    this._ensure_materialized();
    const [lhd3, ldat] = this._ensure_animated();
    const first = this.keyframes[0];
    const first_value = first._stored_value;
    ldat.items.splice(0);
    this.keyframes.splice(0);
    set_lhd3_count(lhd3, 0, LHD3_BLOCK_KEYFRAMES);
    this._deanimate(first_value, first._ldat_item);
  }

  /** Set the tdb4 to AE's static state after removing `last_key`. */
  _static_tdb4(last_key: LdatItem): void {
    const kf_data = last_key.kf_data;
    tdb4_apply_static_template(this._tdb4, {
      in_interpolation: last_key.in_interpolation_type,
      out_interpolation: last_key.out_interpolation_type,
      spatial_flags: kf_data instanceof KfPosition ? kf_data._spatial_flags : 0,
    });
  }

  /**
   * Revert an emptied animated property to a static `value`, after
   * removing `last_key`.
   */
  _deanimate(value: _ValueType, last_key: LdatItem): void {
    const inner = this._keyframe_inner();
    const chunks = this._tdbs.chunks;
    this._static_tdb4(last_key);
    const raw =
      typeof value === "number" || typeof value === "boolean" || Array.isArray(value) ? this._unresolve_value(value) : null;
    let raw_vals: number[];
    if (typeof raw === "number" || typeof raw === "boolean") {
      raw_vals = [float(raw)];
    } else if (Array.isArray(raw)) {
      raw_vals = raw;
    } else {
      raw_vals = [0.0];
    }
    // AE pads the static value to 3 doubles per dimension when the
    // stream flags have bit 1 (spatial and colour streams), 5 otherwise
    // - the layout of every static numeric stream in the samples.
    const per_dim = this._tdb4._spatial_static_flags & 0x02 ? 3 : 5;
    raw_vals.push(...list_mul([0.0], this._tdb4.dimensions * per_dim - raw_vals.length));
    const cdat = new CdatChunk({ values: raw_vals });
    if (inner != null) {
      chunks[index_by_identity(chunks, inner)] = cdat;
    } else {
      chunks.splice(index_by_identity(chunks, this._tdb4) + 1, 0, cdat);
    }
    this._cdat = cdat;
    this._value = null;
  }

  /**
   * Remove any expression, reverting to a plain (non-expression) property.
   *
   * Drops the expression `Utf8` chunk from the `tdbs` and clears the
   * tdb4 expression flag, so `expression` becomes `""` and
   * `expression_enabled` `false`. A no-op when no expression is set.
   */
  _clear_expression(): void {
    if (this._expression_utf8 == null && !this._expression) return;
    if (this._expression_utf8 != null) {
      const kept = this._tdbs.chunks.filter((c) => c !== this._expression_utf8);
      this._tdbs.chunks.splice(0, this._tdbs.chunks.length, ...kept);
      this._expression_utf8 = null;
    }
    this._expression = null;
    this._expression_enabled = null;
    if (this._tdb4 != null) {
      // `_expr_flags` (bit 0 = disabled) and the `_pad10` high-byte
      // marker (`has_expression`) are AE's expression-present flags;
      // clear both so the tdb4 matches a plain static parameter.
      this._tdb4._expr_flags = 0;
      this._tdb4.has_expression = false;
    }
  }

  // -- Complex (parallel-container) keyframe mutation ------------------

  /**
   * Build a `shap` LIST chunk from a {@link Shape}.
   *
   * For a mask property, a pixel-space (from-scratch) shape is
   * converted to the normalized `[0, 1]`-of-LAYER bounding box AE uses
   * (mask space is layer space: the psd_vector_mask_cropped fixture
   * pins the divisor as the layer source size, not the comp size; a
   * text or shape layer divides by 1, see `AVLayer._mask_scale`).
   * Dividing the box leaves the points, which are normalized to that
   * box, unchanged. A mask value read from a layer is in that layer's
   * mask space, so it is brought back to pixels first: like AE 2026's
   * `setValue`, a path copied to another layer or to a shape-layer
   * path keeps its pixel coordinates.
   *
   * A RotoBezier mask path stores a tension per vertex: the value's
   * own when it carries one for every vertex, else 1 (AE 2026 writes 1
   * for every vertex of a value set on a RotoBezier mask, handles or
   * not). A mask path keeps the value's feather points.
   */
  _build_shap_chunk(shape: Shape): Chunk {
    const points = py_or(shape._points, []).map((p: ShapePoint) => new ShapePoint({ x: p.x, y: p.y }));
    const src = shape._shph;
    let bbox: number[];
    if (src != null) {
      bbox = [src.top_left_x, src.top_left_y, src.bottom_right_x, src.bottom_right_y];
    } else {
      bbox = [0.0, 0.0, 0.0, 0.0];
    }
    const is_mask_path = this.match_name === "ADBE Mask Shape";
    const source_size = shape._is_mask ? shape._comp_size : null;
    const [src_w, src_h] = source_size ?? [1.0, 1.0];
    let dst_w: number;
    let dst_h: number;
    if (is_mask_path) {
      const layer = this._containing_layer;
      if (!(layer instanceof _av_layer().AVLayer)) throw new AttributeError("_mask_scale");
      [dst_w, dst_h] = layer._mask_scale;
    } else {
      [dst_w, dst_h] = [1.0, 1.0];
    }
    if (src_w !== dst_w || src_h !== dst_h) {
      // Scale then divide: a pixel-space value divided by the layer size
      // stays bit-identical to the plain division.
      bbox = [
        (bbox[0] * src_w) / dst_w,
        (bbox[1] * src_h) / dst_h,
        (bbox[2] * src_w) / dst_w,
        (bbox[3] * src_h) / dst_h,
      ];
    }
    let tensions: number[] | null = null;
    const mask = this._parent_property;
    if (is_mask_path && mask != null && mask._is_mask && mask instanceof _mask_property_group().MaskPropertyGroup) {
      if (mask.roto_bezier) {
        const own = shape._own_tensions();
        const count = floordiv(points.length, 3);
        tensions = own.length === count ? own : list_mul([1.0], count);
      }
    }
    const shap = build_shap([bbox[0], bbox[1], bbox[2], bbox[3]], {
      open_path: !shape.closed,
      points,
      tensions,
      feather_points: is_mask_path ? shape.feather_points.map((fp) => fp._fp) : null,
    });
    if (src != null) {
      // Carry over the source header's unknown flag bits; build_shap
      // only knows the open/closed bit.
      const new_shph = find_by_type(shap.chunks, "shph");
      new_shph._flags = src._flags;
      new_shph.open = !shape.closed;
    }
    return shap;
  }

  /**
   * Wrap a COS doc Map as a {@link TextDocument} sharing `template`'s
   * COS data / btdk chunk.
   */
  _build_text_view(doc: CosNode, template: TextDocument): TextDocument {
    const char = cos_get(doc, "0", "6", "0", 0, "0", "0", "6");
    const para = cos_get(doc, "0", "5", "0", 0, "0", "0", "5");
    const view = TextDocument._from_binary({
      _char_style: char instanceof Map ? char : null,
      _para_style: para instanceof Map ? para : null,
      _doc: doc,
      _fonts: template._fonts,
      _cos_data: template._cos_data,
      _btdk_body: template._btdk_body,
    });
    if (template._siblings != null) {
      template._siblings.push(view);
      view._siblings = template._siblings;
    }
    // The clone copies the template's text AND its (possibly stale)
    // layout cache, so it inherits the template's staleness verdict.
    view._layout_dirty = template._layout_dirty;
    view._composition_calibrated = template._composition_calibrated;
    return this._wire_text_version(view);
  }

  /**
   * Add the first Source Text keyframe to a static text property.
   *
   * The static document already lives in the shared `btdk` COS blob
   * (`cos["1"]["1"][0]`) and becomes the keyframe's value as-is; AE
   * only swaps the empty `cdat` for a keyframe `LIST:list` and flips
   * the tdb4 static / animated flags (the COS blob is byte-identical
   * between the static and one-keyframe states in AE 2026 output).
   */
  _animate_static_text(time: number, value: _ValueType | string | typeof _USE_VALUE = _USE_VALUE): number {
    const template = this._value;
    if (!(template instanceof TextDocument)) {
      throw new NotImplementedError("text property has no TextDocument value to animate");
    }
    const frame_rate = this._keyframe_frame_rate();
    this._ensure_materialized();
    const [lhd3, ldat] = this._ensure_animated();
    const ldat_item = build_parallel_ldat_item(this._keyframe_item_type());
    const kf = new Keyframe<KeyframeValue<V>>({ _ldat_item: ldat_item, _frame_rate: frame_rate });
    kf._bind_property(this);
    kf._set_time_units(this._keyframe_units_at(time));
    ldat.items.push(ldat_item);
    this.keyframes.push(kf);
    set_lhd3_count(lhd3, 1, LHD3_BLOCK_KEYFRAMES);
    kf._value = template;
    this._value = null;
    if (typeof value === "string") {
      template.text = value;
    } else if (value instanceof TextDocument) {
      template.text = value.text;
    }
    this._link_keyframes();
    return 0;
  }

  /**
   * Add a Source Text keyframe.
   *
   * Text keyframes share a single `btdk` COS blob holding one document
   * per keyframe (`cos["1"]["1"]`). A new keyframe deep-copies the
   * nearest document (inheriting its styling); pass a string or
   * {@link TextDocument} to override the text content. After Effects
   * recomputes the per-keyframe box-frame / glyph caches on open, so
   * they are left untouched.
   */
  _add_text_key(time: number, value: _ValueType | string | typeof _USE_VALUE = _USE_VALUE): number {
    if (this._keyframe_inner() == null || !this.keyframes?.length) {
      return this._animate_static_text(time, value);
    }
    const [lhd3, ldat] = this._ensure_animated();
    const frame_rate = this._keyframe_frame_rate();
    const nearest = this.nearest_key_index(time);
    const template = this.keyframes[nearest].value;
    if (!(template instanceof TextDocument)) {
      throw new NotImplementedError("text keyframe value is not a TextDocument");
    }
    const doc_array = cos_get(template._cos_data, "1", "1");
    const new_doc = deepcopy(cos_at(doc_array, nearest));

    const ldat_item = build_parallel_ldat_item(this._keyframe_item_type());
    const kf = new Keyframe<KeyframeValue<V>>({ _ldat_item: ldat_item, _frame_rate: frame_rate });
    kf._bind_property(this);
    kf._set_time_units(this._keyframe_units_at(time));
    const [idx, exists] = this._keyframe_insert_index(kf.time_units);
    if (exists) return idx;
    this._ensure_materialized();
    ldat.items.splice(idx, 0, ldat_item);
    cos_insert(doc_array, idx, new_doc);
    this.keyframes.splice(idx, 0, kf);
    const td = this._build_text_view(new_doc, template);
    kf._value = td;
    if (typeof value === "string") {
      td.text = value;
    } else if (value instanceof TextDocument) {
      td.text = value.text;
    } else {
      // The text setter above already re-serializes the COS blob; when
      // no text was supplied, propagate the structural insert ourselves.
      td._propagate_cos();
    }
    set_lhd3_count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    this._link_inserted_key(idx);
    return idx;
  }

  /**
   * Remove a Source Text keyframe (its COS document + header item).
   *
   * The per-keyframe box-frame / glyph caches are left untouched -
   * After Effects recomputes them on open.
   */
  _remove_text_key(key_index: number): void {
    const [lhd3, ldat] = this._ensure_animated();
    const removed = this.keyframes[key_index].value;
    if (!(removed instanceof TextDocument)) {
      throw new NotImplementedError("text keyframe value is not a TextDocument");
    }
    const doc_array = cos_get(removed._cos_data, "1", "1");
    this._ensure_materialized();
    ldat.items.splice(key_index, 1);
    if (key_index < cos_len(doc_array)) cos_pop_at(doc_array, key_index);
    this.keyframes.splice(key_index, 1);
    set_lhd3_count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    removed._propagate_cos();
    this._link_keyframes();
  }

  /**
   * Create the missing wrapper subtree / value container for a
   * complex property that stores nothing in the binary.
   *
   * AE omits the wrapper entirely for pristine state (a never-marked
   * layer, a never-edited gradient, a never-modified orientation);
   * the property is backed by a bare `tdbs` (synthesized, or parsed
   * directly for orientation). Keying it wraps the `tdbs` in the
   * kind's wrapper LIST holding the per-keyframe value container,
   * with kind-specific `tdb4` baselines (AE 2026 output).
   */
  _materialize_parallel_container(kind: ParallelKind): ListChunk {
    if (this.match_name === "ADBE Mask Shape") {
      // A path-less mask keys the default full-frame rectangle it
      // stands for, which materializing writes (`_ensure_materialized`).
      this._ensure_materialized();
      const container = this._kf_value_container;
      py_assert(container != null);
      return container;
    }
    if (!kind.can_materialize_wrapper || kind.container_type == null) {
      throw new NotImplementedError(`animating a static ${repr(this.match_name)} property is not yet supported`);
    }
    // Materialize while the bare tdbs is still the property's body in
    // the parent tdgp, so canonical repositioning can anchor it.
    this._ensure_materialized();
    const parent = this.parent_property;
    py_assert(parent != null && parent._tdgp != null);
    const chunks = parent._tdgp.chunks;
    const container = new ListChunk({ list_type: kind.container_type, chunks: [] });
    let wrapper = this._wrapper;
    if (wrapper == null) {
      wrapper =
        chunks.find((c): c is ListChunk => c instanceof ListChunk && c.chunks.some((cc) => cc === this._tdbs)) ?? null;
    }
    if (wrapper != null) {
      // The wrapper exists but has no value container: add it after
      // the tdbs.
      wrapper.chunks.splice(index_by_identity(wrapper.chunks, this._tdbs) + 1, 0, container);
    } else if (chunks.some((c) => c === this._tdbs)) {
      wrapper = new ListChunk({ list_type: kind.wrapper_type, chunks: [this._tdbs, container] });
      chunks[index_by_identity(chunks, this._tdbs)] = wrapper;
      // AE writes the unnamed sentinel into tdsn when it wraps the
      // property (synthesis seeds the auto-name; a pristine
      // orientation stores its real name).
      if (this._name_utf8 != null) this._name_utf8.value = TDSN_SENTINEL;
      kind.on_wrap(this);
    } else {
      throw new NotImplementedError(`animating a static ${repr(this.match_name)} property is not yet supported`);
    }
    this._wrapper = wrapper;
    this._kf_value_container = container;
    return container;
  }

  /**
   * Add a keyframe to a complex (parallel-container) property.
   *
   * When `value` is omitted, the value is taken from the kind's
   * `held_value` (interpolated for orientation, held otherwise).
   */
  _add_parallel_key(time: number, kind: ParallelKind, value: _ValueType | typeof _USE_VALUE = _USE_VALUE): number {
    if (kind === TEXT_KIND) return this._add_text_key(time, value);
    // Check the time and a given value before building the container:
    // that build materializes a fresh mask's default path, and a
    // rejected call must leave the file untouched.
    validate_f8(time);
    const units = this._keyframe_units_at(time);
    _check_time_units(units);
    if (value !== _USE_VALUE) kind.build_value_chunk(this, kind.coerce(value));
    let container = this._kf_value_container;
    if (container == null) container = this._materialize_parallel_container(kind);
    const frame_rate = this._keyframe_frame_rate();
    // Resolve the held value before _ensure_animated: for a static
    // orientation it reads the cdat that the swap removes.
    let new_value = value === _USE_VALUE ? kind.held_value(this, time) : value;
    new_value = kind.coerce(new_value);
    const ldat_item = kind.build_header_item(new_value);
    const value_chunk = kind.build_value_chunk(this, new_value);

    const kf = new Keyframe<KeyframeValue<V>>({ _ldat_item: ldat_item, _frame_rate: frame_rate });
    kf._bind_property(this);
    kf._set_time_units(units);
    const [idx, exists] = this._keyframe_insert_index(kf.time_units);
    if (exists) return idx;
    const was_static = !this.keyframes?.length;
    this._ensure_materialized();
    const [lhd3, ldat] = this._ensure_animated();
    ldat.items.splice(idx, 0, ldat_item);
    this.keyframes.splice(idx, 0, kf);
    if (was_static && container.chunks?.length > 0) {
      // A static property's container already holds its single value
      // chunk; the first keyframe takes its place.
      container.chunks[0] = value_chunk;
    } else {
      container.chunks.splice(idx, 0, value_chunk);
    }
    set_lhd3_count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    // The header item already carries the value (`build_header_item`) and
    // the container chunk is inserted above, so set the shadow directly:
    // the public `kf.value` setter would re-route complex kinds back into
    // the container write path, rebuilding the just-inserted chunk.
    kf._value = new_value;
    // Re-bind the keyframe's model to the chunk just inserted (when the
    // kind wraps); new_value (held or user-supplied) is backed by a
    // different chunk, so edits to it would never reach the serialized
    // keyframe.
    const wrapped = kind.wrap_value_chunk(this, value_chunk);
    if (wrapped != null) kf._value = wrapped;
    kind.bind_keyframe(kf._value, kf);
    if (was_static) {
      // Match the parsers: an animated shape keeps `value` aliased to
      // the first keyframe's Shape; other kinds read through keyframes.
      this._value = kind.aliases_static_value ? kf._value : null;
    }
    this._link_inserted_key(idx);
    if (!was_static && this.is_interpolation_type_valid(KeyframeInterpolationType.BEZIER)) {
      this._type_new_parallel_key(kf);
    }
    return idx;
  }

  /**
   * Give a keyframe `add_key` inserted on a parallel kind AE's types.
   *
   * AE does not reshape the curve here; it reads the key sides facing
   * the new key (the left key's out, the right key's in). Any BEZIER
   * makes it a temporally continuous BEZIER key with the default
   * influence and speed 1 - 0 outside the keyed range. Otherwise it
   * takes the left side's type in, and HOLD out when a side holds,
   * LINEAR if not. Measured on AE 2026 over every pairing, before the
   * first and after the last key, on mask and shape paths and
   * Orientation.
   */
  _type_new_parallel_key(kf: Keyframe): void {
    const bezier = KeyframeInterpolationType.BEZIER;
    const hold = KeyframeInterpolationType.HOLD;
    const sides = [
      kf._prev != null ? kf._prev.out_interpolation_type : null,
      kf._next != null ? kf._next.in_interpolation_type : null,
    ].filter((side) => side != null);
    if (sides.includes(bezier)) {
      kf.in_interpolation_type = bezier;
      kf.out_interpolation_type = bezier;
      kf._ldat_item.temporal_continuous = true;
      const data = kf._ldat_item.kf_data as KfPosition;
      const speed = sides.length === 2 ? 1.0 : 0.0;
      data.in_speed = speed;
      data.out_speed = speed;
      data.in_influence = _DEFAULT_INFLUENCE / 100.0;
      data.out_influence = _DEFAULT_INFLUENCE / 100.0;
      return;
    }
    kf.in_interpolation_type = sides[0];
    kf.out_interpolation_type = sides.includes(hold) ? hold : KeyframeInterpolationType.LINEAR;
  }

  /** Remove a keyframe from a complex (parallel-container) property. */
  _remove_parallel_key(key_index: number, kind: ParallelKind): void {
    if (kind === TEXT_KIND) {
      this._remove_text_key(key_index);
      return;
    }
    const [lhd3, ldat] = this._ensure_animated();
    const container = this._kf_value_container;
    this._ensure_materialized();
    ldat.items.splice(key_index, 1);
    this.keyframes.splice(key_index, 1);
    if (container != null && key_index < container.chunks.length) {
      container.chunks.splice(key_index, 1);
    }
    set_lhd3_count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    this._link_keyframes();
  }

  /**
   * Revert a complex property with one keyframe to its static state.
   *
   * Mirrors AE 2026 output for removing the last keyframe: the keyframe
   * `LIST:list` is replaced by a `cdat` (the empty 4-byte form for most
   * kinds, the angle values for orientation) and the parallel container
   * keeps the removed keyframe's value chunk as the static value (a
   * text property's COS document likewise stays in place). Markers have
   * no static value, so the container entry is removed, leaving the
   * zero-marker state AE writes. AE itself also discards a gradient's
   * value (reverting it to the default gradient); keeping it matches
   * the persisted static-gradient form and `removeKey` semantics.
   */
  _deanimate_parallel(kind: ParallelKind): void {
    const removed = this.keyframes[0];
    const removed_value = removed._stored_value;
    this._ensure_materialized();
    const inner = this._keyframe_inner();
    this.keyframes.splice(0, 1);
    this._link_keyframes();
    const container = this._kf_value_container;
    if (!kind.keeps_value_on_revert && container != null && container.chunks?.length > 0) {
      container.chunks.splice(0, 1);
    }
    const cdat = kind.static_cdat(removed_value);
    this._value = kind.keeps_value_on_revert ? removed_value : null;
    this._static_tdb4(removed._ldat_item);
    const chunks = this._tdbs.chunks;
    if (inner != null) {
      chunks[index_by_identity(chunks, inner)] = cdat;
    } else {
      chunks.splice(index_by_identity(chunks, this._tdb4) + 1, 0, cdat);
    }
    this._cdat = cdat;
  }

  /**
   * Set the property's value at `time`, adding a keyframe if needed.
   *
   * If a keyframe already exists at `time` its value is replaced;
   * otherwise a new keyframe is created (via {@link add_key}). Matches
   * ExtendScript `Property.setValueAtTime()`.
   *
   * time: The composition time, in seconds.
   * new_value: The value to set at that time.
   */
  set_value_at_time(time: number, new_value: PropertyValue | string): void;
  set_value_at_time(time: number, new_value: _ValueType): void {
    this._reject_curves_write();
    validate_number(time);
    if (this._separation_followers() != null) {
      // AE 2026 rejects this on a separated leader for the same reason
      // `setValue` is rejected: the followers hold the animation.
      throw new ValueError(
        `cannot set a value on ${repr(this.match_name)} while its ` +
          "dimensions are separated; key its X / Y / Z followers " +
          "instead (get_separation_follower)",
      );
    }
    const kind = this._parallel_kind();
    if (kind != null) {
      this._set_parallel_value_at(time, new_value, kind);
      return;
    }
    const [idx, exists] = this._keyframe_insert_index(this._keyframe_units_at(time));
    if (exists) {
      this.keyframes[idx].value = new_value;
      return;
    }
    this._add_key(time, new_value);
  }

  /**
   * Set / replace the value at `time` for a complex property.
   *
   * Unlike numeric properties, the value lives in the parallel
   * container, so an existing key's value chunk is rebuilt rather than
   * written through a descriptor.
   */
  _set_parallel_value_at(time: number, value: _ValueType, kind: ParallelKind): void {
    const target_units = this._keyframe_units_at(time);
    if (kind === TEXT_KIND) {
      const new_text = value instanceof TextDocument ? value.text : value;
      for (const kf of this.keyframes) {
        if (kf.time_units === target_units) {
          const td = kf.value;
          if (td instanceof TextDocument && typeof new_text === "string") {
            // The text setter already re-serializes the COS blob.
            td.text = new_text;
            this._ensure_materialized();
          }
          return;
        }
      }
      this._add_text_key(time, value);
      return;
    }
    value = kind.coerce(value);
    for (const kf of this.keyframes) {
      if (kf.time_units === target_units) {
        this._write_parallel_kf_value(kf, value, kind);
        return;
      }
    }
    this._add_parallel_key(time, kind, value);
  }

  /**
   * Persist `value` into an existing complex keyframe's container
   * chunk and mirrored header item, then rebind the keyframe model.
   *
   * Shared by `set_value_at_time` (targeting an existing key) and the
   * `Keyframe.value` setter (BUG 3): a complex keyframe's real value
   * lives in the parallel container, so writing through `kf_data`
   * alone never reaches the serialized form.
   */
  _write_parallel_kf_value(kf: Keyframe, value: _ValueType, kind: ParallelKind): void {
    kind.update_header_item(kf._ldat_item, value);
    const container = this._kf_value_container;
    if (container != null) {
      let i: number;
      try {
        i = index_by_identity(this.keyframes, kf);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        i = -1;
      }
      if (0 <= i && i < container.chunks.length) {
        const value_chunk = kind.build_value_chunk(this, value);
        container.chunks[i] = value_chunk;
        // Re-bind the keyframe's model to the chunk actually
        // inserted (mirrors `_add_parallel_key`); `value` is backed
        // by a different chunk, so editing the keyframe's value
        // afterwards would otherwise reach the caller's chunk -
        // corrupting any other keyframe that shares it.
        const wrapped = kind.wrap_value_chunk(this, value_chunk);
        kf._value = wrapped ?? value;
      } else {
        kf._value = value;
      }
    } else {
      kf._value = value;
    }
    kind.bind_keyframe(kf._value, kf);
    this._ensure_materialized();
  }

  /**
   * Set values at multiple times, adding keyframes as needed.
   *
   * Matches ExtendScript `Property.setValuesAtTimes()`.
   *
   * times: Composition times, in seconds.
   * new_values: Values to set, one per entry in `times`.
   *
   * ValueError: If `times` and `new_values` differ in length.
   */
  set_values_at_times(times: number[], new_values: (PropertyValue | string)[]): void;
  set_values_at_times(times: number[], new_values: _ValueType[]): void {
    if (times.length !== new_values.length) {
      throw new ValueError("times and new_values must have the same length");
    }
    // Every entry is checked before the first is applied, so a bad one
    // rejects the whole call instead of leaving the earlier keys added.
    validate_sequence({})(times);
    for (const value of new_values) _validate_key_value(this, value);
    for (let i = 0; i < times.length; i++) {
      this.set_value_at_time(times[i], new_values[i]);
    }
  }

  /**
   * Seconds between layer-relative keyframe times and composition time.
   *
   * The binary stores keyframe times relative to the layer's start;
   * ExtendScript reports them in composition time. Kept in seconds
   * rather than whole frames so a sub-frame keyframe survives the
   * conversion - AE leaves a layer start off the frame grid after a
   * frame-rate change, which a rounded offset would then quantize. A
   * reversed layer starts a hair early (`Layer._time_origin`).
   */
  get _start_time_offset(): number {
    return this._containing_layer._time_origin;
  }

  /**
   * Composition seconds per second of the owning layer's own time.
   *
   * `layer.stretch / 100`, signed: a negative stretch plays the layer
   * backwards, so its keyframes run down the composition timeline.
   */
  get _time_stretch(): number {
    let stretch: number;
    try {
      stretch = this._containing_layer.stretch;
    } catch (e) {
      if (!(e instanceof ValueError || e instanceof AttributeError)) throw e;
      return 1.0;
    }
    if (!stretch) return 1.0;
    return stretch / 100.0;
  }

  /**
   * Keyframe time units per second of the owning LAYER's time.
   *
   * AE stores `layer_timebase(cdta.internal_timebase, stretch)` (about
   * `internal_timebase * max(1, |stretch| / 100)`, at most 115200) in
   * every `tdb4` and counts keyframe ticks against it, so a stretched
   * layer's ticks stay in its own time (measured on AE 2026: a 150 %
   * layer at 24 fps stores 36864 and a key at layer-second 1 holds
   * 36864 ticks, which AE reports at composition second 1.5). Derived
   * rather than read back so the read and write paths cannot disagree.
   */
  get _layer_timebase(): number {
    const comp = this._owning_comp();
    if (comp == null) return 0.0;
    const base = comp._cdta.internal_timebase;
    if (base === 0) return 0.0;
    return layer_timebase(base, this._time_stretch);
  }

  /**
   * The composition this property belongs to.
   *
   * `_composition` is unset on a freshly synthesized property, whose
   * comp is only reachable by walking up to the layer.
   */
  _owning_comp(): CompItem | null {
    const comp = this._composition;
    if (comp != null) return comp;
    let node: PropertyBase | null = this.parent_property;
    while (node != null) {
      const found = getattr(node, "_containing_comp", null);
      if (found != null) return found;
      node = node.parent_property;
    }
    return null;
  }

  /**
   * Move a normalized vector into the space values are reported in.
   *
   * An effect point (and a footage layer's Anchor Point) stores its
   * value and its spatial tangents normalized against the layer, while
   * ExtendScript reports both in pixels. `invert` divides instead, for
   * the write path.
   *
   * A component with no matching scale factor passes through, so the
   * vector keeps its length rather than being truncated to the scale's.
   */
  _apply_effect_scale(values: number[], kw: { invert?: boolean } = {}): number[] {
    const { invert = false } = kw;
    const scale = this._effect_scale;
    if (scale == null) return [...values];
    const result: number[] = [];
    for (const [index, component] of values.entries()) {
      const factor = index < scale.length ? scale[index] : null;
      if (factor == null) {
        result.push(component);
      } else if (invert) {
        result.push(factor ? component / factor : 0.0);
      } else {
        result.push(component * factor);
      }
    }
    return result;
  }

  /**
   * Scale factors for denormalizing 0-1 binary values to pixel coordinates.
   *
   * Lazily computed from context:
   * - Effect point properties (TWO_D inside an effect): layer
   * dimensions (`Layer.width` / `height`, which already fall back to
   * the comp for a source-less layer).
   * - Anchor Point: layer source dimensions, but ONLY when the layer
   * has a source. Source-less layers (shape, text, null) store the
   * anchor in raw pixels - AE does not normalize it - so applying a
   * scale (which would fall back to comp size) corrupts the value.
   * - All others: `null`.
   */
  get _effect_scale(): number[] | null {
    // Allow explicit override via __dict__ (e.g. from tests).
    if (this._effect_scale_dict != null) {
      const result: number[] | null = this._effect_scale_dict.value;
      return result;
    }

    let scale: number[] | null = null;

    if (this.match_name === "ADBE Anchor Point") {
      // Only footage/comp layers normalize the anchor to source size;
      // source-less layers (shape, text, null) store it in raw pixels.
      if (getattr(this._containing_layer, "source", null) != null) {
        const size = this._layer_pixel_size();
        if (size != null) {
          // Z shares the height divisor, as on a 3-D effect point
          // (AE 2026: an anchor at Z 80 on a 400x300 solid stores
          // 0.2667, Z 30 on a null 0.3).
          scale = [size[0], size[1], size[1]];
        }
      }
    } else if (
      // The PUBLIC control type, so a property the effect creates
      // dynamically and never declares in a `pard` still counts: a
      // puppet pin's position has no param def, and reading the
      // private field left it unscaled. AE 2026 reports a pin at
      // [50, 25] on a 200x100 layer, where the file holds
      // [0.25, 0.25], exactly like a declared effect point.
      (this.property_control_type === PropertyControlType.TWO_D ||
        this.property_control_type === PropertyControlType.THREE_D) &&
      this._is_in_effect()
    ) {
      // An effect point is stored normalized against the LAYER, not
      // the composition. Measured on AE 2026: a Ramp start point set to
      // 100 on a 200x200 solid in an 800x600 comp stores 0.5, which
      // only 100/200 produces - comp normalization would store 0.125.
      // `Layer.width` already falls back to the comp for source-less
      // layers, which is what AE uses there.
      //
      // A 3D point's Z shares the HEIGHT divisor: a Point3D Control set
      // to [100, 50, 7] on a 200x100 layer stores [0.5, 0.5, 0.07], and
      // only 7/100 gives 0.07 (probed in AE 2026 across three
      // comp/layer size pairs).
      const size = this._layer_pixel_size();
      if (size != null) {
        scale = [...size];
        if (this.property_control_type === PropertyControlType.THREE_D) scale.push(size[1]);
      }
    }

    return scale;
  }

  set _effect_scale(value: number[] | null) {
    if (value != null && (!Array.isArray(value) || value.length < 2)) {
      throw new ValueError("_effect_scale must be a list of at least 2 floats");
    }
    this._effect_scale_dict = { value };
  }

  /**
   * The containing layer's pixel dimensions, or `null`.
   *
   * `null` while the property has no layer at all - an effect
   * definition parsed out of `LIST:EfdG` is a free-standing template,
   * so there is nothing to normalize against yet.
   */
  _layer_pixel_size(): [number, number] | null {
    try {
      return this._containing_layer._pixel_size;
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return null;
    }
  }
}

/** Revert a separation follower to its dead, unserialized state. */
export function _deactivate_follower(follower: Property): void {
  // Its chunks stop being written and its value goes back to the 0 AE reports
  // for an inactive follower (measured: AE's own export of a never-separated
  // layer gives X / Y / Z = 0 even for a position of [960, 540, 0]). Without
  // the value reset the model keeps reporting the separated numbers while the
  // file - and any re-parse of it - reads 0.
  follower.remove_all_keys();
  follower._revert_to_synthetic();
  follower._value = 0.0;
}

/** Per-dimension `(v0, v1)` pairs for the segment, or `null` if not numeric. */
export function _segment_components(prev_kf: Keyframe, next_kf: Keyframe): [number[][], number] | null {
  const v0 = prev_kf._stored_value;
  const v1 = next_kf._stored_value;
  if ((typeof v0 === "number" || typeof v0 === "boolean") && (typeof v1 === "number" || typeof v1 === "boolean")) {
    return [[[v0, v1]], 1];
  }
  if (Array.isArray(v0) && Array.isArray(v1) && v0.length === v1.length) {
    if (![...v0, ...v1].every((x) => typeof x === "number" || typeof x === "boolean")) return null;
    return [v0.map((a, i) => [a, v1[i]]), v0.length];
  }
  return null;
}

/**
 * An Essential Properties override leaf (a child of `ADBE Layer Overrides`).
 *
 * Its `value` is its own override (the leaf `cdat`), but its derived metadata
 * - `enabled`, `min_value`/`max_value` (hence `has_min`/`has_max`),
 * `is_modified`, `is_spatial`, `units_text`, `can_vary_over_time` and
 * `can_set_expression` - reflects the Essential Graphics *source* property
 * the override points at, matching After Effects: the override leaf's own
 * `tdsb` enable bit, `tdum`/`tduM` bounds and `tdb4` flags are the EGP
 * slider state, not what ExtendScript reports (the leaf has no `pard`, so
 * e.g. a checkbox override's own `tdb4` reports it cannot vary over time
 * while ExtendScript reports the source checkbox's `true`). Leaves are
 * re-classed to this type after the override group is parsed (see
 * `parsers/property.py::_dispatch_ovg2`); this keeps the base `Property`
 * accessors - and round-trip serialization - untouched.
 */
export class _EssentialOverrideProperty extends Property {
  declare _ov_src: Property | null;
  declare _ov_ctrl_name: string | null;

  /**
   * The resolved source `Property`, or `null` when it does not resolve
   * (e.g. a Media Replacement leaf whose source is an `AVLayer`). Cached.
   */
  _override_source(): Property | null {
    const cached = this._ov_src !== undefined ? this._ov_src : _UNSET;
    if (cached !== _UNSET) return cached;
    const src = this.essential_property_source;
    const resolved = src instanceof Property ? src : null;
    this._ov_src = resolved;
    return resolved;
  }

  /**
   * The name of the override leaf's Essential Graphics controller, or
   * `null` when it does not resolve. Cached. This is the display name AE
   * shows for the override - the leaf's own `tdsn` may be empty.
   */
  _override_controller_name(): string | null {
    const cached = this._ov_ctrl_name !== undefined ? this._ov_ctrl_name : _UNSET;
    if (cached !== _UNSET) return cached;
    const controller = resolve_essential_property_controller(this);
    const name = controller != null ? controller.name : null;
    this._ov_ctrl_name = name;
    return name;
  }

  get name(): string {
    const ctrl_name = this._override_controller_name();
    return ctrl_name != null ? ctrl_name : super.name;
  }

  set name(value: string) {
    Reflect.set(PropertyBase.prototype, "name", value, this);
  }


  get min_value(): number | number[] | null {
    const src = this._override_source();
    return src != null ? src.min_value : super.min_value;
  }

  get max_value(): number | number[] | null {
    const src = this._override_source();
    return src != null ? src.max_value : super.max_value;
  }

  get is_modified(): boolean {
    const src = this._override_source();
    if (src != null) return !_values_equal(this.value, src.value);
    return super.is_modified;
  }

  get is_spatial(): boolean {
    const src = this._override_source();
    return src != null ? src.is_spatial : super.is_spatial;
  }

  get units_text(): string {
    const src = this._override_source();
    return src != null ? src.units_text : super.units_text;
  }

  get can_vary_over_time(): boolean {
    const src = this._override_source();
    return src != null ? src.can_vary_over_time : super.can_vary_over_time;
  }

  get can_set_expression(): boolean {
    const src = this._override_source();
    return src != null ? src.can_set_expression : super.can_set_expression;
  }

  /**
   * Inherit the source parameter's denormalization scale.
   *
   * An override leaf stores its value in the raw 0-1 form AE keeps, but
   * the leaf is not inside an effect, so its own `_effect_scale` is `null`
   * and the value would stay normalized. Borrowing the source's scale puts
   * `value` in the same units the source reports (e.g. source-comp pixels
   * for a point control), matching ExtendScript and making `is_modified`
   * compare like for like. `null` for non-point sources and for
   * media-replacement overrides (whose source is an `AVLayer`, not a
   * `Property`), which fall back to the base (also `null`).
   */
  get _effect_scale(): number[] | null {
    if (this._effect_scale_dict != null) {
      const result: number[] | null = this._effect_scale_dict.value;
      return result;
    }
    const src = this._override_source();
    if (src != null) return src._effect_scale;
    return super._effect_scale;
  }

  set _effect_scale(value: number[] | null) {
    if (value != null && (!Array.isArray(value) || value.length < 2)) {
      throw new ValueError("_effect_scale must be a list of at least 2 floats");
    }
    this._effect_scale_dict = { value };
  }
}

// `enabled` is a ChunkField descriptor on PropertyBase (declared as a field), so TS
// cannot express the override as a class accessor.
Object.defineProperty(_EssentialOverrideProperty.prototype, "enabled", {
  configurable: true,
  enumerable: false,
  get(this: _EssentialOverrideProperty): boolean {
    const src = this._override_source();
    return src != null ? src.enabled : Reflect.get(PropertyBase.prototype, "enabled", this);
  },
  set(this: _EssentialOverrideProperty, value: boolean) {
    Reflect.set(PropertyBase.prototype, "enabled", value, this);
  },
});

/**
 * The root-level `Media Replacement Comps` folder, reused if present
 * (matching AE) or created at the project root.
 */
export function _find_or_create_wrapper_folder(project: Project): FolderItem {
  const root = project.root_folder;
  for (const item of project.items.values()) {
    if (item instanceof _folder().FolderItem && item.name === "Media Replacement Comps" && item.parent_folder === root) {
      return item;
    }
  }
  return root.add_folder("Media Replacement Comps");
}

/**
 * The placed footage's basename, made unique against existing item names
 * with AE's ` N` scheme (bare if free, else the first free integer \>= 2).
 */
export function _unique_wrapper_suffix(footage: FootageItem, project: Project): string {
  const base = _strip_sequence_basename(footage.name);
  const names = new Set([...project.items.values()].map((item) => item.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * Footage display name -\> AE wrapper basename: drop the extension and any
 * trailing image-sequence frame range (`foo_[001-003].gif` -\> `foo`).
 */
export function _strip_sequence_basename(name: string): string {
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return stem.replace(/[ _]?\[\p{Nd}+-\p{Nd}+\](?=\n?$)/u, "");
}

// ---- Chunk-backed field descriptors (ChunkField class attributes) ----

descriptor(Property, "dimensions", new ChunkField("_tdb4", "dimensions", { default: 1, read_only: true }));

descriptor(Property, "_animated", new ChunkField("_tdb4", "animated"));

descriptor(Property, "_color", new ChunkField("_tdb4", "color"));

descriptor(Property, "_integer", new ChunkField("_tdb4", "integer"));

descriptor(Property, "_no_value", new ChunkField("_tdb4", "no_value"));

descriptor(Property, "_vector", new ChunkField("_tdb4", "vector"));

// When `True`, the property's X/Y ratio is locked (the constrain
// proportions switch of a Scale or Mask Feather; `True` on any property
// without one). Read-only.
descriptor(
  Property,
  "locked_ratio",
  new ChunkField("_tdsb", "ratio_unlinked", { transform: (v) => !v, read_only: true }),
);

descriptor(Property, "_is_spatial_raw", new ChunkField("_tdb4", "is_spatial"));
