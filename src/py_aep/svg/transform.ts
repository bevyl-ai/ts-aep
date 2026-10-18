/**
 * 2x3 affine transforms and the SVG `transform` attribute parser.
 *
 * An `Affine` is the matrix `[[a, c, e], [b, d, f]]` mapping
 * `(x, y) -> (a*x + c*y + e, b*x + d*y + f)`, matching SVG's
 * `matrix(a b c d e f)` ordering.
 */

import { float, radians, repr } from "../../pyrt/index.ts";
import { NUMBER_RE } from "./_util.ts";
import { UnsupportedSVGError } from "./errors.ts";

/** A 2x3 affine transform in SVG `matrix(a b c d e f)` order. */
export class Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;

  constructor(a: number = 1.0, b: number = 0.0, c: number = 0.0, d: number = 1.0, e: number = 0.0, f: number = 0.0) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
  }

  *[Symbol.iterator](): Generator<number> {
    yield this.a;
    yield this.b;
    yield this.c;
    yield this.d;
    yield this.e;
    yield this.f;
  }

  equals(other: unknown): boolean {
    return other instanceof Affine && this.a === other.a && this.b === other.b && this.c === other.c && this.d === other.d && this.e === other.e && this.f === other.f;
  }

  /** Return `self @ other` (apply `other` first, then `self`). */
  multiply(other: Affine): Affine {
    return new Affine(
      this.a * other.a + this.c * other.b,
      this.b * other.a + this.d * other.b,
      this.a * other.c + this.c * other.d,
      this.b * other.c + this.d * other.d,
      this.a * other.e + this.c * other.f + this.e,
      this.b * other.e + this.d * other.f + this.f,
    );
  }

  /** Map a point through the transform. */
  apply(x: number, y: number): [number, number] {
    return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f];
  }

  /** Map a direction/offset (ignores translation). */
  applyVector(x: number, y: number): [number, number] {
    return [this.a * x + this.c * y, this.b * x + this.d * y];
  }

  /** Geometric-mean scale factor (for scaling stroke widths). */
  get meanScale(): number {
    const det = Math.abs(this.a * this.d - this.b * this.c);
    return det > 0 ? Math.sqrt(det) : 1.0;
  }
}

export const IDENTITY = new Affine();

// One transform function: name + parenthesized numeric args.
export const _FUNC_RE = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

export const _FUNCTIONS: ReadonlySet<string> = new Set(["matrix", "translate", "scale", "rotate", "skewX", "skewY"]);

export function _numbers(text: string): number[] {
  return Array.from(text.matchAll(NUMBER_RE), (m) => float(m[0]));
}

/**
 * Parse an SVG `transform` attribute into a single `Affine`.
 *
 * Supports `matrix`, `translate`, `scale`, `rotate`, `skewX`, `skewY`.
 * Multiple functions compose left-to-right (the leftmost is applied
 * last), per the SVG spec.
 *
 * @param value - The `transform` attribute string.
 * @returns The composed transform (identity for an empty string, and for a
 *   malformed list: a known function with the wrong number of
 *   arguments or a non-finite one).
 * @throws UnsupportedSVGError For an unknown transform function.
 */
export function parseTransform(value: string): Affine {
  let result = IDENTITY;
  if (!value) {
    return result;
  }
  for (const [, name, args] of value.matchAll(_FUNC_RE)) {
    const nums = _numbers(args);
    if (!_FUNCTIONS.has(name)) {
      throw new UnsupportedSVGError(`Unsupported transform function: ${repr(name)}`);
    }
    if (
      !nums.every((x) => Number.isFinite(x)) ||
      (name === "matrix" && nums.length !== 6) ||
      ((name === "skewX" || name === "skewY") && nums.length === 0)
    ) {
      // An attribute in error is ignored as a whole (SVG 1.1 7.6); AE
      // 2026 imports a `matrix(1 0 0 1)` group untransformed.
      return IDENTITY;
    }
    result = result.multiply(_singleTransform(name, nums));
  }
  return result;
}

/**
 * One transform function, its name and argument count already checked
 * by `parseTransform`.
 */
// NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
export function _singleTransform(name: string, n: number[]): Affine {
  if (name === "matrix") {
    return new Affine(n[0], n[1], n[2], n[3], n[4], n[5]);
  }
  if (name === "translate") {
    const tx = n.length > 0 ? n[0] : 0.0;
    const ty = n.length > 1 ? n[1] : 0.0;
    return new Affine(undefined, undefined, undefined, undefined, tx, ty);
  }
  if (name === "scale") {
    const sx = n.length > 0 ? n[0] : 1.0;
    const sy = n.length > 1 ? n[1] : sx;
    return new Affine(sx, undefined, undefined, sy);
  }
  if (name === "rotate") {
    const ang = n.length > 0 ? radians(n[0]) : 0.0;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const rot = new Affine(cos, sin, -sin, cos);
    if (n.length >= 3) {
      const cx = n[1];
      const cy = n[2];
      // translate(cx,cy) . rotate . translate(-cx,-cy)
      return new Affine(undefined, undefined, undefined, undefined, cx, cy)
        .multiply(rot)
        .multiply(new Affine(undefined, undefined, undefined, undefined, -cx, -cy));
    }
    return rot;
  }
  if (name === "skewX") {
    return new Affine(undefined, undefined, Math.tan(radians(n[0])));
  }
  return new Affine(undefined, Math.tan(radians(n[0]))); // skewY
}
