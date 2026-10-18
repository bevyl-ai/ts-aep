/** Gradient color data model for gradient fill/stroke properties. */

import { INSPECT } from "../../../pyrt/index.ts";
import {
  ValueError,
  descriptor,
  floatRepr,
  format,
  getattr,
  objectGetattr,
  objectSetattr,
  pyEq,
  repr,
  sorted,
  str,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import { toF4 } from "../../binary/bin_utils.ts";
import { Utf8Chunk } from "../../binary/scalar_chunks.ts";
import { validateNormalizedFloat, validatePositiveInt, validateRgbColor, type Validator } from "../validators.ts";

/**
 * Descriptor triggering gradient XML serialization on write.
 *
 * Used on `GradientColorStop`, `GradientAlphaStop`, and `Gradient` to
 * automatically re-serialize gradient XML when a field is modified.
 */
export class _GradientField<T> {
  declare ["constructor"]: ClassAttributes<typeof _GradientField>;
  static _VALIDATORS: Map<string, Validator> = new Map<string, Validator>([
    ["offset", validateNormalizedFloat],
    ["midpoint", validateNormalizedFloat],
    ["color", validateRgbColor],
    ["alpha", validateNormalizedFloat],
  ]);

  declare _slot: string;
  declare _name: string;

  __set_name__(owner: Function, name: string): void {
    this._slot = "_" + name;
    this._name = name;
  }

  __get__(obj: object | null, objtype?: Function | null): T | this {
    if (obj == null) return this;
    const value: T = objectGetattr(obj, this._slot);
    return value;
  }

  __set__(obj: object, value: T): void {
    const validator = this.constructor._VALIDATORS.get(this._name);
    if (validator != null) validator(value, null);
    objectSetattr(obj, this._slot, value);
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
    validateNormalizedFloat(offset);
    validateNormalizedFloat(midpoint);
    validateRgbColor(color);
    this._gradient = null;
    this._offset = offset;
    this._midpoint = midpoint;
    this._color = color;
  }

  [INSPECT](): string {
    const [r, g, b] = this.color;
    // NOTE(port): fields are annotated float (parsed/default values are floats), so float_repr matches f"{x}"; only out-of-annotation int args would differ.
    return (
      `GradientColorStop(offset=${floatRepr(this.offset)}, midpoint=${floatRepr(this.midpoint)}, ` +
      `color=(${floatRepr(r)}, ${floatRepr(g)}, ${floatRepr(b)}))`
    );
  }

  equals(other: unknown): boolean {
    // Python returns NotImplemented for a foreign type; py_eq treats that as False.
    if (!(other instanceof GradientColorStop)) return false;
    return (
      this.offset === other.offset &&
      this.midpoint === other.midpoint &&
      pyEq(this.color, other.color)
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
    validateNormalizedFloat(offset);
    validateNormalizedFloat(midpoint);
    validateNormalizedFloat(alpha);
    this._gradient = null;
    this._offset = offset;
    this._midpoint = midpoint;
    this._alpha = alpha;
  }

  [INSPECT](): string {
    // NOTE(port): see GradientColorStop.__repr__.
    return (
      `GradientAlphaStop(offset=${floatRepr(this.offset)}, midpoint=${floatRepr(this.midpoint)}, ` +
      `alpha=${floatRepr(this.alpha)})`
    );
  }

  equals(other: unknown): boolean {
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
  declare _colorStops: readonly GradientColorStop[];
  declare _alphaStops: readonly GradientAlphaStop[];

  constructor(
    colorStops: GradientColorStop[] | null = null,
    alphaStops: GradientAlphaStop[] | null = null,
    version: string = "1.0",
  ) {
    if (colorStops == null) {
      colorStops = [
        new GradientColorStop(0.0, 0.5, [1.0, 1.0, 1.0]),
        new GradientColorStop(1.0, 0.5, [0.0, 0.0, 0.0]),
      ];
    }
    if (alphaStops == null) {
      alphaStops = [new GradientAlphaStop(0.0, 0.5, 1.0), new GradientAlphaStop(1.0, 0.5, 1.0)];
    }
    if (!colorStops.every((stop) => stop instanceof GradientColorStop)) {
      throw new ValueError("All color stops must be GradientColorStop instances");
    }
    if (!alphaStops.every((stop) => stop instanceof GradientAlphaStop)) {
      throw new ValueError("All alpha stops must be GradientAlphaStop instances");
    }
    this._version = version;
    this._utf8 = new Utf8Chunk();
    this._colorStops = [...colorStops];
    this._alphaStops = [...alphaStops];
    for (const stop of this._colorStops) {
      stop._gradient = this;
    }
    for (const astop of this._alphaStops) {
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
  static _fromBinary(kw: {
    colorStops: GradientColorStop[];
    alphaStops: GradientAlphaStop[];
    _utf8: Utf8Chunk;
    version?: string;
  }): Gradient {
    const { colorStops: color_stops, alphaStops: alpha_stops, _utf8, version = "1.0" } = kw;
    const obj = Object.create(this.prototype);
    obj._version = version;
    obj._utf8 = _utf8;
    obj._colorStops = [...color_stops];
    obj._alphaStops = [...alpha_stops];
    for (const stop of obj._colorStops) {
      stop._gradient = obj;
    }
    for (const astop of obj._alphaStops) {
      astop._gradient = obj;
    }
    return obj;
  }

  /** Ordered color stops defining the gradient. */
  get colorStops(): readonly GradientColorStop[] {
    return this._colorStops;
  }

  set colorStops(value: readonly GradientColorStop[]) {
    if (!value.every((stop) => stop instanceof GradientColorStop)) {
      throw new ValueError("All color stops must be GradientColorStop instances");
    }
    for (const stop of this._colorStops) {
      stop._gradient = null;
    }
    this._colorStops = [...value];
    for (const stop of this._colorStops) {
      stop._gradient = this;
    }
    this._serialize();
  }

  /** Ordered alpha stops defining opacity along the gradient. */
  get alphaStops(): readonly GradientAlphaStop[] {
    return this._alphaStops;
  }

  set alphaStops(value: readonly GradientAlphaStop[]) {
    if (!value.every((stop) => stop instanceof GradientAlphaStop)) {
      throw new ValueError("All alpha stops must be GradientAlphaStop instances");
    }
    for (const stop of this._alphaStops) {
      stop._gradient = null;
    }
    this._alphaStops = [...value];
    for (const astop of this._alphaStops) {
      astop._gradient = this;
    }
    this._serialize();
  }

  /** Add a color stop. */
  addColorStop(offset: number, midpoint: number, color: readonly [number, number, number]): void {
    const stop = new GradientColorStop(offset, midpoint, color);
    stop._gradient = this;
    this._colorStops = [...this._colorStops, stop];
    this._serialize();
  }

  /** Remove a color stop by index. */
  removeColorStop(stop: number): void {
    validatePositiveInt(stop);
    if (stop >= this._colorStops.length) {
      throw new ValueError(
        `color stop index ${stop} out of range ` +
          `(gradient has ${this._colorStops.length} color stops)`,
      );
    }
    this._colorStops[stop]._gradient = null;
    this._colorStops = this._colorStops.filter((s, i) => i !== stop);
    this._serialize();
  }

  /** Add an alpha stop. */
  addAlphaStop(offset: number, midpoint: number, alpha: number): void {
    const stop = new GradientAlphaStop(offset, midpoint, alpha);
    stop._gradient = this;
    this._alphaStops = [...this._alphaStops, stop];
    this._serialize();
  }

  /** Remove an alpha stop by index. */
  removeAlphaStop(stop: number): void {
    validatePositiveInt(stop);
    if (stop >= this._alphaStops.length) {
      throw new ValueError(
        `alpha stop index ${stop} out of range ` +
          `(gradient has ${this._alphaStops.length} alpha stops)`,
      );
    }
    this._alphaStops[stop]._gradient = null;
    this._alphaStops = this._alphaStops.filter((s, i) => i !== stop);
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
      ..._stopsLines(
        "Alpha",
        this._alphaStops.map((s) => [s.offset, s.midpoint, s.alpha]),
      ),
    );
    lines.push(
      ..._stopsLines(
        "Color",
        this._colorStops.map((s) => [s.offset, s.midpoint, ...s.color, 1.0]),
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

  [INSPECT](): string {
    return (
      `Gradient(color_stops=${this.colorStops.length}, ` +
      `alpha_stops=${this.alphaStops.length}, version=${repr(this.version)})`
    );
  }

  equals(other: unknown): boolean {
    // Python returns NotImplemented for a foreign type; py_eq treats that as False.
    if (!(other instanceof Gradient)) return false;
    return (
      pyEq(this.colorStops, other.colorStops) &&
      pyEq(this.alphaStops, other.alphaStops) &&
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
export function _formatFloat(value: number): string {
  return format(toF4(value), ".8g");
}

/** XML lines for one `Alpha Stops` / `Color Stops` prop.pair. */
export function _stopsLines(kind: string, stops: number[][]): string[] {
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
    lines.push(...values.map((v) => `<float>${_formatFloat(v)}</float>`));
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
