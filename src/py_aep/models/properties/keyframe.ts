import { KeyframeInterpolationType, Label } from "../../enums/index.ts";
import { frame_grid } from "../../binary/composition_chunks.ts";
import { _DEFAULT_INFLUENCE, auto_path_speed, auto_spatial_tangents, auto_temporal_speeds, color_auto_speed, color_distance, linear_path_speed } from "../../resolvers/interpolation.ts";
import { ChunkField } from "../descriptors.ts";
import { TextDocument } from "../text/text_document.ts";
import { validate_bool, validate_int, validate_number, validate_sequence } from "../validators.ts";
import { Gradient } from "./gradient.ts";
import { KeyframeEase } from "./keyframe_ease.ts";
import { MarkerValue } from "./marker.ts";
import { TEXT_KIND } from "./parallel.ts";
import { Shape } from "./shape.ts";
import { KfMultiDimensional, KfPosition, type LdatItem } from "../../binary/ldat_chunks.ts";
import type { Curves } from "./curves.ts";
import type { Property } from "./property.ts";
import {
  ValueError,
  deferred,
  descriptor,
  getattr,
  py_assert,
  repr,
  round,
  zip,
} from "../../../pyrt/index.ts";

const _property = deferred<typeof import("./property.ts")>("py_aep/models/properties/property");

/**
 * Any value a {@link Property} or {@link Keyframe} can hold; which one depends on
 * the property's `property_value_type`. `Property<V>` narrows it per property.
 */
// TYPE_CHECKING: `_ValueType = Union[list[float], float, Curves, Gradient, MarkerValue, Shape, TextDocument, None]`
export type PropertyValue = number[] | number | Curves | Gradient | MarkerValue | Shape | TextDocument | null;
export type _ValueType = PropertyValue;

/**
 * The value a keyframe of a `Property<V>` holds: a stored key always has one,
 * so `null` is dropped; a property of unknown kind keeps the full union.
 */
export type KeyframeValue<V> = 0 extends 1 & V ? PropertyValue : NonNullable<V>;

/** sentinel: read value from _ldat_item */
export const _VALUE_FROM_CHUNK: unique symbol = Symbol("_VALUE_FROM_CHUNK");

/**
 * Reject an interpolation type the owning property cannot use.
 *
 * Hold-only properties (markers, source text, checkbox/dropdown effect
 * params) would otherwise accept a LINEAR/BEZIER byte AE never writes.
 * An unbound keyframe has no property to ask, so it is left alone.
 */
export function _validate_interpolation_type(value: KeyframeInterpolationType, keyframe: Keyframe): void {
  const prop = keyframe._property;
  if (prop == null) return;
  // Raises for an out-of-enum value before the descriptor's own
  // membership check gets a chance to.
  if (!prop.is_interpolation_type_valid(value)) {
    throw new ValueError(
      `${KeyframeInterpolationType.name_of(value)} is not a valid ` +
        `interpolation type for ${repr(prop.name)}.`,
    );
  }
}

/**
 * Keyframe units per second of a composition running at `frame_rate`.
 *
 * AE's own frame grid for the rate (see `frame_grid`), not
 * `frame_rate * 256 * time_scale`: the 16.16 rate and time scale stored
 * in the file are a hair off for a decimal rate (12.3456 fps gave
 * 24691, where AE counts 24692 units per second).
 */
export function _timebase_units(frame_rate: number): number {
  return frame_grid(frame_rate)[0];
}

/** Refuse a keyframe time that does not fit the 32-bit time field. */
export function _check_time_units(units: number): void {
  if (!(-0x80000000 <= units && units <= 0x7fffffff)) {
    throw new ValueError(
      `keyframe time out of supported range: ${units} units ` +
        `does not fit the 32-bit keyframe time field`,
    );
  }
}

/**
 * Reject a roving flag After Effects would not accept.
 *
 * AE raises for a non-spatial property ("This property does not have a
 * spatial PropertyValueType"). For the first or last keyframe it silently
 * does nothing and leaves the flag false; py-aep raises instead, so the
 * caller sees the mistake rather than getting a write that appears to
 * succeed and does not.
 */
export function _validate_roving(value: boolean, keyframe: Keyframe): void {
  validate_bool(value);
  if (!value) return;
  const prop = keyframe._property;
  if (prop == null) return;
  if (!prop._has_motion_path) {
    throw new ValueError(
      `roving can only be set on a spatial property, not ${repr(prop.match_name)}`,
    );
  }
  if (keyframe._prev == null || keyframe._next == null) {
    throw new ValueError("the first and last keyframe of a property cannot rove");
  }
}

/**
 * The `Keyframe` object represents a keyframe of a property.
 *
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const position = comp.layers[0].transform.property("ADBE Position");
 * const keyframe = position.keyframes[0];
 * console.log(keyframe.time);
 * ```
 *
 * **Warning:** `Keyframe` object does not exist in ExtendScript API. It has been added
 * for convenience.
 *
 * @typeParam V - The type of {@link Keyframe.value | value}, from the owning `Property<V>`.
 *
 * @example
 */
export class Keyframe<V extends PropertyValue = PropertyValue> {
  /**
   * The "in" interpolation type for the keyframe. Read / Write.
   *
   * Raises `ValueError` if the type is not valid for the owning property
   * (see {@link Property.is_interpolation_type_valid | is_interpolation_type_valid}).
   */
  declare in_interpolation_type: KeyframeInterpolationType;

  /**
   * The label color. Colors are represented by their number (0 for None, or 1
   * to 16 for one of the preset colors in the Labels preferences).
   * Read / Write.
   */
  declare label: Label;

  /**
   * The "out" interpolation type for the keyframe. Read / Write.
   *
   * Raises `ValueError` if the type is not valid for the owning property
   * (see {@link Property.is_interpolation_type_valid | is_interpolation_type_valid}).
   */
  declare out_interpolation_type: KeyframeInterpolationType;

  /**
   * `true` if the keyframe is roving. The first and last keyframe in
   * a property cannot rove. Read / Write.
   *
   * Setting this on a spatial property re-times the run of roving
   * keyframes so the speed the bounding keyframes ask for is held
   * across the whole span.  Editing a spatial keyframe's
   * {@link Keyframe.value | value} or {@link Keyframe.time | time} re-times the
   * adjacent runs automatically.
   *
   * @throws {@link ValueError} When the property is not spatial, or the keyframe is the first or
   *   last in its property.
   */
  declare roving: boolean;

  /**
   * `true` if the keyframe has temporal auto-Bezier interpolation. Temporal
   * auto-Bezier interpolation affects this keyframe only if the keyframe
   * interpolation type is `KeyframeInterpolationType.BEZIER` for both
   * `in_interpolation_type` and `out_interpolation_type`. Read / Write.
   */
  declare temporal_auto_bezier: boolean;

  /**
   * `true` if the keyframe has temporal continuity. Temporal continuity affects
   * this keyframe only if the keyframe interpolation type is
   * `KeyframeInterpolationType.BEZIER` for both `in_interpolation_type` and
   * `out_interpolation_type`. Read / Write.
   *
   * As in After Effects, setting it to `true` turns
   * {@link Keyframe.temporal_auto_bezier | temporal_auto_bezier} off, a temporal
   * auto-Bezier keyframe stays continuous, and setting neither interpolation
   * type to `KeyframeInterpolationType.BEZIER` turns it off.
   */
  declare temporal_continuous: boolean;

  declare _ldat_item: LdatItem;
  declare _frame_rate: number;
  declare _property: Property | null;
  declare _prev: Keyframe | null;
  declare _next: Keyframe | null;
  declare _in_temporal_ease: KeyframeEase[] | null;
  declare _out_temporal_ease: KeyframeEase[] | null;
  declare _value: PropertyValue | typeof _VALUE_FROM_CHUNK;

  constructor(kw: { _ldat_item: LdatItem; _frame_rate: number }) {
    const { _ldat_item, _frame_rate } = kw;
    this._ldat_item = _ldat_item;
    this._frame_rate = _frame_rate;
    this._property = null;
    this._prev = null;
    this._next = null;

    this._in_temporal_ease = null;
    this._out_temporal_ease = null;

    this._value = _VALUE_FROM_CHUNK;
  }

  _on_interpolation_type_set(): void {
    this._settle_temporal_continuous();
    this._retime_roving_runs();
  }

  /**
   * Re-time the property's roving runs after a roving flag, a spatial
   * tangent, or an anchor's interpolation or ease changed: they decide
   * where a run's keys fall (AE 2026 re-times the run on
   * `setInterpolationTypeAtKey` and `setTemporalEaseAtKey`; an out-HOLD
   * anchor packs the run against itself).
   */
  _retime_roving_runs(): void {
    if (this._property != null) {
      this._property._redistribute_roving_keyframes();
    }
  }

  /**
   * Keep temporal continuity consistent with the interpolation types.
   *
   * Measured on AE 2026 (the flags AE saves): continuity needs a BEZIER
   * side - setting both sides to LINEAR / HOLD clears it, one BEZIER
   * side keeps it - and temporal auto-bezier implies it, so AE turns it
   * back on for an auto-bezier key with a BEZIER side. Temporal
   * auto-bezier itself survives any type change.
   */
  _settle_temporal_continuous(): void {
    const bezier = KeyframeInterpolationType.BEZIER;
    if (this.in_interpolation_type !== bezier && this.out_interpolation_type !== bezier) {
      this._ldat_item.temporal_continuous = false;
    } else if (this.temporal_auto_bezier) {
      this._ldat_item.temporal_continuous = true;
    }
  }

  /**
   * Whether the key rides a roving run rather than bounding one: the
   * first and last keys are anchors even when flagged roving.
   */
  get _is_roving_run_key(): boolean {
    return this.roving && this._prev != null && this._next != null;
  }

  /** Set both interpolation types to BEZIER, skipping no-op writes. */
  _force_bezier_both_sides(): void {
    if (this.in_interpolation_type !== KeyframeInterpolationType.BEZIER) {
      this.in_interpolation_type = KeyframeInterpolationType.BEZIER;
    }
    if (this.out_interpolation_type !== KeyframeInterpolationType.BEZIER) {
      this.out_interpolation_type = KeyframeInterpolationType.BEZIER;
    }
  }

  /**
   * Materialize the ease AE derives, and its two companion flags.
   *
   * Setting temporal auto-bezier makes AE rewrite the stored ease to the
   * through-slope with the default influence, force temporal continuity
   * on, and force both interpolation types to BEZIER. Measured on AE
   * 2026; the flag alone left a keyframe carrying ease AE would never
   * pair with it.
   */
  _on_temporal_auto_bezier_set(): void {
    if (!this.temporal_auto_bezier) {
      // AE keeps the derived ease when the flag is cleared.
      return;
    }
    // The raw byte, deliberately not the `temporal_continuous` setter:
    // its hook ties the out speed to the in speed, and the derived ease
    // written below is per-side.
    this._ldat_item.temporal_continuous = true;
    this._force_bezier_both_sides();
    const speeds = this._auto_temporal_speeds();
    if (speeds == null) return;
    this._ensure_ease();
    const pairs: [string, number[], KeyframeEase[] | null][] = [
      ["in", speeds[0], this._in_temporal_ease],
      ["out", speeds[1], this._out_temporal_ease],
    ];
    for (const [direction, values, backing] of pairs) {
      if (backing == null || backing.length !== values.length) continue;
      this._apply_ease(
        values.map((speed) => new KeyframeEase(speed, _DEFAULT_INFLUENCE)),
        direction,
      );
    }
    this._retime_roving_runs();
  }

  /**
   * Force both sides to BEZIER and match the out speed to the in one.
   *
   * Measured on AE 2026 over five in/out interpolation pairings: setting
   * temporal continuity rewrites BOTH interpolation types to BEZIER and
   * then ties the speeds, keeping both influences - `(10, 75) / (90, 25)` becomes `(10, 75) / (10, 25)` whatever the types were
   * beforehand. Forcing BEZIER is what makes the STORED in speed the
   * right one to copy: under LINEAR the getter reports the segment
   * slope instead, and AE reports 10 here, not the slope.
   *
   * Note the spatial equivalent is NOT symmetric: `spatial_continuous`
   * genuinely leaves the tangents alone.
   */
  _on_temporal_continuous_set(): void {
    if (!this.temporal_continuous) {
      // An auto-bezier key stays continuous (AE 2026 turns it back on).
      this._settle_temporal_continuous();
      return;
    }
    // Continuous and auto-bezier are exclusive modes: AE 2026 clears
    // temporal auto-bezier here (the raw byte - its setter would
    // re-derive the ease).
    this._ldat_item.temporal_auto_bezier = false;
    this._force_bezier_both_sides();
    this._ensure_ease();
    const [incoming, outgoing] = [this._in_temporal_ease, this._out_temporal_ease];
    if (incoming == null || outgoing == null) return;
    for (const [out_ease, in_ease] of zip(outgoing, incoming)) {
      out_ease.speed = in_ease.speed;
    }
    this._retime_roving_runs();
  }

  /**
   * Move a raw spatial tangent into the space its value is reported in.
   *
   * An effect point stores both its value and its tangents normalized
   * against the layer, and ExtendScript reports both in pixels. Reading
   * the tangent raw while the value came back resolved left the two in
   * different spaces - a raw -0.5 on a 200-wide layer is AE's -100.
   * `invert` divides instead, for the write path.
   */
  _rescale_tangent(tangent: number[], kw: { invert: boolean }): number[] {
    const { invert } = kw;
    const prop = this._property;
    if (prop == null) return [...tangent];
    return prop._apply_effect_scale(tangent, { invert });
  }

  /** Set the owning property and propagate speed factor to ease. */
  _bind_property(prop: Property): void {
    this._property = prop;
    const factor = prop._speed_factor;
    // Propagate to already-created ease objects
    if (this._in_temporal_ease != null) {
      for (const ease of this._in_temporal_ease) {
        ease._speed_factor = factor;
      }
    }
    if (this._out_temporal_ease != null) {
      for (const ease of this._out_temporal_ease) {
        ease._speed_factor = factor;
      }
    }
  }

  /**
   * Read raw value from the binary chunk data.
   *
   * Returns a scalar for 1-dimensional properties, an array for
   * multi-dimensional or color properties, and `null` when the
   * keyframe type carries no value (e.g. markers).
   */
  _extract_raw_value(): number[] | number | null {
    const kf_data = this._ldat_item.kf_data;
    if (!("value" in kf_data)) return null;
    const values: number[] = [...kf_data.value];
    if (values.length === 1) return values[0];
    return values;
  }

  /**
   * Create in/out temporal ease objects from the binary chunk data.
   *
   * Returns a `[in_ease, out_ease]` pair. Each element is an array of
   * {@link KeyframeEase} objects - one per dimension for
   * multi-dimensional properties, or a single element for scalar /
   * spatial types. Returns `([], [])` when the keyframe type
   * carries no ease data (e.g. markers).
   */
  _create_ease(): [KeyframeEase[], KeyframeEase[]] {
    const kf_data = this._ldat_item.kf_data;
    if (!("in_speed" in kf_data)) return [[], []];

    const factor = this._property != null ? this._property._speed_factor : 1.0;

    let in_ease: KeyframeEase[];
    let out_ease: KeyframeEase[];
    if (kf_data instanceof KfMultiDimensional) {
      in_ease = Array.from({ length: kf_data.in_speed.length }, (_, i) =>
        KeyframeEase._from_binary(kf_data, i, "in", factor),
      );
      out_ease = Array.from({ length: kf_data.out_speed.length }, (_, i) =>
        KeyframeEase._from_binary(kf_data, i, "out", factor),
      );
    } else {
      in_ease = [KeyframeEase._from_binary(kf_data, 0, "in", factor)];
      out_ease = [KeyframeEase._from_binary(kf_data, 0, "out", factor)];
    }
    return [in_ease, out_ease];
  }

  /** Lazily create ease objects on first access. */
  _ensure_ease(): void {
    if (this._in_temporal_ease == null) {
      [this._in_temporal_ease, this._out_temporal_ease] = this._create_ease();
    }
  }

  /**
   * The incoming spatial tangent for the keyframe, if the named
   * property is spatial (that is, the value type is `TwoD_SPATIAL` or
   * `ThreeD_SPATIAL`).
   *
   * - If the property value type is `PropertyValueType.TwoD_SPATIAL`, the
   *   array contains 2 floating-point values.
   * - If the property value type is `PropertyValueType.ThreeD_SPATIAL`, the
   *   array contains 3 floating-point values.
   * - If the property value type is neither of these types, returns `null`.
   */
  get in_spatial_tangent(): number[] | null {
    const kf_data = this._ldat_item.kf_data;
    if (!("in_spatial_tangents" in kf_data)) return null;
    if (this.spatial_auto_bezier) {
      const derived = this._auto_spatial_tangents();
      if (derived != null) {
        return this._rescale_tangent(derived[1], { invert: false });
      }
    }
    return this._rescale_tangent([...kf_data.in_spatial_tangents], { invert: false });
  }

  set in_spatial_tangent(value: number[] | null) {
    if (value == null || this.in_spatial_tangent == null) return;
    validate_sequence({ length: this.in_spatial_tangent.length })(value);
    const kf_data = this._ldat_item.kf_data;
    this._leave_spatial_auto_bezier();
    if ("in_spatial_tangents" in kf_data) {
      kf_data.in_spatial_tangents = this._rescale_tangent(value, { invert: true });
      this._retime_roving_runs();
    }
  }

  /**
   * The outgoing spatial tangent for the keyframe, if the named
   * property is spatial (that is, the value type is `TwoD_SPATIAL` or
   * `ThreeD_SPATIAL`).
   *
   * - If the property value type is `PropertyValueType.TwoD_SPATIAL`, the
   *   array contains 2 floating-point values.
   * - If the property value type is `PropertyValueType.ThreeD_SPATIAL`, the
   *   array contains 3 floating-point values.
   * - If the property value type is neither of these types, returns `null`.
   */
  get out_spatial_tangent(): number[] | null {
    const kf_data = this._ldat_item.kf_data;
    if (!("out_spatial_tangents" in kf_data)) return null;
    if (this.spatial_auto_bezier) {
      const derived = this._auto_spatial_tangents();
      if (derived != null) {
        return this._rescale_tangent(derived[0], { invert: false });
      }
    }
    return this._rescale_tangent([...kf_data.out_spatial_tangents], { invert: false });
  }

  set out_spatial_tangent(value: number[] | null) {
    if (value == null || this.out_spatial_tangent == null) return;
    validate_sequence({ length: this.out_spatial_tangent.length })(value);
    const kf_data = this._ldat_item.kf_data;
    this._leave_spatial_auto_bezier();
    if (value != null && "out_spatial_tangents" in kf_data) {
      kf_data.out_spatial_tangents = this._rescale_tangent(value, { invert: true });
      this._retime_roving_runs();
    }
  }

  /**
   * Turn spatial auto-bezier off before a tangent is written.
   *
   * AE's `setSpatialTangentsAtKey` clears the flag (AE 2026); left on,
   * the derived tangents would keep overriding the written one. The
   * side not written keeps the derived tangent it had.
   */
  _leave_spatial_auto_bezier(): void {
    // Only a spatial keyframe's KfPosition carries the flag.
    const kf_data = this._ldat_item.kf_data;
    if (!(kf_data instanceof KfPosition && kf_data.spatial_auto_bezier)) return;
    const derived = this._auto_spatial_tangents();
    if (derived != null) {
      [kf_data.out_spatial_tangents, kf_data.in_spatial_tangents] = derived;
    }
    kf_data.spatial_auto_bezier = false;
  }

  /**
   * This keyframe plus its immediate neighbours, and its own index.
   *
   * One to three keyframes. The interpolation resolvers clamp at the
   * ends themselves, so a boundary keyframe simply yields a shorter
   * window rather than a special case here.
   */
  _neighbour_window(): [Keyframe[], number] {
    const window = [this._prev, this, this._next].filter(
      (kf): kf is Keyframe => kf != null,
    );
    return [window, this._prev != null ? 1 : 0];
  }

  /**
   * AE's derived tangents for a spatial auto-bezier keyframe.
   *
   * AE recomputes these from the flag and ignores whatever is stored,
   * so its own files legitimately carry stale or zero tangents on an
   * auto-bezier keyframe - reading the chunk back verbatim disagrees
   * with what AE reports for the same file.
   *
   * Derived in the raw chunk space, matching what these accessors
   * return. Returns `null` when the keyframe carries no spatial data.
   */
  _auto_spatial_tangents(): [number[], number[]] | null {
    if (!("in_spatial_tangents" in this._ldat_item.kf_data)) return null;
    const [window, index] = this._neighbour_window();
    // The neighbours are keys of the same spatial property.
    const values = window.map((kf) => [...(kf._ldat_item.kf_data as KfPosition).value]);
    return auto_spatial_tangents(values, index);
  }

  /**
   * AE's derived per-dimension ease speeds for a temporal auto-bezier
   * keyframe, as `(in_speeds, out_speeds)`.
   *
   * Returns `null` when the value is not numeric, so the caller can fall
   * back to the stored ease.
   */
  _auto_temporal_speeds(): [number[], number[]] | null {
    const prop = this._property;
    const kind = prop != null ? prop._parallel_kind() : null;
    if (prop != null && kind != null) {
      // A path and an Orientation are spatial for ExtendScript but have
      // no motion path to measure: AE reports an auto-bezier side at the
      // unit chord slope, like a LINEAR side, and plays it that way
      // (measured on AE 2026 on a mask path and an Orientation key).
      const unit = kind.linear_ease_speed;
      const index = prop._keyframe_index(this);
      if (unit == null || index == null) return null;
      const last = prop.keyframes.length - 1;
      return [[index === 0 ? 0.0 : unit], [index === last ? 0.0 : unit]];
    }
    if (prop != null && prop._color) {
      // One speed along the colour line, like a motion path.
      const [window, at] = this._neighbour_window();
      const speed = color_auto_speed(
        window.map((kf) => kf.value as number[]),
        window.map((kf) => kf._layer_time),
        at,
      );
      return [
        [this._prev == null ? 0.0 : speed],
        [this._next == null ? 0.0 : speed],
      ];
    }
    if (prop != null && prop._has_motion_path) {
      const keyframes = prop.keyframes;
      // A keyframe removed from its property is no longer on its path.
      const index = prop._keyframe_index(this);
      if (index != null) {
        // A motion path carries ONE ease, a speed along the path. AE
        // writes it on both sides; the outward side of an end key is
        // reported as 0, as on any other property.
        const speed = auto_path_speed(keyframes, index, prop._arc_metric);
        return [
          [index === 0 ? 0.0 : speed],
          [index === keyframes.length - 1 ? 0.0 : speed],
        ];
      }
    }

    const as_vector = (keyframe: Keyframe): number[] | null => {
      const value = keyframe.value;
      const is_num = (x: unknown): boolean => typeof x === "number" || typeof x === "boolean";
      if (typeof value === "number" || typeof value === "boolean") return [value];
      if (Array.isArray(value) && value.every(is_num)) {
        return value;
      }
      return null;
    };

    const [window, index] = this._neighbour_window();
    const values = window.map((kf) => as_vector(kf));
    if (!values.every((value) => value != null)) return null;
    const times = window.map((kf) => kf._layer_time);
    return auto_temporal_speeds(values, times, index);
  }

  /**
   * The value of the keyframe. For a 1D property (e.g. Opacity, Rotation),
   * this is a single `float`. For a multi-dimensional property (e.g.
   * Position, Scale), this is a `number[]`. For shape/mask path
   * properties, this is a {@link Shape}. For text properties, this is a
   * {@link TextDocument}. For marker properties, this is a {@link MarkerValue}.
   * For the Curves effect's curves, this is a {@link Curves}. For properties
   * that carry no value, this is `null`.
   */
  get value(): V {
    if (this._property == null) return this._declared(this._stored_value);
    if (this._property._arbs != null) {
      return this._declared(this._property._keyframe_curves(this));
    }
    return this._declared(this._property._mask_inert_z(this._stored_value));
  }

  /** A stored value as the keyframe's declared value type (see `Property._declared`). */
  _declared(value: PropertyValue): V {
    return value as V;
  }

  set value(value: PropertyValue) {
    if (this._property != null) {
      this._property._reject_curves_write();
    }
    if (
      !(
        typeof value === "number" ||
        typeof value === "boolean" ||
        Array.isArray(value) ||
        value instanceof Gradient ||
        value instanceof MarkerValue ||
        value instanceof Shape ||
        value instanceof TextDocument ||
        value == null
      )
    ) {
      throw new ValueError(
        "value must be a number, list of numbers, Gradient, MarkerValue, Shape, TextDocument, or None",
      );
    }
    const prop = this._property;
    if (prop != null) {
      // Reuse the property's value validation (numeric bounds + finite
      // check); it is a no-op for complex value types. Keeps NaN/inf and
      // out-of-range values out of keyframe floats just as `.value=` does.
      _property()._validate_key_value(prop, value);

      // Replacing a TEXT keyframe's value must mutate the EXISTING
      // btdk-wired TextDocument in place (text documents live in the
      // shared btdk COS blob, not a per-keyframe container). Storing a
      // fresh, disconnected TextDocument leaves the real btdk with fewer
      // COS docs than the keyframe count, so AE rejects the file ("error
      // reading text layer from index"). Mirror `_set_parallel_value_at`.
      if (value instanceof TextDocument && prop._parallel_kind() === TEXT_KIND) {
        const current = this.value;
        if (current instanceof TextDocument) {
          current.text = value.text;
          prop._ensure_materialized();
        } else {
          this._value = value;
        }
        return;
      }
    }
    // Complex (parallel-container) properties store their real value in a
    // sibling container chunk (otda / Nmrd / shap / Utf8), not in kf_data;
    // route the write through the property so the container - and any
    // mirrored header bytes - are updated. Text (no container) keeps the
    // shadow path: its documents live in the shared btdk COS blob.
    if (prop != null && prop._kf_value_container != null) {
      const kind = prop._parallel_kind();
      if (kind != null && kind !== TEXT_KIND) {
        prop._write_parallel_kf_value(this, kind.coerce(value), kind);
        return;
      }
    }
    if (prop != null && (typeof value === "number" || Array.isArray(value))) {
      const raw = prop._unresolve_value(value);
      this._write_kf_value(raw);
      this._value = raw;
      prop._redistribute_roving_keyframes();
    } else {
      this._value = value;
    }
  }

  /**
   * The value as stored, before a 2-D layer's Z is reported as 0.
   *
   * Interpolation and ease measurement read this one: AE measures a
   * 2-D layer's motion path with the stored Z too.
   */
  get _stored_value(): _ValueType {
    const val =
      this._value !== _VALUE_FROM_CHUNK ? this._value : this._extract_raw_value();
    if (this._property != null && (typeof val === "number" || Array.isArray(val))) {
      return this._property._resolve_value(val);
    }
    return val;
  }

  /**
   * Cache a value decoded from chunks (parser-only).
   *
   * Unlike the public `value` setter this never writes the
   * parallel value container: the chunks already hold the value,
   * only the in-memory shadow needs filling. Numeric values are
   * stored unresolved, matching `_extract_raw_value`; the write
   * through `_write_kf_value` is a no-op for parallel-kind
   * properties (component-count mismatch) and byte-faithful
   * otherwise.
   */
  _cache_value(value: _ValueType): void {
    const prop = this._property;
    if (prop != null && (typeof value === "number" || Array.isArray(value))) {
      const raw = prop._unresolve_value(value);
      this._write_kf_value(raw);
      this._value = raw;
    } else {
      this._value = value;
    }
  }

  /**
   * Persist a raw numeric value into the backing kf_data chunk.
   *
   * Serialization reads from `kf_data`, not the in-memory `_value`
   * shadow, so numeric / color / spatial keyframe values must be
   * written through here to round-trip.
   *
   * The write is skipped when the kf_data carries no value slot at all -
   * markers, and the parallel (complex) kinds, whose real value lives in
   * a sibling container (an orientation item is a valueless ease item;
   * its angles are in `otky`). For an ordinary numeric property a length
   * mismatch is a genuine dimension error from the caller and is raised.
   */
  _write_kf_value(raw: number[] | number | null): void {
    const kf_data = this._ldat_item.kf_data;
    if (!("value" in kf_data)) return;
    let new_: number[] | null = typeof raw === "number" ? [raw] : null;
    if (new_ == null && Array.isArray(raw)) new_ = raw;
    if (new_ == null) return;
    if (new_.length !== kf_data.value.length) {
      if (this._property != null && this._property._parallel_kind() != null) {
        return;
      }
      throw new ValueError(
        `value has ${new_.length} component(s) but this keyframe ` +
          `expects ${kf_data.value.length}`,
      );
    }
    kf_data.value = new_;
  }

  /**
   * The incoming temporal ease for the keyframe.
   *
   * Array of {@link KeyframeEase} objects:
   * - If the property value type is `PropertyValueType.TwoD`, the list
   *   contains 2 objects.
   * - If the property value type is `PropertyValueType.ThreeD`, the list
   *   contains 3 objects.
   * - For any other value type, the array contains 1 object.
   */
  get in_temporal_ease(): KeyframeEase[] {
    this._ensure_ease();
    py_assert(this._in_temporal_ease != null);
    return this._resolve_ease(this._in_temporal_ease, "in");
  }

  set in_temporal_ease(value: KeyframeEase[]) {
    this._apply_ease(value, "in");
    this._on_ease_written("in");
  }

  /**
   * The outgoing temporal ease for the keyframe.
   *
   * Array of {@link KeyframeEase} objects:
   * - If the property value type is `PropertyValueType.TwoD`, the list
   *   contains 2 objects.
   * - If the property value type is `PropertyValueType.ThreeD`, the list
   *   contains 3 objects.
   * - For any other value type, the array contains 1 object.
   */
  get out_temporal_ease(): KeyframeEase[] {
    this._ensure_ease();
    py_assert(this._out_temporal_ease != null);
    return this._resolve_ease(this._out_temporal_ease, "out");
  }

  set out_temporal_ease(value: KeyframeEase[]) {
    this._apply_ease(value, "out");
    this._on_ease_written("out");
  }

  /**
   * Make a written ease the one that plays, as AE does.
   *
   * `setTemporalEaseAtKey` switches the key to BEZIER and clears temporal
   * auto-bezier (measured on AE 2026, from LINEAR and from HOLD keys):
   * otherwise a LINEAR or HOLD side, or the auto-bezier derivation,
   * would report and play something else than the ease just written.
   * Only the written side is switched - the per-side setters are the
   * two halves of AE's one call.
   */
  _on_ease_written(direction: "in" | "out"): void {
    this._ldat_item.temporal_auto_bezier = false;
    const bezier = KeyframeInterpolationType.BEZIER;
    const name = `${direction}_interpolation_type` as const;
    if (getattr(this, name) !== bezier) {
      const prop = this._property;
      if (prop == null || prop.is_interpolation_type_valid(bezier)) {
        this[name] = bezier;
      }
    }
    this._retime_roving_runs();
  }

  /**
   * Copy `value`'s speed/influence into the chunk-backed ease objects.
   *
   * A user-constructed {@link KeyframeEase} is detached (it carries its own
   * `speed`/`influence` and no chunk), so assigning the array itself
   * would keep the numbers in Python only and lose them on save. The
   * binary-backed objects live in `_in_temporal_ease` / `_out_temporal_ease`;
   * the *getter* may return computed copies (LINEAR, HOLD and boundary
   * keyframes), so the write has to go through these, not through
   * whatever the getter last returned.
   */
  _apply_ease(value: KeyframeEase[], direction: string): void {
    const field = `${direction}_temporal_ease`;
    if (!Array.isArray(value)) {
      throw new ValueError(`${field} must be a list of KeyframeEase objects`);
    }
    if (!value.every((e) => e instanceof KeyframeEase)) {
      throw new ValueError(`${field} must be a list of KeyframeEase objects`);
    }
    this._ensure_ease();
    const backing = direction === "in" ? this._in_temporal_ease : this._out_temporal_ease;
    py_assert(backing != null);
    if (backing.length === 0) {
      // Marker and other ease-less keyframe types have nowhere to
      // store it; ExtendScript's setTemporalEaseAtKey rejects them too.
      throw new ValueError("this keyframe type has no temporal ease");
    }
    // A colour keyframe stores ONE shared ease but the getter resolves
    // one per component (the LINEAR speed is computed per dimension), so
    // accept either length - assigning back what the getter returned has
    // to work. Extra entries have no slot to land in; the first wins,
    // matching what the format can hold.
    const resolved = this._resolve_ease(backing, direction).length;
    if (value.length !== backing.length && value.length !== resolved) {
      const expected =
        resolved === backing.length ? String(backing.length) : `${backing.length} or ${resolved}`;
      throw new ValueError(
        `${field} expects ${expected} KeyframeEase object(s), got ${value.length}`,
      );
    }
    // The unit factor the getter applies, which a backing ease only
    // carries once it has been read as BEZIER: a LINEAR or end key of an
    // effect point would otherwise store its pixel speed unconverted.
    const factor = this._speed_unit_factor();
    for (const [target, source] of zip(backing, value)) {
      target._speed_factor = factor;
      target._write_from(source);
    }
  }

  /** Reported / stored ratio of this keyframe's ease speeds. */
  _speed_unit_factor(): number {
    const prop = this._property;
    if (prop == null) return 1.0;
    const point = prop._effect_point_speed_factor;
    return point != null ? point : prop._speed_factor;
  }

  /**
   * Apply interpolation-type overrides to temporal ease.
   *
   * For BEZIER keyframes the binary-backed ease objects are returned
   * directly (with `_speed_factor` already set).  For LINEAR
   * keyframes the speed is computed from the segment between adjacent
   * keyframes.  For HOLD keyframes the speed is always 0.
   */
  _resolve_ease(raw_ease: KeyframeEase[], direction: string): KeyframeEase[] {
    if (raw_ease.length === 0) return [new KeyframeEase(0.0, 0.0)];

    let interp: KeyframeInterpolationType;
    let other_interp: KeyframeInterpolationType;
    let neighbour: Keyframe | null;
    if (direction === "in") {
      interp = this.in_interpolation_type;
      other_interp = this.out_interpolation_type;
      neighbour = this._prev;
    } else {
      interp = this.out_interpolation_type;
      other_interp = this.in_interpolation_type;
      neighbour = this._next;
    }

    // The interpolation type wins over the temporal auto-bezier flag:
    // AE keeps the flag through `setInterpolationTypeAtKey` and reports
    // (and plays) a LINEAR side as LINEAR and a HOLD side as HOLD
    // (measured on AE 2026).
    if (interp === KeyframeInterpolationType.HOLD) {
      return raw_ease.map(() => new KeyframeEase(0.0, _DEFAULT_INFLUENCE));
    }
    if (interp === KeyframeInterpolationType.LINEAR) {
      return this._linear_ease(raw_ease, direction);
    }

    // A BEZIER side facing a HOLD side reports speed 0, as AE does; the
    // segment holds, so no value depends on it. Roving neighbours are
    // skipped: a run is eased by its anchors, so it is the far anchor's
    // side that decides (AE 2026).
    let anchor = neighbour;
    while (anchor != null && anchor._is_roving_run_key) {
      anchor = direction === "in" ? anchor._prev : anchor._next;
    }
    const facing_hold =
      anchor != null &&
      (direction === "in" ? anchor.out_interpolation_type : anchor.in_interpolation_type) ===
        KeyframeInterpolationType.HOLD;

    // Auto-bezier wins over the stored bytes on a BEZIER side. AE
    // recomputes the ease from the flag, so its own files carry stale
    // ease on an auto-bezier keyframe. When the key's other side is
    // LINEAR, this side takes that side's speed - 0 at an end (measured
    // on AE 2026: the last key B/L reports in-speed 0, an interior B/L
    // key the LINEAR segment's slope rather than the through-slope).
    if (this.temporal_auto_bezier) {
      let chosen: number[] | null = null;
      if (other_interp === KeyframeInterpolationType.LINEAR) {
        const other_direction = direction === "in" ? "out" : "in";
        chosen = this._linear_ease(raw_ease, other_direction).map((e) => e.speed);
      } else {
        const auto_speeds = this._auto_temporal_speeds();
        if (auto_speeds != null) {
          chosen = direction === "in" ? auto_speeds[0] : auto_speeds[1];
        }
      }
      if (chosen != null && chosen.length === raw_ease.length) {
        return chosen.map(
          (speed) =>
            new KeyframeEase(
              facing_hold || neighbour == null ? 0.0 : speed,
              _DEFAULT_INFLUENCE,
            ),
        );
      }
    }

    // BEZIER - boundary keyframes get zeroed speed on the side with
    // no adjacent keyframe.  Keep original influence so the
    // interpolation solver that reads the adjacent direction is
    // unaffected.
    if (neighbour == null || facing_hold) {
      return raw_ease.map((e) => new KeyframeEase(0.0, e.influence));
    }
    // An effect point stores speed normalized against the comp height.
    // Applied here because the factor needs a fully constructed property,
    // and because `_bind_property` resets ease back to the property-level
    // factor whenever the keyframes are re-linked.
    if (this._property != null) {
      const factor = this._property._effect_point_speed_factor;
      if (factor != null) {
        for (const ease of raw_ease) {
          ease._speed_factor = factor;
        }
      }
    }
    return raw_ease;
  }

  /**
   * The ease AE reports for a LINEAR side: the segment's own rate,
   * with the default influence.
   */
  _linear_ease(raw_ease: KeyframeEase[], direction: string): KeyframeEase[] {
    const other = direction === "out" ? this._next : this._prev;
    if (other == null) {
      return raw_ease.map(() => new KeyframeEase(0.0, _DEFAULT_INFLUENCE));
    }
    // A HOLD on the adjacent keyframe's connecting side means the
    // segment holds - speed is 0. A roving neighbour's own type is
    // ignored: AE reports the run's speed past it (AE 2026). An in side
    // looks back over the run to its start anchor instead: every in
    // side of a run that leaves an out-HOLD anchor reads 0, while the
    // out sides keep the run's speed (measured on AE 2026).
    let adjacent: Keyframe = other;
    let adjacent_interp: KeyframeInterpolationType;
    if (direction === "out") {
      adjacent_interp = other.in_interpolation_type;
    } else {
      while (adjacent._is_roving_run_key && adjacent._prev != null) {
        adjacent = adjacent._prev;
      }
      adjacent_interp = adjacent.out_interpolation_type;
    }
    if (adjacent_interp === KeyframeInterpolationType.HOLD && !adjacent._is_roving_run_key) {
      return raw_ease.map(() => new KeyframeEase(0.0, _DEFAULT_INFLUENCE));
    }
    const prop = this._property;
    const kind = prop != null ? prop._parallel_kind() : null;
    if (kind != null && kind.linear_ease_speed != null) {
      // A path and an Orientation have no scalar magnitude for a
      // speed to measure, so AE reports a LINEAR side's speed as
      // the unit chord slope rather than a rate. Measured on AE
      // 2026 across three Orientation segments of different
      // rotation and duration, and on a mask path: always 1.
      // Reporting only - `_single_progress` forces the LINEAR
      // control points and never reads the speed back.
      const linear_speed = kind.linear_ease_speed;
      return raw_ease.map(() => new KeyframeEase(linear_speed, _DEFAULT_INFLUENCE));
    }
    const [left, right] = direction === "out" ? [this, other] : [other, this];
    if (prop != null && prop._color) {
      // One ease along the colour line, in 0-255 units per second
      // (measured on AE 2026: 191.25 for [1,0,0,1] -> [0,0.5,1,1] over
      // 2 s), not one per channel.
      const span = right._layer_time - left._layer_time;
      const speed =
        span > 0
          ? color_distance(left.value as number[], right.value as number[]) / span
          : 0.0;
      return raw_ease.map(() => new KeyframeEase(speed, _DEFAULT_INFLUENCE));
    }
    if (prop != null && prop._has_motion_path && kind == null) {
      const index = prop._keyframe_index(left);
      if (index != null && Array.isArray(left.value)) {
        const speed = linear_path_speed(prop.keyframes, index, prop._arc_metric);
        return raw_ease.map(() => new KeyframeEase(speed, _DEFAULT_INFLUENCE));
      }
    }
    const speeds = _segment_speed(left, right);
    return speeds.map((s) => new KeyframeEase(s, _DEFAULT_INFLUENCE));
  }

  /**
   * `true` if the keyframe has spatial auto-Bezier interpolation. This type
   * of interpolation affects this keyframe only if {@link spatial_continuous} is
   * also `true`. If the property value type is neither `TwoD_SPATIAL` nor
   * `ThreeD_SPATIAL`, the value is `false`.
   */
  get spatial_auto_bezier(): boolean {
    const kf_data = this._ldat_item.kf_data;
    return getattr(kf_data, "spatial_auto_bezier", false);
  }

  set spatial_auto_bezier(value: boolean) {
    // Only spatial kf_data carries this flag. Non-spatial kinds (e.g.
    // Orientation, whose kf_data is a valueless KfNoValue) have no slot
    // for it; the getter tolerantly reads False there, but a write must not
    // silently vanish (ExtendScript's setSpatialAutoBezierAtKey errors).
    validate_bool(value);
    const kf_data = this._ldat_item.kf_data;
    if (!("spatial_auto_bezier" in kf_data)) {
      throw new ValueError("spatial_auto_bezier can only be set on spatial keyframes");
    }
    kf_data.spatial_auto_bezier = value;
    if (!value) {
      // AE keeps the tangents it derived: turning auto-bezier off does
      // not restore whatever was there before.
      return;
    }
    // Enabling it forces spatial continuity on and materializes the
    // derived tangents into the chunk. AE recomputes them on read anyway,
    // but it also WRITES them, and a later edit that clears the flag
    // leaves whatever is stored in force.
    if ("spatial_continuous" in kf_data) {
      kf_data.spatial_continuous = true;
    }
    const derived = this._auto_spatial_tangents();
    if (derived != null) {
      [kf_data.out_spatial_tangents, kf_data.in_spatial_tangents] = derived;
    }
  }

  /**
   * `true` if the keyframe has spatial continuity. If the property value
   * type is neither `TwoD_SPATIAL` nor `ThreeD_SPATIAL`, the value is
   * `false`.
   */
  get spatial_continuous(): boolean {
    const kf_data = this._ldat_item.kf_data;
    return getattr(kf_data, "spatial_continuous", false);
  }

  set spatial_continuous(value: boolean) {
    // See spatial_auto_bezier: non-spatial kf_data has no such slot.
    validate_bool(value);
    const kf_data = this._ldat_item.kf_data;
    if (!("spatial_continuous" in kf_data)) {
      throw new ValueError("spatial_continuous can only be set on spatial keyframes");
    }
    kf_data.spatial_continuous = value;
  }

  /**
   * Keyframe units per second, in the owning LAYER's own time.
   *
   * A layer stretched past 100 % counts its ticks against a stretched
   * base (`layer_timebase`: about `cdta.internal_timebase * |stretch| / 100`, at most 115200), so the comp's own base only applies up to
   * 100 %. Falls back to the cached comp rates when the keyframe has no
   * property yet (construction).
   */
  get _timebase(): number {
    const prop = this._property;
    if (prop != null) {
      const base = prop._layer_timebase;
      if (base) return base;
    }
    return _timebase_units(this._frame_rate);
  }

  /**
   * Time of the keyframe in the owning LAYER's own seconds.
   *
   * The binary stores ticks against the layer's timebase, so this is
   * what the stored value means before any stretch is applied. Every
   * interpolation runs here rather than in composition time: After
   * Effects evaluates the temporal bezier in layer time, its ease
   * speeds are per layer second, and a negatively stretched layer's
   * keys only ascend on this axis (see {@link time}).
   */
  get _layer_time(): number {
    return this._ldat_item.time_units / this._timebase;
  }

  /**
   * Raw keyframe time, as the binary stores it.
   *
   * An integer count of composition timebase units, relative to the
   * owning layer's start. Read-only; assign to {@link time} instead.
   */
  get time_units(): number {
    return this._ldat_item.time_units;
  }

  /** Move this keyframe to `units`, re-sorting the property if needed. */
  _set_time_units(units: number): void {
    _check_time_units(units);
    const prop = this._property;
    if (prop != null) {
      prop._guard_keyframe_move(this, units);
    }
    this._ldat_item.time_units = units;
    if (prop != null) {
      prop._reposition_keyframe(this);
      prop._redistribute_roving_keyframes();
    }
  }

  /**
   * Time of the keyframe, in whole composition frames.
   *
   * A rounded view of {@link time}. After Effects places keyframes off the
   * frame grid freely, so this is lossy for those - read {@link time} when
   * precision matters.
   */
  get frame_time(): number {
    return round(this.time * this._frame_rate);
  }

  set frame_time(value: number) {
    validate_int(value);
    this.time = value / this._frame_rate;
  }

  /**
   * Time of the keyframe, in seconds.
   *
   * Exact: the binary stores an integer count of composition timebase
   * units relative to the layer's start, and AE places keyframes
   * between frames freely - `setValueAtTime(1.5)` in a 25 fps comp
   * lands on frame 37.5, and every roving keyframe is positioned by
   * arc length rather than snapped to the grid.
   *
   * Writable: moving a keyframe past a neighbour re-sorts the
   * property's keyframes (and their backing chunks). Spatial/temporal
   * tangents are left as-is, like dragging a keyframe in AE's
   * timeline.
   *
   * A roving keyframe has no time of its own - it is derived from the
   * spatial path - so it cannot be assigned one. Clear
   * {@link Keyframe.roving | roving} first.
   *
   * @throws {@link ValueError} When another keyframe already sits at the target time, or when this
   *   keyframe is roving.
   */
  get time(): number {
    let seconds = this._layer_time;
    const prop = this._property;
    if (prop != null) {
      // Ticks are layer time; a stretched layer maps them onto the
      // composition timeline by its stretch factor.
      seconds = seconds * prop._time_stretch + prop._start_time_offset;
    }
    return seconds;
  }

  set time(value: number) {
    validate_number(value);
    if (this.roving) {
      // The redistribution that follows every time write would
      // immediately re-derive this keyframe's time from the path, so
      // accepting the value would silently discard it.
      throw new ValueError(
        "a roving keyframe's time is derived from the spatial path; " +
          "set roving to False before moving it",
      );
    }
    const prop = this._property;
    const offset = prop != null ? prop._start_time_offset : 0.0;
    const stretch = prop != null ? prop._time_stretch : 1.0;
    this._set_time_units(round(((value - offset) / stretch) * this._timebase));
  }
}

// Keyframe class attributes that are descriptors (ChunkField) - installed on the prototype
// after the class, as the Python class body does at class creation.
descriptor(
  Keyframe,
  "in_interpolation_type",
  ChunkField.enum(KeyframeInterpolationType, "_ldat_item", "in_interpolation_type", {
    validate: _validate_interpolation_type,
    post_set: "_on_interpolation_type_set",
  }),
);

descriptor(Keyframe, "label", ChunkField.enum(Label, "_ldat_item", "label"));

descriptor(
  Keyframe,
  "out_interpolation_type",
  ChunkField.enum(KeyframeInterpolationType, "_ldat_item", "out_interpolation_type", {
    validate: _validate_interpolation_type,
    post_set: "_on_interpolation_type_set",
  }),
);

descriptor(
  Keyframe,
  "roving",
  ChunkField.bool("_ldat_item", "roving", {
    validate: _validate_roving,
    post_set: "_retime_roving_runs",
  }),
);

descriptor(
  Keyframe,
  "temporal_auto_bezier",
  ChunkField.bool("_ldat_item", "temporal_auto_bezier", {
    post_set: "_on_temporal_auto_bezier_set",
  }),
);

descriptor(
  Keyframe,
  "temporal_continuous",
  ChunkField.bool("_ldat_item", "temporal_continuous", {
    post_set: "_on_temporal_continuous_set",
  }),
);

/** Compute the constant speed between two adjacent keyframes. */
export function _segment_speed(kf_a: Keyframe, kf_b: Keyframe): number[] {
  // Seconds rather than whole frames: two keyframes can sit inside the
  // same frame at different sub-frame times, and rounding them together
  // would report a zero-length segment. LAYER seconds, because AE stores
  // ease speeds per layer second - a 150 % layer whose keys are 3 comp
  // seconds apart reports 25 %/s where the comp-time span gives 16.667.
  const time_seconds = kf_b._layer_time - kf_a._layer_time;
  if (time_seconds === 0) return [0.0];
  const val_a = kf_a._stored_value;
  const val_b = kf_b._stored_value;

  if (!(typeof val_a === "number" || Array.isArray(val_a))) return [0.0];
  if (!(typeof val_b === "number" || Array.isArray(val_b))) return [0.0];

  if (typeof val_a === "number" && typeof val_b === "number") {
    return [(val_b - val_a) / time_seconds];
  }

  if (Array.isArray(val_a) && Array.isArray(val_b)) {
    return zip(val_a, val_b).map(([a, b]) => (b - a) / time_seconds);
  }

  return [0.0];
}
