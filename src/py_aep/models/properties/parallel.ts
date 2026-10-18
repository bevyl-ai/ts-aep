/**
 * Per-kind descriptors for complex (parallel-container) properties.
 *
 * Orientation, marker, shape, gradient and text properties store their
 * per-keyframe values outside the keyframe `ldat` items, in a sibling
 * container inside a wrapper LIST (`otst`/`otky`, `mrst`/`mrky`,
 * `om-s`/`omks`, `GCst`/`GCky`, `btds`/btdk COS). The kinds differ in a
 * small set of facts and conversions; each {@link ParallelKind} subclass
 * centralizes one kind so the generic keyframe mutation algorithms in
 * {@link Property | Property} are written once.
 *
 * All binary forms were reverse-engineered from AE 2026 static-vs-keyed
 * output pairs (`aep-compare` ground-truth workflow).
 */

import { b, deferred, NotImplementedError, TypeError_, instanceDict } from "../../../pyrt/index.ts";
import { type Chunk, ListChunk } from "../../binary/chunk.ts";
import { LdatItemType, type LdatItem } from "../../binary/ldat_chunks.ts";
import { buildParallelLdatItem, cloneChunkTree, setOrientationItemValues } from "../../binary/mutations.ts";
import { CdatChunk, OtdaChunk } from "../../binary/property_chunks.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { PropertyControlType, PropertyValueType } from "../../enums/index.ts";
import { Gradient } from "./gradient.ts";
import { MarkerValue } from "./marker.ts";
import { Shape } from "./shape.ts";
import type { Keyframe, PropertyValue } from "./keyframe.ts";
import type { Property } from "./property.ts";

const _marker = deferred<typeof import("../../parsers/marker.ts")>("py_aep/parsers/marker");
const _specializedProperties = deferred<typeof import("../../parsers/specialized_properties.ts")>("py_aep/parsers/specialized_properties");
import { parseGradientXml } from "../../parsers/gradient.ts";

export const _EMPTY_CDAT_PAD = b("\x00\x00\x00\x00");

/**
 * Descriptor for one complex property kind. Stateless singleton.
 *
 * Subclasses override the class attributes and the conversions that
 * differ for their kind; the defaults implement the most common
 * behavior (held value, no model wrapping, empty static cdat).
 */
export class ParallelKind {
  // Instance fields, not statics: subclasses override them and Python code
  // reads them through the kind instance.
  declare name: string;

  /** The wrapper LIST type holding the tdbs + value container. */
  declare wrapperType: string;

  /**
   * The per-keyframe value container LIST type (null for text,
   * whose values live in the shared btdk COS blob).
   */
  declare containerType: string | null;

  /** The ldat item type of the keyframe header entries. */
  declare headerItemType: LdatItemType;

  /**
   * Whether the container keeps the removed keyframe's value chunk
   * as the static value when the last keyframe is removed (markers
   * have no static value).
   */
  keepsValueOnRevert: boolean = true;

  /**
   * Whether `Property.value` stays aliased to the first keyframe's
   * model after animating (matches the shape parser).
   */
  aliasesStaticValue: boolean = false;

  /**
   * The speed AE reports for a LINEAR side of this kind, if its value
   * has no scalar magnitude for a speed to be a rate OF. `null` means the
   * speed is a real rate and gets measured from the segment.
   */
  linearEaseSpeed: number | null = null;

  /**
   * Whether the wrapper subtree can be created from scratch when the
   * binary stores nothing for the property.
   */
  canMaterializeWrapper: boolean = false;

  /**
   * The value a new keyframe takes at `time` when none is given.
   *
   * Most kinds cannot be interpolated: hold the nearest existing
   * keyframe's value, or the static value.
   */
  heldValue(prop: Property, time: number): PropertyValue {
    if (!prop.keyframes?.length) {
      return prop._value;
    }
    return prop.keyframes[prop.nearestKeyIndex(time)].value;
  }

  /** Normalize a user-supplied value to the kind's value object. */
  coerce(value: PropertyValue): PropertyValue {
    return value;
  }

  /** Build the parallel-container value chunk holding `value`. */
  buildValueChunk(prop: Property, value: PropertyValue): Chunk {
    throw new NotImplementedError();
  }

  /**
   * Wrap a freshly built value chunk as its model view, or null.
   *
   * The returned model reads and writes `value_chunk` directly, so
   * a newly added keyframe can be edited in place (the source model
   * passed to `build_value_chunk` is backed by a different chunk).
   */
  wrapValueChunk(prop: Property, valueChunk: Chunk): PropertyValue {
    return null;
  }

  /** Attach kind-specific back-references after a value is set. */
  bindKeyframe(value: PropertyValue, kf: Keyframe): void {}

  /** Build the keyframe header ldat item for `value`. */
  buildHeaderItem(value: PropertyValue): LdatItem {
    return buildParallelLdatItem(this.headerItemType);
  }

  /** Refresh value data mirrored into an existing header item. */
  updateHeaderItem(item: LdatItem, value: PropertyValue): void {}

  /** The cdat AE writes when the property reverts to static. */
  staticCdat(removedValue: PropertyValue): CdatChunk {
    return new CdatChunk({ pad: _EMPTY_CDAT_PAD });
  }

  /** Kind-specific tdb4 / model fixups after wrapping a bare tdbs. */
  onWrap(prop: Property): void {}
}

export class _OrientationKind extends ParallelKind {
  name = "orientation";
  wrapperType = "otst";
  containerType = "otky";
  headerItemType = LdatItemType.orientation;
  canMaterializeWrapper = true;
  linearEaseSpeed = 1.0;

  heldValue(prop: Property, time: number): PropertyValue {
    // Orientation values interpolate numerically.
    return prop.valueAtTime(time);
  }

  buildValueChunk(prop: Property, value: PropertyValue): Chunk {
    const vals = Array.isArray(value) ? value : [0.0, 0.0, 0.0];
    return new OtdaChunk({ values: vals });
  }

  buildHeaderItem(value: PropertyValue): LdatItem {
    return buildParallelLdatItem(
      this.headerItemType,
      Array.isArray(value) ? value : null,
    );
  }

  updateHeaderItem(item: LdatItem, value: PropertyValue): void {
    if (Array.isArray(value)) {
      setOrientationItemValues(item, value);
    }
  }

  staticCdat(removedValue: PropertyValue): CdatChunk {
    // Inside an otst the cdat doubles are little-endian and hold the
    // actual angles.
    if (Array.isArray(removedValue)) {
      return new CdatChunk({ values: removedValue.slice(0, 3), is_le: true });
    }
    return new CdatChunk({ pad: _EMPTY_CDAT_PAD });
  }

  /**
   * Override parsed metadata with what ExtendScript reports for
   * orientation (angle dial, 3D spatial vector), regardless of the
   * binary tdb4 values. Shared by `parse_orientation` and `on_wrap`.
   */
  applyModelMetadata(prop: Property): void {
    prop._property_control_type = PropertyControlType.ANGLE;
    prop._property_value_type = PropertyValueType.ThreeD_SPATIAL;
    instanceDict(prop).set("dimensions", 3);
    instanceDict(prop).set("_vector", true);
  }

  onWrap(prop: Property): void {
    prop._tdb4.dimensions = 1;
    // 0x6000 (24 fps) is the fallback when the containing comp is
    // unknown; _ensure_time_base overrides it with the comp's timebase.
    prop._tdb4._time_base = 0x6000;
    prop._ensure_time_base();
    this.applyModelMetadata(prop);
  }
}

export class _MarkerKind extends ParallelKind {
  name = "marker";
  wrapperType = "mrst";
  containerType = "mrky";
  headerItemType = LdatItemType.marker;
  keepsValueOnRevert = false;
  canMaterializeWrapper = true;

  heldValue(prop: Property, time: number): PropertyValue {
    return new MarkerValue();
  }

  coerce(value: PropertyValue | string): PropertyValue {
    if (typeof value === "string") {
      return new MarkerValue(value);
    }
    return value;
  }

  buildValueChunk(prop: Property, value: PropertyValue): Chunk {
    if (!(value instanceof MarkerValue)) {
      throw new TypeError_("marker value must be a MarkerValue or str comment");
    }
    // Clone every embedded chunk: a caller may reuse one MarkerValue for
    // several keyframes, and the model's chunks may already be bound to
    // another Nmrd. Sharing them would alias one set of bytes into two
    // markers (an edit or a param splice on one corrupts the other). The
    // keyframe's own editable model is rebound to these clones in
    // `wrap_value_chunk` (mirrors `_GradientKind`).
    const source: Chunk[] = [
      value._nmhd,
      value._comment_utf8,
      value._chapter_utf8,
      value._url_utf8,
      value._frame_target_utf8,
      value._cue_point_name_utf8,
      ...value._param_utf8s,
    ];
    return new ListChunk({ list_type: "Nmrd", chunks: source.map((c) => cloneChunkTree(c)) });
  }

  wrapValueChunk(prop: Property, valueChunk: ListChunk): PropertyValue {
    return _marker().parseMarker(valueChunk);
  }

  bindKeyframe(value: PropertyValue, kf: Keyframe): void {
    if (value instanceof MarkerValue) {
      value._keyframe = kf;
    }
  }

  onWrap(prop: Property): void {
    const t = prop._tdb4;
    t.dimensions = 1;
    t._time_base = 0x6000;
    t._type_flags = 0x08;
    t._no_value_flags = 0x01;
    t._property_category = 0;
    t._spatial_static_flags = 0x01;
    t._cvot_flags = 0x04;
    t._value_hint_type = 1;
    t._value_hint_flag = 0;
    t._spatial_marker = false;
  }
}

export class _ShapeKind extends ParallelKind {
  name = "shape";
  wrapperType = "om-s";
  containerType = "omks";
  headerItemType = LdatItemType.no_value;
  aliasesStaticValue = true;
  linearEaseSpeed = 1.0;

  /**
   * A path interpolates: a key added between two keys takes the
   * in-between shape, not a copy of the nearest key (AE 2026: added at
   * 0.7 s on a 0 -\> 2 s LINEAR segment, [[7, 3.5], [117.5, 0],
   * [107, 114]]).
   */
  heldValue(prop: Property, time: number): PropertyValue {
    if (!prop.keyframes?.length) {
      return prop._value;
    }
    return prop.valueAtTime(time);
  }

  buildValueChunk(prop: Property, value: PropertyValue): Chunk {
    if (!(value instanceof Shape)) {
      throw new TypeError_("shape value must be a Shape");
    }
    return prop._build_shap_chunk(value);
  }

  wrapValueChunk(prop: Property, valueChunk: ListChunk): PropertyValue {
    return _specializedProperties()._parseShapeShap(
      valueChunk,
      prop._containing_layer,
      prop.matchName === "ADBE Mask Shape" ? prop : null,
    );
  }
}

export class _GradientKind extends ParallelKind {
  name = "gradient";
  wrapperType = "GCst";
  containerType = "GCky";
  headerItemType = LdatItemType.no_value;
  canMaterializeWrapper = true;

  buildValueChunk(prop: Property, value: PropertyValue): Chunk {
    if (value == null) {
      // A never-edited gradient has no parsed Gradient model;
      // AE's default gradient seeds the first keyframe.
      return new Gradient()._utf8;
    }
    if (!(value instanceof Gradient)) {
      throw new TypeError_("gradient value must be a Gradient");
    }
    // Clone the serialized XML so keyframes do not share a chunk.
    return new Utf8Chunk({ value: value._utf8.value });
  }

  wrapValueChunk(prop: Property, valueChunk: Utf8Chunk): PropertyValue {
    return parseGradientXml(valueChunk);
  }

  onWrap(prop: Property): void {
    const t = prop._tdb4;
    t.dimensions = 1;
    t._time_base = 0x6000;
    t._type_flags = 0x08;
    t._no_value_flags = 0x01;
    t._property_category = 0;
    t._spatial_static_flags = 0x07;
    t._cvot_flags = 0xff;
    t._value_hint_type = 0xffff;
    t._value_hint_flag = 0xff;
    t._spatial_marker = true;
  }
}

/**
 * Source Text. Values live in the shared btdk COS blob (one document
 * per keyframe), so the add / remove / animate algorithms are the
 * dedicated text paths on {@link Property}, not the generic container ones.
 */
export class _TextKind extends ParallelKind {
  name = "text";
  wrapperType = "btds";
  containerType = null;
  headerItemType = LdatItemType.marker;
}

export const ORIENTATION_KIND = new _OrientationKind();
export const MARKER_KIND = new _MarkerKind();
export const SHAPE_KIND = new _ShapeKind();
export const GRADIENT_KIND = new _GradientKind();
export const TEXT_KIND = new _TextKind();
