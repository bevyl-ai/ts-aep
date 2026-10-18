/**
 * Interpolation utilities for keyframe-based property evaluation.
 *
 * Implements HOLD, LINEAR, and BEZIER interpolation for
 * `Property.valueAtTime()`.  Pure Python with no external dependencies.
 *
 * The temporal structure follows `lottie-web <https://github.com/airbnb/ lottie-web>`_, the industry-standard renderer for Lottie/bodymovin
 * animations exported from After Effects, with the numerics adjusted to
 * match AE's own output:
 *
 * - **Temporal ease** uses a normalised [0, 1] -\> [0, 1] cubic-bezier
 *   easing function (`BezierEasing`), whose curve parameter is solved in
 *   closed form (Cardano).
 * - **Spatial paths** follow AE's own arc-length model instead: an ease curve
 *   in (seconds, distance) space gives the distance travelled, and a spline
 *   fitted to the segment's sampled arc length turns it into the curve
 *   parameter (see `_ArcSpline`).
 */

import { IndexError, ZeroDivisionError, at, floordiv, getOrThrow, int, max, min, mod, radians, sorted, sum, compositeKey, zip } from "../../pyrt/index.ts";
import { KeyframeInterpolationType } from "../enums/index.ts";
import { ORIENTATION_KIND, SHAPE_KIND, type ParallelKind } from "../models/properties/parallel.ts";
import { Shape } from "../models/properties/shape.ts";
import { keyframeTensions } from "./roto_bezier.ts";
import { _eulerXyz } from "./transform.ts";
import type { Keyframe, PropertyValue } from "../models/properties/keyframe.ts";
import type { KeyframeEase } from "../models/properties/keyframe_ease.ts";


export const _DEFAULT_INFLUENCE = 100.0 / 6.0; // 16.6667 %

// ---------------------------------------------------------------------------
// BezierEasing
// ---------------------------------------------------------------------------
// A cached unit-square bezier easing function: given control points
// (cx1, cy1, cx2, cy2), maps x in [0,1] -> y in [0,1].
//
// The curve parameter is solved in CLOSED FORM, the way After Effects does it:
// the segment is rewritten in power basis and `a t^3 + b t^2 + c t + d = 0` is
// handed to a Cardano solver (the Numerical Recipes form, with
// Q = (A^2 - 3B)/9 and R = (2A^3 - 9AB + 27C)/54), after snapping to either
// endpoint within `_EPS`. This replaces an earlier sample-table + Newton port,
// which agreed with AE only to ~1e-5 in the parameter.

export const _EPS = 1e-10;

// AE saturates a vertical slope instead of dividing by a near-zero dx: inside
// this window it reports +/- this value.
export const _VERTICAL_SLOPE_EPS = 1e-12;
export const _VERTICAL_SLOPE = 1e10;

export function _bez_A(a1: number, a2: number): number {
  return 1.0 - 3.0 * a2 + 3.0 * a1;
}

export function _bez_B(a1: number, a2: number): number {
  return 3.0 * a2 - 6.0 * a1;
}

export function _bez_C(a1: number): number {
  return 3.0 * a1;
}

/** Calculate bezier value at t for one axis (x or y). */
export function _calcBezier(t: number, a1: number, a2: number): number {
  return ((_bez_A(a1, a2) * t + _bez_B(a1, a2)) * t + _bez_C(a1)) * t;
}

/**
 * The root of `a t^3 + b t^2 + c t + d` in [0, 1] that AE picks.
 *
 * Closed-form Cardano. The root preference order and its asymmetric
 * bounds - the first root must be strictly inside [0, 1], the second may
 * sit on either end - are AE's, and only tell the two apart on a
 * non-monotonic curve.
 *
 * Returns `null` when no root lands in [0, 1]. AE's result is undefined
 * there; that is a bug, not behaviour to copy.
 */
// NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
export function _solveCubic(a: number, b: number, c: number, d: number): number | null {
  let root: number;
  if (Math.abs(a) >= _EPS) {
    const bigA = b / a;
    const q = (bigA * bigA - 3.0 * (c / a)) / 9.0;
    const r = (2.0 * bigA * bigA * bigA - 9.0 * bigA * (c / a) + 27.0 * (d / a)) / 54.0;
    const third = bigA / 3.0;
    const q3 = q * q * q;
    if (q3 < r * r) {
      // One real root. `sq +/- r` is strictly positive here, since
      // `q3 < r * r` rules out both terms vanishing together.
      const sq = Math.sqrt(r * r - q3);
      if (r < 0.0) {
        const x = Math.pow(sq - r, 1.0 / 3.0);
        return q / x + x - third;
      }
      const x = Math.pow(sq + r, 1.0 / 3.0);
      return -x - q / x - third;
    }
    if (Math.abs(q) < _EPS) return -third;
    // Three real roots.
    const theta = Math.acos(r / Math.sqrt(q3));
    const scale = -2.0 * Math.sqrt(q);
    const first = Math.cos(theta / 3.0) * scale - third;
    if (0.0 < first && first < 1.0) return first;
    const second = Math.cos((theta + 2.0 * Math.PI) / 3.0) * scale - third;
    if (0.0 <= second && second <= 1.0) return second;
    root = Math.cos((theta + 4.0 * Math.PI) / 3.0) * scale - third;
  } else {
    // Degenerates to a quadratic (or a line).
    if (Math.abs(b) < _EPS) return Math.abs(c) >= _EPS ? -d / c : 0.0;
    const disc = c * c - 4.0 * b * d;
    if (disc < 0.0) return null;
    if (Math.abs(disc) < _EPS) return -c / (2.0 * b);
    const sq = Math.sqrt(disc);
    // AE's numerically stable form: both branches yield 2d/q and q/2b.
    const qQuad = c <= 0.0 ? sq - c : -(sq + c);
    const first = (2.0 * d) / qQuad;
    root = qQuad / (2.0 * b);
    if (0.0 <= first && first <= 1.0) return first;
  }
  return 0.0 <= root && root <= 1.0 ? root : null;
}

/** Cached unit-square bezier easing function. */
export class _BezierEasing {
  declare _cx1: number;
  declare _cy1: number;
  declare _cx2: number;
  declare _cy2: number;

  constructor(cx1: number, cy1: number, cx2: number, cy2: number) {
    this._cx1 = cx1;
    this._cy1 = cy1;
    this._cx2 = cx2;
    this._cy2 = cy2;
  }

  /** Map x in [0,1] to eased y in [0,1]. */
  get(x: number): number {
    // The curve is the identity when both handles sit on the diagonal.
    if (this._cx1 === this._cy1 && this._cx2 === this._cy2) return x;
    return _calcBezier(this.parameterAt(x), this._cy1, this._cy2);
  }

  /**
   * The curve parameter `u` whose x-coordinate is `x`.
   *
   * Callers that place their control points in absolute value space
   * (rather than the normalized 0-1 y used by `get`) need the parameter
   * itself: only the TIME axis is normalized there.
   *
   * As in AE, an `x` within `_EPS` of either end snaps to that end
   * before any solving happens.
   */
  parameterAt(x: number): number {
    if (x < 0.0 || Math.abs(x) < _EPS) return 0.0;
    if (x > 1.0 || Math.abs(x - 1.0) < _EPS) return 1.0;
    const u = _solveCubic(_bez_A(this._cx1, this._cx2), _bez_B(this._cx1, this._cx2), _bez_C(this._cx1), -x);
    // No root in [0, 1] means the curve does not reach `x`, which only
    // happens on a degenerate one. Fall back to the linear estimate
    // rather than to AE's undefined result.
    return u == null ? x : u;
  }
}

// Cache for easing functions (mirroring lottie-web's BezierFactory cache)
export const _easingCache = new Map<string, _BezierEasing>();

/** Get or create a cached BezierEasing instance. */
export function _getBezierEasing(cx1: number, cy1: number, cx2: number, cy2: number): _BezierEasing {
  const key = compositeKey(cx1, cy1, cx2, cy2);
  const cached = _easingCache.get(key);
  if (cached != null) return cached;
  const easing = new _BezierEasing(cx1, cy1, cx2, cy2);
  _easingCache.set(key, easing);
  return easing;
}

// ---------------------------------------------------------------------------
// Speed/influence -> bezier control points conversion
// ---------------------------------------------------------------------------
// AEP stores temporal ease as (speed, influence) pairs.
// Lottie JSON stores temporal ease as bezier control points (o.x, o.y, i.x, i.y)
// in a normalized [0,1] coordinate space.
//
// The bodymovin exporter converts from AEP to Lottie format as follows:
//   outgoing: cx1 = out_influence / 100, cy1 = out_speed_normalized
//   incoming: cx2 = 1 - in_influence / 100, cy2 = 1 - in_speed_normalized
//
// Where speed_normalized = speed * influence_fraction * dt / (v1 - v0)
// For spatial properties, speed is in position-units/sec.

/**
 * Convert AEP speed/influence ease to normalized bezier control points.
 *
 * Returns (cx1, cy1, cx2, cy2) for use with BezierEasing.
 */
export function _easeToBezier1d(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  outEase: KeyframeEase,
  inEase: KeyframeEase,
): [number, number, number, number] {
  const dt = t1 - t0;
  const dv = v1 - v0;

  const oSpd = outEase.speed,
    oInf = outEase.influence;
  const iSpd = inEase.speed,
    iInf = inEase.influence;

  // Normalized influence (x-axis control points)
  const cx1 = oInf / 100.0;
  const cx2 = 1.0 - iInf / 100.0;

  // Normalized speed (y-axis control points)
  // cy1 = outgoing speed * influence_fraction * dt / dv
  // cy2 = 1 - incoming speed * influence_fraction * dt / dv
  let cy1: number;
  let cy2: number;
  if (Math.abs(dv) > 1e-12) {
    cy1 = (oSpd * cx1 * dt) / dv;
    cy2 = 1.0 - (iSpd * (1.0 - cx2) * dt) / dv;
  } else {
    // No value change: linear
    cy1 = cx1;
    cy2 = cx2;
  }

  return [cx1, cy1, cx2, cy2];
}

/**
 * The two value-space control points of a temporal bezier segment.
 *
 * After Effects places the ease handles absolutely - `v0 + speed_out * io * dt` and `v1 - speed_in * ii * dt`, with `io`/`ii` the influence
 * fractions - not as a fraction of `v1 - v0`. The two formulations agree
 * whenever the keys differ in value, and only the absolute one keeps the
 * curve bowing when they do not (issue #225: a 1-D BEZIER segment whose
 * keys both hold 50 peaks at 99.5 in AE, not 50).
 */
export function _easeValueHandles(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  outEase: KeyframeEase,
  inEase: KeyframeEase,
): [number, number] {
  const dt = t1 - t0;
  const io = outEase.influence / 100.0;
  const ii = inEase.influence / 100.0;
  return [v0 + outEase.speed * io * dt, v1 - inEase.speed * ii * dt];
}

/**
 * `dv/dt` on the temporal bezier segment at time `t`.
 *
 * The instantaneous speed a keyframe inserted at `t` has to carry for the
 * curve to come through unchanged.
 */
export function segmentValueSlope(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  outEase: KeyframeEase,
  inEase: KeyframeEase,
  t: number,
): number {
  const dt = t1 - t0;
  if (dt <= 0) return 0.0;
  const [cx1, _cy1, cx2, _cy2] = _easeToBezier1d(t0, t1, v0, v1, outEase, inEase);
  const easing = _getBezierEasing(cx1, _cy1, cx2, _cy2);
  const u = easing.parameterAt((t - t0) / dt);
  const [y1, y2] = _easeValueHandles(t0, t1, v0, v1, outEase, inEase);
  const mu = 1.0 - u;
  const dyDu = 3.0 * (mu * mu * (y1 - v0) + 2.0 * mu * u * (y2 - y1) + u * u * (v1 - y2));
  const dxDu = 3.0 * (mu * mu * cx1 + 2.0 * mu * u * (cx2 - cx1) + u * u * (1.0 - cx2));
  if (Math.abs(dxDu) < _VERTICAL_SLOPE_EPS) {
    // The curve is vertical here, so the speed is unbounded. AE reports
    // its saturation value rather than dividing, inside the same 1e-12
    // window; the sign follows the value axis. This is reachable at
    // 100 % influence on both sides, where dx/du is exactly 0 at the
    // midpoint.
    return dyDu >= 0.0 ? _VERTICAL_SLOPE : -_VERTICAL_SLOPE;
  }
  return dyDu / (dxDu * dt);
}

/**
 * Influences after splitting a BEZIER segment at `t`, as percentages.
 *
 * De Casteljau subdivision of the segment's time handles, which is what
 * keeps the curve identical. Returns
 * `(left_out, new_in, new_out, right_in)`; measured on AE 2026, splitting
 * a 5 s 0-\>100 segment eased 0/75 on both sides at 2.5 s gives
 * `(75, 12.5, 12.5, 75)`.
 */
export function splitSegmentInfluences(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  outEase: KeyframeEase,
  inEase: KeyframeEase,
  t: number,
): [number, number, number, number] {
  const dt = t1 - t0;
  if (dt <= 0) {
    return [outEase.influence, _DEFAULT_INFLUENCE, _DEFAULT_INFLUENCE, inEase.influence];
  }
  const [cx1, cy1, cx2, cy2] = _easeToBezier1d(t0, t1, v0, v1, outEase, inEase);
  const easing = _getBezierEasing(cx1, cy1, cx2, cy2);
  const u = easing.parameterAt((t - t0) / dt);

  const lerp = (a: number, b: number): number => a + (b - a) * u;

  const a = lerp(0.0, cx1);
  const b = lerp(cx1, cx2);
  const c = lerp(cx2, 1.0);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const xs = lerp(d, e);

  const leftSpan = xs;
  const rightSpan = 1.0 - xs;
  if (leftSpan <= 1e-12 || rightSpan <= 1e-12) {
    return [outEase.influence, _DEFAULT_INFLUENCE, _DEFAULT_INFLUENCE, inEase.influence];
  }
  // An influence is a percentage of its own sub-span, and a long handle on
  // a short half can exceed 100 - which AE cannot represent either. Clamp
  // to the storable range; the curve then bends by whatever the clamp cost.
  return [
    _clampInfluence((a / leftSpan) * 100.0),
    _clampInfluence(((xs - d) / leftSpan) * 100.0),
    _clampInfluence(((e - xs) / rightSpan) * 100.0),
    _clampInfluence(((1.0 - c) / rightSpan) * 100.0),
  ];
}

/**
 * Keep an influence inside the 0-100 % range the field holds.
 *
 * Not AE's 0.1 % dialog minimum: splitting a segment whose far side has a
 * blank (0) influence leaves that side at 0 in AE's own files (AE 2026).
 */
export function _clampInfluence(value: number): number {
  return min([max([value, 0.0]), 100.0]);
}

// ---------------------------------------------------------------------------
// Spatial motion path - arc length
// ---------------------------------------------------------------------------
// A spatial property travels along its motion path at the pace its temporal
// ease sets, so evaluating one means finding the curve parameter at a given
// DISTANCE along the path. AE's positions are not those of the exact arc
// length: they sit up to ~0.01 px off the curve, even on a straight segment,
// whose parameter still eases in and out (AE 2026: a LINEAR 100 px segment
// over 5 s reports 26.6774826 at 1.333 s, where the line gives 26.6667).
// This module reproduces them with an arc-length model: each segment sampled
// `_ARC_SAMPLES` times, uniformly in the curve parameter, the straight chords
// between the samples summed, a bezier spline fitted through the
// (parameter * length, distance) samples with Schneider's algorithm (P. J.
// Schneider, "An Algorithm for Automatically Fitting Digitized Curves",
// Graphics Gems, 1990) to the property's stored arc accuracy, and that
// spline inverted.
//
// The model matches only as written. A straight segment's samples are
// symmetric, so the fitter's split points are near-ties that rounding
// decides, and a different split moves the result by up to 6e-3 px: AE
// itself reports (0,0)->(100,100) and (20,0)->(120,100) that far apart. As
// written, this reproduces both - and every sampled frame of the
// value_at_time fixtures - to 1e-12, so keep the products and sums in the
// order they are in.

export const _ARC_SAMPLES = 128;
// The `tdb4` arc accuracy of a property stored in pixels, and the one a
// keyed normalized point (effect point, a footage layer's Anchor Point,
// layer-style point) stores: 6.25e-12, exactly this double in AE's files.
export const _DEFAULT_ARC_ACCURACY = 1e-4;
// float.fromhex("0x1.b7cdfd9d7bdbcp-38"), written as an exact double expression.
export const NORMALIZED_ARC_ACCURACY = (1 + 0xb7cdfd9d7bdbc / 2 ** 52) * 2 ** -38;
// The fit's handle length for a two-sample run: 0.333333333333333, not 1/3 -
// the value that reproduces AE's sampled positions.
export const _FIT_THIRD = 0.333333333333333;
// A LINEAR side's handle on the distance curve, as a fraction of the span on
// both axes: 0.16666666667, not 1/6, for the same reason.
export const _LINEAR_HANDLE = 0.16666666667;
// Largest coordinate measured as is; a farther curve is fitted scaled down so
// its squared chords stay finite.
export const _HUGE_COORDINATE = 1e150;

// Four control points of an N-dimensional cubic; tuples so a curve can key
// the spline cache.
export type _Curve = number[][];
export type _Point2 = [number, number];

/**
 * How AE measures one spatial property's motion path.
 *
 * AE measures a path in the property's STORED units, each dimension scaled
 * by a per-property multiplier, and fits its arc spline to a per-property
 * accuracy; both live in the property's `tdb4`. A layer's Position scales
 * X by the composition's pixel aspect, so it measures in square pixels. A
 * normalized point (stored as a fraction of the layer) scales X by the
 * layer's width / height, so both axes measure in layer heights.
 */
export class ArcMetric {
  readonly accuracy: number;
  // Per-dimension scale on a stored value before it is measured.
  readonly multipliers: readonly number[];
  // Reported / stored ratio per dimension, for a normalized point.
  readonly divisors: readonly number[] | null;
  // Reported / stored ratio of a temporal ease speed.
  readonly speedDivisor: number;

  /** NamedTuple positional constructor; the defaults are the Python field defaults. */
  constructor(
    accuracy: number = _DEFAULT_ARC_ACCURACY,
    multipliers: readonly number[] = [1.0, 1.0, 1.0],
    divisors: readonly number[] | null = null,
    speedDivisor: number = 1.0,
  ) {
    this.accuracy = accuracy;
    this.multipliers = multipliers;
    this.divisors = divisors;
    this.speedDivisor = speedDivisor;
  }

  /** NamedTuple unpacking: `accuracy, multipliers, divisors, speed_divisor = metric`. */
  *[Symbol.iterator](): Generator<number | readonly number[] | null> {
    yield this.accuracy;
    yield this.multipliers;
    yield this.divisors;
    yield this.speedDivisor;
  }
}

export const _DEFAULT_ARC_METRIC = new ArcMetric();

/** One coordinate of a cubic bezier, evaluated the way AE evaluates it. */
export function _cubic1d(a: number, b: number, c: number, d: number, t: number): number {
  const mt = 1.0 - t;
  const t2 = t * t;
  return ((3.0 * b * t + mt * a) * mt + 3.0 * c * t2) * mt + t2 * t * d;
}

export function _cubicPoint(curve: _Curve, t: number): number[] {
  const [p0, p1, p2, p3] = curve;
  return Array.from({ length: p0.length }, (_v, d) => _cubic1d(p0[d], p1[d], p2[d], p3[d], t));
}

/** A spatial segment's control points, in reported units. */
export function _spatialCurve(v0: number[], v1: number[], outTangent: number[], inTangent: number[]): _Curve {
  const ndim = v0.length;
  return [
    [...v0],
    Array.from({ length: ndim }, (_v, d) => v0[d] + outTangent[d]),
    Array.from({ length: ndim }, (_v, d) => v1[d] + inTangent[d]),
    [...v1],
  ];
}

/** A reported vector in the space AE measures arc length in. */
export function _measured(values: number[], metric: ArcMetric): number[] {
  const divisors = metric.divisors;
  const result: number[] = [];
  for (const [d, raw] of values.entries()) {
    let value = raw;
    if (divisors != null && d < divisors.length && divisors[d] !== 0) {
      value = value / divisors[d];
    }
    result.push(at(metric.multipliers, d) * value);
  }
  return result;
}

/**
 * A spatial segment's control points, in the space AE measures arc
 * length in.
 */
export function _measuredCurve(
  v0: number[],
  v1: number[],
  outTangent: number[],
  inTangent: number[],
  metric: ArcMetric,
): _Curve {
  return _spatialCurve(
    _measured(v0, metric),
    _measured(v1, metric),
    _measured(outTangent, metric),
    _measured(inTangent, metric),
  );
}

/** `(parameter, distance)` samples along `curve`, and its length. */
export function _arcSamples(curve: _Curve): [_Point2[], number] {
  const p0 = curve[0];
  const step = 1.0 / (_ARC_SAMPLES - 1);
  const samples: _Point2[] = [[0.0, 0.0]];
  let previous: number[] = p0;
  let total = 0.0;
  let t = step;
  for (let _i = 1; _i < _ARC_SAMPLES; _i++) {
    const point = _cubicPoint(curve, t);
    let squared = 0.0;
    for (let d = 0; d < point.length; d++) {
      const delta = point[d] - previous[d];
      squared = squared + delta * delta;
    }
    total = Math.sqrt(squared) + total;
    samples.push([t, total]);
    previous = point;
    // Accumulated, not `i * step`: the samples' low bits steer the fit.
    t = t + step;
  }
  return [samples, total];
}

export function _unit(x: number, y: number): _Point2 {
  const length = Math.sqrt(x * x + y * y);
  if (length === 0.0) return [x, y];
  const inverse = 1.0 / length;
  return [inverse * x, inverse * y];
}

export function _fitPoint(curve: _Point2[], u: number): _Point2 {
  const [p0, p1, p2, p3] = curve;
  return [
    _cubic1d(p0[0], p1[0], p2[0], p3[0], u),
    _cubic1d(p0[1], p1[1], p2[1], p3[1], u),
  ];
}

/** Schneider's chord-length parameterization of `points[first:last+1]`. */
export function _chordParameters(points: _Point2[], first: number, last: number): number[] {
  const u: number[] = [0.0];
  for (let i = first + 1; i <= last; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    u.push(Math.sqrt(dy * dy + dx * dx) + u[u.length - 1]);
  }
  const inverse = u[u.length - 1] !== 0.0 ? 1.0 / u[u.length - 1] : 0.0;
  return u.map((value) => inverse * value);
}

/**
 * Schneider's least-squares cubic through `points[first:last+1]`.
 *
 * Two departures from the published code, both needed to reproduce AE's
 * sampled positions: a near-singular system is regularized against 1e-4
 * rather than tested for exactly 0, and only a NEGATIVE handle length
 * falls back to the Wu/Barsky heuristic.
 */
export function _fitBezier(
  points: _Point2[],
  first: number,
  last: number,
  u: number[],
  tangent1: _Point2,
  tangent2: _Point2,
): _Point2[] {
  const p0 = points[first];
  const p3 = points[last];
  let c00 = 0.0;
  let c01 = 0.0;
  let c11 = 0.0;
  let x0 = 0.0;
  let x1 = 0.0;
  for (const [i, ui] of u.entries()) {
    const mu = 1.0 - ui;
    const u3 = ui * 3.0;
    const b1 = mu * mu * u3;
    const b2 = u3 * ui * mu;
    const a0x = tangent1[0] * b1;
    const a0y = b1 * tangent1[1];
    const a1x = b2 * tangent2[0];
    const a1y = b2 * tangent2[1];
    c00 += a0x * a0x + a0y * a0y;
    c01 += a0x * a1x + a0y * a1y;
    c11 += a1x * a1x + a1y * a1y;
    const b0 = mu * mu * mu;
    const b3 = ui * ui * ui;
    const point = points[first + i];
    const tx = point[0] - (b1 * p0[0] + b0 * p0[0] + b2 * p3[0] + b3 * p3[0]);
    const ty = point[1] - (b1 * p0[1] + b0 * p0[1] + b2 * p3[1] + b3 * p3[1]);
    x0 += a0x * tx + a0y * ty;
    x1 += a1x * tx + ty * a1y;
  }
  let det = c11 * c00 - c01 * c01;
  if (det < 1e-4) {
    if (det > -1e-4) {
      det = c11 * c00 * 10.0 * 1e-4;
    }
    if (det < 1e-4 && det > -1e-4) {
      det = 1e-3;
    }
  }
  let alphaL = (x0 * c11 - x1 * c01) / det;
  let alphaR = (x1 * c00 - x0 * c01) / det;
  if (alphaL < 0.0 || alphaR < 0.0) {
    const dx = p3[0] - p0[0];
    const dy = p3[1] - p0[1];
    alphaL = alphaR = Math.sqrt(dx * dx + dy * dy) * _FIT_THIRD;
  }
  return [
    p0,
    [alphaL * tangent1[0] + p0[0], alphaL * tangent1[1] + p0[1]],
    [alphaR * tangent2[0] + p3[0], alphaR * tangent2[1] + p3[1]],
    p3,
  ];
}

/**
 * The worst squared distance from `curve`, and where it is.
 *
 * A tie goes to the LATER sample, which is what decides the split on a
 * symmetric run.
 */
export function _fitError(
  points: _Point2[],
  first: number,
  last: number,
  curve: _Point2[],
  u: number[],
): [number, number] {
  let worst = 0.0;
  let split = floordiv(first + last + 1, 2);
  for (let i = first + 1; i < last; i++) {
    const q = _fitPoint(curve, u[i - first]);
    const dx = q[0] - points[i][0];
    const dy = q[1] - points[i][1];
    const squared = dy * dy + dx * dx;
    if (squared >= worst) {
      worst = squared;
      split = i;
    }
  }
  return [worst, split];
}

/**
 * Fit `points[first:last+1]`, appending the cubics' control points.
 *
 * Schneider's fitter tries a few Newton reparameterizations before
 * splitting, but only while the error is under the tolerance SQUARED. For
 * every tolerance below 1 - all AE writes - that bound lies under the
 * tolerance itself, so the fit always splits.
 */
export function _fitCubics(
  points: _Point2[],
  first: number,
  last: number,
  tangent1: _Point2,
  tangent2: _Point2,
  error: number,
  knots: _Point2[],
): void {
  let curve: _Point2[];
  if (last - first === 1) {
    const start = points[first];
    const end = points[last];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const reach = Math.sqrt(dx * dx + dy * dy) * _FIT_THIRD;
    curve = [
      start,
      [reach * tangent1[0] + start[0], reach * tangent1[1] + start[1]],
      [reach * tangent2[0] + end[0], reach * tangent2[1] + end[1]],
      end,
    ];
  } else {
    const u = _chordParameters(points, first, last);
    curve = _fitBezier(points, first, last, u, tangent1, tangent2);
    const [worst, split] = _fitError(points, first, last, curve, u);
    if (worst >= error) {
      const before = points[split - 1];
      const at = points[split];
      const after = points[split + 1];
      const center = _unit(
        (before[0] - at[0] + (at[0] - after[0])) * 0.5,
        (before[1] - at[1] + (at[1] - after[1])) * 0.5,
      );
      _fitCubics(points, first, split, tangent1, center, error, knots);
      _fitCubics(points, split, last, [-center[0], -center[1]], tangent2, error, knots);
      return;
    }
  }
  if (knots.length === 0) knots.push(curve[0]);
  knots.push(...curve.slice(1));
}

/**
 * The parameter at which `curve`'s `axis` coordinate reaches `value`.
 *
 * Snaps to either end within `_EPS`, and clamps outside them.
 */
export function _tOnAxis(curve: _Point2[], axis: number, value: number): number {
  const v0 = curve[0][axis];
  if (v0 > value || Math.abs(value - v0) < _EPS) return 0.0;
  const v3 = curve[3][axis];
  if (value > v3 || Math.abs(value - v3) < _EPS) return 1.0;
  const v1 = curve[1][axis];
  const v2 = curve[2][axis];
  const t = _solveCubic(
    (v1 - v2) * 3.0 - v0 + v3,
    (v0 - (v1 + v1) + v2) * 3.0,
    (v1 - v0) * 3.0,
    v0 - value,
  );
  // No root in [0, 1] only happens on a degenerate curve; AE's result is
  // undefined there, so take the linear estimate instead.
  return t == null ? (value - v0) / (v3 - v0) : t;
}

/**
 * Pull an overshooting handle back to the curve's range on the y axis.
 *
 * The handle is shortened along its own slope, not just clamped.
 */
export function _nonDecreasing(curve: _Point2[]): _Point2[] {
  const p0 = curve[0];
  let p1 = curve[1];
  let p2 = curve[2];
  const p3 = curve[3];
  if (p3[1] < p1[1]) {
    if (p1[1] - p0[1] === 0) throw new ZeroDivisionError("float division by zero");
    p1 = [((p3[1] - p0[1]) / (p1[1] - p0[1])) * (p1[0] - p0[0]) + p0[0], p3[1]];
  }
  if (p2[1] < p0[1]) {
    if (p3[1] - p2[1] === 0) throw new ZeroDivisionError("float division by zero");
    p2 = [((p3[1] - p0[1]) / (p3[1] - p2[1])) * (p2[0] - p3[0]) + p3[0], p0[1]];
  }
  return [p0, p1, p2, p3];
}

export function _isNonDecreasing(curve: _Point2[]): boolean {
  const [y0, y1, y2, y3] = curve.map((point) => point[1]);
  return !(
    (y1 < y0 && Math.abs(y1 - y0) >= _EPS) ||
    (y3 < y1 && Math.abs(y1 - y3) >= _EPS) ||
    (y2 < y0 && Math.abs(y2 - y0) >= _EPS) ||
    (y3 < y2 && Math.abs(y2 - y3) >= _EPS)
  );
}

/**
 * AE's arc-length model of one spatial segment.
 *
 * Built from the segment's control points in measured units.
 */
export class _ArcSpline {
  declare length: number;
  declare _knots: _Point2[];

  constructor(curve: _Curve, accuracy: number) {
    // Squared chords overflow past ~1e154, which any f64 value can reach:
    // fit a scaled copy instead (arc length scales linearly, the squared
    // tolerance quadratically) and scale the distances back.
    const reach = max(curve.flatMap((point) => point.map((c) => Math.abs(c))));
    const scale = reach > _HUGE_COORDINATE ? _HUGE_COORDINATE / reach : 1.0;
    if (scale !== 1.0) {
      curve = curve.map((point) => point.map((c) => c * scale));
      accuracy = accuracy * scale * scale;
    }
    const [samples, length] = _arcSamples(curve);
    this.length = length;
    const points: _Point2[] = samples.map(([t, s]): _Point2 => [this.length * t, s]);
    const last = points.length - 1;
    const knots: _Point2[] = [];
    _fitCubics(
      points,
      0,
      last,
      _unit(points[1][0] - points[0][0], points[1][1] - points[0][1]),
      _unit(points[last - 1][0] - points[last][0], points[last - 1][1] - points[last][1]),
      accuracy,
      knots,
    );
    const inverse = this.length !== 0.0 ? 1.0 / this.length : 0.0;
    this._knots = knots.slice(0, -1).map(([x, y]): _Point2 => [inverse * x, y / scale]);
    this._knots.push([1.0, knots[knots.length - 1][1] / scale]);
    this.length = this.length / scale;
  }

  /** The curve parameter `distance` along the segment. */
  parameterAt(distance: number): number {
    const knots = this._knots;
    const total = knots[knots.length - 1][1];
    if (distance < 0.0 || Math.abs(distance) < _EPS) return 0.0;
    if (distance > total || Math.abs(distance - total) < _EPS) return 1.0;
    let end = 3;
    while (end < knots.length) {
      if (Math.abs(distance - knots[end][1]) < _EPS) return knots[end][0];
      if (distance < knots[end][1]) break;
      end += 3;
    }
    let cubic = knots.slice(end - 3, end + 1);
    if (!_isNonDecreasing(cubic)) {
      cubic = _nonDecreasing(cubic);
    }
    const t = _tOnAxis(cubic, 1, distance);
    return _cubic1d(cubic[0][0], cubic[1][0], cubic[2][0], cubic[3][0], t);
  }
}

// NOTE(port): matches `functools.lru_cache(maxsize=1024)` (value-keyed via `tkey`, LRU eviction at 1024); pyrt `lruCache` keys by identity and would never hit.
export const _arcSplineCache = new Map<string, _ArcSpline>();

/** A cached `_ArcSpline`: every evaluated frame rebuilds the same one. */
export function _arcSpline(curve: _Curve, accuracy: number): _ArcSpline {
  const key = compositeKey(curve, accuracy);
  const cached = _arcSplineCache.get(key);
  if (cached !== undefined) {
    // Re-insert so the entry becomes the most recently used one.
    _arcSplineCache.delete(key);
    _arcSplineCache.set(key, cached);
    return cached;
  }
  const spline = new _ArcSpline(curve, accuracy);
  _arcSplineCache.set(key, spline);
  if (_arcSplineCache.size > 1024) {
    const oldest = _arcSplineCache.keys().next();
    if (!oldest.done) _arcSplineCache.delete(oldest.value);
  }
  return spline;
}

/** A spatial segment's arc length, in the units its ease speeds report. */
export function motionPathLength(
  v0: number[],
  v1: number[],
  outTangent: number[],
  inTangent: number[],
  metric: ArcMetric,
): number {
  const curve = _measuredCurve(v0, v1, outTangent, inTangent, metric);
  return _arcSpline(curve, metric.accuracy).length * metric.speedDivisor;
}

/**
 * The ease curve of a spatial span, in (seconds, distance).
 *
 * Absolute units, not a unit square: an eased side's handle reaches
 * `influence * duration` along time at its stored speed, and a LINEAR
 * side's sits `_LINEAR_HANDLE` along the chord whatever its stored ease
 * (so it is not read: a LINEAR ease derives from the path's arc length).
 * An overshooting handle is pulled back so the distance never reverses.
 */
export function _distanceCurve(
  duration: number,
  distance: number,
  kfStart: Keyframe,
  kfEnd: Keyframe,
  outType: KeyframeInterpolationType,
  inType: KeyframeInterpolationType,
  speedDivisor: number,
): _Point2[] {
  let outHandle: _Point2;
  if (outType === KeyframeInterpolationType.LINEAR) {
    outHandle = [duration * _LINEAR_HANDLE, distance * _LINEAR_HANDLE];
  } else {
    const outEase = kfStart.outTemporalEase[0];
    const reach = duration * (outEase.influence / 100.0);
    outHandle = [reach, reach * (outEase.speed / speedDivisor)];
  }
  let inHandle: _Point2;
  if (inType === KeyframeInterpolationType.LINEAR) {
    inHandle = [duration - duration * _LINEAR_HANDLE, distance - distance * _LINEAR_HANDLE];
  } else {
    const inEase = kfEnd.inTemporalEase[0];
    const reach = -(inEase.influence / 100.0) * duration;
    inHandle = [reach + duration, reach * (inEase.speed / speedDivisor) + distance];
  }
  return _nonDecreasing([[0.0, 0.0], outHandle, inHandle, [duration, distance]]);
}

/**
 * Distance travelled `elapsed` seconds into a spatial span.
 *
 * The span runs from `kfStart` to `kfEnd`, a single segment or a whole
 * roving run. HOLD on either side keeps it at the start.
 */
export function _spatialDistance(
  elapsed: number,
  duration: number,
  distance: number,
  kfStart: Keyframe,
  kfEnd: Keyframe,
  speedDivisor: number,
): number {
  const outType = kfStart.outInterpolationType;
  const inType = kfEnd.inInterpolationType;
  if ([outType, inType].includes(KeyframeInterpolationType.HOLD)) return 0.0;
  if (outType === KeyframeInterpolationType.LINEAR && inType === KeyframeInterpolationType.LINEAR) {
    return (elapsed / duration) * distance;
  }
  const curve = _distanceCurve(duration, distance, kfStart, kfEnd, outType, inType, speedDivisor);
  const [y0, y1, y2, y3] = curve.map((point) => point[1]);
  if (y0 === y1 && y1 === y2 && y2 === y3) return y0;
  const t = _tOnAxis(curve, 0, elapsed);
  return _cubic1d(y0, y1, y2, y3, t);
}

/**
 * De Casteljau split of a spatial segment at parameter `u`.
 *
 * Returns `(left_out, new_in, split_point, new_out, right_in)` - the four
 * tangents the two halves need, plus the point they meet at. Splitting the
 * path is what lets a keyframe be inserted without moving the motion path.
 */
export function splitSpatialPath(
  v0: number[],
  v1: number[],
  outTangent: number[],
  inTangent: number[],
  u: number,
): [number[], number[], number[], number[], number[]] {
  const ndim = v0.length;
  const p0 = [...v0];
  const p1 = Array.from({ length: ndim }, (_v, d) => v0[d] + outTangent[d]);
  const p2 = Array.from({ length: ndim }, (_v, d) => v1[d] + inTangent[d]);
  const p3 = [...v1];

  const lerp = (a: number[], b: number[]): number[] =>
    Array.from({ length: ndim }, (_v, d) => a[d] + (b[d] - a[d]) * u);

  const a = lerp(p0, p1);
  const b = lerp(p1, p2);
  const c = lerp(p2, p3);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const split = lerp(d, e);
  return [
    Array.from({ length: ndim }, (_v, i) => a[i] - p0[i]),
    Array.from({ length: ndim }, (_v, i) => d[i] - split[i]),
    split,
    Array.from({ length: ndim }, (_v, i) => e[i] - split[i]),
    Array.from({ length: ndim }, (_v, i) => c[i] - p3[i]),
  ];
}

export function _tangentsAreZero(tangent: number[] | null): boolean {
  if (tangent == null) return true;
  return tangent.every((x) => Math.abs(x) < 1e-12);
}

// ---------------------------------------------------------------------------
// Auto-bezier computation (same as original - needed for AEP binary data)
// ---------------------------------------------------------------------------

export const _AUTO_BEZIER_CHORD_SCALE = 1.0 / 6.0;

/**
 * AE's auto-bezier spatial tangents for `values[index]`.
 *
 * The tangent is one sixth of the chord between the keyframe's two
 * neighbours, applied symmetrically: `in = -out`. An endpoint uses the
 * chord to its single neighbour, and still gets both tangents. A lone
 * keyframe gets zeros.
 *
 * Measured on AE 2018 (a five-key diamond, every tangent matching) and on
 * AE 2026 with deliberately uneven time spacing, which rules out the
 * time-weighted variant this used to implement - that agrees with AE only
 * when the neighbours are equidistant in time.
 *
 * The result is expressed in whatever space `values` are in, so callers
 * working in raw chunk units and callers working in resolved units both
 * get a self-consistent answer.
 *
 * @returns An `(out_tangent, in_tangent)` pair.
 */
export function autoSpatialTangents(values: number[][], index: number): [number[], number[]] {
  const ndim = values[index].length;
  const zero = new Array<number>(ndim).fill(0.0);
  if (values.length < 2) return [zero, [...zero]];
  const low = index > 0 ? values[index - 1] : values[index];
  const high = index < values.length - 1 ? values[index + 1] : values[index];
  const outTangent = Array.from({ length: ndim }, (_v, d) => (high[d] - low[d]) * _AUTO_BEZIER_CHORD_SCALE);
  return [outTangent, outTangent.map((component) => -component)];
}

/**
 * AE's auto-bezier temporal speeds for `values[index]`, per dimension.
 *
 * An interior keyframe takes the through-slope across its neighbours on
 * both sides. An endpoint takes the slope of its single segment on the
 * inward side and zero on the outward side. Influence is always
 * `_DEFAULT_INFLUENCE`.
 *
 * Multi-dimensional properties get a per-dimension slope (measured on AE
 * 2026: 2-D Scale 100-\>200-\>400 / 100-\>120-\>150 yields speeds 150 and 25).
 *
 * @returns An `(in_speeds, out_speeds)` pair, one entry per dimension.
 */
export function autoTemporalSpeeds(values: number[][], times: number[], index: number): [number[], number[]] {
  const ndim = values[index].length;
  const zero = new Array<number>(ndim).fill(0.0);
  const count = values.length;
  if (count < 2) return [[...zero], [...zero]];

  const slope = (lo: number, hi: number): number[] => {
    const span = times[hi] - times[lo];
    if (span <= 0) return new Array<number>(ndim).fill(0.0);
    return Array.from({ length: ndim }, (_v, d) => (values[hi][d] - values[lo][d]) / span);
  };

  if (index === 0) return [[...zero], slope(0, 1)];
  if (index === count - 1) return [slope(count - 2, count - 1), [...zero]];
  const through = slope(index - 1, index + 1);
  return [through, [...through]];
}

/**
 * Ease curve mapping a time fraction to a progress fraction, for eases
 * whose speed is dimensionless (1 = the chord slope, see
 * `_singleProgress`). `null` means "no explicit ease", i.e. constant
 * progress.
 */
export function _progressEasing(
  outEase: KeyframeEase | null,
  inEase: KeyframeEase | null,
  kw: { outLinear?: boolean; inLinear?: boolean } = {},
): _BezierEasing | null {
  const { outLinear = false, inLinear = false } = kw;
  if (outEase == null || inEase == null) return null;
  if (outEase.influence <= 0 && inEase.influence <= 0) return null;

  const outInfFrac = outEase.influence / 100.0;
  const inInfFrac = inEase.influence / 100.0;

  let cx1 = outInfFrac;
  let cy1 = outEase.speed * outInfFrac;
  let cx2 = 1.0 - inInfFrac;
  let cy2 = 1.0 - inEase.speed * inInfFrac;

  // A LINEAR side carries no ease: its handle sits on the diagonal, so
  // progress advances at a constant rate on that side. The side's
  // interpolation type governs the EASE only - the path itself always
  // follows the spatial tangents (AE 2026).
  if (outLinear) cy1 = cx1;
  if (inLinear) cy2 = cx2;

  // Between two eased sides, a handle that reaches past the unit square is
  // shortened ALONG ITS OWN SLOPE, which keeps the speed the user asked for
  // and spends influence instead (AE 2026: Orientation eases at speed 5 to
  // 200 against an eased far side). Facing a LINEAR side it is kept and
  // the progress overshoots instead: an Orientation eased at speed 50 /
  // influence 50 % into a LINEAR key reads [203.94, 60.25, 293.25] 0.125 s
  // in - about 2.9 times the way - and a mask path bows past its end shape
  // the same way (AE 2026).
  if (!(outLinear || inLinear)) {
    if (cy1 > 1.0) {
      cx1 = cx1 / cy1;
      cy1 = 1.0;
    } else if (cy1 < 0.0) {
      cy1 = 0.0;
    }
    if (cy2 < 0.0) {
      cx2 = 1.0 - (1.0 - cx2) / (1.0 - cy2);
      cy2 = 0.0;
    } else if (cy2 > 1.0) {
      cy2 = 1.0;
    }
  }

  return _getBezierEasing(cx1, cy1, cx2, cy2);
}

/**
 * Time units for every roving keyframe, spaced along the motion path.
 *
 * A roving keyframe's time is derived, not stored: AE places it where the
 * enclosing anchors' eased span has travelled the path up to it. The
 * anchors' ease applies ONCE across the whole run, so the time is read
 * off the same (seconds, distance) curve the run's value is evaluated on,
 * then rounded half up to the layer's units - truncated instead when both
 * anchors are LINEAR, whose time is computed in units directly. Each
 * result is clamped so the run keeps one unit per keyframe inside its
 * anchors.
 *
 * The spacing follows the length of the actual curve, not the chord
 * between keyframes - measured on AE 2026 with one segment bowed by +/-400 px
 * tangents, where chord length predicts 0.667 s and AE produced 2.2205 s.
 * A 4-point run over 8 s with 0/80 ease on both anchors puts the two
 * roving keys at 3.54484 and 4.308594.
 *
 * @returns A `{keyframe index: time units}` mapping covering only the roving keyframes that sit
 *   between two anchors. Units count LAYER time, so a stretched layer needs no further conversion.
 */
export function rovingKeyframeTimes(keyframes: Keyframe[], metric: ArcMetric): Map<number, number> {
  const result = new Map<number, number>();
  // The first and last keys bound a run even when flagged roving: removing
  // the first anchor leaves the flag on the key that becomes first, and AE
  // 2026 keeps it there and times the run from that key.
  const final = keyframes.length - 1;
  const anchors = [...keyframes.entries()]
    .filter(([i, kf]) => !kf.roving || [0, final].includes(i))
    .map(([i]) => i);
  if (anchors.length < 2) return result;
  for (let k = 0; k < anchors.length - 1; k++) {
    const start = anchors[k];
    const end = anchors[k + 1];
    if (end - start < 2) continue;
    if (!keyframes.slice(start, end + 1).every((kf) => Array.isArray(kf._storedValue))) continue;
    const [splines, total] = _runSplines(keyframes, start, end, metric);
    if (total <= 0) continue;
    const first = keyframes[start];
    const last = keyframes[end];
    const units0 = first.timeUnits;
    const units1 = last.timeUnits;
    const outType = first.outInterpolationType;
    const inType = last.inInterpolationType;
    // HOLD on either anchor keeps the whole run at its start.
    const held = [outType, inType].includes(KeyframeInterpolationType.HOLD);
    let curve: _Point2[] | null = null;
    let timebase = 0.0;
    if (
      !held &&
      !(outType === KeyframeInterpolationType.LINEAR && inType === KeyframeInterpolationType.LINEAR)
    ) {
      timebase = first._timebase;
      curve = _distanceCurve(
        (units1 - units0) / timebase,
        total,
        first,
        last,
        outType,
        inType,
        metric.speedDivisor,
      );
    }
    let travelled = 0.0;
    for (let index = start + 1; index < end; index++) {
      travelled += splines[index - start - 1].length;
      const units = held ? units0 : _rovingUnits(curve, timebase, units0, units1, travelled, total);
      result.set(index, Math.min(Math.max(units, units0 + index - start), units1 - (end - index)));
    }
  }
  return result;
}

/**
 * The time unit at which a roving run has travelled `travelled`, read
 * off the run's ease `curve` (`null` when both anchors are LINEAR).
 */
export function _rovingUnits(
  curve: _Point2[] | null,
  timebase: number,
  units0: number,
  units1: number,
  travelled: number,
  total: number,
): number {
  if (curve == null) return int((units1 - units0) * (travelled / total) + units0);
  const t = _tOnAxis(curve, 1, travelled);
  const seconds = _cubic1d(curve[0][0], curve[1][0], curve[2][0], curve[3][0], t);
  return units0 + Math.floor(timebase * seconds + 0.5);
}

/**
 * The `(out, in)` spatial tangents of `keyframes[first]` to
 * `keyframes[last]`, by index, auto-bezier ones derived.
 *
 * An auto-bezier keyframe's stored tangents are NOT used even when they
 * are non-zero: AE recomputes them from the flag and ignores what is on
 * disk, so its own files legitimately carry stale values. Only the keys
 * asked for (and an auto-bezier key's neighbours) are read: evaluating
 * one segment must not walk every keyframe of a long track.
 */
export function _spatialTangents(keyframes: Keyframe[], first: number, last: number): Map<number, [number[], number[]]> {
  const result = new Map<number, [number[], number[]]>();
  for (let i = first; i <= last; i++) {
    const kf = keyframes[i];
    if (kf.spatialAutoBezier) {
      const low = Math.max(i - 1, 0);
      const window = keyframes.slice(low, i + 2).map((k) => k._storedValue as number[]);
      result.set(i, autoSpatialTangents(window, i - low));
      continue;
    }
    const zero = new Array<number>((kf._storedValue as number[]).length).fill(0.0);
    const outTangent = kf.outSpatialTangent;
    const inTangent = kf.inSpatialTangent;
    result.set(i, [outTangent != null && outTangent.length > 0 ? outTangent : zero, inTangent != null && inTangent.length > 0 ? inTangent : zero]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Segment interpolation - lottie-web approach
// ---------------------------------------------------------------------------

/**
 * Interpolate 1D using lottie-web's BezierEasing approach.
 *
 * Converts speed/influence to normalized bezier control points,
 * then uses BezierEasing to get the eased progress, then lerps.
 */
export function _interpolateBezier1d(
  t: number,
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  outEase: KeyframeEase,
  inEase: KeyframeEase,
): number {
  const dt = t1 - t0;
  if (dt === 0) return v0;

  // Convert AEP ease to normalized bezier control points. Only the x
  // (time) axis is used to find the curve parameter; the value axis is
  // evaluated from absolute control points so a segment whose keys hold
  // the same value still bows (see `_easeValueHandles`).
  const [cx1, cy1, cx2, cy2] = _easeToBezier1d(t0, t1, v0, v1, outEase, inEase);

  // Get easing function (cached)
  const easing = _getBezierEasing(cx1, cy1, cx2, cy2);

  // Normalized time fraction
  const x = (t - t0) / dt;
  const u = easing.parameterAt(x);

  const [y1, y2] = _easeValueHandles(t0, t1, v0, v1, outEase, inEase);
  const mu = 1.0 - u;
  return mu * mu * mu * v0 + 3.0 * mu * mu * u * y1 + 3.0 * mu * u * u * y2 + u * u * u * v1;
}

/** The arc spline of the segment from `keyframes[index]` to the next. */
export function _segmentSpline(
  keyframes: Keyframe[],
  index: number,
  tangents: Map<number, [number[], number[]]>,
  metric: ArcMetric,
): _ArcSpline {
  const curve = _measuredCurve(
    keyframes[index]._storedValue as number[],
    keyframes[index + 1]._storedValue as number[],
    getOrThrow(tangents, index)[0],
    getOrThrow(tangents, index + 1)[1],
    metric,
  );
  return _arcSpline(curve, metric.accuracy);
}

/**
 * The arc splines of the segments from `keyframes[start]` to
 * `keyframes[end]`, and their total length (summed left to right).
 */
export function _runSplines(keyframes: Keyframe[], start: number, end: number, metric: ArcMetric): [_ArcSpline[], number] {
  const tangents = _spatialTangents(keyframes, start, end);
  const splines: _ArcSpline[] = [];
  for (let i = start; i < end; i++) splines.push(_segmentSpline(keyframes, i, tangents, metric));
  let total = 0.0;
  for (const spline of splines) total += spline.length;
  return [splines, total];
}

/**
 * The control points of the segment from `keyframes[index]` to the
 * next, in reported units.
 */
export function _segmentCurve(keyframes: Keyframe[], index: number): _Curve {
  const tangents = _spatialTangents(keyframes, index, index + 1);
  return _spatialCurve(
    keyframes[index]._storedValue as number[],
    keyframes[index + 1]._storedValue as number[],
    getOrThrow(tangents, index)[0],
    getOrThrow(tangents, index + 1)[1],
  );
}

/**
 * AE's temporal auto-bezier speed for `keyframes[index]` on a motion path.
 *
 * One speed along the path, not one per dimension: the arc distance
 * between the neighbouring anchors (roving keys skipped) over their time
 * span - at either end, the single segment's. AE derives it rather than
 * storing it: its own files hold speed 0 and influence 0 there (AE 2026,
 * three auto-bezier keys on Position).
 */
export function autoPathSpeed(keyframes: Keyframe[], index: number, metric: ArcMetric): number {
  const low = index > 0 ? _runBounds(keyframes, index - 1)[0] : index;
  const high = index < keyframes.length - 1 ? _runBounds(keyframes, index)[1] : index;
  return _pathSpeed(keyframes, low, high, metric);
}

/**
 * The speed AE reports for a LINEAR side of the segment that starts at
 * `keyframes[index]` on a motion path.
 *
 * The arc length - not the chord - over the time span, taken across the
 * whole roving run the segment belongs to (measured on AE 2026: a LINEAR
 * segment bowed by its tangents reports 263.41 where the chord gives 200,
 * one with coincident keys but non-zero tangents 188.63, and every side
 * of a roving run the run's length over its span).
 */
export function linearPathSpeed(keyframes: Keyframe[], index: number, metric: ArcMetric): number {
  const [low, high] = _runBounds(keyframes, index);
  return _pathSpeed(keyframes, low, high, metric);
}

/**
 * The anchors enclosing the segment that starts at `keyframes[left]`:
 * the ends of the roving run it belongs to.
 */
export function _runBounds(keyframes: Keyframe[], left: number): [number, number] {
  let start = left;
  let end = left + 1;
  while (start > 0 && keyframes[start].roving) start -= 1;
  while (end < keyframes.length - 1 && keyframes[end].roving) end += 1;
  return [start, end];
}

/**
 * The arc distance from `keyframes[low]` to `keyframes[high]` over their
 * time span, in the units ease speeds report.
 */
export function _pathSpeed(keyframes: Keyframe[], low: number, high: number, metric: ArcMetric): number {
  const span = keyframes[high]._layerTime - keyframes[low]._layerTime;
  if (span <= 0) return 0.0;
  const [, distance] = _runSplines(keyframes, low, high, metric);
  return (distance / span) * metric.speedDivisor;
}

/**
 * Where a motion path is at `time`: a segment and its curve parameter.
 *
 * `time` is in the owning layer's seconds, strictly inside the segment
 * starting at `keyframes[left]`. A roving keyframe is not an ease
 * boundary: AE eases a whole roving run once, between its anchors, and
 * walks the run's segments by distance - so the segment returned can be
 * another one of the run. Easing each sub-segment on its own instead (with
 * the per-segment speeds AE leaves on the roving keys) is 99 px out on
 * the measured 4-point fixture.
 *
 * @returns `(index, u)`: the segment starting at `keyframes[index]`, and the curve parameter along
 *   it.
 */
export function spatialLocation(time: number, keyframes: Keyframe[], left: number, metric: ArcMetric): [number, number] {
  const [start, end] = _runBounds(keyframes, left);
  const [splines, total] = _runSplines(keyframes, start, end, metric);
  const first = keyframes[start];
  const last = keyframes[end];
  const t0 = first._layerTime;
  let distance = _spatialDistance(time - t0, last._layerTime - t0, total, first, last, metric.speedDivisor);
  let index = 0;
  while (index < splines.length - 1 && distance > splines[index].length) {
    distance -= splines[index].length;
    index += 1;
  }
  return [start + index, splines[index].parameterAt(distance)];
}

/**
 * The direction a motion path heads at `time`, in layer seconds.
 *
 * What auto-orientation along a path follows. At a keyframe it is the
 * outgoing segment's start, before the first key the first segment's
 * start and past the last the last segment's end (measured on AE 2026).
 * `null` without a path to follow, and inside a held segment: AE 2026
 * turns a layer whose current segment starts on a HOLD key not at all,
 * while past the last key it still follows the last segment.
 */
export function motionPathDirection(time: number, keyframes: Keyframe[], metric: ArcMetric): number[] | null {
  // Every keyframe of a property holds the same kind of value.
  if (keyframes.length < 2 || !Array.isArray(keyframes[0]._storedValue)) return null;
  const last = keyframes.length - 2;
  let index: number;
  let u: number;
  if (time >= keyframes[keyframes.length - 1]._layerTime) {
    index = last;
    u = 1.0;
  } else {
    index = 0;
    while (index < last && keyframes[index + 1]._layerTime <= time) index += 1;
    if (time <= keyframes[index]._layerTime) {
      u = 0.0;
    } else {
      [index, u] = spatialLocation(time, keyframes, index, metric);
    }
    if (keyframes[index].outInterpolationType === KeyframeInterpolationType.HOLD) return null;
  }
  const [p0, p1, p2, p3] = _segmentCurve(keyframes, index);
  const mt = 1 - u;
  let direction = Array.from(
    { length: p0.length },
    (_v, d) =>
      3 * mt * mt * (p1[d] - p0[d]) + 6 * mt * u * (p2[d] - p1[d]) + 3 * u * u * (p3[d] - p2[d]),
  );
  // A handle of zero length stalls the curve at its end: the path then
  // heads toward the next control point along.
  const fallbacks: [number[], number[]][] = u < 0.5 ? [[p2, p0], [p3, p0]] : [[p3, p1], [p3, p0]];
  for (const [head, tail] of fallbacks) {
    if (direction.some((c) => Math.abs(c) > 1e-9)) break;
    direction = Array.from({ length: p0.length }, (_v, d) => head[d] - tail[d]);
  }
  return direction;
}

// ---------------------------------------------------------------------------
// Single-progress value kinds: paths and Orientation
// ---------------------------------------------------------------------------
// A mask / shape path and an Orientation keyframe carry ONE ease per side
// (their value has no per-component speed to ease against), and AE drives
// the whole value along that single progress. Measured on AE 2026 across
// LINEAR, eased, asymmetric and mixed LINEAR/BEZIER key pairs: a path and
// an Orientation with the same ease yield the same progress curve, and
// every ease AE writes for these kinds stores a speed of 0.
/**
 * The eased 0-1 parameter AE drives a path or Orientation segment with.
 *
 * These values have no scalar magnitude for a speed to be a rate OF, so
 * a stored ease speed is dimensionless: 1 means the chord slope, which
 * is exactly what AE reports for a LINEAR side. Unit time against unit
 * arc length says exactly that, and leaves the handle at
 * `speed * influence` - measured on AE 2026, where normalizing against
 * the rotation arc instead is 33 degrees out on a 40 deg/s Orientation
 * ease.
 *
 * @param kfLeft - The keyframe starting the segment.
 * @param kfRight - The keyframe ending it.
 * @param time - Evaluation time, in the owning layer's seconds.
 * @param t0 - `kfLeft`'s layer time.
 * @param t1 - `kfRight`'s layer time.
 */
export function _singleProgress(
  kfLeft: Keyframe,
  kfRight: Keyframe,
  time: number,
  t0: number,
  t1: number,
): number {
  // Bound to locals: `in/out_temporal_ease` re-derives its list on every
  // read, and this runs once per interpolated frame.
  const outEase = kfLeft.outTemporalEase;
  const inEase = kfRight.inTemporalEase;
  const easing = _progressEasing(
    outEase?.length > 0 ? outEase[0] : null,
    inEase?.length > 0 ? inEase[0] : null,
    {
      outLinear: kfLeft.outInterpolationType === KeyframeInterpolationType.LINEAR,
      inLinear: kfRight.inInterpolationType === KeyframeInterpolationType.LINEAR,
    },
  );
  const x = (time - t0) / (t1 - t0);
  return easing != null ? easing.get(x) : x;
}

/** A rotation of `degrees` about axis 0 (X), 1 (Y) or 2 (Z). */
export function _axisQuaternion(axis: number, degrees: number): [number, number, number, number] {
  const half = radians(degrees) / 2.0;
  const parts = [0.0, 0.0, 0.0, Math.cos(half)];
  parts[axis] = Math.sin(half);
  return [parts[0], parts[1], parts[2], parts[3]];
}

export function _quaternionMultiply(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * Orientation angles in degrees as a quaternion.
 *
 * Uses AE's own composition order, `Rx . Ry . Rz` - the same one
 * `buildLocalMatrix` applies an Orientation with.
 */
export function eulerToQuaternion(angles: number[]): [number, number, number, number] {
  let q: [number, number, number, number] = [0.0, 0.0, 0.0, 1.0];
  for (const [axis, angle] of angles.slice(0, 3).entries()) {
    q = _quaternionMultiply(q, _axisQuaternion(axis, angle));
  }
  return q;
}

/**
 * The `Rx . Ry . Rz` angles of `q`, in degrees wrapped into [0, 360).
 *
 * AE reports a rotation that runs backwards past zero as its positive
 * equivalent - a Z orientation eased from 10 to 350 reads 357.5, not
 * -2.5 (AE 2026).
 *
 * The extraction itself is `_eulerXyz`, which this feeds the quaternion's
 * rotation matrix; only the elements it needs are built.
 */
export function quaternionToEuler(q: readonly number[]): number[] {
  let [x, y, z, w] = q;
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (norm > 0) {
    x = x / norm;
    y = y / norm;
    z = z / norm;
    w = w / norm;
  }
  return _eulerXyz(
    1.0 - 2.0 * (y * y + z * z), // m00
    2.0 * (x * y - z * w), // m01
    2.0 * (x * z + y * w), // m02
    2.0 * (x * y + z * w), // m10
    1.0 - 2.0 * (x * x + z * z), // m11
    2.0 * (y * z - x * w), // m12
    1.0 - 2.0 * (x * x + y * y), // m22
  ).map((angle) => mod(angle, 360.0));
}

/**
 * Interpolate two Orientation values the way After Effects does.
 *
 * AE turns both ends into quaternions, takes the shortest arc between
 * them and reads it at `progress` - NOT a per-axis blend of the angles.
 * Verified against AE 2026 to 1e-13 degrees: `[0,0,0]` to `[45,90,30]`
 * reads `[22.0832, 42.8194, 22.0832]` at the midpoint, where a per-axis
 * blend would give `[22.5, 45, 15]`.
 */
export function slerpOrientation(start: number[], end: number[], progress: number): number[] {
  const q0 = eulerToQuaternion(start);
  let q1 = eulerToQuaternion(end);
  let dot = sum(q0.map((a, i) => a * q1[i]));
  if (dot < 0.0) {
    // Opposite hemisphere: negate so the arc taken is the short one.
    q1 = [-q1[0], -q1[1], -q1[2], -q1[3]];
    dot = -dot;
  }
  dot = min([1.0, max([-1.0, dot])]);
  if (dot > 0.9995) {
    // Nearly parallel: sin(theta) underflows, and a normalized linear
    // blend is within float noise of the arc.
    const blend = q0.map((a, i) => a + (q1[i] - a) * progress);
    return quaternionToEuler(blend);
  }
  // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const s0 = Math.sin((1.0 - progress) * theta) / sinTheta;
  const s1 = Math.sin(progress * theta) / sinTheta;
  return quaternionToEuler(
    q0.map((a, i) => a * s0 + q1[i] * s1),
  );
}

export function _lerpPoints(a: number[][], b: number[][], progress: number): number[][] {
  return zip(a, b).map(([p, q]) => [p[0] + (q[0] - p[0]) * progress, p[1] + (q[1] - p[1]) * progress]);
}

export function _lerpPoint(a: _Point2, b: _Point2, t: number): _Point2 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// A cubic bezier segment: start, its out handle, the end's in handle, end.
export type _Cubic = [_Point2, _Point2, _Point2, _Point2];

/**
 * De Casteljau: the two halves of `cubic` either side of `t`.
 *
 * `splitSpatialPath` above is the same subdivision, but it speaks the
 * TANGENT representation and returns one side. Resampling chains splits
 * and wants both halves as control points, which is what this returns -
 * marshalling between the two costs more than the 6 lerps do.
 */
export function _splitCubic(cubic: _Cubic, t: number): [_Cubic, _Cubic] {
  const [p0, p1, p2, p3] = cubic;
  const a = _lerpPoint(p0, p1, t);
  const b = _lerpPoint(p1, p2, t);
  const c = _lerpPoint(p2, p3, t);
  const d = _lerpPoint(a, b, t);
  const e = _lerpPoint(b, c, t);
  const f = _lerpPoint(d, e, t);
  return [
    [p0, a, d, f],
    [f, e, c, p3],
  ];
}

/**
 * Where AE cuts each segment to reach `targetCount` segments.
 *
 * After Effects bisects breadth-first: every segment once in path
 * order, then every half in that same order, and so on, stopping the
 * moment the counts match. Measured on AE 2026 over 22 source/target
 * pairs from 2 to 12 vertices, open and closed - the distribution
 * depends on the counts alone, not on either path's geometry (a target
 * of a completely different shape, and a source with even rather than
 * lopsided segments, both cut identically).
 */
export function _subdivisionCuts(segmentCount: number, targetCount: number): number[][] {
  const pieces: [number, number, number][] = [];
  for (let index = 0; index < segmentCount; index++) pieces.push([index, 0.0, 1.0]);
  while (pieces.length < targetCount) {
    const piece = pieces.shift();
    if (piece === undefined) throw new IndexError("pop from an empty deque");
    const [index, start, end] = piece;
    const middle = (start + end) / 2.0;
    pieces.push([index, start, middle]);
    pieces.push([index, middle, end]);
  }
  const cuts: number[][] = Array.from({ length: segmentCount }, () => []);
  for (const [index, start] of pieces) {
    if (start > 0.0) cuts[index].push(start);
  }
  for (const perSegment of cuts) {
    perSegment.splice(0, perSegment.length, ...sorted(perSegment));
  }
  return cuts;
}

/**
 * Add vertices to a path until it has `target` of them, shape intact.
 *
 * The new vertices land where a de Casteljau split puts them, so the
 * outline is unchanged - only its parameterisation gains points.
 */
export function _resamplePath(
  vertices: number[][],
  inTangents: number[][],
  outTangents: number[][],
  closed: boolean,
  target: number,
): [number[][], number[][], number[][]] {
  const count = vertices.length;
  const segmentCount = closed ? count : count - 1;
  if (segmentCount < 1) {
    // A one-vertex open path: nothing to subdivide, so it cannot be
    // brought up to `target`. The caller checks the resulting length.
    return [vertices, inTangents, outTangents];
  }
  const cuts = _subdivisionCuts(segmentCount, segmentCount + target - count);

  const chain: _Cubic[] = [];
  for (let index = 0; index < segmentCount; index++) {
    const tail = (index + 1) % count;
    const start: _Point2 = [vertices[index][0], vertices[index][1]];
    const end: _Point2 = [vertices[tail][0], vertices[tail][1]];
    const outT = outTangents[index];
    const inT = inTangents[tail];
    if (!outT.some((x) => x !== 0) && !inT.some((x) => x !== 0)) {
      // AE keeps a straight segment straight: the new vertices land
      // on the line at the cut parameters and every handle stays
      // zero. Splitting it as the degenerate cubic instead would put
      // them at 0.15625 rather than 0.25 and hand each one a handle
      // a quarter of the segment long (AE 2026).
      const bounds = [0.0, ...cuts[index], 1.0];
      for (const [low, high] of zip(bounds, bounds.slice(1))) {
        const a = _lerpPoint(start, end, low);
        const b = _lerpPoint(start, end, high);
        chain.push([a, a, b, b]);
      }
      continue;
    }
    let cubic: _Cubic = [
      start,
      [start[0] + outT[0], start[1] + outT[1]],
      [end[0] + inT[0], end[1] + inT[1]],
      end,
    ];
    let consumed = 0.0;
    for (const cut of cuts[index]) {
      const [left, right] = _splitCubic(cubic, (cut - consumed) / (1.0 - consumed));
      chain.push(left);
      cubic = right;
      consumed = cut;
    }
    chain.push(cubic);
  }

  const newVertices: number[][] = chain.map((c) => [c[0][0], c[0][1]]);
  const newOut: number[][] = chain.map((c) => [c[1][0] - c[0][0], c[1][1] - c[0][1]]);
  // Each piece's own IN handle, measured at the vertex it arrives at.
  const arriving: number[][] = chain.map((c) => [c[2][0] - c[3][0], c[2][1] - c[3][1]]);
  let newIn: number[][];
  if (closed) {
    // Every vertex starts a piece, so its IN handle comes from the
    // piece before it - the last one wrapping around to vertex 0.
    newIn = [...arriving.slice(-1), ...arriving.slice(0, -1)];
  } else {
    // The open path's final vertex ends the last piece rather than
    // starting one, so it is appended, and the first vertex keeps the
    // original path's own leading handles.
    const lastPiece = chain[chain.length - 1];
    newVertices.push([lastPiece[3][0], lastPiece[3][1]]);
    newOut.push([...outTangents[outTangents.length - 1]]);
    newIn = [[...inTangents[0]], ...arriving];
  }
  return [newVertices, newIn, newOut];
}

/**
 * Blend two path values vertex by vertex.
 *
 * Vertices and both tangent sets move linearly at `progress`; `closed`
 * is held at the left key's, as AE does. When the two keys hold
 * different vertex counts the shorter path is resampled up to the
 * longer one first, the way AE does it.
 *
 * `null` means "no blend is defined" - either path is empty, or the
 * shorter one has no segment to subdivide - and the caller holds the
 * left keyframe's value instead.
 */
export function interpolateShapes(start: Shape, end: Shape, progress: number): Shape | null {
  // The stored handles blend (what a new keyframe stores); a RotoBezier
  // mask's drawn tangents are derived from the result instead.
  let vertsA = start.vertices;
  let inA = start._storedTangents(-1);
  let outA = start._storedTangents(1);
  let vertsB = end.vertices;
  let inB = end._storedTangents(-1);
  let outB = end._storedTangents(1);
  if (!vertsA?.length || !vertsB?.length) return null;
  // A RotoBezier mask draws the in-between with the keyframes' tensions
  // blended at the same progress (measured on AE 2026); each key's come
  // from its handles as stored, before any resampling.
  const tensions = start._isRotoBezier()
    ? [
        keyframeTensions(start._ownTensions(), inA, outA),
        keyframeTensions(end._ownTensions(), inB, outB),
      ]
    : null;
  const target = Math.max(vertsA.length, vertsB.length);
  if (vertsA.length < target) {
    [vertsA, inA, outA] = _resamplePath(vertsA, inA, outA, start.closed, target);
  } else if (vertsB.length < target) {
    [vertsB, inB, outB] = _resamplePath(vertsB, inB, outB, end.closed, target);
  }
  if (vertsA.length !== vertsB.length) {
    // `_resamplePath` could not reach the target: a one-vertex open
    // path has no segment to subdivide.
    return null;
  }
  const blended = new Shape(
    _lerpPoints(vertsA, vertsB, progress),
    _lerpPoints(inA, inB, progress),
    _lerpPoints(outA, outB, progress),
    { closed: start.closed },
  );
  blended._maskPath = start._maskPath;
  if (tensions != null && tensions[0].length === tensions[1].length && tensions[1].length === vertsA.length) {
    blended._tensions = tensions[0].map((a, k) => a + (tensions[1][k] - a) * progress);
  }
  return blended;
}

// A colour's ease speed is a rate along the straight line between its keys,
// in 0-255 channel units: the 0-1 channel distance times this.
export const _COLOR_SPEED_SCALE = 255.0;

/**
 * The distance between two colours in the units their ease speeds use.
 *
 * Euclidean over the channels, in 0-255 units (measured on AE 2026: a
 * LINEAR segment from [1, 0, 0, 1] to [0, 0.5, 1, 1] over 2 s reports a
 * speed of 1.5 * 255 / 2 = 191.25).
 */
export function colorDistance(start: number[], end: number[]): number {
  let squared = 0.0;
  for (const [a, b] of zip(start, end)) {
    squared += (b - a) * (b - a);
  }
  return Math.sqrt(squared) * _COLOR_SPEED_SCALE;
}

/**
 * AE's temporal auto-bezier speed for the colour `values[index]`.
 *
 * The colour distance travelled from the previous key to the next one
 * over their time span; at either end, the single segment's (measured on
 * AE 2026: [1,0,0,1] / [0,0.5,1,1] / [0.2,1,0.3,1] at 0 / 1 / 2 s reports
 * 382.5, 303.85 and 225.21).
 */
export function colorAutoSpeed(values: number[][], times: number[], index: number): number {
  const low = Math.max(index - 1, 0);
  const high = Math.min(index + 1, values.length - 1);
  const span = times[high] - times[low];
  if (span <= 0) return 0.0;
  let distance = 0.0;
  for (let i = low; i < high; i++) {
    distance += colorDistance(values[i], values[i + 1]);
  }
  return distance / span;
}

/**
 * A colour segment: one eased progress along the straight line.
 *
 * The progress is a bezier in (time, fraction of the colour distance):
 * an eased side's handle reaches `influence` of the span at its speed
 * divided by the distance, and a LINEAR side's handle sits on the
 * diagonal. Fitted to AE 2026, which it reproduces to 1e-12 on LINEAR,
 * eased and mixed segments, and with stored speeds of 0 it is the
 * influence-only curve measured earlier.
 */
export function _interpolateColor(
  kfLeft: Keyframe,
  kfRight: Keyframe,
  time: number,
  t0: number,
  t1: number,
  v0: number[],
  v1: number[],
): number[] {
  const duration = t1 - t0;
  const distance = colorDistance(v0, v1);
  let cx1: number;
  let cy1: number;
  if (kfLeft.outInterpolationType === KeyframeInterpolationType.LINEAR) {
    cx1 = _DEFAULT_INFLUENCE / 100.0;
    cy1 = cx1;
  } else {
    const outEase = kfLeft.outTemporalEase[0];
    cx1 = outEase.influence / 100.0;
    cy1 = distance !== 0 ? (outEase.speed * cx1 * duration) / distance : cx1;
  }
  let cx2: number;
  let cy2: number;
  if (kfRight.inInterpolationType === KeyframeInterpolationType.LINEAR) {
    cx2 = 1.0 - _DEFAULT_INFLUENCE / 100.0;
    cy2 = cx2;
  } else {
    const inEase = kfRight.inTemporalEase[0];
    const reach = inEase.influence / 100.0;
    cx2 = 1.0 - reach;
    cy2 = distance !== 0 ? 1.0 - (inEase.speed * reach * duration) / distance : cx2;
  }
  const progress = _getBezierEasing(cx1, cy1, cx2, cy2).get((time - t0) / duration);
  return Array.from({ length: v0.length }, (_v, d) => v0[d] + (v1[d] - v0[d]) * progress);
}

/**
 * Compute the interpolated value at `time` from a keyframe list.
 *
 * @param time - Time in the owning LAYER's seconds, not composition seconds. AE evaluates the
 *   temporal bezier in layer time - its ease speeds are per layer second, and a negatively
 *   stretched layer's keyframes only ascend on this axis.
 *   {@link Property.valueAtTime | Property.valueAtTime} converts before calling.
 * @param keyframes - Keyframes in stored (layer time ascending) order.
 * @param isSpatial - Whether the property is spatial.
 * @param inertDimensions - Indices the layer ignores, held at the left keyframe's value instead of
 *   interpolated - the Z of a 2-D layer's Scale, which AE never moves.
 * @param valueKind - `SHAPE_KIND` or `ORIENTATION_KIND` for the two kinds AE blends as one eased
 *   quantity rather than per component; `null` for an ordinary numeric property.
 * @param metric - How the property's motion path is measured, from its `tdb4`; only a spatial
 *   property reads it.
 * @param isColor - Whether the value is a colour, which AE blends along one eased progress (see
 *   `_interpolateColor`).
 * @returns Interpolated value, or `null` if no keyframes.
 */
export function interpolateKeyframes(
  time: number,
  keyframes: Keyframe[],
  isSpatial: boolean,
  inertDimensions: ReadonlySet<number> = new Set<number>(),
  valueKind: ParallelKind | null = null,
  metric: ArcMetric = _DEFAULT_ARC_METRIC,
  isColor = false,
): PropertyValue {
  if (!keyframes?.length) return null;

  const n = keyframes.length;

  // Before first keyframe or single keyframe
  if (n === 1 || time <= keyframes[0]._layerTime) {
    return keyframes[0]._storedValue;
  }

  // After last keyframe
  if (time >= keyframes[keyframes.length - 1]._layerTime) {
    return keyframes[keyframes.length - 1]._storedValue;
  }

  // Find the segment
  let rightIdx = 0;
  for (let i = 1; i < n; i++) {
    if (keyframes[i]._layerTime >= time) {
      rightIdx = i;
      break;
    }
  }

  const leftIdx = rightIdx - 1;
  const kfLeft = keyframes[leftIdx];
  const kfRight = keyframes[rightIdx];

  const t0 = kfLeft._layerTime;
  const t1 = kfRight._layerTime;

  // At exactly a keyframe time
  if (Math.abs(time - t0) < 1e-12) return kfLeft._storedValue;
  if (Math.abs(time - t1) < 1e-12) return kfRight._storedValue;

  const v0 = kfLeft._storedValue;
  const v1 = kfRight._storedValue;
  const outType = kfLeft.outInterpolationType;
  const inType = kfRight.inInterpolationType;

  // A motion path is evaluated by distance, through AE's arc-length model.
  // A LINEAR key still follows the cubic its tangents define - only the
  // EASE is linear (AE 2026: a LINEAR/LINEAR segment from (50,50) to
  // (350,50) with tangents (100,200)/(-100,200) passes through (200,200),
  // not the straight line's (200,50)) - and a roving run is eased by its
  // anchors alone, whatever its roving keys' own interpolation says.
  if (isSpatial && valueKind == null && Array.isArray(v0) && Array.isArray(v1)) {
    const [index, u] = spatialLocation(time, keyframes, leftIdx, metric);
    return _cubicPoint(_segmentCurve(keyframes, index), u);
  }

  // HOLD
  const holds = [outType, inType].includes(KeyframeInterpolationType.HOLD);
  if (outType === KeyframeInterpolationType.HOLD && valueKind == null) {
    return v0;
  }
  if (inType === KeyframeInterpolationType.HOLD && valueKind == null) {
    // A scalar or vector jumps to the next key's value straight away,
    // but a colour holds the start, as a motion path does (measured on
    // AE 2026).
    const held = isColor ? v0 : v1;
    return held;
  }

  // A path and an Orientation blend as ONE eased quantity, so they skip
  // the per-dimension machinery below entirely. A HOLD on either side
  // holds the start, but still as the blend at progress 0: AE reports a
  // held Orientation in its canonical angles and a held path resampled to
  // the next key's vertex count (measured on AE 2026).
  if (valueKind != null) {
    const progress = holds ? 0.0 : _singleProgress(kfLeft, kfRight, time, t0, t1);
    if (valueKind === SHAPE_KIND && v0 instanceof Shape && v1 instanceof Shape) {
      const blended = interpolateShapes(v0, v1, progress);
      return blended != null ? blended : v0;
    }
    if (valueKind === ORIENTATION_KIND && Array.isArray(v0) && Array.isArray(v1)) {
      return slerpOrientation(v0, v1, progress);
    }
  }

  // AE stores a LINEAR side as a diagonal handle - speed equal to the
  // chord slope, influence 100/6 - so the ordinary bezier path below
  // reproduces it exactly, including the case AE cares about: a LINEAR out
  // side facing an EASED in side still gets that ease (measured on AE
  // 2026: Opacity 0->100 over 2 s with a LINEAR out and a 90 % influence in
  // side reaches 87.5 at t=1, where a lerp gives 50).
  if ((outType === KeyframeInterpolationType.BEZIER || outType === KeyframeInterpolationType.LINEAR)) {
    // Non-spatial: per-dimension 1D bezier
    if (isColor && Array.isArray(v0) && Array.isArray(v1)) {
      return _interpolateColor(kfLeft, kfRight, time, t0, t1, v0, v1);
    }
    if (Array.isArray(v0) && Array.isArray(v1)) {
      // One stored ease for a multi-dimensional value means AE drives
      // the whole value with a single progress rather than a bezier per
      // dimension - a colour, whose speed has no per-channel meaning.
      // Measured on AE 2026: the progress follows the INFLUENCES alone
      // (handles at `(out/100, 0)` and `(1 - in/100, 1)`), reproducing
      // five sampled colour segments to 4e-4, and the stored speed does
      // not shape it. Interpolating per channel instead drove the
      // unchanged channels out of gamut.
      // `min`, not both: AE stores exactly one ease per side on a
      // colour, but py's own key insertion can leave one side holding a
      // per-channel list, and a single ease on either side still means
      // one progress.
      if (Math.min(kfLeft.outTemporalEase.length, kfRight.inTemporalEase.length) === 1) {
        const progress = _getBezierEasing(
          kfLeft.outTemporalEase[0].influence / 100.0,
          0.0,
          1.0 - kfRight.inTemporalEase[0].influence / 100.0,
          1.0,
        ).get((time - t0) / (t1 - t0));
        return Array.from({ length: v0.length }, (_v, d) => v0[d] + (v1[d] - v0[d]) * progress);
      }

      const result: number[] = [];
      for (let d = 0; d < v0.length; d++) {
        if (inertDimensions.has(d)) {
          // AE leaves an inert dimension alone: a 2-D layer's Scale
          // Z reads exactly 100 across a segment whose live X and Y
          // bow. (AE also refuses to STORE any other Z there, so the
          // two keyframes always agree.)
          result.push(v0[d]);
          continue;
        }
        const outE =
          d < kfLeft.outTemporalEase.length ? kfLeft.outTemporalEase[d] : kfLeft.outTemporalEase[0];
        const inE =
          d < kfRight.inTemporalEase.length ? kfRight.inTemporalEase[d] : kfRight.inTemporalEase[0];
        result.push(_interpolateBezier1d(time, t0, t1, v0[d], v1[d], outE, inE));
      }
      return result;
    }

    if (typeof v0 === "number" && typeof v1 === "number") {
      const outE1d = kfLeft.outTemporalEase?.length > 0 ? kfLeft.outTemporalEase[0] : null;
      const inE1d = kfRight.inTemporalEase?.length > 0 ? kfRight.inTemporalEase[0] : null;
      if (outE1d != null && inE1d != null) {
        return _interpolateBezier1d(time, t0, t1, v0, v1, outE1d, inE1d);
      }
      const ratio = (time - t0) / (t1 - t0);
      return v0 + (v1 - v0) * ratio;
    }
  }

  // Fallback
  return v0;
}
