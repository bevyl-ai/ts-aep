/**
 * The curves of the Curves effect (`ADBE CurvesCustom-0001`).
 *
 * After Effects keeps them as the effect's own arbitrary data, an `aRbp`
 * chunk (see `CurvesArbpChunk` for the layout): a mode, then per channel (the
 * RGB master, red, green, blue, alpha) a 256-entry map and its points.
 *
 * A curve through points is the natural cubic spline through them (second
 * derivative 0 at both ends, a straight line through two points), flat
 * beyond the first and last points. Rounded, it gives the map AE stores to
 * within one level: of 101 edited point-mode channels, 96 match exactly and
 * 5 differ by one level, at exact half-level ties on two-point lines (AE's
 * float32 evaluation lands on the other side of the tie).
 */

import { INSPECT } from "../../../pyrt/index.ts";
import {
  ValueError,
  at,
  bytes_,
  bytesEq,
  floordiv,
  getitem,
  int,
  pyEq,
  repr,
  sorted,
  zip,
} from "../../../pyrt/index.ts";
import { validateNumber } from "../validators.ts";
import type { CurvesArbpChunk } from "../../binary/property_chunks.ts";

/**
 * Channel names, in After Effects' order: `rgb` is the master curve.
 */
export const CURVES_CHANNELS = ["rgb", "red", "green", "blue", "alpha"];

/**
 * Natural cubic spline through `(x, y)` points, flat outside them.
 *
 * Points sharing an input keep the last one's output, as a curve can only
 * pass through one output per input.
 */
export class _NaturalSpline {
  declare xs: number[];
  declare ys: number[];
  declare m: number[];

  constructor(points: Array<[number, number]>) {
    const byX = new Map<number, number>();
    for (const [x, y] of points) byX.set(x, y);
    const pts = sorted(byX.entries());
    this.xs = pts.map((p) => p[0]);
    this.ys = pts.map((p) => p[1]);
    const n = pts.length;
    // Second derivatives, 0 at both ends.
    this.m = new Array<number>(n).fill(0.0);
    if (n < 3) return;
    const xs = this.xs;
    const ys = this.ys;
    const h: number[] = [];
    for (let i = 0; i < n - 1; i++) h.push(xs[i + 1] - xs[i]);
    const a = new Array<number>(n).fill(0.0);
    const b = new Array<number>(n).fill(1.0);
    const c = new Array<number>(n).fill(0.0);
    const d = new Array<number>(n).fill(0.0);
    for (let i = 1; i < n - 1; i++) {
      a[i] = h[i - 1];
      b[i] = 2.0 * (h[i - 1] + h[i]);
      c[i] = h[i];
      d[i] = 6.0 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1]);
    }
    for (let i = 1; i < n; i++) {
      const w = a[i] / b[i - 1];
      b[i] -= w * c[i - 1];
      d[i] -= w * d[i - 1];
    }
    this.m[n - 1] = d[n - 1] / b[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      this.m[i] = (d[i] - c[i] * this.m[i + 1]) / b[i];
    }
  }

  _segment(x: number): number {
    const xs = this.xs;
    let lo = 0;
    let hi = xs.length - 2;
    while (lo < hi) {
      const mid = floordiv(lo + hi + 1, 2);
      if (xs[mid] <= x) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  // NOTE(port): Python `__call__`; no rulebook mapping, so callers use `.__call__(x)` explicitly.
  __call__(x: number): number {
    const xs = this.xs;
    const ys = this.ys;
    const m = this.m;
    if (xs.length === 1 || x <= at(xs, 0)) return at(ys, 0);
    if (x >= at(xs, -1)) return at(ys, -1);
    const i = this._segment(x);
    const h = xs[i + 1] - xs[i];
    const u = (xs[i + 1] - x) / h;
    const v = 1.0 - u;
    // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
    const cubic = (u ** 3 - u) * m[i] + (v ** 3 - v) * m[i + 1];
    return u * ys[i] + v * ys[i + 1] + (cubic * h * h) / 6.0;
  }
}

/**
 * One channel's curve: its points and its 8-bit map. Read-only.
 */
export class CurvesChannel {
  declare _name: string;
  declare _points: Array<[number, number]>;
  declare _map: Uint8Array;
  declare _selected: number;
  declare _usesPoints: boolean;
  declare _spline: _NaturalSpline;

  constructor(
    name: string,
    points: Array<[number, number]>,
    lut: Uint8Array,
    selected: number,
    usesPoints = true,
  ) {
    this._name = name;
    this._points = points;
    this._map = lut;
    // AE leaves junk here at times (0x9200FF with 3 points).
    this._selected = 0 <= selected && selected < points.length ? selected : -1;
    this._usesPoints = usesPoints;
    /**
     * The natural cubic spline through the points, in 0..255 on both axes.
     */
    this._spline = new _NaturalSpline(points);
  }

  /**
   * The channel: `rgb` (the master), `red`, `green`, `blue` or `alpha`.
   */
  get name(): string {
    return this._name;
  }

  /**
   * The live points, `(input, output)` in 0..255.
   */
  get points(): Array<[number, number]> {
    return [...this._points];
  }

  /**
   * 256 output levels, one per input level.
   */
  get map(): number[] {
    return Array.from(this._map);
  }

  /**
   * The index of the selected point, -1 for none.
   */
  get selected(): number {
    return this._selected;
  }

  /**
   * Whether the curve leaves every level unchanged.
   *
   * Drawn with the pencil, the map is the curve and the points are
   * stale, so only the map counts.
   */
  get isIdentity(): boolean {
    const mapIsIdentity = this._map.every((v, i) => v === i);
    if (!this._usesPoints) return mapIsIdentity;
    return mapIsIdentity && this._points.every(([x, y]) => x === y);
  }

  /**
   * Whether this curve is `other`'s: the same points when both go
   * through theirs, else the same map (what a pencil curve renders).
   */
  _sameCurve(other: CurvesChannel): boolean {
    if (this._usesPoints && other._usesPoints) return pyEq(this._points, other._points);
    return bytesEq(this._map, other._map);
  }

  [INSPECT](): string {
    // NOTE(port): points are tuples in Python, so each `(x, y)` pair is rendered by hand with float repr.
    const points = `[${this._points.map(([x, y]) => `(${repr(x)}, ${repr(y)})`).join(", ")}]`;
    return `CurvesChannel(${repr(this._name)}, points=${points})`;
  }
}

/**
 * The five curves of a Curves effect.
 *
 * Read-only: py-aep does not write curves back to the project, and reads
 * them from one ({@link Property.value} or {@link Keyframe.value}).
 */
export class Curves {
  declare _version: number;
  declare _mode: number;
  declare _channels: Map<string, CurvesChannel>;

  /**
   * Build the curves from a Curves effect's aRbp layout.
   */
  static _fromBinary(chunk: CurvesArbpChunk): Curves {
    // `cls.__new__(cls)`: an instance without running `__init__`.
    const obj: Curves = Object.create(this.prototype);
    obj._version = chunk.version;
    obj._mode = chunk.mode;
    obj._channels = new Map();
    for (const [c, [name, record]] of zip(CURVES_CHANNELS, chunk.records).entries()) {
      const lut = bytes_.slice(chunk.maps, 256 * c, 256 * (c + 1));
      let points = record.points;
      if (points.length < 2) {
        // Nothing usable: the channel's map is all there is.
        points = [
          [0, lut[0]],
          [255, lut[255]],
        ];
      }
      obj._channels.set(
        name,
        new CurvesChannel(name, points, lut, record.selected, obj.usesPoints),
      );
    }
    return obj;
  }

  /**
   * Whether these curves are `other`'s, channel by channel (the
   * bytes differ by the stale points and junk AE leaves).
   */
  _sameCurves(other: Curves): boolean {
    return Array.from(this._channels).every(([name, ch]) =>
      ch._sameCurve(getitem(other._channels, name)),
    );
  }

  /**
   * The data's version, 1.
   */
  get version(): number {
    return this._version;
  }

  /**
   * 1 when the curves are drawn with points, 0 with the pencil.
   */
  get mode(): number {
    return this._mode;
  }

  /**
   * Whether the curves go through their points; if not, they were
   * drawn with the pencil and their maps are what renders.
   */
  get usesPoints(): boolean {
    return this._mode !== 0;
  }

  /**
   * The curves by channel name, in `CURVES_CHANNELS` order.
   */
  get channels(): Map<string, CurvesChannel> {
    return new Map(this._channels);
  }

  /**
   * Whether every curve leaves every level unchanged, as an untouched
   * Curves does.
   */
  get isIdentity(): boolean {
    return Array.from(this._channels.values()).every((ch) => ch.isIdentity);
  }

  /**
   * One channel's curve at `x` in 0..1, on its own (not through the
   * master): the spline through its points, or its map read linearly
   * when drawn with the pencil. Clamped to 0..1 unless `clamp` is
   * `false`, which leaves the spline's overshoot between the points.
   *
   * @throws {@link ValueError} If `channel` is not one of `CURVES_CHANNELS`, or `x` is not a finite
   *   number.
   */
  evaluate(channel: string, x: number, clamp = true): number {
    if (!CURVES_CHANNELS.includes(channel)) {
      throw new ValueError(
        `channel must be one of ${CURVES_CHANNELS.join(", ")}, not ${repr(channel)}`,
      );
    }
    validateNumber(x);
    const ch = getitem(this._channels, channel);
    let y: number;
    if (this.usesPoints) {
      y = ch._spline.__call__(x * 255.0) / 255.0;
    } else {
      const f = Math.min(Math.max(x, 0.0), 1.0) * 255.0;
      const i = Math.min(int(Math.floor(f)), 254);
      const t = f - i;
      const lut = ch._map;
      y = (lut[i] * (1.0 - t) + lut[i + 1] * t) / 255.0;
    }
    return clamp ? Math.min(Math.max(y, 0.0), 1.0) : y;
  }

  [INSPECT](): string {
    const edited = Array.from(this._channels)
      .filter(([, c]) => !c.isIdentity)
      .map(([n]) => n);
    return `Curves(mode=${this._mode}, edited=${repr(edited)})`;
  }
}
