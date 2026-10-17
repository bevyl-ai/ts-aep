/** Gradient color data model for gradient fill/stroke properties. */

import {
  ValueError,
  descriptor,
  float_repr,
  format,
  getattr,
  object_getattr,
  object_setattr,
  py_eq,
  repr,
  sorted,
  str,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import { to_f4 } from "../../binary/bin_utils.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { validate_normalized_float, validate_positive_int, validate_rgb_color, type Validator } from "../validators.ts";

/**
 * Descriptor triggering gradient XML serialization on write.
 *
 * Used on `GradientColorStop`, `GradientAlphaStop`, and `Gradient` to
 * automatically re-serialize gradient XML when a field is modified.
 */
export class _GradientField<T = unknown> {
  declare ["constructor"]: ClassAttributes<typeof _GradientField>;
  static _VALIDATORS: Map<string, Validator> = new Map<string, Validator>([
    ["offset", validate_normalized_float],
    ["midpoint", validate_normalized_float],
    ["color", validate_rgb_color],
    ["alpha", validate_normalized_float],
  ]);

  declare _slot: string;
  declare _name: string;

  __set_name__(owner: Function, name: string): void {
    this._slot = "_" + name;
    this._name = name;
  }

  __get__(obj: object | null, objtype?: Function | null): T | this {
    if (obj == null) return this;
    const value: T = object_getattr(obj, this._slot);
    return value;
  }

  __set__(obj: object, value: T): void {
    const validator = this.constructor._VALIDATORS.get(this._name);
    if (validator != null) validator(value, null);
    object_setattr(obj, this._slot, value);
    const gradient = getattr(obj, "_gradient", obj);
    const serialize = getattr(gradient, "_serialize", null);
    if (serialize != null) serialize.call(gradient);
  }
}

/**
 * A single color stop in a gradient.
 *
 * Each stop defines a color at a specific position along the gradient.
 * The midpoint controls the interpolation bias between this stop and
 * the next.
 */
export class GradientColorStop {
  /** Position along the gradient (0.0 to 1.0). */
  declare offset: number;
  /** Interpolation midpoint to next stop (0.0 to 1.0). */
  declare midpoint: number;
  /** RGB color as `(red, green, blue)` with values 0.0 to 1.0. */
  declare color: readonly [number, number, number];

  declare _gradient: Gradient | null;
  declare _offset: number;
  declare _midpoint: number;
  declare _color: readonly [number, number, number];

  constructor(offset: number, midpoint: number, color: readonly [number, number, number]) {
    validate_normalized_float(offset);
    validate_normalized_float(midpoint);
    validate_rgb_color(color);
    this._gradient = null;
    this._offset = offset;
    this._midpoint = midpoint;
    this._color = color;
  }

  __repr__(): string {
    const [r, g, b] = this.color;
    // NOTE(port): fields are annotated float (parsed/default values are floats), so float_repr matches f"{x}"; only out-of-annotation int args would differ.
    return (
      `GradientColorStop(offset=${float_repr(this.offset)}, midpoint=${float_repr(this.midpoint)}, ` +
      `color=(${float_repr(r)}, ${float_repr(g)}, ${float_repr(b)}))`
    );
  }

  __eq__(other: unknown): boolean {
    // Python returns NotImplemented for a foreign type; py_eq treats that as False.
    if (!(other instanceof GradientColorStop)) return false;
    return (
      this.offset === other.offset &&
      this.midpoint === other.midpoint &&
      py_eq(this.color, other.color)
    );
  }
}

descriptor(GradientColorStop, "offset", new _GradientField<number>());
descriptor(GradientColorStop, "midpoint", new _GradientField<number>());
descriptor(GradientColorStop, "color", new _GradientField<readonly [number, number, number]>());

/**
 * A single alpha (opacity) stop in a gradient.
 *
 * Each stop defines an opacity at a specific position along the gradient.
 */
export class GradientAlphaStop {
  /** Position along the gradient (0.0 to 1.0). */
  declare offset: number;
  /** Interpolation midpoint to next stop (0.0 to 1.0). */
  declare midpoint: number;
  /** Opacity value (0.0 to 1.0). */
  declare alpha: number;

  declare _gradient: Gradient | null;
  declare _offset: number;
  declare _midpoint: number;
  declare _alpha: number;

  constructor(offset: number, midpoint: number, alpha: number) {
    validate_normalized_float(offset);
    validate_normalized_float(midpoint);
    validate_normalized_float(alpha);
    this._gradient = null;
    this._offset = offset;
    this._midpoint = midpoint;
    this._alpha = alpha;
  }

  __repr__(): string {
    // NOTE(port): see GradientColorStop.__repr__.
    return (
      `GradientAlphaStop(offset=${float_repr(this.offset)}, midpoint=${float_repr(this.midpoint)}, ` +
      `alpha=${float_repr(this.alpha)})`
    );
  }

  __eq__(other: unknown): boolean {
    // Python returns NotImplemented for a foreign type; py_eq treats that as False.
    if (!(other instanceof GradientAlphaStop)) return false;
    return (
      this.offset === other.offset &&
      this.midpoint === other.midpoint &&
      this.alpha === other.alpha
    );
  }
}

descriptor(GradientAlphaStop, "offset", new _GradientField<number>());
descriptor(GradientAlphaStop, "midpoint", new _GradientField<number>());
descriptor(GradientAlphaStop, "alpha", new _GradientField<number>());

/**
 * Gradient color data for a gradient fill/stroke property.
 *
 * Contains ordered lists of color stops and alpha stops that define
 * the gradient appearance. Constructing a `Gradient` without
 * arguments creates After Effects' default gradient (white to black,
 * full alpha).
 */
export class Gradient {
  /** Gradient data format version. */
  declare version: string;

  declare _version: string;
  declare _utf8: Utf8Chunk;
  declare _color_stops: readonly GradientColorStop[];
  declare _alpha_stops: readonly GradientAlphaStop[];

  constructor(
    color_stops: GradientColorStop[] | null = null,
    alpha_stops: GradientAlphaStop[] | null = null,
    version: string = "1.0",
  ) {
    if (color_stops == null) {
      color_stops = [
        new GradientColorStop(0.0, 0.5, [1.0, 1.0, 1.0]),
        new GradientColorStop(1.0, 0.5, [0.0, 0.0, 0.0]),
      ];
    }
    if (alpha_stops == null) {
      alpha_stops = [new GradientAlphaStop(0.0, 0.5, 1.0), new GradientAlphaStop(1.0, 0.5, 1.0)];
    }
    if (!color_stops.every((stop) => stop instanceof GradientColorStop)) {
      throw new ValueError("All color stops must be GradientColorStop instances");
    }
    if (!alpha_stops.every((stop) => stop instanceof GradientAlphaStop)) {
      throw new ValueError("All alpha stops must be GradientAlphaStop instances");
    }
    this._version = version;
    this._utf8 = new Utf8Chunk();
    this._color_stops = [...color_stops];
    this._alpha_stops = [...alpha_stops];
    for (const stop of this._color_stops) {
      stop._gradient = this;
    }
    for (const astop of this._alpha_stops) {
      astop._gradient = this;
    }
    this._serialize();
  }

  /**
   * Wrap a parsed gradient XML chunk as a `Gradient`.
   *
   * Does not re-serialize, so the backing chunk keeps its original
   * bytes (parse / save round-trips stay byte-identical).
   */
  static _from_binary(kw: {
    color_stops: GradientColorStop[];
    alpha_stops: GradientAlphaStop[];
    _utf8: Utf8Chunk;
    version?: string;
  }): Gradient {
    const { color_stops, alpha_stops, _utf8, version = "1.0" } = kw;
    const obj = Object.create(this.prototype);
    obj._version = version;
    obj._utf8 = _utf8;
    obj._color_stops = [...color_stops];
    obj._alpha_stops = [...alpha_stops];
    for (const stop of obj._color_stops) {
      stop._gradient = obj;
    }
    for (const astop of obj._alpha_stops) {
      astop._gradient = obj;
    }
    return obj;
  }

  /** Ordered color stops defining the gradient. */
  get color_stops(): readonly GradientColorStop[] {
    return this._color_stops;
  }

  set color_stops(value: readonly GradientColorStop[]) {
    if (!value.every((stop) => stop instanceof GradientColorStop)) {
      throw new ValueError("All color stops must be GradientColorStop instances");
    }
    for (const stop of this._color_stops) {
      stop._gradient = null;
    }
    this._color_stops = [...value];
    for (const stop of this._color_stops) {
      stop._gradient = this;
    }
    this._serialize();
  }

  /** Ordered alpha stops defining opacity along the gradient. */
  get alpha_stops(): readonly GradientAlphaStop[] {
    return this._alpha_stops;
  }

  set alpha_stops(value: readonly GradientAlphaStop[]) {
    if (!value.every((stop) => stop instanceof GradientAlphaStop)) {
      throw new ValueError("All alpha stops must be GradientAlphaStop instances");
    }
    for (const stop of this._alpha_stops) {
      stop._gradient = null;
    }
    this._alpha_stops = [...value];
    for (const astop of this._alpha_stops) {
      astop._gradient = this;
    }
    this._serialize();
  }

  /** Add a color stop. */
  add_color_stop(offset: number, midpoint: number, color: readonly [number, number, number]): void {
    const stop = new GradientColorStop(offset, midpoint, color);
    stop._gradient = this;
    this._color_stops = [...this._color_stops, stop];
    this._serialize();
  }

  /** Remove a color stop by index. */
  remove_color_stop(stop: number): void {
    validate_positive_int(stop);
    if (stop >= this._color_stops.length) {
      throw new ValueError(
        `color stop index ${stop} out of range ` +
          `(gradient has ${this._color_stops.length} color stops)`,
      );
    }
    this._color_stops[stop]._gradient = null;
    this._color_stops = this._color_stops.filter((s, i) => i !== stop);
    this._serialize();
  }

  /** Add an alpha stop. */
  add_alpha_stop(offset: number, midpoint: number, alpha: number): void {
    const stop = new GradientAlphaStop(offset, midpoint, alpha);
    stop._gradient = this;
    this._alpha_stops = [...this._alpha_stops, stop];
    this._serialize();
  }

  /** Remove an alpha stop by index. */
  remove_alpha_stop(stop: number): void {
    validate_positive_int(stop);
    if (stop >= this._alpha_stops.length) {
      throw new ValueError(
        `alpha stop index ${stop} out of range ` +
          `(gradient has ${this._alpha_stops.length} alpha stops)`,
      );
    }
    this._alpha_stops[stop]._gradient = null;
    this._alpha_stops = this._alpha_stops.filter((s, i) => i !== stop);
    this._serialize();
  }

  /**
   * Re-serialize gradient data to the backing Utf8 chunk.
   *
   * The output matches After Effects' own gradient XML byte for
   * byte (XML declaration, one tag per line, single quotes, alpha
   * stops before color stops, float32-rounded values printed at 8
   * significant digits).
   */
  _serialize(): void {
    const lines: string[] = [
      "<?xml version='1.0'?>",
      "<prop.map version='4'>",
      "<prop.list>",
      "<prop.pair>",
      "<key>Gradient Color Data</key>",
      "<prop.list>",
    ];
    lines.push(
      ..._stops_lines(
        "Alpha",
        this._alpha_stops.map((s) => [s.offset, s.midpoint, s.alpha]),
      ),
    );
    lines.push(
      ..._stops_lines(
        "Color",
        this._color_stops.map((s) => [s.offset, s.midpoint, ...s.color, 1.0]),
      ),
    );
    lines.push(
      "</prop.list>",
      "</prop.pair>",
      "<prop.pair>",
      "<key>Gradient Colors</key>",
      `<string>${this._version}</string>`,
      "</prop.pair>",
      "</prop.list>",
      "</prop.map>",
    );
    this._utf8.value = lines.join("\n") + "\n";
  }

  __repr__(): string {
    return (
      `Gradient(color_stops=${this.color_stops.length}, ` +
      `alpha_stops=${this.alpha_stops.length}, version=${repr(this.version)})`
    );
  }

  __eq__(other: unknown): boolean {
    // Python returns NotImplemented for a foreign type; py_eq treats that as False.
    if (!(other instanceof Gradient)) return false;
    return (
      py_eq(this.color_stops, other.color_stops) &&
      py_eq(this.alpha_stops, other.alpha_stops) &&
      this.version === other.version
    );
  }
}

descriptor(Gradient, "version", new _GradientField<string>());

/**
 * Format a float the way AE writes gradient XML.
 *
 * AE stores stop values as float32 and prints them at up to 8
 * significant digits (e.g. `0.83` becomes `0.82999998`).
 */
export function _format_float(value: number): string {
  return format(to_f4(value), ".8g");
}

/** XML lines for one `Alpha Stops` / `Color Stops` prop.pair. */
export function _stops_lines(kind: string, stops: number[][]): string[] {
  const lines: string[] = [
    "<prop.pair>",
    `<key>${kind} Stops</key>`,
    "<prop.list>",
    "<prop.pair>",
    "<key>Stops List</key>",
    "<prop.list>",
  ];
  // AE stores stops in a string-keyed map and serializes them in
  // LEXICOGRAPHIC key order (Stop-0, Stop-1, Stop-10, ..., Stop-15,
  // Stop-2, ...), not numeric order. Match that so gradients with >9
  // stops are byte-identical (identical for <=10 stops).
  for (const i of sorted(Array.from({ length: stops.length }, (_, i) => i), (n: number) => str(n))) {
    const values = stops[i];
    lines.push(
      "<prop.pair>",
      `<key>Stop-${i}</key>`,
      "<prop.list>",
      "<prop.pair>",
      `<key>Stops ${kind}</key>`,
      "<array>",
      "<array.type><float/></array.type>",
    );
    lines.push(...values.map((v) => `<float>${_format_float(v)}</float>`));
    lines.push("</array>", "</prop.pair>", "</prop.list>", "</prop.pair>");
  }
  lines.push(
    "</prop.list>",
    "</prop.pair>",
    "<prop.pair>",
    "<key>Stops Size</key>",
    `<int type='unsigned' size='32'>${stops.length}</int>`,
    "</prop.pair>",
    "</prop.list>",
    "</prop.pair>",
  );
  return lines;
}
