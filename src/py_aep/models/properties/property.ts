import { KeyframeInterpolationType, LayerType, PropertyControlType, PropertyType, PropertyValueType } from "../../enums/index.ts";
import { cosGet } from "../../cos/index.ts";
import type { CosNode } from "../../cos/cos.ts";
import { cosAt, cosInsert, cosLen, cosPopAt } from "../../cos/kinds.ts";
import { resolveCanSetExpression } from "../../resolvers/can_set_expression.ts";
import { _DEFAULT_INFLUENCE, NORMALIZED_ARC_ACCURACY, ArcMetric, _tangentsAreZero, colorDistance, interpolateKeyframes, motionPathDirection, motionPathLength, rovingKeyframeTimes, segmentValueSlope, spatialLocation, splitSegmentInfluences, splitSpatialPath } from "../../resolvers/interpolation.ts";
import { Chunk, ContainerChunk, ListChunk } from "../../binary/chunk.ts";
import { layerTimebase } from "../../binary/composition_chunks.ts";
import { LHD3_BLOCK_KEYFRAMES, KfPosition, LdatItemType, ShapePoint, setLhd3Count, LdatChunk, LdatItem, Lhd3Chunk } from "../../binary/ldat_chunks.ts";
import { EnumPardChunk } from "../../binary/misc_chunks.ts";
import { ITEM_SIZE_BY_TYPE, buildKeyframeList, buildKfData, buildLdatItem, buildParallelLdatItem, buildShap } from "../../binary/mutations.ts";
import { TDSN_SENTINEL, CdatChunk, CurvesArbpChunk, Tdb4Chunk, TdmnChunk, TdsbChunk, TdsnChunk, TdumChunk, tdb4ApplyAnimatedTemplate, tdb4ApplyStaticTemplate, tdb4ClearKeyframeRecord } from "../../binary/property_chunks.ts";
import type { VfdnChunk } from "../../binary/property_chunks.ts";
import { S4Chunk, Utf8Chunk, U4Chunk } from "../../binary/scalar_chunks.ts";
import { ChunkNotFoundError, findByListTypeOrNull, findByType, indexByIdentity } from "../../binary/utils.ts";
import { VF_AXIS_PREFIX } from "../../data/match_names.ts";
import { UNITS_TEXT_MAP } from "../../data/units.ts";
import { canAddProperty } from "../../resolvers/motion_graphics.ts";
import { _USE_VALUE, PropSpec } from "../../synthesis/property.ts";
import { ChunkField } from "../descriptors.ts";
import { TextDocument } from "../text/text_document.ts";
import { _validateNumber, validateBool, validateEnum, validateF8, validateName, validateNumber, validateSequence, validateText } from "../validators.ts";
import type { FolderItem } from "../items/folder.ts";
import type { CompItem } from "../items/composition.ts";
import type { AVLayer } from "../layers/av_layer.ts";
import type { Project } from "../project.ts";
import { Curves } from "./curves.ts";
import type { Gradient } from "./gradient.ts";
import { Keyframe, _checkTimeUnits, _timebaseUnits } from "./keyframe.ts";
import type { KeyframeValue, PropertyValue, _ValueType } from "./keyframe.ts";
import { KeyframeEase } from "./keyframe_ease.ts";
import type { MarkerValue } from "./marker.ts";
import { _ALWAYS_MODIFIED, _CANVARY_OVERRIDES, _ISSPATIAL_OVERRIDES, _NAME_OVERRIDES, _PLACEHOLDER_UNBOUNDED, _UNBOUNDED_MATCH_NAMES } from "./overrides.ts";
import { _EMPTY_CDAT_PAD, GRADIENT_KIND, MARKER_KIND, ORIENTATION_KIND, SHAPE_KIND, TEXT_KIND, type ParallelKind } from "./parallel.ts";
import { PropertyBase } from "./property_base.ts";
import { Shape } from "./shape.ts";
import type { PropertyGroup } from "./property_group.ts";
import { deepcopy, getOrThrow, isclose, valueEquals, warn, round, ValueError, IndexError, AttributeError, NotImplementedError, StopIteration, assert, literal, zip, float, ord, descriptor, typeName, type ClassAttributes, truthyOr } from "../../../pyrt/index.ts";
import { AVItem } from "../items/av_item.ts";
import { FootageItem } from "../items/footage.ts";
import { resolveEssentialPropertyController, resolveEssentialPropertySource } from "../../resolvers/essential_properties.ts";
import * as _propertyGroup from "./property_group.ts";
import * as _folder from "../items/folder.ts";
import * as _avLayer from "../layers/av_layer.ts";

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
  [ORIENTATION_KIND, MARKER_KIND, SHAPE_KIND, GRADIENT_KIND, TEXT_KIND].map((kind) => [kind.wrapperType, kind] as const),
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

export function _getMax(prop: Property): number | null {
  const v = prop.maxValue;
  if (typeof v !== "number") return null;
  // A max of exactly 0.0 is, across the whole sample corpus, always AE's
  // [0.0] placeholder for an unbounded/runtime-grown bound (Time Remapping,
  // and Light/Camera props that carry a [0.0] tduM) - never a genuine
  // enforceable maximum. So do not enforce it on the value setter. (A
  // hypothetical effect param with a real max of 0 is unsampled.)
  if (v === 0.0) return null;
  return v;
}

export function _getMin(prop: Property): number | null {
  const v = prop.minValue;
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

// Effect controls whose values AE reports rounded (`_roundHalfUp`). Matched
// against the control type the effect declares (`_propertyControlType`):
// the type inferred for other properties reads BOOLEAN for plain scalars,
// and a shape's Star Points of 5.5 reports 5.5 (AE 2026).
export const _ROUNDED_CONTROL_TYPES: ReadonlySet<PropertyControlType> = new Set<PropertyControlType>([
  PropertyControlType.BOOLEAN,
  PropertyControlType.ENUM,
]);

export function _getDimensions(prop: Property): number {
  const d: number = prop.dimensions;
  // Color properties use dimensions=1 but store 4-element lists.
  if (prop._color) return 4;
  return d;
}

export const _validateScalar = _validateNumber({ min: _getMin, max: _getMax });
export const _validateList = validateSequence({ length: _getDimensions, min: _getMin, max: _getMax });

export function _samePath(a: Shape, b: PropertyValue): boolean {
  // Whether two path values draw the same featherless path (vertices,
  // stored handles and closed flag; a path with feather points never
  // matches).
  return (
    b instanceof Shape &&
    a.closed == b.closed &&
    valueEquals(a.vertices, b.vertices) &&
    valueEquals(a._storedTangents(-1), b._storedTangents(-1)) &&
    valueEquals(a._storedTangents(1), b._storedTangents(1)) &&
    !a.featherPoints?.length &&
    !b.featherPoints?.length
  );
}

export function _validateValue(prop: Property, value: PropertyValue): void {
  // Validate type, length and bounds of a property value.
  // A mask or shape-layer path only holds a Shape: AE 2026 refuses any other
  // value ("Array is not of the correct type"), and the numeric write path
  // it would otherwise take leaves the file untouched while the model
  // reports the stray value.
  if (prop._parallelKind() === SHAPE_KIND && !(value instanceof Shape)) {
    throw new TypeError(`${literal(prop.matchName)} takes a Shape, got ${typeName(value)}`);
  }
  if (prop.matchName === "ADBE Mask Shape") {
    const layer = prop._containingLayer;
    if (!(layer instanceof _avLayer.AVLayer)) throw new AttributeError("_maskScale");
    if (layer._maskScale.includes(0)) {
      // Mask paths are stored normalized to the layer's source, so on an
      // audio-only layer (0 x 0) every path reads back as four points at
      // the origin. AE 2026 hangs on the same write.
      throw new ValueError("an audio-only layer's mask paths cannot be set");
    }
  }
  if (prop.propertyValueType === PropertyValueType.MASK_INDEX) {
    // A mask of the layer, 1-based, or 0 for none: AE 2026 refuses -1,
    // 1.6 and true ("is not an unsigned integer") and a mask the layer
    // lacks ("Value 2 out of range 0 to 1").
    const ids = _maskIds(prop);
    const count = ids != null ? ids.length : null;
    _validateNumber({ min: 0, max: count, integer: true })(value);
    return;
  }
  if (value == null) return;
  // Variable-font axis properties are 2-dimensional in the binary
  // ([value, tag]) but scalar in ExtendScript. They carry the
  // VARIABLE_FONT_AXIS value type, which is NOT in _NUMERIC_VALUE_TYPES,
  // so this must run BEFORE the numeric-type gate below - otherwise the
  // gate returns early and axis values skip finite/range validation
  // entirely (a NaN/inf or out-of-[min,max] weight would be written).
  if (prop._isVfAxis && (typeof value === "number" || typeof value === "boolean")) {
    _validateScalar(value, prop);
    return;
  }
  if (!_NUMERIC_VALUE_TYPES.has(prop.propertyValueType)) return;
  const expectsList = prop.dimensions > 1 || prop._color;
  if (expectsList) _validateList(value, prop);
  else _validateScalar(value, prop);
}

/**
 * The ids of the masks a mask-index value picks from, in order, or `null`
 * for a property with no layer (an effect definition).
 */
export function _maskIds(prop: Property): number[] | null {
  let masks: PropertyGroup | null;
  try {
    masks = prop._containingLayer.masks;
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    return null;
  }
  if (masks == null) return [];
  return masks.properties
    .filter((m) => m._isMaskGroup())
    .map((m) => m._mkif.maskId);
}

export function _validateKeyValue(prop: Property, value: PropertyValue): void {
  // Validate a keyframe value: `_validateValue`, after refusing `None` for
  // a numeric keyframe, which always holds a number (storing `None` only in
  // the model left the file at whatever the slot held, 0).
  if (value == null && prop._parallelKind() == null && !prop._noValue) {
    throw new TypeError(`${literal(prop.matchName)} keyframe value cannot be null`);
  }
  _validateValue(prop, value);
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

export function _vfTagToStr(raw: number): string | null {
  // Decode a variable-font axis tag stored as a 4CC number.
  //
  // The axis property's second dimension holds the tag packed big-endian
  // (e.g. 2003265652.0 = 0x77676874 = `wght`). Returns `None` for values
  // that do not decode to four printable ASCII characters.
  const n = Math.trunc(raw);
  if (n <= 0 || n > 0xffffffff) return null;
  const chars = [24, 16, 8, 0].map((shift) => (n >>> shift) & 0xff);
  if (chars.some((c) => c < 0x20 || c > 0x7e)) return null;
  return chars.map((c) => String.fromCodePoint(c)).join("");
}

export function _vfTagFromStr(tag: string): number {
  // Encode a 4-character axis tag to its packed 4CC number.
  let n = 0;
  for (const c of tag) n = ((n << 8) | ord(c)) >>> 0;
  return n;
}

export function _valuesEqual(a: PropertyValue, b: PropertyValue): boolean {
  // Compare two property values with float tolerance.
  //
  // Handles scalars, arrays, booleans, and null.
  // Uses [math.isclose][] for numeric comparisons.
  if (a == null || b == null) return a == b;
  if (typeof a === "boolean" || typeof b === "boolean") return valueEquals(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => _valuesEqual(x, b[i]));
  }
  if (typeof a === "number" && typeof b === "number") return isclose(a, b, 1e-9, 1e-6);
  return valueEquals(a, b);
}

/**
 * A checkbox / popup value as After Effects reports it.
 *
 * AE stores what it is given (a float32 0.6 for `setValue(0.6)`) but
 * reports checkbox and popup values rounded half up: 0.4 -\> 0, 0.5 -\> 1,
 * 1.5 -\> 2, -0.5 -\> 0 (AE 2026: Puppet On Transparent, Gaussian Blur
 * Repeat Edge Pixels, a Checkbox Control and Blur Dimensions; static
 * values, keyframes and `valueAtTime` alike).
 */
export function _roundHalfUp<T>(value: T): T | number {
  return typeof value === "number" ? Math.floor(value + 0.5) : value;
}

/**
 * `value`, with a list copied so no other holder shares it.
 *
 * Synthesized properties start from the spec tables' lists, shared by every
 * property of the spec in the process; a list read or passed in by the user
 * must not stay linked to the property either. Complex values (Shape,
 * TextDocument, ...) write through to their chunks and are kept as is.
 */
export function _ownList(value: PropertyValue): PropertyValue {
  return Array.isArray(value) ? [...value] : value;
}

/**
 * A list {@link Property.value | value} that writes item assignments back.
 *
 * `prop.value[0] = 50` sets component 0 of the property through the
 * `value` setter, from the property's current stored value (so a list
 * read earlier does not reset the other components, and a 2-D layer's
 * stored Z, read as 0, is kept). ExtendScript hands out a detached array
 * instead, where the same line does nothing. Other array methods act on
 * this copy only; copying it gives a plain array. The property is held
 * weakly, so a kept value does not keep its project alive.
 *
 * A JS array cannot override item assignment, so `bind` returns a Proxy
 * over a plain copy whose `set` trap is Python's `__setitem__`; methods
 * run on the plain copy, as the list methods py-aep does not override.
 */
export class _PropertyValueList {
  static bind<T>(value: readonly T[], prop: Property): T[] {
    const _prop = new WeakRef(prop);
    const list: T[] = [...value];
    return new Proxy(list, {
      get(target, key) {
        const got: T | number | Function | undefined = Reflect.get(target, key);
        return typeof got === "function" && key !== "constructor" ? got.bind(target) : got;
      },
      set(target, key, item) {
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) return Reflect.set(target, key, item);
        const index = Number(key);
        const owner = _prop.deref();
        if (owner == null) {
          if (index >= target.length) throw new IndexError("list assignment index out of range");
          return Reflect.set(target, key, item);
        }
        // A copy: for a keyed property this is the first key's own value,
        // which the setter then refuses to replace.
        const stored = owner._storedStaticValue();
        if (!Array.isArray(stored)) throw new TypeError(`'${typeName(stored)}' object is not iterable`);
        const new_ = [...stored];
        if (index >= new_.length) throw new IndexError("list assignment index out of range");
        new_[index] = item;
        owner.value = new_;
        const current = owner.value;
        target.splice(0, target.length, ...(Array.isArray(current) ? current : []));
        return true;
      },
    });
  }
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
  declare expressionError: string;

  /** The last value of the property (before animation). */
  declare lastValue: PropertyValue;

  /** The number of options in a dropdown property. */
  declare nbOptions: number | null;

  declare _animated: boolean;

  declare _color: boolean;

  declare _integer: boolean;

  declare _noValue: boolean;

  declare _vector: boolean;

  /**
   * When `true`, the property's X/Y ratio is locked (the constrain
   * proportions switch of a Scale or Mask Feather; `true` on any property
   * without one). Read-only.
   */
  declare lockedRatio: boolean;

  declare _isSpatialRaw: boolean;

  /**
   * When `true`, the named property defines a spatial value.
   *
   * Examples are position and effect point controls. Read-only.
   */
  get isSpatial(): boolean {
    const override = _ISSPATIAL_OVERRIDES.get(this.matchName) ?? null;
    if (override != null) return override;
    if (this._color) {
      // ExtendScript reports every color property as spatial, but AE
      // leaves the tdb4 spatial bit clear on them (an edited effect
      // color writes `_spatialStaticFlags` 0x07, measured in AE
      // 2026), so the raw bit would say otherwise.
      return true;
    }
    return !!this._isSpatialRaw;
  }

  /**
   * Whether the property interpolates along a spatial motion path.
   *
   * `isSpatial` also reports `true` for colors, to match what
   * ExtendScript says; a color has no motion path, so the keyframe
   * binary (the ldat item's key flags and layout), the speed math and
   * the roving guard ask this instead.
   */
  get _hasMotionPath(): boolean {
    return this.isSpatial && !this._color;
  }

  /** Display name of the property. Read / Write. */
  get name(): string {
    const override = _NAME_OVERRIDES.get(this.matchName) ?? null;
    if (override != null) return override;
    // Active variable-font axes display as e.g. "Font Axis Weight".
    // AE stores the name (from the font's axis name table) in a vfdn
    // sibling chunk; fall back to mapping the registered OpenType
    // tags, with custom tags showing the raw tag.
    if (this._isVfAxis) {
      if (this._vfdn != null) {
        try {
          return this._vfdn.utf8.value;
        } catch (e) {
          if (!(e instanceof ChunkNotFoundError)) throw e;
        }
      }
      const tag = this.axisTag;
      if (tag != null) return "Font Axis " + (_VF_AXIS_STANDARD_NAMES.get(tag) ?? tag);
    }
    const baseName = super.name;
    // NO_VALUE effect properties that store the match_name in tdsn
    // are unnamed separators/group headers - ExtendScript returns "".
    if (this.propertyValueType === PropertyValueType.NO_VALUE && baseName === this.matchName && this._isInEffect()) {
      return "";
    }
    return baseName;
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
   * uses the spec's `defaultValue` logic.
   * synthetic: If True, mark backing chunks as synthetic
   * (skipped during serialization).
   * control_type: Override for the property control type. When
   * omitted, defaults to `PropertyControlType.UNKNOWN`.
   */
  static _new(
    spec: PropSpec,
    propertyDepth: number,
    kw: {
      parentProperty: PropertyGroup;
      value?: PropertyValue | typeof _USE_VALUE;
      defaultValue?: PropertyValue | typeof _USE_VALUE;
      synthetic?: boolean;
      controlType?: PropertyControlType | null;
    },
  ): Property {
    const { parentProperty, value = _USE_VALUE, defaultValue = _USE_VALUE, synthetic = false, controlType = null } = kw;
    const finalValue = value === _USE_VALUE ? spec.value : value;
    const noValue = spec.pvt === PropertyValueType.NO_VALUE;
    let canVary: boolean;
    if (spec.canVaryOverTime != null) {
      canVary = spec.canVaryOverTime;
    } else {
      canVary = !noValue;
    }

    const _tdsb = new TdsbChunk({ synthetic });

    const _tdb4 = new Tdb4Chunk({ synthetic, dimensions: spec.dimensions });
    if (spec.hasTimeBase) {
      const binaryNv = noValue || (spec.isSpatial && !spec.color);
      _tdb4._timeBase = 0x7800;
      _tdb4._spatialMarker = spec.isSpatial;
      _tdb4.noValue = binaryNv;
      if (spec.spatialFlags != null) _tdb4._spatialStaticFlags = spec.spatialFlags;
      if (spec.integer) {
        _tdb4.integer = true;
        _tdb4._cvotFlags = spec.cvot ?? 0x04;
        _tdb4._propertyCategory = 0x04;
        _tdb4._valueHintType = spec.valueHintType ?? 0xffff;
      } else if (spec.color) {
        _tdb4.color = true;
        _tdb4._cvotFlags = spec.cvot ?? 0xff;
        _tdb4._propertyCategory = 0x01;
        _tdb4._valueHintType = spec.valueHintType ?? 1;
        _tdb4._valueHintFlag = 0xff;
      } else if (binaryNv) {
        _tdb4._typeFlags = spec.isSpatial ? 0x18 : 0x08;
        _tdb4._cvotFlags = spec.cvot ?? 0x04;
        _tdb4._valueHintType = spec.valueHintType ?? 1;
      } else {
        _tdb4.vector = true;
        _tdb4._cvotFlags = spec.cvot ?? 0xff;
        _tdb4._propertyCategory = 0x09;
        _tdb4._valueHintType = spec.valueHintType ?? 1;
        _tdb4._valueHintFlag = 0xff;
      }
    } else {
      if (spec.spatialFlags != null) {
        _tdb4._spatialStaticFlags = spec.spatialFlags;
      } else {
        _tdb4.isSpatial = spec.isSpatial;
      }
      _tdb4.noValue = noValue;
      _tdb4.color = spec.color;
      _tdb4.integer = spec.integer;
      _tdb4.vector = spec.dimensions > 1;
      _tdb4.canVaryOverTime = canVary;
    }

    if (spec.propertyCategory != null) _tdb4._propertyCategory = spec.propertyCategory;
    if (spec.pad2a != null) _tdb4._pad2a = spec.pad2a;

    // AE writes the unnamed sentinel; the display name resolves
    // from auto_name on the model.
    const tdsn = TdsnChunk.new_(TDSN_SENTINEL, { synthetic });
    const nameUtf8 = tdsn.utf8;
    const _tdbs = new ListChunk({
      listType: "tdbs",
      chunks: [_tdsb, tdsn, _tdb4],
      synthetic,
    });

    // Pre-create cdat for numeric values so _ensure_materialized
    // only needs to flip synthetic flags.
    let _cdat: CdatChunk | null = null;
    if (finalValue != null && (typeof finalValue === "number" || typeof finalValue === "boolean" || Array.isArray(finalValue))) {
      let rawVals: number[];
      if (Array.isArray(finalValue)) {
        rawVals = finalValue;
      } else {
        rawVals = [finalValue];
      }
      _cdat = new CdatChunk({ values: rawVals, synthetic });
      _tdbs.chunks.push(_cdat);
    }

    // Insert into parent's chunk tree (before parent's group end).
    const _tdmn = new TdmnChunk({
      value: spec.matchName,
      synthetic,
    });
    const tdgp = parentProperty._tdgp;
    if (tdgp != null) {
      _propertyGroup._insertBeforeGroupEnd(tdgp, _tdmn);
      _propertyGroup._insertBeforeGroupEnd(tdgp, _tdbs);
    }

    const prop = new this({
      _tdmn,
      _tdsb,
      _tdb4,
      _tdbs,
      _nameUtf8: nameUtf8,
      _cdat,
      keyframes: [],
      matchName: spec.matchName,
      autoName: spec.autoName,
      parentProperty,
      propertyControlType: controlType || PropertyControlType.UNKNOWN,
      propertyDepth,
      propertyValueType: spec.pvt,
      value: finalValue,
      canVaryOverTime: spec.canVaryOverTime,
      unitsText: spec.unitsText,
    });
    if (defaultValue !== _USE_VALUE) {
      prop.defaultValue = defaultValue;
    } else {
      prop.defaultValue = spec.defaultValue === _USE_VALUE ? finalValue : spec.defaultValue;
    }
    if (spec.chunkBoundsAreHints) {
      // tdum/tduM hold UI slider hints, not real bounds: the spec is
      // authoritative (None = unbounded).
      prop._minValueFallback = spec.minValue;
      prop._maxValueFallback = spec.maxValue;
    } else {
      if (spec.minValue != null) prop._minValueFallback = spec.minValue;
      if (spec.maxValue != null) prop._maxValueFallback = spec.maxValue;
    }
    if (spec.hintBounds != null) prop._hintBounds = spec.hintBounds;
    if (spec.boundChunks != null) {
      prop._boundChunksHint = spec.boundChunks;
    } else {
      prop._boundChunksHint =
        (spec.minValue != null || spec.maxValue != null) && !spec.integer && !spec.color && !spec.isSpatial;
    }

    return prop;
  }

  declare _tdmn: TdmnChunk;
  declare _tdb4: Tdb4Chunk;
  declare _expressionUtf8: Utf8Chunk | null;
  declare _tdbs: ListChunk;
  declare _tdum: TdumChunk | null;
  declare _tduM: TdumChunk | null;
  declare _cdat: CdatChunk | null;
  declare _tdpi: S4Chunk | null;
  declare _composition: CompItem | null;
  /**
   * Whether AE writes tdum/tduM placeholder bounds for this property when
   * materialized. Set from the synthesis spec in `_new`.
   */
  declare _boundChunksHint: boolean;
  /**
   * The tdum/tduM values AE writes at materialization (UI slider hints),
   * set from `PropSpec.hint_bounds` in `_new`; `null` keeps the family
   * behavior in `_ensureBoundChunks`.
   */
  declare _hintBounds: [number, number] | null;
  /**
   * Parallel per-keyframe value container for complex value types (otky /
   * mrky / omks / GCky), one value chunk per keyframe, aligned with
   * `keyframes`. Set by the specialized parsers.
   */
  declare _kfValueContainer: ListChunk | null;
  /**
   * The wrapper LIST holding this property's tdbs + value container (otst
   * / mrst / om-s / GCst / btds). Set by the specialized parsers; null for
   * ordinary numeric properties and for complex properties whose pristine
   * state stores a bare tdbs.
   */
  declare _wrapper: ListChunk | null;
  declare _blsv: U4Chunk | null;
  /**
   * Media-replacement slot chunks (blsv/blsi), siblings of this leaf's tdbs
   * inside an `ADBE Layer Source Alternate` group run. Set by the tdbs
   * dispatcher only for that match name. `blsi` is the alternate-source item
   * id (0 = no replacement set).
   */
  declare _blsi: U4Chunk | null;
  declare _canVaryOverTime: boolean | null;
  /**
   * Expressions can never be set on this parameter (from the pard
   * definition header flag; set by _apply_param_def_metadata).
   */
  declare _expressionsDisabled: boolean;
  declare _dimensionsSeparated: boolean | null;
  declare _expressionEnabled: boolean | null;
  declare _expression: string | null;
  declare _propertyControlType: PropertyControlType | null;
  declare _propertyValueType: PropertyValueType | null;
  declare _value: PropertyValue;
  declare _unitsText: string | null;
  /**
   * A default that follows other state (a camera's Position follows its
   * Zoom) reads from this callable instead of `_defaultValue`.
   */
  declare _defaultValueSource: (() => V) | null;
  declare _defaultValue: V | null;
  declare _keyframePositions: Map<Keyframe, number> | null;
  declare _typesMemo: [number[], [PropertyControlType, PropertyValueType]] | null;
  declare _effectScaleDict: { value: number[] | null } | null;
  declare _minValueFallback: number | null | typeof _UNSET;
  declare _maxValueFallback: number | null | typeof _UNSET;
  declare _sliderMin: number | null;
  declare _sliderMax: number | null;
  declare _scaleZOverride: number | null;
  declare _propertyParameters: string[] | null;
  declare _propertyType: PropertyType;
  /**
   * Cached raw axis-tag number for variable-font axis properties; survives
   * de-animation (the tag lives in the value data, which keyframe removal
   * deletes before `_deanimate` re-writes it).
   */
  declare _vfTagCache: number | null;
  /**
   * The axis display-name container AE writes after an active variable-font
   * axis slot's tdbs (set by the parser).
   */
  declare _vfdn: VfdnChunk | null;
  /**
   * The Curves effect's curves, its arbitrary data (set by the parser): a
   * LIST:aRbs of one aRbp, or of one per keyframe when keyed, in key order.
   * `value` decodes them as {@link Curves}.
   */
  declare _arbs: ListChunk | null;
  /** The static aRbp decoded, on first read. */
  declare _curves: Curves | null;
  /** The Curves effect's default curves, from its parT (set by the parser). */
  declare _defaultArbp: Chunk | null;

  constructor(kw: {
    _tdmn: TdmnChunk;
    _tdsb: TdsbChunk;
    _tdb4: Tdb4Chunk;
    _expressionUtf8?: Utf8Chunk | null;
    _nameUtf8: Utf8Chunk;
    _tdbs: ListChunk;
    _tdum?: TdumChunk | null;
    _tduM?: TdumChunk | null;
    _cdat?: CdatChunk | null;
    _tdpi?: S4Chunk | null;
    _composition?: CompItem | null;
    parentProperty?: PropertyGroup | null;
    matchName: string;
    propertyDepth: number;
    autoName?: string | null;
    keyframes: Keyframe<KeyframeValue<NoInfer<V>>>[];
    value: PropertyValue;
    propertyControlType?: PropertyControlType | null;
    propertyValueType?: PropertyValueType | null;
    unitsText?: string | null;
    canVaryOverTime?: boolean | null;
  }) {
    const {
      _tdmn,
      _tdsb,
      _tdb4,
      _expressionUtf8 = null,
      _nameUtf8,
      _tdbs,
      _tdum = null,
      _tduM = null,
      _cdat = null,
      _tdpi = null,
      _composition = null,
      parentProperty = null,
      matchName,
      propertyDepth,
      autoName = null,
      keyframes,
      value,
      propertyControlType = null,
      propertyValueType = null,
      unitsText = null,
      canVaryOverTime = null,
    } = kw;
    super({
      _tdsb,
      _nameUtf8,
      parentProperty,
      matchName,
      autoName,
      propertyDepth,
    });
    // py-aep keeps these as class defaults, set on an instance only when it
    // has a value (CPython instance-dict sizing); here every instance starts
    // at the same defaults.
    this._expressionUtf8 = _expressionUtf8;
    this._tdpi = _tdpi;
    this._unitsText = unitsText;
    this.expressionError = "";
    this.nbOptions = null;
    this._dimensionsSeparated = null;
    this._expressionEnabled = null;
    this._expression = null;
    this._kfValueContainer = null;
    this._wrapper = null;
    this._blsv = null;
    this._blsi = null;
    this._expressionsDisabled = false;
    this._defaultValueSource = null;
    this._scaleZOverride = null;
    this._propertyParameters = null;
    this._vfTagCache = null;
    this._vfdn = null;
    this._arbs = null;
    this._curves = null;
    this._defaultArbp = null;

    this._tdmn = _tdmn;
    this._tdb4 = _tdb4;
    this._tdbs = _tdbs;
    this._cdat = _cdat;

    this.keyframes = keyframes;
    this._linkKeyframes();

    this._propertyControlType = propertyControlType;

    this._propertyValueType = propertyValueType;

    this._value = _ownList(value);

    this._defaultValue = null;

    this._minValueFallback = _UNSET;
    this._maxValueFallback = _UNSET;

    this._propertyType = PropertyType.PROPERTY;

    this._tdum = _tdum;
    this._tduM = _tduM;
    this._composition = _composition;
    this._canVaryOverTime = canVaryOverTime;
    this._boundChunksHint = false;
    this._hintBounds = null;
    this._typesMemo = null;
    this.lastValue = null;
    // The pard UI slider range (effect params only; None elsewhere).
    this._sliderMin = null;
    this._sliderMax = null;
  }

  /** `true` for a variable-font axis slot property. */
  get _isVfAxis(): boolean {
    return this.matchName.startsWith(VF_AXIS_PREFIX);
  }

  /**
   * The raw 4CC tag number of an ACTIVE axis property, else `null`.
   *
   * Read from the static value's second dimension or the first
   * keyframe's, then cached (see `_vfTagCache`).
   */
  _vfAxisTagRaw(): number | null {
    if (!this._isVfAxis) return null;
    if (this._vfTagCache != null) return this._vfTagCache;
    let raw: number | null = null;
    if (this._cdat != null && this._cdat.values.length >= 2) {
      raw = this._cdat.values[1];
    } else if (this.keyframes?.length > 0) {
      const kfRaw = this.keyframes[0]._extractRawValue();
      if (Array.isArray(kfRaw) && kfRaw.length >= 2) raw = kfRaw[1];
    }
    if (raw != null && raw !== 0) {
      this._vfTagCache = raw;
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
   * `axisTag` does not exist in the ExtendScript API. It has
   * been added for convenience (ExtendScript surfaces the tag
   * only through the property's display name).
   */
  get axisTag(): string | null {
    const raw = this._vfAxisTagRaw();
    if (raw == null) return null;
    return _vfTagToStr(raw);
  }

  /** Speed unit factor for ease objects: 100 for percent properties. */
  get _speedFactor(): number {
    if (_PERCENT_MATCH_NAMES.has(this.matchName)) return 100.0;
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
   * keyframe: `_effectScale` is unavailable while the property is still
   * being constructed, and re-deriving it per value read used to rescan
   * every keyframe, which is quadratic in the keyframe count.
   */
  get _effectPointSpeedFactor(): number | null {
    const scale = this._effectScale;
    if (scale == null || scale[1] === 0) return null;
    return scale[1];
  }

  /**
   * Set back-references on keyframes after construction.
   *
   * Each keyframe gets a reference to its owning property and to its
   * prev/next neighbours for lazy ease computation.
   */
  _linkKeyframes(): void {
    // Assign None explicitly at the boundaries: after a removal or a
    // reorder the previous links are stale, and boundary keyframes
    // must read prev/next as None (ease resolution depends on it).
    for (const [i, kf] of this.keyframes.entries()) {
      kf._bindProperty(this);
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
  _keyframeIndex(keyframe: Keyframe): number | null {
    const keyframes = this.keyframes;
    let positions: Map<Keyframe, number> = this._keyframePositions || new Map();
    let index = positions.get(keyframe) ?? null;
    if (index == null || index >= keyframes.length || keyframes[index] !== keyframe) {
      positions = new Map(keyframes.map((kf, i) => [kf, i] as const));
      this._keyframePositions = positions;
      index = positions.get(keyframe) ?? null;
    }
    return index;
  }

  /**
   * Re-link only the keyframe inserted at `idx` and its neighbours.
   *
   * Equivalent to `_linkKeyframes` after a single insertion, but O(1)
   * so bulk additions (`setValuesAtTimes`) stay linear.
   */
  _linkInsertedKey(idx: number): void {
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
   * `addKey` construction the time is assigned before insertion, and
   * landing on an existing time legitimately returns that keyframe's
   * index instead.
   */
  _guardKeyframeMove(kf: Keyframe, newUnits: number): void {
    try {
      indexByIdentity(this.keyframes, kf);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return;
    }
    if (this.keyframes.some((k) => k !== kf && k.timeUnits === newUnits)) {
      throw new ValueError(`another keyframe already exists at time ${newUnits} units`);
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
   * prev/next chain (LINEAR ease speeds and `valueAtTime` read
   * neighbours by order). No-op for a keyframe not (yet) in
   * `keyframes` or whose sorted position is unchanged.
   */
  _repositionKeyframe(kf: Keyframe): void {
    let old: number;
    try {
      old = indexByIdentity(this.keyframes, kf);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return;
    }
    const newUnits = kf.timeUnits;
    const new_ = this.keyframes.filter((k) => k !== kf && k.timeUnits < newUnits).length;
    if (new_ === old) return;
    const [_lhd3, ldat] = this._ensureAnimated();
    this.keyframes.splice(new_, 0, ...this.keyframes.splice(old, 1));
    ldat.items.splice(new_, 0, ...ldat.items.splice(old, 1));
    const container = this._kfValueContainer;
    if (container != null && old < container.chunks.length) {
      container.chunks.splice(new_, 0, ...container.chunks.splice(old, 1));
    }
    if (this._arbs != null && old < this._arbs.chunks.length) {
      // The Curves effect's curves, one aRbp per key: AE pairs them by
      // position, so a key's curves move with it.
      this._arbs.chunks.splice(new_, 0, ...this._arbs.chunks.splice(old, 1));
    }
    if (this._parallelKind() === TEXT_KIND) {
      const td = kf.value;
      if (td instanceof TextDocument) {
        const docArray = cosGet(td._cosData, "1", "1");
        if (old < cosLen(docArray)) {
          cosInsert(docArray, new_, cosPopAt(docArray, old));
        }
        td._propagateCos();
      }
    }
    this._linkKeyframes();
  }

  /**
   * Re-derive every roving keyframe's time from the spatial path.
   *
   * Called after any mutation that can reshape a roving run: a value
   * edit (the path changed), a bounding keyframe's time moving (the
   * span changed), or a roving flag flip. Writes directly to the
   * backing time field to avoid recursion through `_setTimeUnits`.
   */
  _redistributeRovingKeyframes(): void {
    if (!this._hasMotionPath) return;
    // Orientation is spatial-valued but inert under roving: AE's
    // menu accepts the command (26.3x87) yet the keyframe keeps its
    // time and ease unchanged.
    if (this.matchName === "ADBE Orientation") return;
    const keyframes = this.keyframes;
    if (keyframes.length < 3) return;
    // This runs on every value, time and tangent write, so a property
    // with no roving keyframes must not pay for a full pass. The flag is
    // read off the chunk rather than through the `roving` descriptor:
    // that hop was four fifths of the cost.
    if (!keyframes.some((kf) => kf._ldatItem.roving)) return;
    const targets = rovingKeyframeTimes(keyframes, this._arcMetric);
    if (!targets?.size) return;
    // Units count layer time, so there is no composition-time offset or
    // stretch to undo here. Converting scaled the run by the stretch
    // factor and displaced it by the layer's start time, pushing roving
    // keys outside their own anchors (AE 2026: a run bounded at comp 2
    // and 8 on a 200 % layer put a roving key at -0.017).
    const holders = new Map<number, number>(keyframes.map((kf, i) => [kf.timeUnits, i] as const));
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
      if (units === kf.timeUnits || (holders.get(units) ?? index) !== index) continue;
      holders.delete(kf.timeUnits);
      holders.set(units, index);
      kf._ldatItem.timeUnits = units;
    }
  }

  /**
   * Flip synthetic flags so backing chunks become visible to write_aep().
   *
   * Called automatically by `ChunkField.set` on first end-user write
   * to a synthesized property. After this method, the property is
   * indistinguishable from one that was parsed from binary.
   */
  _ensureMaterialized(): void {
    assert(this._tdsb != null);
    if (!this._tdsb.synthetic) return;

    const parent = this.parentProperty;
    if (this.matchName === "ADBE Mask Shape" && parent != null && parent._isMask && parent._isMaskGroup()) {
      // A path-less mask stores no path. Whatever first writes its
      // Mask Path (a value, a key, an expression) makes AE write the
      // default full-frame rectangle it stands for; a bare placeholder
      // instead is "file is damaged" (AE 2026). The builder replaces
      // the placeholder in place and rebinds this property to it.
      parent._materializeMaskShape();
      return;
    }
    if (parent != null) parent._ensureMaterialized();

    this._setSubtreeSynthetic(false);

    this._ensureTimeBase();
    this._completeStaticValueChunks();
    this._repositionCanonically();
    this._ensureBoundChunks();
    this._materializeStaticOrientation();
    this._ensureMaskIndexChunks();
  }

  /**
   * Flip the synthetic flag on `tdmn` and the whole `tdbs` subtree.
   *
   * `writeAep` skips synthetic chunks, so this is what hides a
   * property from the writer or reveals it: `false` materializes,
   * `true` un-materializes (see `_revertToSynthetic`).
   */
  _setSubtreeSynthetic(value: boolean): void {
    if (this._tdmn != null) this._tdmn.synthetic = value;
    this._tdbs.synthetic = value;
    for (const chunk of this._tdbs.chunks) {
      chunk.synthetic = value;
      if (chunk instanceof ListChunk || chunk instanceof ContainerChunk) {
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
   * `_completeStaticValueChunks`), and rejects a materialized tdbs
   * lacking it with "missing data in file".
   */
  _ensureMaskIndexChunks(): void {
    if (this.propertyValueType !== PropertyValueType.MASK_INDEX) return;
    if (this._tdliChunk() != null) return;
    // No mask; a value write that follows stores its mask's id.
    this._tdbs.chunks.push(new S4Chunk({ chunkType: "tdli", value: 0 }));
  }

  _tdliChunk(): S4Chunk | null {
    for (const chunk of this._tdbs.chunks) {
      if (chunk.chunkType === "tdli" && chunk instanceof S4Chunk) return chunk;
    }
    return null;
  }

  /**
   * A mask-index property's value: the 1-based position of the mask it
   * names, or 0.
   *
   * The `tdli` stores the mask's id (`mkif`), not its position, so the
   * reference follows the mask. On AE 2026, a text Path on mask id 2
   * reads 1 once that mask is moved first, once the mask before it is
   * removed, and after it is duplicated (the copy gets id 3 and goes
   * after it). An id no mask has reads 0.
   */
  _maskIndex(): number {
    const tdli = this._tdliChunk();
    if (tdli == null || tdli.value === 0) return 0;
    const ids = _maskIds(this);
    if (ids == null) return tdli.value;
    return ids.includes(tdli.value) ? ids.indexOf(tdli.value) + 1 : 0;
  }

  /**
   * Stamp the containing comp's timebase into a py-created tdb4.
   *
   * AE writes `cdta.internal_timebase` (e.g. 24576 for 24 fps) into
   * every layer-level tdb4 and rejects the file with "zero denominator
   * converting ratio denominators" when the field is 0. Synthesized
   * tdb4 chunks start at 0 (or the 30 fps placeholder 0x7800), so fix
   * them up the moment they become visible to `writeAep`. Chunks
   * parsed from a real file never reach this method (the synthetic
   * early-return above), preserving byte identity.
   */
  _ensureTimeBase(): void {
    if (this._tdb4 == null) return;
    const comp = this._owningComp();
    if (comp != null) {
      // The layer's own base, not the comp's: a stretched layer counts
      // its keyframe ticks against `internal_timebase * |stretch|`.
      this._tdb4._timeBase = Math.trunc(this._layerTimebase || comp._cdta.internalTimebase);
      if (this._tdb4._spatialMarker && !this._tdb4.color && !this._tdb4.noValue && this._effectScale == null) {
        // AE writes the comp's pixel aspect into a layer's spatial
        // point tdb4s (not orientation / color). A point stored
        // normalized to its layer is measured otherwise, stamped
        // when keyed (`_stampNormalizedArcMetric`).
        this._tdb4.pixelAspect = comp._cdta.pixelAspect;
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
  _stampNormalizedArcMetric(): void {
    const scale = this._effectScale;
    if (scale == null || scale[1] === 0 || !this._hasMotionPath) return;
    const layer = this._containingLayer;
    const source = layer._sourceItem;
    const pixelAspect = source != null ? source.pixelAspect : layer.containingComp.pixelAspect;
    this._tdb4.pixelAspect = (scale[0] * pixelAspect) / scale[1];
    this._tdb4._arcAccuracy = NORMALIZED_ARC_ACCURACY;
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
  _ensureBoundChunks(): void {
    if (this._tdum != null || this._tduM != null) return;
    if (this._hintBounds != null) {
      // Layer Styles scalars: AE writes the UI slider hints (not the
      // real clamp) as the bound values (psd_layer_styles fixtures).
      const [low, high] = this._hintBounds;
      this._tdbs.chunks.push(new TdumChunk({ chunkType: "tdum", values: [low] }));
      this._tdbs.chunks.push(new TdumChunk({ chunkType: "tduM", values: [high] }));
      return;
    }
    // Synthetic EFFECT params: AE writes tdum/tduM for SCALAR /
    // INTEGER / SLIDER control types (RE'd vs AE 2026) regardless of
    // can_vary, and omits them for ANGLE / POINT / 3D / COLOR / BOOLEAN /
    // ENUM / LAYER. This bypasses the can_vary / fallback gating below,
    // which only governs layer/shape props.
    const effectBounded =
      this._isInEffect() && this.constructor._EFFECT_BOUNDED_CONTROL_TYPES.has(this._propertyControlType);
    if (!effectBounded) {
      // AE writes [0.0] bounds only on ANIMATABLE bounded leaves; it omits
      // them on bounded menu/dropdown leaves (Line Cap, Fill Rule, Grad
      // Type, ...) which report can_vary_over_time=False. Match that.
      if (this._canVaryOverTime === false) return;
      const multiDimVector = !this._color && !this.isSpatial && this._vector && this.dimensions > 1;
      const fallbackBounded =
        (this._minValueFallback !== _UNSET || this._maxValueFallback !== _UNSET) &&
        !this._color &&
        !this.isSpatial &&
        !this._tdb4.integer &&
        !this._isInEffect();
      // AE persists the [0.0] placeholder tdum/tduM for the props in
      // _PLACEHOLDER_UNBOUNDED (e.g. Light Intensity) even though
      // ExtendScript reports hasMin/hasMax=False, and rejects a
      // materialized one that lacks them ("missing data in file").
      const placeholderUnbounded = _PLACEHOLDER_UNBOUNDED.has(this.matchName);
      if (!multiDimVector && !this._boundChunksHint && !fallbackBounded && !placeholderUnbounded) {
        return;
      }
    }
    if (this._tdbs.chunks.some((c) => c.chunkType === "tdum" || c.chunkType === "tduM")) return;
    // AE writes doubles whatever the tdb4 integer flag says (all 47652
    // integer-flagged bounds in the sample corpus are 8 bytes), holding an
    // effect param's UI slider range (24594 of the corpus's 24676 effect
    // bounds, and AE 2026 materializing a Slider Control writes 0 / 100).
    // AE reads neither back: the bounds ExtendScript reports come from
    // the effect's definition.
    const sliderLow = effectBounded ? this._sliderMin : null;
    const sliderHigh = effectBounded ? this._sliderMax : null;
    this._tdbs.chunks.push(
      new TdumChunk({
        chunkType: "tdum",
        values: [sliderLow == null ? 0.0 : sliderLow],
      }),
    );
    this._tdbs.chunks.push(
      new TdumChunk({
        chunkType: "tduM",
        values: [sliderHigh == null ? 0.0 : sliderHigh],
      }),
    );
  }

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
  _completeStaticValueChunks(): void {
    if (this._parallelKind() != null || this._tdb4 == null) return;
    if (this.propertyValueType === PropertyValueType.MASK_INDEX) {
      // MASK_INDEX cdat is 5 zero doubles (like OneD); the index value
      // lives in a separate `tdli` chunk (see _ensure_mask_index_chunks),
      // NOT in the cdat, which stays all-zeros.
      if (this._cdat == null) {
        const cdat = new CdatChunk({ values: Array.from({ length: 5 }, () => 0.0) });
        this._tdbs.chunks.splice(indexByIdentity(this._tdbs.chunks, this._tdb4) + 1, 0, cdat);
        this._cdat = cdat;
      } else if (this._cdat.values.length < 5) {
        this._cdat.values = Array.from({ length: 5 }, () => 0.0);
      }
      return;
    }
    if (!this.constructor._NUMERIC_PVTS.has(this.propertyValueType)) return;
    if (this._tdb4.noValue) {
      // No-value properties (e.g. Layer Source Alternate) carry a
      // 4-zero-byte empty cdat; a padded double block makes AE fail
      // with "chunk in file too big".
      if (this._cdat == null) {
        const cdat = new CdatChunk({ pad: new Uint8Array(4) });
        this._tdbs.chunks.splice(indexByIdentity(this._tdbs.chunks, this._tdb4) + 1, 0, cdat);
        this._cdat = cdat;
      }
      return;
    }
    if (this.matchName === "ADBE Anchor Point" || this.matchName === "ADBE Position") {
      // AE writes static transform spatials with vector-style flags
      // (measured on addCamera / addLight output, AE 2026).
      this._tdb4._spatialStaticFlags = 0x0f;
      this._tdb4._valueHintType = 0xffff;
      this._tdb4._valueHintFlag = 0xff;
      this._tdb4._cvotFlags = 0xff;
      this._tdb4._typeFlags = 0x08;
      this._tdb4._propertyCategory = 0x09;
      this._tdb4._spatialMarker = true;
    } else if (
      [
        "ADBE Vector Position",
        "ADBE Vector Anchor",
        "ADBE Vector Grad Start Pt",
        "ADBE Vector Grad End Pt",
      ].includes(this.matchName)
    ) {
      // Static shape spatials (measured on an AE 2026 SVG-cropped
      // import: group transform Position/Anchor + gradient-fill
      // Start/End points share one canon). Same vector-style flags as
      // a layer transform plus pad2a=3; without them AE silently
      // ignores the materialized value (reads 0,0).
      this._tdb4._spatialStaticFlags = 0x0f;
      this._tdb4._pad2a = 3;
      this._tdb4._valueHintType = 0xffff;
      this._tdb4._valueHintFlag = 0xff;
      this._tdb4._cvotFlags = 0xff;
      this._tdb4._typeFlags = 0x08;
      this._tdb4._propertyCategory = 0x09;
      this._tdb4._spatialMarker = true;
    } else if (this._color && !this._isInEffect() && this._tdb4._valueHintType === 0) {
      // Static color canon (measured on a script-modified vector
      // fill color, AE 2026); with the synthesis-default flags AE
      // silently ignores the materialized value.
      this._tdb4._spatialStaticFlags = 0x07;
      this._tdb4._valueHintType = 2;
      this._tdb4._valueHintFlag = 0xff;
      this._tdb4._cvotFlags = 0xff;
      this._tdb4._typeFlags = 0x01;
      this._tdb4._propertyCategory = 0x01;
      this._tdb4._spatialMarker = true;
    } else if (
      !this._color &&
      !this.isSpatial &&
      !this._tdb4.integer &&
      !this._isInEffect() &&
      this._tdb4._valueHintType === 0 &&
      this._tdb4._propertyCategory === 0
    ) {
      // Plain numeric properties synthesized without a time base
      // carry default flag bytes; AE writes them with the standard
      // vector canon (Scale, Rotate Z, Opacity, Z Position...).
      this._tdb4._valueHintType = 1;
      this._tdb4._valueHintFlag = 0xff;
      this._tdb4._cvotFlags = 0xff;
      this._tdb4._typeFlags |= 0x08;
      this._tdb4._propertyCategory = 0x09;
    }
    const dims = this._tdb4.dimensions;
    let value = this._value;
    // A synthesized effect point keeps its raw fraction in the cdat and
    // no cached value (`_normalizeSyntheticPoint`): re-deriving the
    // fraction from pixels would round it.
    const keepCdat = value == null && this._cdat != null;
    if (!(typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) value = this.defaultValue;
    if (!(typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) {
      value = dims <= 1 ? 0.0 : Array.from({ length: dims }, () => 0.0);
    }
    const mult = this._color || this.isSpatial ? 3 : 5;
    const target = dims * mult;
    if (this._cdat == null) {
      const cdat = new CdatChunk({ values: Array.from({ length: target }, () => 0.0) });
      this._tdbs.chunks.splice(indexByIdentity(this._tdbs.chunks, this._tdb4) + 1, 0, cdat);
      this._cdat = cdat;
    } else if (this._cdat.values.length < target) {
      this._cdat.values = [...this._cdat.values, ...Array.from({ length: target - this._cdat.values.length }, () => 0.0)];
    }
    if (!keepCdat) this._writeCdat(value);
  }

  /**
   * Wrap a materialized static Orientation in the `otst` subtree
   * AE writes: `otst[tdbs(cdat le) + otky[otda]]` with a 1-dim tdb4.
   *
   * AE rejects a bare big-endian Orientation tdbs with "missing data
   * in file".
   */
  _materializeStaticOrientation(): void {
    const kind = this._parallelKind();
    if (kind == null || kind.name !== "orientation") return;
    if (this._wrapper != null || this.keyframes?.length > 0) return;
    let value = this._value;
    if (!Array.isArray(value)) {
      value = Array.isArray(this.defaultValue) ? this.defaultValue : [0.0, 0.0, 0.0];
    }
    const container = this._materializeParallelContainer(kind);
    container.chunks.push(kind.buildValueChunk(this, value));
    const newCdat = kind.staticCdat(value);
    if (this._cdat != null && this._tdbs.chunks.some((c) => c === this._cdat)) {
      this._tdbs.chunks[indexByIdentity(this._tdbs.chunks, this._cdat)] = newCdat;
    } else {
      this._tdbs.chunks.splice(indexByIdentity(this._tdbs.chunks, this._tdb4) + 1, 0, newCdat);
    }
    this._cdat = newCdat;
  }

  _chunkBody(): ListChunk | null {
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
  _isPlaceholderBound(body: TdumChunk): boolean {
    return _PLACEHOLDER_UNBOUNDED.has(this.matchName) && body.values.every((v) => v === 0.0);
  }

  /** Extract value from a tdum/tduM chunk body. */
  static _readTdum(body: TdumChunk): number | number[] {
    if (body.isColor) return [...body.values];
    if (body.isInteger) return Math.trunc(body.values[0]);
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
  _readCdatRaw(): number | number[] | null {
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
  _resolveValue(raw: number[] | number | null): number[] | number | null {
    if (raw == null) return null;
    // 0. Variable-font axis: the binary stores [value, tag4cc] but
    //    ExtendScript exposes only the scalar axis value.
    if (this._isVfAxis && Array.isArray(raw) && raw.length >= 2) {
      if (this._vfTagCache == null && raw[1] !== 0) this._vfTagCache = raw[1];
      return raw[0];
    }
    // 1. Percent scaling (0-1 fraction -> 0-100 percentage)
    if (_PERCENT_MATCH_NAMES.has(this.matchName)) {
      if (typeof raw === "number" || typeof raw === "boolean") {
        raw = raw * 100.0;
      } else if (Array.isArray(raw)) {
        raw = raw.map((v) => v * 100.0);
      }
      // For 2D layers, Z-Scale is stored as 0.01 in the binary
      // (irrelevant axis). ES always normalizes it to 100.
      if (this._scaleZOverride != null && Array.isArray(raw) && raw.length >= 3) {
        raw[2] = this._scaleZOverride;
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
    if (Array.isArray(raw) && raw.length >= 2) {
      raw = this._applyEffectScale(raw);
    }
    // 4. Checkbox / popup: reported rounded, stored as given
    if (this._propertyControlType != null && _ROUNDED_CONTROL_TYPES.has(this._propertyControlType)) {
      raw = _roundHalfUp(raw);
    }
    return raw;
  }

  /**
   * A cached value (one the setter or synthesis stored) as AE reports it,
   * as `_resolveValue` does for a stored one: a 2-D layer's Scale Z is 100
   * whatever was written (AE 2026 stores the 40 of `setValue([50, 60, 40])`
   * and reports `[50, 60, 100]`), a checkbox or popup value is rounded.
   */
  _reported(value: PropertyValue): PropertyValue {
    if (Array.isArray(value)) {
      if (this._scaleZOverride != null && value.length >= 3) {
        value[2] = this._scaleZOverride;
      }
    } else if (this._propertyControlType != null && _ROUNDED_CONTROL_TYPES.has(this._propertyControlType)) {
      value = _roundHalfUp(value);
    }
    return value;
  }

  /**
   * Reverse-transform a user-facing value to raw binary units.
   *
   * Applied in reverse order: effect point normalization, color
   * conversion, then percent scaling.
   */
  _unresolveValue(value: number | number[]): number | number[];
  _unresolveValue(value: _ValueType | boolean): _ValueType | boolean;
  _unresolveValue(value: _ValueType | boolean): _ValueType | boolean {
    if (value == null) return null;
    if (!(typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) return value;
    if (Array.isArray(value) && value?.length > 0 && !(typeof value[0] === "number" || typeof value[0] === "boolean")) return value;
    // 0. Variable-font axis: re-attach the tag dimension to a scalar
    //    ExtendScript-style value (raw 2-dim lists pass through).
    if (this._isVfAxis && (typeof value === "number" || typeof value === "boolean")) {
      const tag = this._vfAxisTagRaw();
      if (tag != null) return [float(value), tag];
      return value;
    }
    // 3. Reverse effect point (pixel coordinates -> 0-1 fraction)
    if (Array.isArray(value) && value.length >= 2) {
      value = this._applyEffectScale(value, { invert: true });
    }
    // 2. Reverse color (RGBA 0-1 -> ARGB 0-255)
    if (this._color) {
      if (Array.isArray(value) && value.length === 4) {
        const [r, g, b_, a] = value;
        value = [a * 255.0, r * 255.0, g * 255.0, b_ * 255.0];
      }
    }
    // 1. Reverse percent (0-100 -> 0-1 fraction)
    if (_PERCENT_MATCH_NAMES.has(this.matchName)) {
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
   * Applies `_unresolveValue` to convert back to raw binary units
   * before writing.
   */
  _writeCdat(value: PropertyValue): void {
    if (this._cdat == null) return;
    if (!(typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) return;
    if (Array.isArray(value) && value?.length > 0 && !(typeof value[0] === "number" || typeof value[0] === "boolean")) return;
    const rawValue = this._unresolveValue(value);
    const raw = [...this._cdat.values];
    if (Array.isArray(rawValue)) {
      // `raw[:len(raw_value)] = raw_value` - a slice assignment.
      raw.splice(0, Math.min(rawValue.length, raw.length), ...rawValue);
    } else if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      raw[0] = rawValue as number;
    }
    this._cdat.values = raw;
  }

  /**
   * The leader's value composed from its followers, or `null`.
   *
   * While `dimensionsSeparated` is on, the leader's own `cdat` is dead:
   * AE resets it to the comp-centre default on separate and drives the
   * layer from the X / Y / Z followers instead. Reading the stored value
   * reports that default - `keyframe_separated_dimensions.aep` stores
   * `[100, 100, 0]` on a 200x200 comp where AE reports `[0, 200, 0]`.
   *
   * With a `time`, each follower is sampled there instead: the leader
   * holds no keyframes while separated, so `valueAtTime` would
   * otherwise report the same frozen value for the whole timeline.
   */
  _separatedValue(time: number | null = null): number[] | null {
    const followers = this._separationFollowers();
    if (followers == null) return null;
    const composed: number[] = [];
    for (const follower of followers) {
      const component = time == null ? follower.value : follower.valueAtTime(time);
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
  _separationFollowers(): Property<number>[] | null {
    if (!this.isSeparationLeader || !this.dimensionsSeparated) return null;
    const followers = Array.from({ length: 3 }, (_, dim) => this.getSeparationFollower(dim));
    if (!followers.every((follower) => follower != null)) return null;
    return followers;
  }

  /** The Curves effect's static curves, decoded from its aRbp. */
  _staticCurves(): Curves {
    assert(this._arbs != null);
    if (this._curves == null) {
      const arbp = this._arbs.chunks[0];
      this._curves = Curves._fromBinary(CurvesArbpChunk.fromArbp(arbp));
    }
    return this._curves;
  }

  /**
   * A keyed Curves effect's curves at `keyframe`, from its own aRbp.
   *
   * `null` when the aRbs does not hold one aRbp per keyframe.
   */
  _keyframeCurves(keyframe: Keyframe): Curves | null {
    assert(this._arbs != null);
    const arbps = this._arbs.chunks;
    if (arbps.length !== this.keyframes.length) {
      return null;
    }
    const arbp = arbps[indexByIdentity(this.keyframes, keyframe)];
    return Curves._fromBinary(CurvesArbpChunk.fromArbp(arbp));
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
  _resetCurves(): void {
    assert(this._arbs != null && this._defaultArbp != null);
    const inner = this._keyframeInner();
    if (inner != null) {
      const cdat = new CdatChunk({ pad: _EMPTY_CDAT_PAD });
      const chunks = this._tdbs.chunks;
      chunks[indexByIdentity(chunks, inner)] = cdat;
      this._cdat = cdat;
      this.keyframes.length = 0;
      tdb4ApplyStaticTemplate(this._tdb4, { inInterpolation: 0, outInterpolation: 0, spatialFlags: 0 });
    }
    this._arbs.chunks.splice(0, this._arbs.chunks.length, new Chunk({ chunkType: "aRbp", data: this._defaultArbp.data }));
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
  _keyedCurvesAt(time: number): Curves | null {
    const keys = this.keyframes;
    if (time <= keys[0].time) return this._keyframeCurves(keys[0]);
    if (time >= keys[keys.length - 1].time) return this._keyframeCurves(keys[keys.length - 1]);
    const previous = [...keys].reverse().find((k) => k.time <= time);
    if (previous === undefined) throw new StopIteration();
    if (isclose(previous.time, time, 0.0, 1e-9) || previous.outInterpolationType === KeyframeInterpolationType.HOLD) {
      return this._keyframeCurves(previous);
    }
    return null;
  }

  /**
   * Refuse a write to the Curves effect's curves, which py-aep only reads.
   *
   * ValueError: If this property holds a Curves effect's curves.
   */
  _rejectCurvesWrite(): void {
    if (this._arbs != null) {
      throw new ValueError(
        `${literal(this.matchName)} holds the Curves effect's curves, which ` +
          "are read-only: py-aep does not write them back",
      );
    }
  }

  /** The default value of the property. */
  get defaultValue(): V | null {
    if (this._defaultValueSource != null) return this._defaultValueSource();
    return this._defaultValue;
  }

  set defaultValue(value: V | null) {
    this._defaultValue = this._declared(_ownList(value));
    // back to the class default
    if (this._defaultValueSource != null) this._defaultValueSource = null;
  }

  /**
   * The value of the named property at the current time.
   *
   * If `expressionEnabled` is `true`, returns the evaluated expression
   * value. If there are keyframes, returns the keyframed value at the
   * current time. Otherwise, returns the static value. Read / Write.
   *
   * The type depends on `propertyValueType`:
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
   * const textDoc = prop.value;
   * textDoc.fontSize = 72; // persists automatically
   * // prop.value = textDoc; // unnecessary - same object
   * ```
   *
   * So does item assignment on a list value, one component at a time
   * through the setter (in ExtendScript the array is a copy and the
   * same line does nothing). Other array methods act on a copy:
   *
   * ```ts
   * import { parse } from "@bevyl-ai/ts-aep";
   *
   * const app = parse("project.aep");
   * const position = app.project.compositions[0].layers[0].transform.property("ADBE Position");
   * position.value[0] = 960; // sets X, keeps Y and Z
   * position.value[1] += 10;
   * ```
   */
  get value(): V {
    const value = this._maskInertZ(this._storedStaticValue());
    if (Array.isArray(value)) return this._declared(_PropertyValueList.bind(value, this));
    return this._declared(value);
  }

  set value(value: V) {
    this._rejectCurvesWrite();
    if (this._separationFollowers() != null) {
      throw new ValueError(
        `cannot set the value of ${literal(this.matchName)} while its ` +
          "dimensions are separated; write its X / Y / Z followers " +
          "instead (getSeparationFollower)",
      );
    }
    this._setOwnValue(value);
  }

  /** {@link Property.value | value} before a 2-D layer's Z is reported as 0. */
  _storedStaticValue(): PropertyValue {
    if (this._tdpi != null && this._composition != null) {
      const layerId = this._tdpi.value;
      if (layerId === 0) return 0;
      return (this._composition._layerIdToIndex.get(layerId) ?? -1) + 1;
    }
    if (this._propertyValueType === PropertyValueType.MASK_INDEX) return this._maskIndex();
    const separated = this._separatedValue();
    if (separated != null) return separated;
    if (this._arbs != null && !this.keyframes?.length) return this._staticCurves();
    // A copy of a cached list: `valueAtTime` hands it out too.
    if (this._value != null) return this._reported(_ownList(this._wireTextVersion(this._value)));
    if (this.keyframes?.length > 0) return this._storedValueAt(0);
    if (this._cdat != null) return this._resolveValue(this._readCdatRaw());
    if (this.matchName === "ADBE Mask Shape") {
      // A mask AE never needed a path for stores none; AE reports the
      // rectangle bounding the layer's mask space, the path it writes
      // once one is needed. Built on every read, not cached, so it
      // follows the layer's source and a read, edited and re-assigned
      // value is still written.
      const layer = this._containingLayer;
      if (!(layer instanceof _avLayer.AVLayer)) throw new AttributeError("_maskScale");
      const [w, h] = layer._maskScale;
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
   * While `dimensionsSeparated` is on the leader's own `cdat` is dead -
   * AE drives the layer from the followers - so a write that landed
   * there would read back as the stale default and never reach what AE
   * renders. This is the write-side counterpart of `_separatedValue`.
   *
   * Only components that actually change are written, which leaves an
   * untouched Z follower synthetic on a 2D layer (as AE does) and
   * avoids materializing it for nothing.
   */
  _setSeparatedValue(value: _ValueType, followers: Property<number>[]): void {
    _validateValue(this, value);
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
  _unstoredMaskPath(): boolean {
    return this.matchName === "ADBE Mask Shape" && this._kfValueContainer == null;
  }

  /**
   * Write this property's own value, bypassing any separation fan-out.
   *
   * The raw path under the `value` setter, for the deliberate "park the
   * leader on its default" writes in `_separateStatic` /
   * `_separateAnimated`, which target the dead leader on purpose.
   */
  _setOwnValue(value: _ValueType): void {
    // Re-assigning the identical complex value object (TextDocument,
    // Shape, MarkerValue, Gradient) is a no-op: those types write through
    // to the backing chunks via their own descriptors. Plain numeric/list
    // values have no write-through, so a value read, mutated in place, and
    // re-assigned must still be written to the cdat chunk.
    if (value == null && this._parallelKind() === SHAPE_KIND) {
      // A fresh mask caches no value, so the identity shortcut below
      // would swallow `None` instead of rejecting it.
      _validateValue(this, value);
    }
    if (value === this._value && !(typeof value === "number" || typeof value === "boolean" || Array.isArray(value))) return;
    if (this.keyframes?.length > 0) {
      // ExtendScript: "Can not call setValue() on a property with
      // keyframes." Writing a static value alongside keyframe data
      // produces a file AE refuses to open.
      throw new ValueError("Cannot set value on a property with keyframes. " + "Use setValueAtTime() instead.");
    }
    _validateValue(this, value);
    if (this._unstoredMaskPath() && _samePath(value as Shape, this.value)) {
      // AE 2026 writes no path for a fresh mask set to the rectangle it
      // already reports (`maskPath.setValue(maskPath.value)` saves the
      // bare mask atom), so the default stays implicit here too.
      return;
    }
    const complexValue = !(typeof value === "number" || typeof value === "boolean" || Array.isArray(value) || value == null);
    // Arbitrary-data params (CUSTOM_VALUE, e.g. an effect's Curves /
    // ARBITRARY_DATA leaf) store their data in a separate blob, not the
    // numeric cdat. Writing a scalar/list into the cdat overflows it
    // (AE: "chunk in file too big") or crashes on the empty buffer; reject
    // it. Complex value objects take the write-through path below and are
    // unaffected.
    if (!complexValue && this.propertyValueType === PropertyValueType.CUSTOM_VALUE) {
      throw new ValueError(
        "Cannot set a numeric value on a CUSTOM_VALUE (arbitrary-data) " +
          "property; its data is not stored in the numeric value chunk.",
      );
    }
    this._ensureMaterialized();
    if (complexValue) {
      // A new complex value object (Shape, Gradient, TextDocument,
      // MarkerValue) assigned to a static property: `_writeCdat`
      // only writes numeric values, so the static value container
      // must be rebuilt.
      this._value = this._writeStaticComplexValue(value);
      return;
    }
    if (this.propertyValueType === PropertyValueType.MASK_INDEX) {
      // The mask's id lives in the `tdli` chunk, not the cdat (which
      // stays all-zeros); _ensure_materialized has appended one.
      const ids = _maskIds(this);
      const index = typeof value === "number" || typeof value === "boolean" ? Math.trunc(value) : 0;
      const tdli = this._tdliChunk();
      if (tdli == null) throw new AttributeError("'NoneType' object has no attribute 'value'");
      tdli.value = index !== 0 && ids != null ? ids[index - 1] : index;
      return;
    }
    this._writeCdat(value);
    this._cacheWritten(value);
  }

  /**
   * Cache a value decoded from chunks (parser-only).
   *
   * Unlike the public `value` setter this never rebuilds value
   * containers, never enforces the keyframe guard, and skips
   * validation: the value comes from the file and the chunks
   * already hold it. `_writeCdat` keeps the numeric path
   * byte-faithful (a no-op write-back of the values just read).
   */
  _cacheValue(value: _ValueType): void {
    this._writeCdat(value);
    this._cacheWritten(value);
  }

  /**
   * Cache a numeric value `_writeCdat` just stored.
   *
   * Not an effect point's: it is stored normalized and AE re-reads the
   * stored fraction against the layer's current size - [30, 40] on a
   * 200x100 solid reads [60, 40] once the solid is 400 wide, and
   * [288, 432] once it is an adjustment layer in a 1920x1080 comp (AE
   * 2026) - so its value is always read back from the cdat. Nor a
   * footage, solid or precomp layer's Anchor Point, stored normalized
   * against its source: [30, 40] on a 200x100 solid reads [60, 40] once
   * the solid is 400 wide, and [60, 80] after `replaceSource` with a
   * 400x200 one (AE 2026).
   */
  _cacheWritten(value: _ValueType): void {
    if (this._cdat != null && this._effectScale != null) {
      this._value = null;
    } else {
      this._value = _ownList(value);
    }
  }

  /**
   * Rebuild a static complex property's value container chunk.
   *
   * Static shapes / gradients store their single value chunk as the
   * only entry of the parallel container (omks / GCky); rebuild it
   * from `value` and return the model rebound to the inserted chunk
   * (so later in-place edits reach the serialized form, not the
   * caller's chunk). Orientation stores its value in the
   * (little-endian) cdat, which `_writeCdat` handles, so it is left
   * to the numeric path. Text (byte-format-sensitive btdk COS) and
   * markers (no static value) have no clean from-scratch container
   * build and are rejected.
   */
  _writeStaticComplexValue(value: PropertyValue): PropertyValue {
    const kind = this._parallelKind();
    if (kind == null || kind.name === "orientation") {
      this._writeCdat(value);
      return value;
    }
    if (kind.name === "text") {
      throw new ValueError(
        "Cannot replace a static text value with a new TextDocument. " +
          "Mutate the existing prop.value in place (e.g. prop.value.text = ...).",
      );
    }
    if (kind.name === "marker") throw new ValueError("Markers have no static value to set.");
    let container = this._kfValueContainer;
    if (container == null) {
      // A synthesized complex property (e.g. a freshly added gradient
      // fill) has no wrapper/container yet; build it the same way
      // animating would, then seed the static value.
      if (!kind.canMaterializeWrapper) {
        throw new ValueError(`static ${literal(this.matchName)} property has no value ` + "container to update");
      }
      container = this._materializeParallelContainer(kind);
      // AE keeps an (empty) cdat in the static tdbs; a synthesized
      // gradient leaf has none, which AE rejects as "missing data".
      if (this._cdat == null && this._tdbs != null && this._tdb4 != null) {
        const cdat = kind.staticCdat(value);
        this._tdbs.chunks.splice(indexByIdentity(this._tdbs.chunks, this._tdb4) + 1, 0, cdat);
        this._cdat = cdat;
      }
    }
    const valueChunk = kind.buildValueChunk(this, value);
    if (container.chunks?.length > 0) {
      container.chunks[0] = valueChunk;
    } else {
      container.chunks.push(valueChunk);
    }
    const wrapped = kind.wrapValueChunk(this, valueChunk);
    return wrapped ?? value;
  }

  /**
   * Give a {@link TextDocument} value a path to the project head so its
   * version-gated attributes can resolve the AE major version. No-op for
   * other value types or when the containing comp is unknown.
   */
  _wireTextVersion<T extends _ValueType>(value: T): T {
    if (value instanceof TextDocument && this._composition != null) {
      value._head = this._composition._project._head;
    }
    return value;
  }

  /**
   * The minimum permitted value of the named property. Only valid if
   * `hasMin` is `true`. Read-only.
   */
  get minValue(): number | number[] | null {
    if (_UNBOUNDED_MATCH_NAMES.has(this.matchName)) return null;
    if (this._minValueFallback !== _UNSET) return this._minValueFallback;
    if (this._tdum != null) {
      if (this._isPlaceholderBound(this._tdum)) return null;
      return this.constructor._readTdum(this._tdum);
    }
    return null;
  }

  /**
   * The maximum permitted value of the named property. Only valid if
   * `hasMax` is `true`. Read-only.
   */
  get maxValue(): number | number[] | null {
    if (_UNBOUNDED_MATCH_NAMES.has(this.matchName)) return null;
    if (this._maxValueFallback !== _UNSET) return this._maxValueFallback;
    if (this._tduM != null) {
      if (this._isPlaceholderBound(this._tduM)) return null;
      return this.constructor._readTdum(this._tduM);
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
  get unitsText(): string {
    if (this._unitsText != null) return this._unitsText;
    if (this._propertyControlType === PropertyControlType.ANGLE) return "degrees";
    // The map holds the spatial-valued exceptions (e.g. ADBE Orientation
    // is 3D-spatial but degrees), so it must win over the pixels heuristic.
    const mapped = UNITS_TEXT_MAP.get(this.matchName) ?? null;
    if (mapped != null) return mapped;
    const valueType = this._propertyValueType;
    if (valueType === PropertyValueType.TwoD_SPATIAL || valueType === PropertyValueType.ThreeD_SPATIAL) {
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
  get valueText(): string | null {
    const params = this.propertyParameters;
    if (!params?.length) return null;
    const value = this.value;
    if (typeof value !== "number" && typeof value !== "boolean") return null;
    // Dropdown values are 1-based indices into the menu strings.
    const index = Math.trunc(value) - 1;
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
   * Menu Control (see `isDropdownEffect`; mirrors ExtendScript
   * `Property.setPropertyParameters()`): the new items replace the
   * existing menu entries in the project file. Items must be
   * non-empty unique strings without `\\` or `|` characters; the
   * string `(-` inserts a separator line (and may repeat).
   */
  get propertyParameters(): string[] | null {
    return this._propertyParameters;
  }

  set propertyParameters(items: string[]) {
    const effect = this._parentProperty;
    if (!(this.isDropdownEffect && effect != null && effect.matchName.startsWith("Pseudo/"))) {
      throw new ValueError(
        "propertyParameters can only be set on the Menu property " + "of a Dropdown Menu Control.",
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
        if (seen.has(item)) throw new ValueError(`duplicate menu item ${literal(item)}.`);
        seen.add(item);
      }
    }
    items = [...items];
    this._writeDropdownItems(items);
    this._propertyParameters = items;
    this.nbOptions = items.length;
    this._maxValueFallback = items.length;
  }

  /**
   * The `parT` containers holding this Menu param's definition.
   *
   * A dropdown's parameter definition lives in the owning effect's
   * layer-level `sspc` and is mirrored in the project-level
   * `LIST:EfdG`; both copies must stay in sync when the menu items
   * change.
   */
  _dropdownParamDefs(): ListChunk[] {
    const effect = this._parentProperty;
    assert(effect != null);
    const parts: ListChunk[] = [];
    const parade = effect._parentProperty;
    if (parade != null) {
      if (parade._tdgp != null) {
        const sspc = effect._backingListChunk(parade._tdgp);
        if (sspc.listType === "sspc") {
          const part = findByListTypeOrNull(sspc.chunks, "parT");
          if (part !== null) parts.push(part);
        }
      }
      // The project-level EfdG mirror, via the parade's cached
      // definitions lookup. Effect params can parse without a
      // composition ref, leaving the project unreachable.
      let entry: ReturnType<PropertyGroup["_installedEffectDef"]>;
      try {
        entry = parade._installedEffectDef(effect.matchName);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        entry = null;
      }
      if (entry != null) {
        const part = findByListTypeOrNull(entry[2].chunks, "parT");
        if (part !== null) parts.push(part);
      }
    }
    return parts;
  }

  /** Write new menu items into every copy of this param's definition. */
  _writeDropdownItems(items: string[]): void {
    const joined = items.join("|");
    let written = false;
    for (const part of this._dropdownParamDefs()) {
      let current: string | null = null;
      for (const chunk of part.chunks) {
        if (chunk.chunkType === "tdmn" && chunk instanceof TdmnChunk) {
          current = chunk.value;
        } else if (current === this.matchName) {
          if (chunk instanceof EnumPardChunk) {
            // AE keeps the default choice unchanged.
            chunk.nbOptions = items.length;
          } else if (chunk.chunkType === "pdnm" && chunk instanceof ContainerChunk) {
            const utf8 = findByType(chunk.chunks, "Utf8");
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
    const effect = this._parentProperty;
    assert(effect != null);
    let comp = this._composition;
    if (comp == null) {
      try {
        comp = this._containingLayer.containingComp;
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        comp = null;
      }
    }
    if (comp != null) {
      const paramDef = comp._project._effectParamDefs.get(effect.matchName)?.get(this.matchName);
      if (paramDef != null) {
        paramDef.propertyParameters = [...items];
        paramDef.nbOptions = items.length;
        paramDef.maxValue = items.length;
      }
    }
  }

  /**
   * When `true`, the named property can vary over time - that is, keyframe
   * values or expressions can be written to this property.
   *
   * **Note:** 
   * A small subset of effect dropdown / menu parameters may report
   * `canVaryOverTime` as `false` in the binary even though After
   * Effects allows keyframing them.
   * Read-only.
   */
  get canVaryOverTime(): boolean {
    // The residue table first: a synthesized effect parameter carries its
    // pard's verdict in `_canVaryOverTime`, and the Puppet Engine's
    // pard claims it varies where AE says it does not.
    const override = _CANVARY_OVERRIDES.get(this.matchName);
    if (override !== undefined) return override;
    if (this._canVaryOverTime != null) return this._canVaryOverTime;
    // NO_VALUE properties always report canVaryOverTime=True in AE,
    // even though the binary byte says otherwise.
    return !!(this._tdb4.canVaryOverTime || this._noValue);
  }

  /**
   * When `true`, the property's dimensions are represented as separate
   * properties. For example, if the layer's position is represented as X
   * Position and Y Position properties in the Timeline panel, the Position
   * property has this attribute set to `true`. This attribute applies only
   * when the property is a "separation leader" (a multidimensional property
   * that can be separated). Read / Write.
   */
  get dimensionsSeparated(): boolean {
    if (this._dimensionsSeparated != null) return this._dimensionsSeparated;
    if (this.matchName === "ADBE Position") {
      // Camera and Light positions separate like any other 3-D layer's:
      // AE 2026 reports `dimensionsSeparated` false on a fresh one,
      // accepts the write, and reads back true with the position intact.
      //
      assert(this._tdsb != null);
      return !!this._tdsb.dimensionsSeparated;
    }
    return false;
  }

  set dimensionsSeparated(value: boolean) {
    validateBool(value);
    if (!this.isSeparationLeader) {
      // AE silently ignores this on a non-leader; raising keeps a
      // caller's mistake visible instead of swallowing the write.
      throw new ValueError(
        `dimensionsSeparated is only settable on the separation ` + `leader, not ${literal(this.matchName)}`,
      );
    }
    if (value === this.dimensionsSeparated) {
      // AE's dimensionsSeparated is idempotent. Re-running the transfer
      // would re-seed the followers from a leader that the first call
      // already reset to its default, destroying the separated values.
      return;
    }

    const followers = Array.from({ length: 3 }, (_, dim) => this.getSeparationFollower(dim));
    if (!followers.every((follower) => follower != null)) {
      throw new ValueError(`${literal(this.matchName)} has no separation followers to transfer to`);
    }
    const live = followers;
    const animated = this.keyframes?.length > 0 || live.some((follower) => follower.keyframes?.length > 0);
    if (value) {
      if (animated) {
        this._separateAnimated(live);
      } else {
        this._separateStatic(live);
      }
    } else if (animated) {
      this._recombineAnimated(live);
    } else {
      this._recombineStatic(live);
    }
  }

  /**
   * Flag the leader separated or recombined in its own `tdsb`.
   *
   * AE hides the leader in the Timeline while the followers drive the
   * layer (enable byte 0x3, lock byte 0x8 on every separated position it
   * authored) and shows it again once recombined (enable byte 0x1).
   */
  _setSeparatedFlags(separated: boolean): void {
    this._ensureMaterialized();
    assert(this._tdsb != null);
    this._tdsb.dimensionsSeparated = separated;
    this._tdsb.hidden = separated;
    this._dimensionsSeparated = separated;
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
  _separateStatic(followers: Property<number>[]): void {
    const components = this.value as number[];
    const default_ = this.defaultValue as number[];
    this._setSeparatedFlags(true);
    const threeD = this._containingLayer.is3d;
    for (const [dimension, follower] of followers.entries()) {
      if (dimension === 2 && !threeD) continue;
      follower.value = components[dimension];
    }
    // The leader keeps a value AE never reads again; AE parks it on the
    // default rather than leaving the old position there.
    this._setOwnValue([...default_]);
  }

  /**
   * Fold the followers back into the leader.
   *
   * AE writes the composed value onto the leader and reverts the
   * followers to their dead, unserialized state.
   */
  _recombineStatic(followers: Property<number>[]): void {
    const composed = followers.map((follower) => follower.value);
    this._setSeparatedFlags(false);
    this._setOwnValue(composed);
    for (const follower of followers) _deactivateFollower(follower);
  }

  /** Incoming and outgoing segment durations for each keyframe. */
  static _segmentSpans(times: number[]): [number[], number[]] {
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
  _separateAnimated(followers: Property<number>[]): void {
    const keyframes = [...this.keyframes];
    const times = keyframes.map((keyframe) => keyframe.time);
    const values = keyframes.map((keyframe) => keyframe.value as number[]);
    const inTangents = keyframes.map((keyframe) => truthyOr(keyframe.inSpatialTangent, []));
    const outTangents = keyframes.map((keyframe) => truthyOr(keyframe.outSpatialTangent, []));
    const interpolation = keyframes.map(
      (keyframe) => [keyframe.inInterpolationType, keyframe.outInterpolationType] as const,
    );
    const [incoming, outgoing] = this.constructor._segmentSpans(times);

    this.removeAllKeys();
    this._setSeparatedFlags(true);
    this._setOwnValue([...(this.defaultValue as number[])]);

    const threeD = this._containingLayer.is3d;
    for (const [dimension, follower] of followers.entries()) {
      if (dimension === 2 && !threeD) continue;
      for (const [index, time] of times.entries()) {
        const added = follower._addKey(time, values[index][dimension]);
        const keyframe = follower.keyframes[added];
        keyframe.inInterpolationType = interpolation[index][0];
        keyframe.outInterpolationType = interpolation[index][1];
        // Before the ease, not after: the continuity flag ties the
        // out speed to the in speed, and AE's own separated keyframes
        // carry tC=True with *different* speeds on each side.
        keyframe.temporalContinuous = true;
        for (const [direction, tangents, spans] of [
          ["in", inTangents, incoming],
          ["out", outTangents, outgoing],
        ] as const) {
          const span = spans[index];
          const tangent = tangents[index];
          if (span <= 0 || dimension >= tangent.length) {
            // An outer side has no segment to ease along; AE
            // parks it on zero speed and the default influence.
            keyframe._applyEase([new KeyframeEase(0.0, _DEFAULT_INFLUENCE)], direction);
            continue;
          }
          let speed = tangent[dimension] * 100.0;
          if (direction === "in") speed = -speed;
          // Clamped: influence is a percentage, and a segment
          // shorter than 0.01 s (sub-frame keys, or one frame of a
          // very high frame rate) drives `1/dt` past the 100% the
          // field can mean.
          keyframe._applyEase([new KeyframeEase(speed, Math.min(1.0 / span, 100.0))], direction);
        }
      }
    }
  }

  /**
   * Fold the followers' keyframes back into the leader.
   *
   * The inverse of `_separateAnimated`: a tangent component is
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
  _recombineAnimated(followers: Property<number>[]): void {
    if (!followers.some((follower) => follower.keyframes?.length > 0)) {
      this._recombineStatic(followers);
      return;
    }
    const keysAt: Map<number, Keyframe<number>>[] = followers.map(
      (follower) => new Map(follower.keyframes.map((kf) => [kf.time, kf] as const)),
    );
    const times = [...new Set(keysAt.flatMap((perDimension) => [...perDimension.keys()]))].sort((a, b) => a - b);
    const [incoming, outgoing] = this.constructor._segmentSpans(times);
    const dimensions = followers.length;
    const composed = times.map(() => Array.from({ length: dimensions }, () => 0.0));
    const inTangents = times.map(() => Array.from({ length: dimensions }, () => 0.0));
    const outTangents = times.map(() => Array.from({ length: dimensions }, () => 0.0));
    // Interpolation is per keyframe, not per dimension: take it from the
    // first dimension that has a keyframe at that time.
    const interpolation = times.map((time) => {
      for (const perDimension of keysAt) {
        const kf = perDimension.get(time);
        if (kf !== undefined) {
          return [kf.inInterpolationType, kf.outInterpolationType] as const;
        }
      }
      return [KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR] as const;
    });

    for (const [dimension, follower] of followers.entries()) {
      for (const [index, time] of times.entries()) {
        const keyframe = keysAt[dimension].get(time);
        if (keyframe == null) {
          const sampled = follower.valueAtTime(time);
          composed[index][dimension] = typeof sampled === "number" ? sampled : 0.0;
          continue;
        }
        composed[index][dimension] = keyframe.value;
        for (const [direction, target, spans] of [
          ["in", inTangents, incoming],
          ["out", outTangents, outgoing],
        ] as const) {
          const span = spans[index];
          if (span <= 0) continue;
          const ease = direction === "in" ? keyframe.inTemporalEase : keyframe.outTemporalEase;
          if (!ease?.length) continue;
          const magnitude = ease[0].speed * (ease[0].influence / 100.0) * span;
          target[index][dimension] = direction === "in" ? -magnitude : magnitude;
        }
      }
    }

    for (const follower of followers) _deactivateFollower(follower);

    this._setSeparatedFlags(false);
    for (const [index, time] of times.entries()) {
      this._addKey(time, composed[index]);
    }
    for (const [index, keyframe] of this.keyframes.entries()) {
      if (index >= times.length) break;
      keyframe.inInterpolationType = interpolation[index][0];
      keyframe.outInterpolationType = interpolation[index][1];
      if (keyframe.inSpatialTangent != null) {
        keyframe.inSpatialTangent = inTangents[index].slice(0, keyframe.inSpatialTangent.length);
      }
      if (keyframe.outSpatialTangent != null) {
        keyframe.outSpatialTangent = outTangents[index].slice(0, keyframe.outSpatialTangent.length);
      }
    }
  }

  /**
   * Hide this property's chunks from `writeAep` again.
   *
   * The inverse of `_ensureMaterialized`'s flag flip, for a property AE
   * un-materializes - a separation follower once its leader is
   * recombined. Chunk order is left alone: synthetic chunks are skipped
   * on write, and `_repositionCanonically` runs again if the property is
   * ever materialized anew.
   */
  _revertToSynthetic(): void {
    if (this._tdsb == null || this._tdsb.synthetic) return;
    this._setSubtreeSynthetic(true);
  }

  /**
   * The expression for the named property. Writeable only when
   * `canSetExpression` for the named property is `true`.
   * Read / Write.
   */
  get expression(): string {
    if (this._expression != null) return this._expression;
    if (this._expressionUtf8 != null) return this._expressionUtf8.value;
    return "";
  }

  set expression(value: string) {
    if (value && !this.canSetExpression) {
      throw new AttributeError(`expression cannot be set on property ${literal(this.matchName)}`);
    }
    // A NUL ends the expression for AE 2026, which keeps only the text
    // before it, both when a script sets it and when it reads the file.
    validateText(value);
    if (!value) {
      // Empty string clears the expression (chunk + tdb4 markers).
      this._clearExpression();
      return;
    }
    this._ensureMaterialized();
    if (this._expressionUtf8 != null) {
      this._expressionUtf8.value = value;
    } else {
      const chunk = new Utf8Chunk({ value });
      // AE stores the expression Utf8 immediately after the value
      // container (cdat or the keyframe LIST:list), BEFORE any
      // tdum/tduM bounds - the order is positional, so appending at
      // the tail makes AE reject the file ("missing data in file").
      const chunks = this._tdbs.chunks;
      const anchor = this._cdat ?? this._keyframeInner();
      if (anchor != null) {
        chunks.splice(indexByIdentity(chunks, anchor) + 1, 0, chunk);
      } else {
        chunks.splice(indexByIdentity(chunks, this._tdb4) + 1, 0, chunk);
      }
      this._expressionUtf8 = chunk;
    }
    this._expression = value;
    // Assigning an expression enables it (AE semantics): clear any stale
    // disabled state so the cache recomputes True (mirrors _clear_expression).
    this._expressionEnabled = null;
    if (this._tdb4 != null) {
      // AE marks an expression-bearing parameter in tdb4._pad10; the
      // inverse of _clear_expression so a created expression round-trips.
      this._tdb4.hasExpression = true;
      this._tdb4._exprFlags = 0;
    }
  }

  /**
   * When `true`, the named property uses its associated expression to
   * generate a value. When `false`, the keyframe information or static
   * value of the property is used. Read / Write.
   */
  get expressionEnabled(): boolean {
    if (this._expressionEnabled != null) return this._expressionEnabled;
    const disabled = "expressionDisabled" in this._tdb4 ? this._tdb4.expressionDisabled : true;
    return !disabled && !!this.expression;
  }

  set expressionEnabled(value: boolean) {
    validateBool(value);
    if (value && !this.canSetExpression) {
      // AE refuses the same write: "Can not set expression with this
      // property, because the property or a parent property is
      // hidden." Without the guard the write also materializes the
      // property, which for MARKER / NO_VALUE kinds emits chunks AE
      // rejects.
      throw new ValueError(`property ${literal(this.matchName)} cannot take an expression`);
    }
    if (value && !this.expression) {
      // AE silently no-ops here, leaving expressionEnabled false. Doing
      // the same would clear the tdb4 disabled bit for an expression
      // that does not exist - a byte AE never writes, which the getter
      // then masks behind `bool(self.expression)`. Raising instead of
      // mirroring the no-op keeps the caller's mistake visible.
      throw new ValueError(`property ${literal(this.matchName)} has no expression to enable`);
    }
    if (!value && !this.expression && this._unstoredMaskPath()) {
      // Nothing to disable: AE 2026 saves a fresh mask given
      // `expressionEnabled = false` as the bare atom, with no path.
      return;
    }
    this._ensureMaterialized();
    this._expressionEnabled = value;
    this._tdb4.expressionDisabled = !value;
  }

  /** When `true`, an expression can be set for the named property. Read-only. */
  get canSetExpression(): boolean {
    return resolveCanSetExpression(this);
  }

  /** The control type of the property (e.g., scalar, color, boolean). Read-only. */
  get propertyControlType(): PropertyControlType {
    if (this._propertyControlType != null) return this._propertyControlType;
    const [pct] = this._determinePropertyTypes();
    return pct;
  }

  /**
   * The type of value stored in the named property. Each type of data is
   * stored and retrieved in a different kind of structure. For example,
   * a 3D spatial property (such as a layer's position) is stored as an
   * array of three floating-point values. Read-only.
   */
  get propertyValueType(): PropertyValueType {
    if (this._propertyValueType != null) return this._propertyValueType;
    const [, pvt] = this._determinePropertyTypes();
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
   * The `__dict__` overrides of `_noValue` / `_color` / `_vector` /
   * `dimensions` are not in the key. They are set once at parse or
   * synthesis time before any read, and `ChunkField.set` pops them
   * on a real write, so they cannot change under a live memo.
   *
   * Uncached this ran on every `propertyValueType` and
   * `propertyControlType` read - 15 times per `valueAtTime` on an
   * animated Opacity, since `_effectScale` alone consults the control
   * type ten times.
   */
  _determinePropertyTypes(): [PropertyControlType, PropertyValueType] {
    const tdb4 = this._tdb4;
    let key: number[] | null;
    if (tdb4 != null) {
      key = [tdb4.dimensions, tdb4._typeFlags, tdb4._spatialStaticFlags, tdb4._noValueFlags];
      const memo = this._typesMemo;
      if (memo != null && valueEquals(memo[0], key)) {
        return memo[1];
      }
    } else {
      key = null;
    }
    const result = this._computePropertyTypes();
    if (key != null) {
      this._typesMemo = [key, result];
    }
    return result;
  }

  /** Derive the control and value types from the tdb4 flags. */
  _computePropertyTypes(): [PropertyControlType, PropertyValueType] {
    let pct: PropertyControlType = PropertyControlType.UNKNOWN;
    let pvt: PropertyValueType = PropertyValueType.UNKNOWN;

    if (this._noValue) pvt = PropertyValueType.NO_VALUE;
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
        pvt = this.isSpatial ? PropertyValueType.TwoD_SPATIAL : PropertyValueType.TwoD;
      } else if (this.dimensions === 3) {
        pct = PropertyControlType.THREE_D;
        pvt = this.isSpatial ? PropertyValueType.ThreeD_SPATIAL : PropertyValueType.ThreeD;
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
        `Could not determine type for property ${this.matchName}` +
          ` | dimensions: ${this.dimensions}` +
          ` | integer: ${this._integer}` +
          ` | is_spatial: ${this.isSpatial}` +
          ` | vector: ${this._vector}` +
          ` | no_value: ${this._noValue}` +
          ` | color: ${this._color}`,
      );
    }

    return [pct, pvt];
  }

  /**
   * `true` if the property is a multidimensional property that
   * can be separated.
   */
  get isSeparationLeader(): boolean {
    return this.matchName === _SEPARATION_LEADER;
  }

  /**
   * `true` if the property is a component of a separated
   * multidimensional property (e.g. X Position, Y Position,
   * Z Position).
   */
  get isSeparationFollower(): boolean {
    return _SEPARATION_FOLLOWERS.includes(this.matchName);
  }

  /**
   * For a separated follower, the dimension it represents.
   *
   * Returns 0, 1, or 2 for X, Y, or Z. Returns `null` for
   * properties that are not separation followers.
   */
  get separationDimension(): number | null {
    if (!this.isSeparationFollower) return null;
    return _SEPARATION_FOLLOWERS.indexOf(this.matchName);
  }

  /**
   * For a separation follower, the leader property.
   *
   * Returns the {@link Property} that acts as the separation leader
   * (e.g. Position) for this follower (e.g. X Position).
   * Returns `null` when this property is not a follower or the
   * leader cannot be found.
   */
  get separationLeader(): Property<number[]> | null {
    if (!_SEPARATION_FOLLOWERS.includes(this.matchName)) return null;
    const parent = this.parentProperty;
    if (parent == null || !("properties" in parent)) return null;
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
  getSeparationFollower(dim: number): Property<number> | null {
    if (!this.isSeparationLeader) return null;
    const parent = this.parentProperty;
    if (parent == null || !("properties" in parent)) return null;
    if (dim < 0 || dim >= _SEPARATION_FOLLOWERS.length) {
      throw new ValueError(`dim must be in range [0, ${_SEPARATION_FOLLOWERS.length - 1}], got ${dim}`);
    }
    const matchName = _SEPARATION_FOLLOWERS[dim];
    // A separated leader on a 2D layer genuinely has no Z follower.
    return parent._childOrNull(matchName);
  }

  /**
   * Returns the index of the keyframe nearest to the specified time.
   *
   * time: The time in seconds; a floating-point value. The beginning
   * of the composition is 0.
   */
  nearestKeyIndex(time: number): number {
    const distances = this.keyframes.map((kf) => Math.abs(kf.time - time));
    return distances.indexOf(Math.min(...distances));
  }

  /**
   * Returns the keyframe nearest to the specified time.
   *
   * time: The time in seconds; a floating-point value. The beginning
   * of the composition is 0.
   */
  nearestKey(time: number): Keyframe<KeyframeValue<V>> {
    const index = this.nearestKeyIndex(time);
    return this.keyframes[index];
  }

  /**
   * `true` if the property value differs from its default.
   *
   * A property is considered modified when it has keyframes, has an
   * expression (enabled or disabled), or when its current value
   * differs from `defaultValue`.
   */
  get isModified(): boolean {
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
    if (this.isSeparationFollower && this.separationDimension === 2) {
      const leader = this.separationLeader;
      if (leader != null && !leader.dimensionsSeparated) {
        const layer = this._containingLayer;
        const layerType = layer._ldta.layerType;
        if (layerType === LayerType.CAMERA || layerType === LayerType.LIGHT) return true;
      }
    }
    // Source Text has no meaningful default - always modified when it
    // has a value (text is always user-authored).
    if (this.matchName === "ADBE Text Document" && this.value != null) return true;
    // NO_VALUE (button/separator/group header) properties inside effects
    // are always reported as modified in ExtendScript.
    if (this.propertyValueType === PropertyValueType.NO_VALUE) return this._isInEffect();
    // Mask reference properties that exist in the binary are always
    // modified - their presence indicates user interaction even when
    // the value is 0 (no mask).  Synthesized default slots (synthetic)
    // remain unmodified.
    if (
      this.propertyValueType === PropertyValueType.MASK_INDEX &&
      this._isInEffect() &&
      this._tdsb != null &&
      !this._tdsb.synthetic
    ) {
      return true;
    }
    // The Curves effect's default curves are an aRbp in its parT; an
    // untouched instance's is byte-identical to it. The curves are
    // compared, not the bytes, which carry stale points and junk.
    if (this._arbs != null) {
      const curves = this._staticCurves();
      if (this._defaultArbp == null) return !curves.isIdentity;
      const default_ = CurvesArbpChunk.fromArbp(this._defaultArbp);
      return !curves._sameCurves(Curves._fromBinary(default_));
    }
    if (_ALWAYS_MODIFIED.has(this.matchName)) return true;
    if (this.defaultValue != null) return !_valuesEqual(this.value, this.defaultValue);
    // Effect properties with no known default are considered modified
    // when they have a value - ExtendScript treats the absence of a
    // default as "always modified". LAYER_INDEX is excluded because
    // its binary default (0 = "None" layer) is not stored in pard;
    // layer references should report False when unset.
    if (
      this.value != null &&
      this._isInEffect() &&
      this.propertyValueType !== PropertyValueType.LAYER_INDEX
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
  get canSetAlternateSource(): boolean {
    return this._blsi != null && this._blsi.value !== 0;
  }

  /**
   * The alternate source item set for a Media Replacement slot, or
   * `null` when unset / unsupported. Read / Write.
   *
   * After Effects wraps the replacement footage in a composition, so this
   * resolves to that wrapper item (the `blsi` item id).
   */
  get alternateSource(): AVItem | null {
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
   * (`canSetAlternateSource` is `false`), when `source` is not in the
   * project, or when `source.isMediaReplacementCompatible` is `false`,
   * and `TypeError` when `source` is not an `AVItem`.
   */
  set alternateSource(source: AVItem) {
    if (!this.canSetAlternateSource || this._blsi == null) {
      throw new ValueError(
        "This property does not support media replacement " + "(canSetAlternateSource is false).",
      );
    }
    if (!(source instanceof AVItem)) {
      throw new TypeError(`alternate source must be an AVItem, not ${typeName(source)}`);
    }
    if (this._composition == null || !this._composition._project.items.has(source.id)) {
      throw new ValueError(`Item ${literal(source.name)} (id=${source.id}) is not in the project.`);
    }
    // Checked on the passed item, not the wrapper: wrapping an audio-only
    // footage in a comp would make the slot look compatible.
    if (!source.isMediaReplacementCompatible) {
      throw new ValueError(
        `Item ${literal(source.name)} (id=${source.id}) cannot be used as an ` +
          "alternate source (isMediaReplacementCompatible is false).",
      );
    }
    if (source instanceof FootageItem) {
      this._blsi.value = this._buildReplacementWrapper(source).id;
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
  _buildReplacementWrapper(footage: FootageItem): CompItem {
    const host = this._composition;
    assert(host != null); // guarded by the caller's project check
    const project = host._project;
    const folder = _findOrCreateWrapperFolder(project);
    const name = `${this.name}_${_uniqueWrapperSuffix(footage, project)}`;
    const wrapper = folder.addComp(
      name,
      host.width,
      host.height,
      host.pixelAspect,
      host.duration,
      host.frameRate,
    );
    // AE's wrapper comp shares the host comp's cdta exactly (timebase,
    // shutter phase, work area) - `addComp`'s fresh skeleton diverges on
    // time_divisor/work_area_start_divisor/shutter_phase, so clone the host
    // cdta over it. idta/iide (the item ids) are separate chunks and stay
    // the wrapper's own.
    const newCdta = deepcopy(host._cdta);
    const chunks = wrapper._itemList.chunks;
    // Python `chunks.index(...)` compares by attrs equality (first equal chunk).
    const cdtaIndex = chunks.findIndex((c: Chunk) => valueEquals(c, wrapper._cdta));
    if (cdtaIndex < 0) throw new ValueError("list.index(x): x not in list");
    chunks[cdtaIndex] = newCdta;
    wrapper._cdta = newCdta;
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
  get essentialPropertySource(): Property | PropertyGroup | AVLayer | null {
    return resolveEssentialPropertySource(this);
  }

  /** `true` if the property is the Menu property of a Dropdown Menu Control effect. */
  get isDropdownEffect(): boolean {
    // A Dropdown Menu Control is a `Pseudo/@@<id>` effect (its Essential
    // Graphics override leaf keeps that match name). AE 2026 reports
    // false on every other popup, named pseudo effects' ones included.
    return (
      this._propertyControlType === PropertyControlType.ENUM &&
      this.matchName.startsWith("Pseudo/@@")
    );
  }

  /** `true` if the named property has keyframes or an enabled expression. */
  get isTimeVarying(): boolean {
    return !!((this.expression && this.expressionEnabled) || this._animated);
  }

  /** `true` if there is a maximum permitted value for the named property. */
  get hasMax(): boolean {
    return this.maxValue != null;
  }

  /** `true` if there is a minimum permitted value for the named property. */
  get hasMin(): boolean {
    return this.minValue != null;
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
   * NotImplementedError: If `preExpression` is `false`,
   * because the parser cannot evaluate expressions.
   */
  valueAtTime(time: number, preExpression = true): V {
    if (!preExpression) {
      throw new NotImplementedError("Expression evaluation is not supported by the parser.");
    }
    if (typeof time !== "number") {
      throw new TypeError(`time must be a number, got ${typeName(time)}`);
    }
    if (Number.isNaN(time)) {
      // AE 2026: "Unable to call valueAtTime because of parameter 1.
      // NaN is not a number." Infinity IS accepted (it evaluates to the
      // last keyframe's value), so only NaN is rejected here.
      throw new ValueError("time must be a number, got NaN");
    }
    return this._declared(this._maskInertZ(this._storedValueAt(time)));
  }

  /**
   * {@link valueAtTime} before a 2-D layer's Z is reported as 0: what
   * AE stores in a key added at `time` (measured on AE 2026: `addKey`
   * between keys at Z 40 and -30 stores Z 5.0005).
   */
  _storedValueAt(time: number): PropertyValue {
    if (!this.keyframes?.length) {
      const separated = this._separatedValue(time);
      if (separated != null) return separated;
      return this._storedStaticValue();
    }
    if (this._arbs != null) return this._keyedCurvesAt(time);

    const kind = this._parallelKind();
    const hasMotionPath = this._hasMotionPath;
    const result = interpolateKeyframes(
      this._evaluatedLayerTime(time),
      this.keyframes,
      hasMotionPath,
      this._inertDimensions(),
      kind,
      hasMotionPath ? this._arcMetric : new ArcMetric(),
      !!this._color,
    );
    return this._clampToRange(result);
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
  _maskInertZ(value: PropertyValue): PropertyValue {
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      (this.matchName === "ADBE Position" || this.matchName === "ADBE Anchor Point") &&
      !this._containingLayer.is3d
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
  _evaluatedLayerTime(time: number): number {
    const base = this._layerTimebase;
    if (base === 0 || !Number.isFinite(time)) return this._layerTimeFromComp(time);
    const snapped = Math.floor(time * base + 0.5) / base;
    const layer = this._layerTimeFromComp(snapped);
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
  _clampToRange(value: PropertyValue): PropertyValue {
    const lo = _getMin(this);
    const hi = _getMax(this);
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
  get _arcMetric(): ArcMetric {
    const tdb4 = this._tdb4;
    const scale = this._effectScale;
    return new ArcMetric(
      tdb4._arcAccuracy,
      [tdb4.pixelAspect, tdb4._arcMultiplierY, tdb4._arcMultiplierZ, tdb4._arcMultiplierW],
      scale != null ? [...scale] : null,
      // `_effectPointSpeedFactor`, from the scale already in hand.
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
  _layerTimeFromComp(time: number): number {
    return (time - this._startTimeOffset) / this._timeStretch;
  }

  /**
   * Value indices the owning layer ignores.
   *
   * A 2-D layer's Scale still carries a Z component, and AE holds it
   * flat across a segment whose X and Y bow - it will not even store a
   * Z other than 100 there.
   */
  _inertDimensions(): ReadonlySet<number> {
    if (this.matchName !== "ADBE Scale") return new Set<number>();
    const layer = this._containingLayer;
    if (layer == null || layer.is3d) return new Set<number>();
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
  isInterpolationTypeValid(type: number): boolean {
    validateEnum(KeyframeInterpolationType)(type);
    const interp = KeyframeInterpolationType.of(type);
    if (!this.canVaryOverTime) return false;
    if (interp === KeyframeInterpolationType.HOLD) return true;
    const valueType = this.propertyValueType;
    if (valueType === PropertyValueType.MARKER || valueType === PropertyValueType.TEXT_DOCUMENT) {
      return false;
    }
    // Only the pard-derived control type is authoritative for the
    // checkbox/dropdown test: the tdb4 flag fallback in
    // _determine_property_types maps any 1-D integer scalar to BOOLEAN,
    // but integer sliders (e.g. Mosaic blocks) interpolate in AE.
    const controlType = this._propertyControlType;
    return !(controlType === PropertyControlType.BOOLEAN || controlType === PropertyControlType.ENUM);
  }

  // -- Keyframe mutation -------------------------------------------------

  /** The frame rate keyframe times convert with. */
  _keyframeFrameRate(): number {
    if (this.keyframes?.length > 0) return this.keyframes[0]._frameRate;
    let comp = this._composition;
    if (comp == null) comp = this._containingLayer.containingComp;
    return comp.frameRate;
  }

  /** The `LIST:list` holding the keyframe header chunks, or None. */
  _keyframeInner(): ListChunk | null {
    return findByListTypeOrNull(this._tdbs.chunks, "list");
  }

  /**
   * The complex-value kind storing keyframe values in a parallel
   * container, or `null` for ordinary numeric properties.
   */
  _parallelKind(): ParallelKind | null {
    const wrapper = this._wrapper;
    if (wrapper != null) {
      // `_materializeParallelContainer` can adopt an arbitrary
      // sibling LIST as the wrapper, so an unknown type falls through
      // to the match name rather than deciding the answer is None.
      const kind = _WRAPPER_KINDS.get(wrapper.listType) ?? null;
      if (kind != null) return kind;
    }
    return _SYNTHESIZED_KINDS.get(this.matchName) ?? null;
  }

  /** The `LdatItemType` for this property's keyframe header data. */
  _keyframeItemType(): LdatItemType {
    const kind = this._parallelKind();
    if (kind != null) return kind.headerItemType;
    if (this._color) return LdatItemType.color;
    if (this._noValue) return LdatItemType.no_value;
    const dims = this.dimensions;
    if (dims >= 3) {
      return this.isSpatial ? LdatItemType.three_d_spatial : LdatItemType.three_d;
    }
    if (dims === 2) return this.isSpatial ? LdatItemType.two_d_spatial : LdatItemType.two_d;
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
  _animateTdb4(): void {
    const t = this._tdb4;
    if (this._parallelKind() != null) {
      t.static = false;
      t.animated = true;
      t._spatialMarker = false;
      // AE clears the opaque interpolation residue it leaves in these
      // fields when a complex property went static (bytes 0x49-0x4E).
      t._reserved48 = (t._reserved48 & 0xff000000) >>> 0;
      t._reserved4c = t._reserved4d = t._pad4e = 0;
      return;
    }
    // AE keeps a variable-font axis's value-hint flag, cvot flags
    // and time base unchanged across the static<->animated
    // transition (verified against the variable_font_axis_animated
    // AE 2026 fixture).
    const preserved = this._isVfAxis ? [t._valueHintFlag, t._cvotFlags, t._timeBase] : null;
    tdb4ApplyAnimatedTemplate(t, { color: !!this._color, spatial: this._hasMotionPath });
    // The template cannot know the comp's timebase or pixel aspect.
    // `_ensureMaterialized` stamps them, but only for a synthesized
    // property - one parsed from a real file returns early there, so
    // animating it needs the stamp applied here too.
    this._ensureTimeBase();
    this._stampNormalizedArcMetric();
    // After the stamp, which reads the record's 0x4F to spot a static
    // spatial point.
    tdb4ClearKeyframeRecord(t);
    if (preserved != null) {
      [t._valueHintFlag, t._cvotFlags, t._timeBase] = preserved;
    }
  }

  /**
   * Return the keyframe `(lhd3, ldat)`, creating them if static.
   *
   * Transitioning a static property to animated replaces its `cdat`
   * with a `LIST:list` keyframe container and rewrites the `tdb4`
   * metadata to AE's animated state.
   */
  _ensureAnimated(): [Lhd3Chunk, LdatChunk] {
    let inner = this._keyframeInner();
    if (inner == null) {
      const itemType = this._keyframeItemType();
      let lhd3: Lhd3Chunk;
      let ldat: LdatChunk;
      [inner, lhd3, ldat] = buildKeyframeList(itemType, getOrThrow(ITEM_SIZE_BY_TYPE, itemType));
      this._animateTdb4();
      const chunks = this._tdbs.chunks;
      if (this._cdat != null) {
        chunks[indexByIdentity(chunks, this._cdat)] = inner;
        this._cdat = null;
      } else {
        chunks.splice(indexByIdentity(chunks, this._tdb4) + 1, 0, inner);
      }
      return [lhd3, ldat];
    }
    const lhd3 = findByType(inner.chunks, "lhd3");
    const ldat = findByType(inner.chunks, "ldat");
    return [lhd3, ldat];
  }

  /**
   * Locate `timeUnits` among the keyframes.
   *
   * Returns `(index, exists)`: when a keyframe already sits at
   * `timeUnits`, `exists` is True and `index` is its position;
   * otherwise `exists` is False and `index` is the sorted insertion
   * point. Keyed on raw units rather than frame indices so two
   * sub-frame keyframes inside one frame stay distinct.
   */
  _keyframeInsertIndex(timeUnits: number): [number, boolean] {
    for (const [i, kf] of this.keyframes.entries()) {
      const units = kf.timeUnits;
      if (units === timeUnits) return [i, true];
      if (units > timeUnits) return [i, false];
    }
    return [this.keyframes.length, false];
  }

  /**
   * Layer-relative keyframe units for a composition `time` in seconds.
   *
   * Where AE puts a key added at `time`: the layer tick it evaluates
   * `time` at (`_evaluatedLayerTime`), not the nearest tick to the
   * exact layer time. Measured on AE 2026: 584 of 585 `setValueAtTime`
   * keys over 8 frame rates and stretches from -500 to 9900 % (the
   * one-step rounding missed 10, each by one tick).
   */
  _keyframeUnitsAt(time: number): number {
    let timebase: number = this._layerTimebase;
    if (timebase !== 0) return round(this._evaluatedLayerTime(time) * timebase);
    timebase = _timebaseUnits(this._keyframeFrameRate());
    return round(((time - this._startTimeOffset) / this._timeStretch) * timebase);
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
  canAddToMotionGraphicsTemplate(comp: CompItem): boolean {
    return canAddProperty(this, comp);
  }

  /**
   * Add this property to `comp`'s Essential Graphics panel, using the
   * property's own name for the controller.
   *
   * Returns `true` on success, or `false` when the property cannot be added
   * (see `canAddToMotionGraphicsTemplate`).
   *
   * comp: The composition to add the property to.
   */
  addToMotionGraphicsTemplate(comp: CompItem): boolean {
    return comp._addPropertyController(this, null);
  }

  /**
   * Add this property to `comp`'s Essential Graphics panel with an
   * explicit controller `name`.
   *
   * Returns `true` on success, or `false` when the property cannot be
   * added (see `canAddToMotionGraphicsTemplate`).
   *
   * comp: The composition to add the property to.
   * name: The controller name to show in the Essential Graphics panel.
   */
  addToMotionGraphicsTemplateAs(comp: CompItem, name: string): boolean {
    validateName(name);
    return comp._addPropertyController(this, name);
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
  addKey(time: number): number {
    this._rejectCurvesWrite();
    return this._addKey(time);
  }

  /**
   * Add a keyframe at `time`, seeding its value when supplied.
   *
   * When `value` is omitted, the keyframe takes the property's value at
   * `time` (interpolated when animated, the static value otherwise).
   */
  _addKey(time: number, value: _ValueType | typeof _USE_VALUE = _USE_VALUE): number {
    validateNumber(time);
    if (!this.canVaryOverTime) {
      throw new ValueError(`property ${literal(this.matchName)} cannot vary over time`);
    }
    const kind = this._parallelKind();
    if (kind != null) return this._addParallelKey(time, kind, value);
    // A no-value numeric property has no value slot to keyframe; building
    // a numeric keyframe item for it produces a wrong-size ldat item.
    // (Complex kinds above store their value in a sibling container and
    // legitimately report no_value=True, so this only guards the numeric
    // path.)
    if (this._noValue) {
      throw new ValueError(`property ${literal(this.matchName)} has no value to keyframe`);
    }
    const frameRate = this._keyframeFrameRate();

    const itemType = this._keyframeItemType();
    const kfData = buildKfData(itemType, this.dimensions);
    const ldatItem = buildLdatItem(kfData, { spatial: this._hasMotionPath });

    const kf = new Keyframe<KeyframeValue<V>>({
      _ldatItem: ldatItem,
      _frameRate: frameRate,
    });
    kf._bindProperty(this);
    // Before any mutation: `time` can be far enough out that its tick
    // count overflows the 32-bit field, and animating first left the
    // property marked animated with no keyframes and its static value
    // gone (issue #228). `_addParallelKey` orders itself the same way.
    kf._setTimeUnits(this._keyframeUnitsAt(time));

    const [idx, exists] = this._keyframeInsertIndex(kf.timeUnits);
    if (exists) return idx;
    // At the key's own time, which is `time` rounded to whole units: the
    // value has to be where the curve is when the key sits, or it kinks
    // the motion path at the split.
    const newValue = value === _USE_VALUE ? this._storedValueAt(kf.time) : value;
    // Written into the detached keyframe first: the setter validates the
    // value (type, length, finiteness, range), and a rejected one must
    // leave the property exactly as it was rather than holding a new key
    // at 0.
    kf.value = newValue;
    this._ensureMaterialized();
    const [lhd3, ldat] = this._ensureAnimated();
    ldat.items.splice(idx, 0, ldatItem);
    this.keyframes.splice(idx, 0, kf);
    setLhd3Count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    this._linkInsertedKey(idx);
    this._preserveCurveOnInsert(idx, value !== _USE_VALUE);
    this._redistributeRovingKeyframes();
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
   * `setValue` is for `setValueAtTime`, which seeds a value of its
   * own: AE leaves a key it adds that way into a LINEAR segment with a
   * blank (0 / 0) ease, where `addKey` writes the slope (AE 2026).
   */
  _preserveCurveOnInsert(idx: number, setValue = false): void {
    if (idx <= 0 || idx >= this.keyframes.length - 1) {
      // Outside the keyed range there is no segment to preserve.
      return;
    }
    const kf = this.keyframes[idx];
    const prevKf = this.keyframes[idx - 1];
    const nextKf = this.keyframes[idx + 1];

    const components = _segmentComponents(prevKf, nextKf);
    if (components == null) return;
    let [pairs, dims] = components;

    let outType = prevKf.outInterpolationType;
    let inType = nextKf.inInterpolationType;
    // Either side holding makes the whole segment hold, so the inserted
    // key has to hold on both sides to leave the value where it was.
    if (outType === KeyframeInterpolationType.HOLD || inType === KeyframeInterpolationType.HOLD) {
      outType = inType = KeyframeInterpolationType.HOLD;
    }
    const mixed =
      !setValue &&
      ((outType === KeyframeInterpolationType.LINEAR && inType === KeyframeInterpolationType.BEZIER) ||
        (outType === KeyframeInterpolationType.BEZIER && inType === KeyframeInterpolationType.LINEAR));
    const linearOut = outType === KeyframeInterpolationType.LINEAR;
    if (mixed) {
      outType = inType = KeyframeInterpolationType.BEZIER;
    }
    kf.inInterpolationType = outType;
    kf.outInterpolationType = inType;

    // Layer time: the speeds synthesized below are stored per layer
    // second, and on a reversed layer only this axis ascends.
    const t0 = prevKf._layerTime;
    const t1 = nextKf._layerTime;
    const t = kf._layerTime;
    if (!(t0 < t && t < t1)) return;
    if (setValue && outType === KeyframeInterpolationType.LINEAR) return;

    // Read while the neighbours still have their own types: a LINEAR
    // side resolves to its segment slope at the default influence.
    const prevOut = [...prevKf.outTemporalEase];
    const nextIn = [...nextKf.inTemporalEase];
    if (mixed) {
      prevKf.outInterpolationType = KeyframeInterpolationType.BEZIER;
      nextKf.inInterpolationType = KeyframeInterpolationType.BEZIER;
    }
    const newIn: KeyframeEase[] = [];
    const newOut: KeyframeEase[] = [];
    const leftOut: KeyframeEase[] = [];
    const rightIn: KeyframeEase[] = [];

    // A spatial property stores ONE ease for the whole vector (its speed
    // is along the path), where a plain vector stores one per dimension.
    const nEase = Math.min(prevOut.length, nextIn.length) || 1;
    const spatial = nEase === 1 && dims > 1;
    let splitAt: number | null = null;
    if (this._color) {
      // One ease along the colour line: split it as one quantity, the
      // colour distance in the units its speeds use.
      pairs = [[0.0, colorDistance(prevKf.value as number[], nextKf.value as number[])]];
    } else if (spatial) {
      // A spatial ease's speed is measured along the PATH, so the split
      // runs once over the segment's arc length - the chord would be
      // short wherever the tangents bow the curve.
      pairs = [[0.0, this._segmentArcLength(prevKf, nextKf)]];
      // Read before the eases below change: the new key has to sit
      // where the path was at its time.
      splitAt = this._motionPathParameter(idx, t);
    }

    for (let d = 0; d < nEase; d++) {
      const [v0, v1] = d < pairs.length ? pairs[d] : pairs[0];
      let oEase = d < prevOut.length ? prevOut[d] : prevOut[0];
      let iEase = d < nextIn.length ? nextIn[d] : nextIn[0];
      if (mixed) {
        // The LINEAR side as the BEZIER handle it is: the slope of
        // the whole segment (not of its first half - the new key is
        // already linked) at the default influence.
        const asBezier = new KeyframeEase((v1 - v0) / (t1 - t0), _DEFAULT_INFLUENCE);
        if (linearOut) {
          oEase = asBezier;
        } else {
          iEase = asBezier;
        }
      }
      let slope: number;
      let infl: number[];
      let inflNext: number;
      let oSpeed: number;
      let iSpeed: number;
      if (outType === KeyframeInterpolationType.HOLD) {
        slope = 0.0;
        infl = [oEase.influence, _DEFAULT_INFLUENCE, _DEFAULT_INFLUENCE];
        inflNext = iEase.influence;
        oSpeed = oEase.speed;
        iSpeed = iEase.speed;
      } else if (outType === KeyframeInterpolationType.LINEAR) {
        slope = (v1 - v0) / (t1 - t0);
        infl = [_DEFAULT_INFLUENCE, _DEFAULT_INFLUENCE, _DEFAULT_INFLUENCE];
        inflNext = _DEFAULT_INFLUENCE;
        oSpeed = slope;
        iSpeed = slope;
      } else {
        slope = segmentValueSlope(t0, t1, v0, v1, oEase, iEase, t);
        const [lo, ni, no, ri] = splitSegmentInfluences(t0, t1, v0, v1, oEase, iEase, t);
        infl = [lo, ni, no];
        inflNext = ri;
        oSpeed = oEase.speed;
        iSpeed = iEase.speed;
      }
      leftOut.push(new KeyframeEase(oSpeed, infl[0]));
      newIn.push(new KeyframeEase(slope, infl[1]));
      newOut.push(new KeyframeEase(slope, infl[2]));
      rightIn.push(new KeyframeEase(iSpeed, inflNext));
    }

    kf._applyEase(newIn, "in");
    kf._applyEase(newOut, "out");
    prevKf._applyEase(leftOut, "out");
    nextKf._applyEase(rightIn, "in");

    if (splitAt != null) {
      this._splitMotionPath(prevKf, kf, nextKf, splitAt);
    }
  }

  /**
   * Arc length of the motion path between two keyframes.
   *
   * In the units the property's ease speeds are reported in.
   */
  _segmentArcLength(prevKf: Keyframe, nextKf: Keyframe): number {
    const v0 = prevKf._storedValue;
    const v1 = nextKf._storedValue;
    if (!Array.isArray(v0) || !Array.isArray(v1)) return 0.0;
    const ndim = v0.length;
    const outTangent = truthyOr(prevKf.outSpatialTangent, Array.from({ length: ndim }, () => 0.0));
    const inTangent = truthyOr(nextKf.inSpatialTangent, Array.from({ length: ndim }, () => 0.0));
    return motionPathLength(v0, v1, outTangent, inTangent, this._arcMetric);
  }

  /** The direction this property's motion path heads at comp `time`. */
  _motionDirectionAt(time: number): number[] | null {
    return motionPathDirection(this._layerTimeFromComp(time), this.keyframes, this._arcMetric);
  }

  /**
   * The curve parameter the motion path was at, at `time` in layer time.
   *
   * Located on the path as it was before the keyframe at `idx` was
   * inserted, which is what the inserted key's value was read from.
   * `null` when the time falls on another segment of a roving run.
   */
  _motionPathParameter(idx: number, time: number): number | null {
    const before = [...this.keyframes.slice(0, idx), ...this.keyframes.slice(idx + 1)];
    if (!before.every((kf) => Array.isArray(kf.value))) return null;
    const [segment, u] = spatialLocation(time, before, idx - 1, this._arcMetric);
    return segment === idx - 1 ? u : null;
  }

  /**
   * Split the motion path at curve parameter `u` so the inserted key
   * does not reshape it.
   *
   * Without this the new keyframe carries no spatial tangents and the
   * single curve becomes two straight-ish halves.
   */
  _splitMotionPath(prevKf: Keyframe, kf: Keyframe, nextKf: Keyframe, u: number): void {
    const v0 = prevKf._storedValue;
    const v1 = nextKf._storedValue;
    if (!Array.isArray(v0) || !Array.isArray(v1)) return;
    const ndim = v0.length;
    const outTangent = truthyOr(prevKf.outSpatialTangent, Array.from({ length: ndim }, () => 0.0));
    const inTangent = truthyOr(nextKf.inSpatialTangent, Array.from({ length: ndim }, () => 0.0));
    if (_tangentsAreZero(outTangent) && _tangentsAreZero(inTangent)) return;
    const [leftOut, newIn, _split, newOut, rightIn] = splitSpatialPath(v0, v1, outTangent, inTangent, u);
    prevKf.outSpatialTangent = leftOut;
    kf.inSpatialTangent = newIn;
    kf.outSpatialTangent = newOut;
    nextKf.inSpatialTangent = rightIn;
  }

  /**
   * Remove the keyframe at `keyIndex` (0-based).
   *
   * Removing the last remaining keyframe reverts the property to a
   * static value (the removed keyframe's value), matching ExtendScript
   * `Property.removeKey()`. Markers have no static value: removing the
   * last marker leaves the property empty.
   *
   * key_index: The 0-based index of the keyframe to remove.
   *
   * IndexError: If the property has no keyframes.
   * ValueError: If `keyIndex` is out of range.
   */
  removeKey(keyIndex: number): void {
    this._rejectCurvesWrite();
    if (!this.keyframes?.length) throw new IndexError("property has no keyframes");
    _validateNumber({ integer: true, min: 0, max: this.keyframes.length - 1 })(keyIndex);
    const kind = this._parallelKind();
    if (kind != null) {
      if (this.keyframes.length === 1) {
        this._deanimateParallel(kind);
        return;
      }
      this._removeParallelKey(keyIndex, kind);
      return;
    }
    this._ensureMaterialized();
    const [lhd3, ldat] = this._ensureAnimated();
    const removed = this.keyframes[keyIndex];
    const removedValue = removed._storedValue;
    ldat.items.splice(keyIndex, 1);
    this.keyframes.splice(keyIndex, 1);
    setLhd3Count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    this._linkKeyframes();
    if (!this.keyframes?.length) {
      this._deanimate(removedValue, removed._ldatItem);
      return;
    }
    // The run a removed anchor bounded now spans to the next anchor: AE
    // re-times its roving keys along it (AE 2026).
    this._redistributeRovingKeyframes();
  }

  /**
   * Remove every keyframe from this property.
   *
   * Equivalent to calling `removeKey` for each keyframe: the
   * property reverts to a static value (the first keyframe's value).
   * Markers have no static value: the property is left empty. A
   * no-op when the property has no keyframes.
   */
  removeAllKeys(): void {
    if (this.keyframes?.length > 0) this._rejectCurvesWrite();
    if (this._parallelKind() != null) {
      while (this.keyframes?.length > 0) this.removeKey(this.keyframes.length - 1);
      return;
    }
    if (!this.keyframes?.length) return;
    // Bulk path: clearing key-by-key would re-link the remaining
    // keyframes after every removal (quadratic) and decode values
    // that are thrown away.
    this._ensureMaterialized();
    const [lhd3, ldat] = this._ensureAnimated();
    const first = this.keyframes[0];
    const firstValue = first._storedValue;
    ldat.items.splice(0);
    this.keyframes.splice(0);
    setLhd3Count(lhd3, 0, LHD3_BLOCK_KEYFRAMES);
    this._deanimate(firstValue, first._ldatItem);
  }

  /** Set the tdb4 to AE's static state after removing `lastKey`. */
  _staticTdb4(lastKey: LdatItem): void {
    const kfData = lastKey.kfData;
    tdb4ApplyStaticTemplate(this._tdb4, {
      inInterpolation: lastKey.inInterpolationType,
      outInterpolation: lastKey.outInterpolationType,
      spatialFlags: kfData instanceof KfPosition ? kfData._spatialFlags : 0,
    });
  }

  /**
   * Revert an emptied animated property to a static `value`, after
   * removing `lastKey`.
   */
  _deanimate(value: _ValueType, lastKey: LdatItem): void {
    const inner = this._keyframeInner();
    const chunks = this._tdbs.chunks;
    this._staticTdb4(lastKey);
    const raw =
      typeof value === "number" || typeof value === "boolean" || Array.isArray(value) ? this._unresolveValue(value) : null;
    let rawVals: number[];
    if (typeof raw === "number" || typeof raw === "boolean") {
      rawVals = [raw];
    } else if (Array.isArray(raw)) {
      rawVals = raw;
    } else {
      rawVals = [0.0];
    }
    // AE pads the static value to 3 doubles per dimension when the
    // stream flags have bit 1 (spatial and colour streams), 5 otherwise
    // - the layout of every static numeric stream in the samples.
    const perDim = this._tdb4._spatialStaticFlags & 0x02 ? 3 : 5;
    rawVals.push(...Array.from({ length: this._tdb4.dimensions * perDim - rawVals.length }, () => 0.0));
    const cdat = new CdatChunk({ values: rawVals });
    if (inner != null) {
      chunks[indexByIdentity(chunks, inner)] = cdat;
    } else {
      chunks.splice(indexByIdentity(chunks, this._tdb4) + 1, 0, cdat);
    }
    this._cdat = cdat;
    this._value = null;
  }

  /**
   * Remove any expression, reverting to a plain (non-expression) property.
   *
   * Drops the expression `Utf8` chunk from the `tdbs` and clears the
   * tdb4 expression flag, so `expression` becomes `""` and
   * `expressionEnabled` `false`. A no-op when no expression is set.
   */
  _clearExpression(): void {
    if (this._expressionUtf8 == null && !this._expression) return;
    if (this._expressionUtf8 != null) {
      const kept = this._tdbs.chunks.filter((c) => c !== this._expressionUtf8);
      this._tdbs.chunks.splice(0, this._tdbs.chunks.length, ...kept);
      this._expressionUtf8 = null;
    }
    this._expression = null;
    this._expressionEnabled = null;
    if (this._tdb4 != null) {
      // `_exprFlags` (bit 0 = disabled) and the `_pad10` high-byte
      // marker (`hasExpression`) are AE's expression-present flags;
      // clear both so the tdb4 matches a plain static parameter.
      this._tdb4._exprFlags = 0;
      this._tdb4.hasExpression = false;
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
  _buildShapChunk(shape: Shape): Chunk {
    const points = truthyOr(shape._points, []).map((p: ShapePoint) => new ShapePoint({ x: p.x, y: p.y }));
    const src = shape._shph;
    let bbox: number[];
    if (src != null) {
      bbox = [src.topLeftX, src.topLeftY, src.bottomRightX, src.bottomRightY];
    } else {
      bbox = [0.0, 0.0, 0.0, 0.0];
    }
    const isMaskPath = this.matchName === "ADBE Mask Shape";
    const sourceSize = shape._isMask ? shape._compSize : null;
    const [srcW, srcH] = sourceSize ?? [1.0, 1.0];
    let dstW: number;
    let dstH: number;
    if (isMaskPath) {
      const layer = this._containingLayer;
      if (!(layer instanceof _avLayer.AVLayer)) throw new AttributeError("_maskScale");
      [dstW, dstH] = layer._maskScale;
    } else {
      [dstW, dstH] = [1.0, 1.0];
    }
    if (srcW !== dstW || srcH !== dstH) {
      // Scale then divide: a pixel-space value divided by the layer size
      // stays bit-identical to the plain division.
      bbox = [
        (bbox[0] * srcW) / dstW,
        (bbox[1] * srcH) / dstH,
        (bbox[2] * srcW) / dstW,
        (bbox[3] * srcH) / dstH,
      ];
    }
    let tensions: number[] | null = null;
    const mask = this._parentProperty;
    if (isMaskPath && mask != null && mask._isMask && mask._isMaskGroup()) {
      if (mask.rotoBezier) {
        const own = shape._ownTensions();
        const count = Math.floor(points.length / 3);
        tensions = own.length === count ? own : Array.from({ length: count }, () => 1.0);
      }
    }
    const shap = buildShap([bbox[0], bbox[1], bbox[2], bbox[3]], {
      openPath: !shape.closed,
      points,
      tensions,
      featherPoints: isMaskPath ? shape.featherPoints.map((fp) => fp._fp) : null,
    });
    if (src != null) {
      // Carry over the source header's unknown flag bits; build_shap
      // only knows the open/closed bit.
      const newShph = findByType(shap.chunks, "shph");
      newShph._flags = src._flags;
      newShph.open = !shape.closed;
    }
    return shap;
  }

  /**
   * Wrap a COS doc Map as a {@link TextDocument} sharing `template`'s
   * COS data / btdk chunk.
   */
  _buildTextView(doc: CosNode, template: TextDocument): TextDocument {
    const char = cosGet(doc, "0", "6", "0", 0, "0", "0", "6");
    const para = cosGet(doc, "0", "5", "0", 0, "0", "0", "5");
    const view = TextDocument._fromBinary({
      _charStyle: char instanceof Map ? char : null,
      _paraStyle: para instanceof Map ? para : null,
      _doc: doc,
      _fonts: template._fonts,
      _cosData: template._cosData,
      _btdkBody: template._btdkBody,
    });
    if (template._siblings != null) {
      template._siblings.push(view);
      view._siblings = template._siblings;
    }
    // The clone copies the template's text AND its (possibly stale)
    // layout cache, so it inherits the template's staleness verdict.
    view._layoutDirty = template._layoutDirty;
    view._compositionCalibrated = template._compositionCalibrated;
    return this._wireTextVersion(view);
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
  _animateStaticText(time: number, value: _ValueType | string | typeof _USE_VALUE = _USE_VALUE): number {
    const template = this._value;
    if (!(template instanceof TextDocument)) {
      throw new NotImplementedError("text property has no TextDocument value to animate");
    }
    const frameRate = this._keyframeFrameRate();
    this._ensureMaterialized();
    const [lhd3, ldat] = this._ensureAnimated();
    const ldatItem = buildParallelLdatItem(this._keyframeItemType());
    const kf = new Keyframe<KeyframeValue<V>>({ _ldatItem: ldatItem, _frameRate: frameRate });
    kf._bindProperty(this);
    kf._setTimeUnits(this._keyframeUnitsAt(time));
    ldat.items.push(ldatItem);
    this.keyframes.push(kf);
    setLhd3Count(lhd3, 1, LHD3_BLOCK_KEYFRAMES);
    kf._value = template;
    this._value = null;
    if (typeof value === "string") {
      template.text = value;
    } else if (value instanceof TextDocument) {
      template.text = value.text;
    }
    this._linkKeyframes();
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
  _addTextKey(time: number, value: _ValueType | string | typeof _USE_VALUE = _USE_VALUE): number {
    if (this._keyframeInner() == null || !this.keyframes?.length) {
      return this._animateStaticText(time, value);
    }
    const [lhd3, ldat] = this._ensureAnimated();
    const frameRate = this._keyframeFrameRate();
    const nearest = this.nearestKeyIndex(time);
    const template = this.keyframes[nearest].value;
    if (!(template instanceof TextDocument)) {
      throw new NotImplementedError("text keyframe value is not a TextDocument");
    }
    const docArray = cosGet(template._cosData, "1", "1");
    const newDoc = deepcopy(cosAt(docArray, nearest));

    const ldatItem = buildParallelLdatItem(this._keyframeItemType());
    const kf = new Keyframe<KeyframeValue<V>>({ _ldatItem: ldatItem, _frameRate: frameRate });
    kf._bindProperty(this);
    kf._setTimeUnits(this._keyframeUnitsAt(time));
    const [idx, exists] = this._keyframeInsertIndex(kf.timeUnits);
    if (exists) return idx;
    this._ensureMaterialized();
    ldat.items.splice(idx, 0, ldatItem);
    cosInsert(docArray, idx, newDoc);
    this.keyframes.splice(idx, 0, kf);
    const td = this._buildTextView(newDoc, template);
    kf._value = td;
    if (typeof value === "string") {
      td.text = value;
    } else if (value instanceof TextDocument) {
      td.text = value.text;
    } else {
      // The text setter above already re-serializes the COS blob; when
      // no text was supplied, propagate the structural insert ourselves.
      td._propagateCos();
    }
    setLhd3Count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    this._linkInsertedKey(idx);
    return idx;
  }

  /**
   * Remove a Source Text keyframe (its COS document + header item).
   *
   * The per-keyframe box-frame / glyph caches are left untouched -
   * After Effects recomputes them on open.
   */
  _removeTextKey(keyIndex: number): void {
    const [lhd3, ldat] = this._ensureAnimated();
    const removed = this.keyframes[keyIndex].value;
    if (!(removed instanceof TextDocument)) {
      throw new NotImplementedError("text keyframe value is not a TextDocument");
    }
    const docArray = cosGet(removed._cosData, "1", "1");
    this._ensureMaterialized();
    ldat.items.splice(keyIndex, 1);
    if (keyIndex < cosLen(docArray)) cosPopAt(docArray, keyIndex);
    this.keyframes.splice(keyIndex, 1);
    setLhd3Count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    removed._propagateCos();
    this._linkKeyframes();
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
  _materializeParallelContainer(kind: ParallelKind): ListChunk {
    if (this.matchName === "ADBE Mask Shape") {
      // A path-less mask keys the default full-frame rectangle it
      // stands for, which materializing writes (`_ensureMaterialized`).
      this._ensureMaterialized();
      const container = this._kfValueContainer;
      assert(container != null);
      return container;
    }
    if (!kind.canMaterializeWrapper || kind.containerType == null) {
      throw new NotImplementedError(`animating a static ${literal(this.matchName)} property is not yet supported`);
    }
    // Materialize while the bare tdbs is still the property's body in
    // the parent tdgp, so canonical repositioning can anchor it.
    this._ensureMaterialized();
    const parent = this.parentProperty;
    assert(parent != null && parent._tdgp != null);
    const chunks = parent._tdgp.chunks;
    const container = new ListChunk({ listType: kind.containerType, chunks: [] });
    let wrapper = this._wrapper;
    if (wrapper == null) {
      wrapper =
        chunks.find((c): c is ListChunk => c instanceof ListChunk && c.chunks.some((cc) => cc === this._tdbs)) ?? null;
    }
    if (wrapper != null) {
      // The wrapper exists but has no value container: add it after
      // the tdbs.
      wrapper.chunks.splice(indexByIdentity(wrapper.chunks, this._tdbs) + 1, 0, container);
    } else if (chunks.some((c) => c === this._tdbs)) {
      wrapper = new ListChunk({ listType: kind.wrapperType, chunks: [this._tdbs, container] });
      chunks[indexByIdentity(chunks, this._tdbs)] = wrapper;
      // AE writes the unnamed sentinel into tdsn when it wraps the
      // property (synthesis seeds the auto-name; a pristine
      // orientation stores its real name).
      if (this._nameUtf8 != null) this._nameUtf8.value = TDSN_SENTINEL;
      kind.onWrap(this);
    } else {
      throw new NotImplementedError(`animating a static ${literal(this.matchName)} property is not yet supported`);
    }
    this._wrapper = wrapper;
    this._kfValueContainer = container;
    return container;
  }

  /**
   * Add a keyframe to a complex (parallel-container) property.
   *
   * When `value` is omitted, the value is taken from the kind's
   * `heldValue` (interpolated for orientation, held otherwise).
   */
  _addParallelKey(time: number, kind: ParallelKind, value: _ValueType | typeof _USE_VALUE = _USE_VALUE): number {
    if (kind === TEXT_KIND) return this._addTextKey(time, value);
    // Check the time and a given value before building the container:
    // that build materializes a fresh mask's default path, and a
    // rejected call must leave the file untouched.
    validateF8(time);
    const units = this._keyframeUnitsAt(time);
    _checkTimeUnits(units);
    if (value !== _USE_VALUE) kind.buildValueChunk(this, kind.coerce(value));
    let container = this._kfValueContainer;
    if (container == null) container = this._materializeParallelContainer(kind);
    const frameRate = this._keyframeFrameRate();
    // Resolve the held value before _ensure_animated: for a static
    // orientation it reads the cdat that the swap removes.
    let newValue = value === _USE_VALUE ? kind.heldValue(this, time) : value;
    newValue = kind.coerce(newValue);
    const ldatItem = kind.buildHeaderItem(newValue);
    const valueChunk = kind.buildValueChunk(this, newValue);

    const kf = new Keyframe<KeyframeValue<V>>({ _ldatItem: ldatItem, _frameRate: frameRate });
    kf._bindProperty(this);
    kf._setTimeUnits(units);
    const [idx, exists] = this._keyframeInsertIndex(kf.timeUnits);
    if (exists) return idx;
    const wasStatic = !this.keyframes?.length;
    this._ensureMaterialized();
    const [lhd3, ldat] = this._ensureAnimated();
    ldat.items.splice(idx, 0, ldatItem);
    this.keyframes.splice(idx, 0, kf);
    if (wasStatic && container.chunks?.length > 0) {
      // A static property's container already holds its single value
      // chunk; the first keyframe takes its place.
      container.chunks[0] = valueChunk;
    } else {
      container.chunks.splice(idx, 0, valueChunk);
    }
    setLhd3Count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    // The header item already carries the value (`buildHeaderItem`) and
    // the container chunk is inserted above, so set the shadow directly:
    // the public `kf.value` setter would re-route complex kinds back into
    // the container write path, rebuilding the just-inserted chunk.
    kf._value = _ownList(newValue);
    // Re-bind the keyframe's model to the chunk just inserted (when the
    // kind wraps); new_value (held or user-supplied) is backed by a
    // different chunk, so edits to it would never reach the serialized
    // keyframe.
    const wrapped = kind.wrapValueChunk(this, valueChunk);
    if (wrapped != null) kf._value = wrapped;
    kind.bindKeyframe(kf._value, kf);
    if (wasStatic) {
      // Match the parsers: an animated shape keeps `value` aliased to
      // the first keyframe's Shape; other kinds read through keyframes.
      this._value = kind.aliasesStaticValue ? kf._value : null;
    }
    this._linkInsertedKey(idx);
    if (!wasStatic && this.isInterpolationTypeValid(KeyframeInterpolationType.BEZIER)) {
      this._typeNewParallelKey(kf);
    }
    return idx;
  }

  /**
   * Give a keyframe `addKey` inserted on a parallel kind AE's types.
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
  _typeNewParallelKey(kf: Keyframe): void {
    const bezier = KeyframeInterpolationType.BEZIER;
    const hold = KeyframeInterpolationType.HOLD;
    const sides = [
      kf._prev != null ? kf._prev.outInterpolationType : null,
      kf._next != null ? kf._next.inInterpolationType : null,
    ].filter((side) => side != null);
    if (sides.includes(bezier)) {
      kf.inInterpolationType = bezier;
      kf.outInterpolationType = bezier;
      kf._ldatItem.temporalContinuous = true;
      const data = kf._ldatItem.kfData as KfPosition;
      const speed = sides.length === 2 ? 1.0 : 0.0;
      data.inSpeed = speed;
      data.outSpeed = speed;
      data.inInfluence = _DEFAULT_INFLUENCE / 100.0;
      data.outInfluence = _DEFAULT_INFLUENCE / 100.0;
      return;
    }
    kf.inInterpolationType = sides[0];
    kf.outInterpolationType = sides.includes(hold) ? hold : KeyframeInterpolationType.LINEAR;
  }

  /** Remove a keyframe from a complex (parallel-container) property. */
  _removeParallelKey(keyIndex: number, kind: ParallelKind): void {
    if (kind === TEXT_KIND) {
      this._removeTextKey(keyIndex);
      return;
    }
    const [lhd3, ldat] = this._ensureAnimated();
    const container = this._kfValueContainer;
    this._ensureMaterialized();
    ldat.items.splice(keyIndex, 1);
    this.keyframes.splice(keyIndex, 1);
    if (container != null && keyIndex < container.chunks.length) {
      container.chunks.splice(keyIndex, 1);
    }
    setLhd3Count(lhd3, this.keyframes.length, LHD3_BLOCK_KEYFRAMES);
    this._linkKeyframes();
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
  _deanimateParallel(kind: ParallelKind): void {
    const removed = this.keyframes[0];
    const removedValue = removed._storedValue;
    this._ensureMaterialized();
    const inner = this._keyframeInner();
    this.keyframes.splice(0, 1);
    this._linkKeyframes();
    const container = this._kfValueContainer;
    if (!kind.keepsValueOnRevert && container != null && container.chunks?.length > 0) {
      container.chunks.splice(0, 1);
    }
    const cdat = kind.staticCdat(removedValue);
    this._value = kind.keepsValueOnRevert ? removedValue : null;
    this._staticTdb4(removed._ldatItem);
    const chunks = this._tdbs.chunks;
    if (inner != null) {
      chunks[indexByIdentity(chunks, inner)] = cdat;
    } else {
      chunks.splice(indexByIdentity(chunks, this._tdb4) + 1, 0, cdat);
    }
    this._cdat = cdat;
  }

  /**
   * Set the property's value at `time`, adding a keyframe if needed.
   *
   * If a keyframe already exists at `time` its value is replaced;
   * otherwise a new keyframe is created (via {@link addKey}). Matches
   * ExtendScript `Property.setValueAtTime()`.
   *
   * time: The composition time, in seconds.
   * new_value: The value to set at that time.
   */
  setValueAtTime(time: number, newValue: PropertyValue | string): void;
  setValueAtTime(time: number, newValue: _ValueType): void {
    this._rejectCurvesWrite();
    validateNumber(time);
    if (this._separationFollowers() != null) {
      // AE 2026 rejects this on a separated leader for the same reason
      // `setValue` is rejected: the followers hold the animation.
      throw new ValueError(
        `cannot set a value on ${literal(this.matchName)} while its ` +
          "dimensions are separated; key its X / Y / Z followers " +
          "instead (getSeparationFollower)",
      );
    }
    const kind = this._parallelKind();
    if (kind != null) {
      this._setParallelValueAt(time, newValue, kind);
      return;
    }
    const [idx, exists] = this._keyframeInsertIndex(this._keyframeUnitsAt(time));
    if (exists) {
      this.keyframes[idx].value = newValue;
      return;
    }
    this._addKey(time, newValue);
  }

  /**
   * Set / replace the value at `time` for a complex property.
   *
   * Unlike numeric properties, the value lives in the parallel
   * container, so an existing key's value chunk is rebuilt rather than
   * written through a descriptor.
   */
  _setParallelValueAt(time: number, value: _ValueType, kind: ParallelKind): void {
    const targetUnits = this._keyframeUnitsAt(time);
    if (kind === TEXT_KIND) {
      const newText = value instanceof TextDocument ? value.text : value;
      for (const kf of this.keyframes) {
        if (kf.timeUnits === targetUnits) {
          const td = kf.value;
          if (td instanceof TextDocument && typeof newText === "string") {
            // The text setter already re-serializes the COS blob.
            td.text = newText;
            this._ensureMaterialized();
          }
          return;
        }
      }
      this._addTextKey(time, value);
      return;
    }
    value = kind.coerce(value);
    for (const kf of this.keyframes) {
      if (kf.timeUnits === targetUnits) {
        this._writeParallelKfValue(kf, value, kind);
        return;
      }
    }
    this._addParallelKey(time, kind, value);
  }

  /**
   * Persist `value` into an existing complex keyframe's container
   * chunk and mirrored header item, then rebind the keyframe model.
   *
   * Shared by `setValueAtTime` (targeting an existing key) and the
   * `Keyframe.value` setter (BUG 3): a complex keyframe's real value
   * lives in the parallel container, so writing through `kfData`
   * alone never reaches the serialized form.
   */
  _writeParallelKfValue(kf: Keyframe, value: _ValueType, kind: ParallelKind): void {
    kind.updateHeaderItem(kf._ldatItem, value);
    const container = this._kfValueContainer;
    if (container != null) {
      let i: number;
      try {
        i = indexByIdentity(this.keyframes, kf);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        i = -1;
      }
      if (0 <= i && i < container.chunks.length) {
        const valueChunk = kind.buildValueChunk(this, value);
        container.chunks[i] = valueChunk;
        // Re-bind the keyframe's model to the chunk actually
        // inserted (mirrors `_addParallelKey`); `value` is backed
        // by a different chunk, so editing the keyframe's value
        // afterwards would otherwise reach the caller's chunk -
        // corrupting any other keyframe that shares it.
        const wrapped = kind.wrapValueChunk(this, valueChunk);
        kf._value = wrapped ?? _ownList(value);
      } else {
        kf._value = _ownList(value);
      }
    } else {
      kf._value = _ownList(value);
    }
    kind.bindKeyframe(kf._value, kf);
    this._ensureMaterialized();
  }

  /**
   * Set values at multiple times, adding keyframes as needed.
   *
   * Matches ExtendScript `Property.setValuesAtTimes()`.
   *
   * times: Composition times, in seconds.
   * new_values: Values to set, one per entry in `times`.
   *
   * ValueError: If `times` and `newValues` differ in length.
   */
  setValuesAtTimes(times: number[], newValues: (PropertyValue | string)[]): void;
  setValuesAtTimes(times: number[], newValues: _ValueType[]): void {
    if (times.length !== newValues.length) {
      throw new ValueError("times and newValues must have the same length");
    }
    // Every entry is checked before the first is applied, so a bad one
    // rejects the whole call instead of leaving the earlier keys added.
    validateSequence({})(times);
    for (const value of newValues) _validateKeyValue(this, value);
    for (let i = 0; i < times.length; i++) {
      this.setValueAtTime(times[i], newValues[i]);
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
  get _startTimeOffset(): number {
    return this._containingLayer._timeOrigin;
  }

  /**
   * Composition seconds per second of the owning layer's own time.
   *
   * `layer.stretch / 100`, signed: a negative stretch plays the layer
   * backwards, so its keyframes run down the composition timeline.
   */
  get _timeStretch(): number {
    let stretch: number;
    try {
      stretch = this._containingLayer.stretch;
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
  get _layerTimebase(): number {
    const comp = this._owningComp();
    if (comp == null) return 0.0;
    const base = comp._cdta.internalTimebase;
    if (base === 0) return 0.0;
    return layerTimebase(base, this._timeStretch);
  }

  /**
   * The composition this property belongs to.
   *
   * `_composition` is unset on a freshly synthesized property, whose
   * comp is only reachable by walking up to the layer.
   */
  _owningComp(): CompItem | null {
    const comp = this._composition;
    if (comp != null) return comp;
    let node: PropertyBase | null = this.parentProperty;
    while (node != null) {
      const found = "_containingComp" in node ? (node._containingComp as CompItem) : null;
      if (found != null) return found;
      node = node.parentProperty;
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
  _applyEffectScale(values: number[], kw: { invert?: boolean } = {}): number[] {
    const { invert = false } = kw;
    const scale = this._effectScale;
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
  get _effectScale(): number[] | null {
    // Allow explicit override via __dict__ (e.g. from tests).
    if (this._effectScaleDict != null) {
      const result: number[] | null = this._effectScaleDict.value;
      return result;
    }

    let scale: number[] | null = null;

    if (this.matchName === "ADBE Anchor Point") {
      // Only footage/comp layers normalize the anchor to source size;
      // source-less layers (shape, text, null) store it in raw pixels.
      const layer = this._containingLayer;
      if (layer._sourceItem != null) {
        const size = layer._pixelSize;
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
      (this.propertyControlType === PropertyControlType.TWO_D ||
        this.propertyControlType === PropertyControlType.THREE_D) &&
      this._isInEffect()
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
      // comp/layer size pairs). An adjustment layer normalizes against
      // its composition (`Layer._effect_point_size`).
      let size: [number, number] | null;
      try {
        size = this._containingLayer._effectPointSize;
      } catch (e) {
        // an EfdG definition: no layer yet
        if (!(e instanceof ValueError)) throw e;
        size = null;
      }
      if (size != null) {
        scale = [...size];
        if (this.propertyControlType === PropertyControlType.THREE_D) scale.push(size[1]);
      }
    }

    return scale;
  }

  set _effectScale(value: number[] | null) {
    if (value != null && (!Array.isArray(value) || value.length < 2)) {
      throw new ValueError("_effect_scale must be a list of at least 2 floats");
    }
    this._effectScaleDict = { value };
  }

  /**
   * The containing layer's pixel dimensions, or `null`.
   *
   * `null` while the property has no layer at all - an effect
   * definition parsed out of `LIST:EfdG` is a free-standing template,
   * so there is nothing to normalize against yet.
   */
  _layerPixelSize(): [number, number] | null {
    try {
      return this._containingLayer._pixelSize;
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      return null;
    }
  }

  static {
    // ---- Chunk-backed field descriptors (ChunkField class attributes) ----
    descriptor(this, "dimensions", new ChunkField("_tdb4", "dimensions", { default: 1, readOnly: true }));
    descriptor(this, "_animated", new ChunkField("_tdb4", "animated"));
    descriptor(this, "_color", new ChunkField("_tdb4", "color"));
    descriptor(this, "_integer", new ChunkField("_tdb4", "integer"));
    descriptor(this, "_noValue", new ChunkField("_tdb4", "noValue"));
    descriptor(this, "_vector", new ChunkField("_tdb4", "vector"));
    // When `True`, the property's X/Y ratio is locked (the constrain
    // proportions switch of a Scale or Mask Feather; `True` on any property
    // without one). Read-only.
    descriptor(this, "lockedRatio", new ChunkField("_tdsb", "ratioUnlinked", { transform: (v) => !v, readOnly: true }));
    descriptor(this, "_isSpatialRaw", new ChunkField("_tdb4", "isSpatial"));
  }
}

/** Revert a separation follower to its dead, unserialized state. */
export function _deactivateFollower(follower: Property): void {
  // Its chunks stop being written and its value goes back to the 0 AE reports
  // for an inactive follower (measured: AE's own export of a never-separated
  // layer gives X / Y / Z = 0 even for a position of [960, 540, 0]). Without
  // the value reset the model keeps reporting the separated numbers while the
  // file - and any re-parse of it - reads 0.
  follower.removeAllKeys();
  follower._revertToSynthetic();
  follower._value = 0.0;
}

/** Per-dimension `(v0, v1)` pairs for the segment, or `null` if not numeric. */
export function _segmentComponents(prevKf: Keyframe, nextKf: Keyframe): [number[][], number] | null {
  const v0 = prevKf._storedValue;
  const v1 = nextKf._storedValue;
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
 * - `enabled`, `minValue`/`maxValue` (hence `hasMin`/`hasMax`),
 * `isModified`, `isSpatial`, `unitsText`, `canVaryOverTime` and
 * `canSetExpression` - reflects the Essential Graphics *source* property
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
  declare _ovSrc: Property | null;
  declare _ovCtrlName: string | null;

  /**
   * The resolved source `Property`, or `null` when it does not resolve
   * (e.g. a Media Replacement leaf whose source is an `AVLayer`). Cached.
   */
  _overrideSource(): Property | null {
    const cached = this._ovSrc !== undefined ? this._ovSrc : _UNSET;
    if (cached !== _UNSET) return cached;
    const src = this.essentialPropertySource;
    const resolved = src instanceof Property ? src : null;
    this._ovSrc = resolved;
    return resolved;
  }

  /**
   * The name of the override leaf's Essential Graphics controller, or
   * `null` when it does not resolve. Cached. This is the display name AE
   * shows for the override - the leaf's own `tdsn` may be empty.
   */
  _overrideControllerName(): string | null {
    const cached = this._ovCtrlName !== undefined ? this._ovCtrlName : _UNSET;
    if (cached !== _UNSET) return cached;
    const controller = resolveEssentialPropertyController(this);
    const name = controller != null ? controller.name : null;
    this._ovCtrlName = name;
    return name;
  }

  get name(): string {
    const ctrlName = this._overrideControllerName();
    return ctrlName != null ? ctrlName : super.name;
  }

  set name(value: string) {
    Reflect.set(PropertyBase.prototype, "name", value, this);
  }

  get minValue(): number | number[] | null {
    const src = this._overrideSource();
    return src != null ? src.minValue : super.minValue;
  }

  get maxValue(): number | number[] | null {
    const src = this._overrideSource();
    return src != null ? src.maxValue : super.maxValue;
  }

  get isModified(): boolean {
    const src = this._overrideSource();
    if (src != null) return !_valuesEqual(this.value, src.value);
    return super.isModified;
  }

  get isSpatial(): boolean {
    const src = this._overrideSource();
    return src != null ? src.isSpatial : super.isSpatial;
  }

  get unitsText(): string {
    const src = this._overrideSource();
    return src != null ? src.unitsText : super.unitsText;
  }

  get canVaryOverTime(): boolean {
    const src = this._overrideSource();
    return src != null ? src.canVaryOverTime : super.canVaryOverTime;
  }

  get canSetExpression(): boolean {
    const src = this._overrideSource();
    return src != null ? src.canSetExpression : super.canSetExpression;
  }

  /**
   * Inherit the source parameter's denormalization scale.
   *
   * An override leaf stores its value in the raw 0-1 form AE keeps, but
   * the leaf is not inside an effect, so its own `_effectScale` is `null`
   * and the value would stay normalized. Borrowing the source's scale puts
   * `value` in the same units the source reports (e.g. source-comp pixels
   * for a point control), matching ExtendScript and making `isModified`
   * compare like for like. `null` for non-point sources and for
   * media-replacement overrides (whose source is an `AVLayer`, not a
   * `Property`), which fall back to the base (also `null`).
   */
  get _effectScale(): number[] | null {
    if (this._effectScaleDict != null) {
      const result: number[] | null = this._effectScaleDict.value;
      return result;
    }
    const src = this._overrideSource();
    if (src != null) return src._effectScale;
    return super._effectScale;
  }

  set _effectScale(value: number[] | null) {
    if (value != null && (!Array.isArray(value) || value.length < 2)) {
      throw new ValueError("_effect_scale must be a list of at least 2 floats");
    }
    this._effectScaleDict = { value };
  }
}

// `enabled` is a ChunkField descriptor on PropertyBase (declared as a field), so TS
// cannot express the override as a class accessor.
Object.defineProperty(_EssentialOverrideProperty.prototype, "enabled", {
  configurable: true,
  enumerable: false,
  get(this: _EssentialOverrideProperty): boolean {
    const src = this._overrideSource();
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
export function _findOrCreateWrapperFolder(project: Project): FolderItem {
  const root = project.rootFolder;
  for (const item of project.items.values()) {
    if (item instanceof _folder.FolderItem && item.name === "Media Replacement Comps" && item.parentFolder === root) {
      return item;
    }
  }
  return root.addFolder("Media Replacement Comps");
}

/**
 * The placed footage's basename, made unique against existing item names
 * with AE's ` N` scheme (bare if free, else the first free integer \>= 2).
 */
export function _uniqueWrapperSuffix(footage: FootageItem, project: Project): string {
  const base = _stripSequenceBasename(footage.name);
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
export function _stripSequenceBasename(name: string): string {
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return stem.replace(/[ _]?\[\p{Nd}+-\p{Nd}+\](?=\n?$)/u, "");
}
