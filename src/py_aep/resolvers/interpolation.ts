/**
 * Interpolation utilities for keyframe-based property evaluation.
 *
 * Implements HOLD, LINEAR, and BEZIER interpolation for
 * `Property.value_at_time()`.  Pure Python with no external dependencies.
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

import { IndexError, ZeroDivisionError, at, floordiv, getitem, int, max, min, mod, radians, sorted, sum, tkey, zip } from "../../pyrt/index.ts";
import { KeyframeInterpolationType } from "../enums/index.ts";
import { ORIENTATION_KIND, SHAPE_KIND, type ParallelKind } from "../models/properties/parallel.ts";
import { Shape } from "../models/properties/shape.ts";
import { keyframe_tensions } from "./roto_bezier.ts";
import { _euler_xyz } from "./transform.ts";
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
export function _calc_bezier(t: number, a1: number, a2: number): number {
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
export function _solve_cubic(a: number, b: number, c: number, d: number): number | null {
  let root: number;
  if (Math.abs(a) >= _EPS) {
    const big_a = b / a;
    const q = (big_a * big_a - 3.0 * (c / a)) / 9.0;
    const r = (2.0 * big_a * big_a * big_a - 9.0 * big_a * (c / a) + 27.0 * (d / a)) / 54.0;
    const third = big_a / 3.0;
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
    const q_quad = c <= 0.0 ? sq - c : -(sq + c);
    const first = (2.0 * d) / q_quad;
    root = q_quad / (2.0 * b);
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
    return _calc_bezier(this.parameter_at(x), this._cy1, this._cy2);
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
  parameter_at(x: number): number {
    if (x < 0.0 || Math.abs(x) < _EPS) return 0.0;
    if (x > 1.0 || Math.abs(x - 1.0) < _EPS) return 1.0;
    const u = _solve_cubic(_bez_A(this._cx1, this._cx2), _bez_B(this._cx1, this._cx2), _bez_C(this._cx1), -x);
    // No root in [0, 1] means the curve does not reach `x`, which only
    // happens on a degenerate one. Fall back to the linear estimate
    // rather than to AE's undefined result.
    return u == null ? x : u;
  }
}

// Cache for easing functions (mirroring lottie-web's BezierFactory cache)
export const _easing_cache = new Map<string, _BezierEasing>();

/** Get or create a cached BezierEasing instance. */
export function _get_bezier_easing(cx1: number, cy1: number, cx2: number, cy2: number): _BezierEasing {
  const key = tkey(cx1, cy1, cx2, cy2);
  const cached = _easing_cache.get(key);
  if (cached != null) return cached;
  const easing = new _BezierEasing(cx1, cy1, cx2, cy2);
  _easing_cache.set(key, easing);
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
export function _ease_to_bezier_1d(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  out_ease: KeyframeEase,
  in_ease: KeyframeEase,
): [number, number, number, number] {
  const dt = t1 - t0;
  const dv = v1 - v0;

  const o_spd = out_ease.speed,
    o_inf = out_ease.influence;
  const i_spd = in_ease.speed,
    i_inf = in_ease.influence;

  // Normalized influence (x-axis control points)
  const cx1 = o_inf / 100.0;
  const cx2 = 1.0 - i_inf / 100.0;

  // Normalized speed (y-axis control points)
  // cy1 = outgoing speed * influence_fraction * dt / dv
  // cy2 = 1 - incoming speed * influence_fraction * dt / dv
  let cy1: number;
  let cy2: number;
  if (Math.abs(dv) > 1e-12) {
    cy1 = (o_spd * cx1 * dt) / dv;
    cy2 = 1.0 - (i_spd * (1.0 - cx2) * dt) / dv;
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
export function _ease_value_handles(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  out_ease: KeyframeEase,
  in_ease: KeyframeEase,
): [number, number] {
  const dt = t1 - t0;
  const io = out_ease.influence / 100.0;
  const ii = in_ease.influence / 100.0;
  return [v0 + out_ease.speed * io * dt, v1 - in_ease.speed * ii * dt];
}

/**
 * `dv/dt` on the temporal bezier segment at time `t`.
 *
 * The instantaneous speed a keyframe inserted at `t` has to carry for the
 * curve to come through unchanged.
 */
export function segment_value_slope(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  out_ease: KeyframeEase,
  in_ease: KeyframeEase,
  t: number,
): number {
  const dt = t1 - t0;
  if (dt <= 0) return 0.0;
  const [cx1, _cy1, cx2, _cy2] = _ease_to_bezier_1d(t0, t1, v0, v1, out_ease, in_ease);
  const easing = _get_bezier_easing(cx1, _cy1, cx2, _cy2);
  const u = easing.parameter_at((t - t0) / dt);
  const [y1, y2] = _ease_value_handles(t0, t1, v0, v1, out_ease, in_ease);
  const mu = 1.0 - u;
  const dy_du = 3.0 * (mu * mu * (y1 - v0) + 2.0 * mu * u * (y2 - y1) + u * u * (v1 - y2));
  const dx_du = 3.0 * (mu * mu * cx1 + 2.0 * mu * u * (cx2 - cx1) + u * u * (1.0 - cx2));
  if (Math.abs(dx_du) < _VERTICAL_SLOPE_EPS) {
    // The curve is vertical here, so the speed is unbounded. AE reports
    // its saturation value rather than dividing, inside the same 1e-12
    // window; the sign follows the value axis. This is reachable at
    // 100 % influence on both sides, where dx/du is exactly 0 at the
    // midpoint.
    return dy_du >= 0.0 ? _VERTICAL_SLOPE : -_VERTICAL_SLOPE;
  }
  return dy_du / (dx_du * dt);
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
export function split_segment_influences(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  out_ease: KeyframeEase,
  in_ease: KeyframeEase,
  t: number,
): [number, number, number, number] {
  const dt = t1 - t0;
  if (dt <= 0) {
    return [out_ease.influence, _DEFAULT_INFLUENCE, _DEFAULT_INFLUENCE, in_ease.influence];
  }
  const [cx1, cy1, cx2, cy2] = _ease_to_bezier_1d(t0, t1, v0, v1, out_ease, in_ease);
  const easing = _get_bezier_easing(cx1, cy1, cx2, cy2);
  const u = easing.parameter_at((t - t0) / dt);

  const lerp = (a: number, b: number): number => a + (b - a) * u;

  const a = lerp(0.0, cx1);
  const b = lerp(cx1, cx2);
  const c = lerp(cx2, 1.0);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const xs = lerp(d, e);

  const left_span = xs;
  const right_span = 1.0 - xs;
  if (left_span <= 1e-12 || right_span <= 1e-12) {
    return [out_ease.influence, _DEFAULT_INFLUENCE, _DEFAULT_INFLUENCE, in_ease.influence];
  }
  // An influence is a percentage of its own sub-span, and a long handle on
  // a short half can exceed 100 - which AE cannot represent either. Clamp
  // to the storable range; the curve then bends by whatever the clamp cost.
  return [
    _clamp_influence((a / left_span) * 100.0),
    _clamp_influence(((xs - d) / left_span) * 100.0),
    _clamp_influence(((e - xs) / right_span) * 100.0),
    _clamp_influence(((1.0 - c) / right_span) * 100.0),
  ];
}

/**
 * Keep an influence inside the 0-100 % range the field holds.
 *
 * Not AE's 0.1 % dialog minimum: splitting a segment whose far side has a
 * blank (0) influence leaves that side at 0 in AE's own files (AE 2026).
 */
export function _clamp_influence(value: number): number {
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
  readonly speed_divisor: number;

  /** NamedTuple positional constructor; the defaults are the Python field defaults. */
  constructor(
    accuracy: number = _DEFAULT_ARC_ACCURACY,
    multipliers: readonly number[] = [1.0, 1.0, 1.0],
    divisors: readonly number[] | null = null,
    speed_divisor: number = 1.0,
  ) {
    this.accuracy = accuracy;
    this.multipliers = multipliers;
    this.divisors = divisors;
    this.speed_divisor = speed_divisor;
  }

  /** NamedTuple unpacking: `accuracy, multipliers, divisors, speed_divisor = metric`. */
  *[Symbol.iterator](): Generator<number | readonly number[] | null> {
    yield this.accuracy;
    yield this.multipliers;
    yield this.divisors;
    yield this.speed_divisor;
  }
}

export const _DEFAULT_ARC_METRIC = new ArcMetric();

/** One coordinate of a cubic bezier, evaluated the way AE evaluates it. */
export function _cubic_1d(a: number, b: number, c: number, d: number, t: number): number {
  const mt = 1.0 - t;
  const t2 = t * t;
  return ((3.0 * b * t + mt * a) * mt + 3.0 * c * t2) * mt + t2 * t * d;
}

export function _cubic_point(curve: _Curve, t: number): number[] {
  const [p0, p1, p2, p3] = curve;
  return Array.from({ length: p0.length }, (_v, d) => _cubic_1d(p0[d], p1[d], p2[d], p3[d], t));
}

/** A spatial segment's control points, in reported units. */
export function _spatial_curve(v0: number[], v1: number[], out_tangent: number[], in_tangent: number[]): _Curve {
  const ndim = v0.length;
  return [
    [...v0],
    Array.from({ length: ndim }, (_v, d) => v0[d] + out_tangent[d]),
    Array.from({ length: ndim }, (_v, d) => v1[d] + in_tangent[d]),
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
export function _measured_curve(
  v0: number[],
  v1: number[],
  out_tangent: number[],
  in_tangent: number[],
  metric: ArcMetric,
): _Curve {
  return _spatial_curve(
    _measured(v0, metric),
    _measured(v1, metric),
    _measured(out_tangent, metric),
    _measured(in_tangent, metric),
  );
}

/** `(parameter, distance)` samples along `curve`, and its length. */
export function _arc_samples(curve: _Curve): [_Point2[], number] {
  const p0 = curve[0];
  const step = 1.0 / (_ARC_SAMPLES - 1);
  const samples: _Point2[] = [[0.0, 0.0]];
  let previous: number[] = p0;
  let total = 0.0;
  let t = step;
  for (let _i = 1; _i < _ARC_SAMPLES; _i++) {
    const point = _cubic_point(curve, t);
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

export function _fit_point(curve: _Point2[], u: number): _Point2 {
  const [p0, p1, p2, p3] = curve;
  return [
    _cubic_1d(p0[0], p1[0], p2[0], p3[0], u),
    _cubic_1d(p0[1], p1[1], p2[1], p3[1], u),
  ];
}

/** Schneider's chord-length parameterization of `points[first:last+1]`. */
export function _chord_parameters(points: _Point2[], first: number, last: number): number[] {
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
export function _fit_bezier(
  points: _Point2[],
  first: number,
  last: number,
  u: number[],
  tangent_1: _Point2,
  tangent_2: _Point2,
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
    const a0x = tangent_1[0] * b1;
    const a0y = b1 * tangent_1[1];
    const a1x = b2 * tangent_2[0];
    const a1y = b2 * tangent_2[1];
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
  let alpha_l = (x0 * c11 - x1 * c01) / det;
  let alpha_r = (x1 * c00 - x0 * c01) / det;
  if (alpha_l < 0.0 || alpha_r < 0.0) {
    const dx = p3[0] - p0[0];
    const dy = p3[1] - p0[1];
    alpha_l = alpha_r = Math.sqrt(dx * dx + dy * dy) * _FIT_THIRD;
  }
  return [
    p0,
    [alpha_l * tangent_1[0] + p0[0], alpha_l * tangent_1[1] + p0[1]],
    [alpha_r * tangent_2[0] + p3[0], alpha_r * tangent_2[1] + p3[1]],
    p3,
  ];
}

/**
 * The worst squared distance from `curve`, and where it is.
 *
 * A tie goes to the LATER sample, which is what decides the split on a
 * symmetric run.
 */
export function _fit_error(
  points: _Point2[],
  first: number,
  last: number,
  curve: _Point2[],
  u: number[],
): [number, number] {
  let worst = 0.0;
  let split = floordiv(first + last + 1, 2);
  for (let i = first + 1; i < last; i++) {
    const q = _fit_point(curve, u[i - first]);
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
export function _fit_cubics(
  points: _Point2[],
  first: number,
  last: number,
  tangent_1: _Point2,
  tangent_2: _Point2,
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
      [reach * tangent_1[0] + start[0], reach * tangent_1[1] + start[1]],
      [reach * tangent_2[0] + end[0], reach * tangent_2[1] + end[1]],
      end,
    ];
  } else {
    const u = _chord_parameters(points, first, last);
    curve = _fit_bezier(points, first, last, u, tangent_1, tangent_2);
    const [worst, split] = _fit_error(points, first, last, curve, u);
    if (worst >= error) {
      const before = points[split - 1];
      const at = points[split];
      const after = points[split + 1];
      const center = _unit(
        (before[0] - at[0] + (at[0] - after[0])) * 0.5,
        (before[1] - at[1] + (at[1] - after[1])) * 0.5,
      );
      _fit_cubics(points, first, split, tangent_1, center, error, knots);
      _fit_cubics(points, split, last, [-center[0], -center[1]], tangent_2, error, knots);
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
export function _t_on_axis(curve: _Point2[], axis: number, value: number): number {
  const v0 = curve[0][axis];
  if (v0 > value || Math.abs(value - v0) < _EPS) return 0.0;
  const v3 = curve[3][axis];
  if (value > v3 || Math.abs(value - v3) < _EPS) return 1.0;
  const v1 = curve[1][axis];
  const v2 = curve[2][axis];
  const t = _solve_cubic(
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
export function _non_decreasing(curve: _Point2[]): _Point2[] {
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

export function _is_non_decreasing(curve: _Point2[]): boolean {
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
    const [samples, length] = _arc_samples(curve);
    this.length = length;
    const points: _Point2[] = samples.map(([t, s]): _Point2 => [this.length * t, s]);
    const last = points.length - 1;
    const knots: _Point2[] = [];
    _fit_cubics(
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
  parameter_at(distance: number): number {
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
    if (!_is_non_decreasing(cubic)) {
      cubic = _non_decreasing(cubic);
    }
    const t = _t_on_axis(cubic, 1, distance);
    return _cubic_1d(cubic[0][0], cubic[1][0], cubic[2][0], cubic[3][0], t);
  }
}

// NOTE(port): matches `functools.lru_cache(maxsize=1024)` (value-keyed via `tkey`, LRU eviction at 1024); pyrt `lru_cache` keys by identity and would never hit.
export const _arc_spline_cache = new Map<string, _ArcSpline>();

/** A cached `_ArcSpline`: every evaluated frame rebuilds the same one. */
export function _arc_spline(curve: _Curve, accuracy: number): _ArcSpline {
  const key = tkey(curve, accuracy);
  const cached = _arc_spline_cache.get(key);
  if (cached !== undefined) {
    // Re-insert so the entry becomes the most recently used one.
    _arc_spline_cache.delete(key);
    _arc_spline_cache.set(key, cached);
    return cached;
  }
  const spline = new _ArcSpline(curve, accuracy);
  _arc_spline_cache.set(key, spline);
  if (_arc_spline_cache.size > 1024) {
    const oldest = _arc_spline_cache.keys().next();
    if (!oldest.done) _arc_spline_cache.delete(oldest.value);
  }
  return spline;
}

/** A spatial segment's arc length, in the units its ease speeds report. */
export function motion_path_length(
  v0: number[],
  v1: number[],
  out_tangent: number[],
  in_tangent: number[],
  metric: ArcMetric,
): number {
  const curve = _measured_curve(v0, v1, out_tangent, in_tangent, metric);
  return _arc_spline(curve, metric.accuracy).length * metric.speed_divisor;
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
export function _distance_curve(
  duration: number,
  distance: number,
  kf_start: Keyframe,
  kf_end: Keyframe,
  out_type: KeyframeInterpolationType,
  in_type: KeyframeInterpolationType,
  speed_divisor: number,
): _Point2[] {
  let out_handle: _Point2;
  if (out_type === KeyframeInterpolationType.LINEAR) {
    out_handle = [duration * _LINEAR_HANDLE, distance * _LINEAR_HANDLE];
  } else {
    const out_ease = kf_start.out_temporal_ease[0];
    const reach = duration * (out_ease.influence / 100.0);
    out_handle = [reach, reach * (out_ease.speed / speed_divisor)];
  }
  let in_handle: _Point2;
  if (in_type === KeyframeInterpolationType.LINEAR) {
    in_handle = [duration - duration * _LINEAR_HANDLE, distance - distance * _LINEAR_HANDLE];
  } else {
    const in_ease = kf_end.in_temporal_ease[0];
    const reach = -(in_ease.influence / 100.0) * duration;
    in_handle = [reach + duration, reach * (in_ease.speed / speed_divisor) + distance];
  }
  return _non_decreasing([[0.0, 0.0], out_handle, in_handle, [duration, distance]]);
}

/**
 * Distance travelled `elapsed` seconds into a spatial span.
 *
 * The span runs from `kf_start` to `kf_end`, a single segment or a whole
 * roving run. HOLD on either side keeps it at the start.
 */
export function _spatial_distance(
  elapsed: number,
  duration: number,
  distance: number,
  kf_start: Keyframe,
  kf_end: Keyframe,
  speed_divisor: number,
): number {
  const out_type = kf_start.out_interpolation_type;
  const in_type = kf_end.in_interpolation_type;
  if ([out_type, in_type].includes(KeyframeInterpolationType.HOLD)) return 0.0;
  if (out_type === KeyframeInterpolationType.LINEAR && in_type === KeyframeInterpolationType.LINEAR) {
    return (elapsed / duration) * distance;
  }
  const curve = _distance_curve(duration, distance, kf_start, kf_end, out_type, in_type, speed_divisor);
  const [y0, y1, y2, y3] = curve.map((point) => point[1]);
  if (y0 === y1 && y1 === y2 && y2 === y3) return y0;
  const t = _t_on_axis(curve, 0, elapsed);
  return _cubic_1d(y0, y1, y2, y3, t);
}

/**
 * De Casteljau split of a spatial segment at parameter `u`.
 *
 * Returns `(left_out, new_in, split_point, new_out, right_in)` - the four
 * tangents the two halves need, plus the point they meet at. Splitting the
 * path is what lets a keyframe be inserted without moving the motion path.
 */
export function split_spatial_path(
  v0: number[],
  v1: number[],
  out_tangent: number[],
  in_tangent: number[],
  u: number,
): [number[], number[], number[], number[], number[]] {
  const ndim = v0.length;
  const p0 = [...v0];
  const p1 = Array.from({ length: ndim }, (_v, d) => v0[d] + out_tangent[d]);
  const p2 = Array.from({ length: ndim }, (_v, d) => v1[d] + in_tangent[d]);
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

export function _tangents_are_zero(tangent: number[] | null): boolean {
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
export function auto_spatial_tangents(values: number[][], index: number): [number[], number[]] {
  const ndim = values[index].length;
  const zero = new Array<number>(ndim).fill(0.0);
  if (values.length < 2) return [zero, [...zero]];
  const low = index > 0 ? values[index - 1] : values[index];
  const high = index < values.length - 1 ? values[index + 1] : values[index];
  const out_tangent = Array.from({ length: ndim }, (_v, d) => (high[d] - low[d]) * _AUTO_BEZIER_CHORD_SCALE);
  return [out_tangent, out_tangent.map((component) => -component)];
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
export function auto_temporal_speeds(values: number[][], times: number[], index: number): [number[], number[]] {
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
 * `_single_progress`). `null` means "no explicit ease", i.e. constant
 * progress.
 */
export function _progress_easing(
  out_ease: KeyframeEase | null,
  in_ease: KeyframeEase | null,
  kw: { out_linear?: boolean; in_linear?: boolean } = {},
): _BezierEasing | null {
  const { out_linear = false, in_linear = false } = kw;
  if (out_ease == null || in_ease == null) return null;
  if (out_ease.influence <= 0 && in_ease.influence <= 0) return null;

  const out_inf_frac = out_ease.influence / 100.0;
  const in_inf_frac = in_ease.influence / 100.0;

  let cx1 = out_inf_frac;
  let cy1 = out_ease.speed * out_inf_frac;
  let cx2 = 1.0 - in_inf_frac;
  let cy2 = 1.0 - in_ease.speed * in_inf_frac;

  // A LINEAR side carries no ease: its handle sits on the diagonal, so
  // progress advances at a constant rate on that side. The side's
  // interpolation type governs the EASE only - the path itself always
  // follows the spatial tangents (AE 2026).
  if (out_linear) cy1 = cx1;
  if (in_linear) cy2 = cx2;

  // Between two eased sides, a handle that reaches past the unit square is
  // shortened ALONG ITS OWN SLOPE, which keeps the speed the user asked for
  // and spends influence instead (AE 2026: Orientation eases at speed 5 to
  // 200 against an eased far side). Facing a LINEAR side it is kept and
  // the progress overshoots instead: an Orientation eased at speed 50 /
  // influence 50 % into a LINEAR key reads [203.94, 60.25, 293.25] 0.125 s
  // in - about 2.9 times the way - and a mask path bows past its end shape
  // the same way (AE 2026).
  if (!(out_linear || in_linear)) {
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

  return _get_bezier_easing(cx1, cy1, cx2, cy2);
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
export function roving_keyframe_times(keyframes: Keyframe[], metric: ArcMetric): Map<number, number> {
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
    if (!keyframes.slice(start, end + 1).every((kf) => Array.isArray(kf._stored_value))) continue;
    const [splines, total] = _run_splines(keyframes, start, end, metric);
    if (total <= 0) continue;
    const first = keyframes[start];
    const last = keyframes[end];
    const units0 = first.time_units;
    const units1 = last.time_units;
    const out_type = first.out_interpolation_type;
    const in_type = last.in_interpolation_type;
    // HOLD on either anchor keeps the whole run at its start.
    const held = [out_type, in_type].includes(KeyframeInterpolationType.HOLD);
    let curve: _Point2[] | null = null;
    let timebase = 0.0;
    if (
      !held &&
      !(out_type === KeyframeInterpolationType.LINEAR && in_type === KeyframeInterpolationType.LINEAR)
    ) {
      timebase = first._timebase;
      curve = _distance_curve(
        (units1 - units0) / timebase,
        total,
        first,
        last,
        out_type,
        in_type,
        metric.speed_divisor,
      );
    }
    let travelled = 0.0;
    for (let index = start + 1; index < end; index++) {
      travelled += splines[index - start - 1].length;
      const units = held ? units0 : _roving_units(curve, timebase, units0, units1, travelled, total);
      result.set(index, Math.min(Math.max(units, units0 + index - start), units1 - (end - index)));
    }
  }
  return result;
}

/**
 * The time unit at which a roving run has travelled `travelled`, read
 * off the run's ease `curve` (`null` when both anchors are LINEAR).
 */
export function _roving_units(
  curve: _Point2[] | null,
  timebase: number,
  units0: number,
  units1: number,
  travelled: number,
  total: number,
): number {
  if (curve == null) return int((units1 - units0) * (travelled / total) + units0);
  const t = _t_on_axis(curve, 1, travelled);
  const seconds = _cubic_1d(curve[0][0], curve[1][0], curve[2][0], curve[3][0], t);
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
export function _spatial_tangents(keyframes: Keyframe[], first: number, last: number): Map<number, [number[], number[]]> {
  const result = new Map<number, [number[], number[]]>();
  for (let i = first; i <= last; i++) {
    const kf = keyframes[i];
    if (kf.spatial_auto_bezier) {
      const low = Math.max(i - 1, 0);
      const window = keyframes.slice(low, i + 2).map((k) => k._stored_value as number[]);
      result.set(i, auto_spatial_tangents(window, i - low));
      continue;
    }
    const zero = new Array<number>((kf._stored_value as number[]).length).fill(0.0);
    const out_tangent = kf.out_spatial_tangent;
    const in_tangent = kf.in_spatial_tangent;
    result.set(i, [out_tangent != null && out_tangent.length > 0 ? out_tangent : zero, in_tangent != null && in_tangent.length > 0 ? in_tangent : zero]);
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
export function _interpolate_bezier_1d(
  t: number,
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  out_ease: KeyframeEase,
  in_ease: KeyframeEase,
): number {
  const dt = t1 - t0;
  if (dt === 0) return v0;

  // Convert AEP ease to normalized bezier control points. Only the x
  // (time) axis is used to find the curve parameter; the value axis is
  // evaluated from absolute control points so a segment whose keys hold
  // the same value still bows (see `_ease_value_handles`).
  const [cx1, cy1, cx2, cy2] = _ease_to_bezier_1d(t0, t1, v0, v1, out_ease, in_ease);

  // Get easing function (cached)
  const easing = _get_bezier_easing(cx1, cy1, cx2, cy2);

  // Normalized time fraction
  const x = (t - t0) / dt;
  const u = easing.parameter_at(x);

  const [y1, y2] = _ease_value_handles(t0, t1, v0, v1, out_ease, in_ease);
  const mu = 1.0 - u;
  return mu * mu * mu * v0 + 3.0 * mu * mu * u * y1 + 3.0 * mu * u * u * y2 + u * u * u * v1;
}

/** The arc spline of the segment from `keyframes[index]` to the next. */
export function _segment_spline(
  keyframes: Keyframe[],
  index: number,
  tangents: Map<number, [number[], number[]]>,
  metric: ArcMetric,
): _ArcSpline {
  const curve = _measured_curve(
    keyframes[index]._stored_value as number[],
    keyframes[index + 1]._stored_value as number[],
    getitem(tangents, index)[0],
    getitem(tangents, index + 1)[1],
    metric,
  );
  return _arc_spline(curve, metric.accuracy);
}

/**
 * The arc splines of the segments from `keyframes[start]` to
 * `keyframes[end]`, and their total length (summed left to right).
 */
export function _run_splines(keyframes: Keyframe[], start: number, end: number, metric: ArcMetric): [_ArcSpline[], number] {
  const tangents = _spatial_tangents(keyframes, start, end);
  const splines: _ArcSpline[] = [];
  for (let i = start; i < end; i++) splines.push(_segment_spline(keyframes, i, tangents, metric));
  let total = 0.0;
  for (const spline of splines) total += spline.length;
  return [splines, total];
}

/**
 * The control points of the segment from `keyframes[index]` to the
 * next, in reported units.
 */
export function _segment_curve(keyframes: Keyframe[], index: number): _Curve {
  const tangents = _spatial_tangents(keyframes, index, index + 1);
  return _spatial_curve(
    keyframes[index]._stored_value as number[],
    keyframes[index + 1]._stored_value as number[],
    getitem(tangents, index)[0],
    getitem(tangents, index + 1)[1],
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
export function auto_path_speed(keyframes: Keyframe[], index: number, metric: ArcMetric): number {
  const low = index > 0 ? _run_bounds(keyframes, index - 1)[0] : index;
  const high = index < keyframes.length - 1 ? _run_bounds(keyframes, index)[1] : index;
  return _path_speed(keyframes, low, high, metric);
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
export function linear_path_speed(keyframes: Keyframe[], index: number, metric: ArcMetric): number {
  const [low, high] = _run_bounds(keyframes, index);
  return _path_speed(keyframes, low, high, metric);
}

/**
 * The anchors enclosing the segment that starts at `keyframes[left]`:
 * the ends of the roving run it belongs to.
 */
export function _run_bounds(keyframes: Keyframe[], left: number): [number, number] {
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
export function _path_speed(keyframes: Keyframe[], low: number, high: number, metric: ArcMetric): number {
  const span = keyframes[high]._layer_time - keyframes[low]._layer_time;
  if (span <= 0) return 0.0;
  const [, distance] = _run_splines(keyframes, low, high, metric);
  return (distance / span) * metric.speed_divisor;
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
export function spatial_location(time: number, keyframes: Keyframe[], left: number, metric: ArcMetric): [number, number] {
  const [start, end] = _run_bounds(keyframes, left);
  const [splines, total] = _run_splines(keyframes, start, end, metric);
  const first = keyframes[start];
  const last = keyframes[end];
  const t0 = first._layer_time;
  let distance = _spatial_distance(time - t0, last._layer_time - t0, total, first, last, metric.speed_divisor);
  let index = 0;
  while (index < splines.length - 1 && distance > splines[index].length) {
    distance -= splines[index].length;
    index += 1;
  }
  return [start + index, splines[index].parameter_at(distance)];
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
export function motion_path_direction(time: number, keyframes: Keyframe[], metric: ArcMetric): number[] | null {
  // Every keyframe of a property holds the same kind of value.
  if (keyframes.length < 2 || !Array.isArray(keyframes[0]._stored_value)) return null;
  const last = keyframes.length - 2;
  let index: number;
  let u: number;
  if (time >= keyframes[keyframes.length - 1]._layer_time) {
    index = last;
    u = 1.0;
  } else {
    index = 0;
    while (index < last && keyframes[index + 1]._layer_time <= time) index += 1;
    if (time <= keyframes[index]._layer_time) {
      u = 0.0;
    } else {
      [index, u] = spatial_location(time, keyframes, index, metric);
    }
    if (keyframes[index].out_interpolation_type === KeyframeInterpolationType.HOLD) return null;
  }
  const [p0, p1, p2, p3] = _segment_curve(keyframes, index);
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
 * @param kf_left - The keyframe starting the segment.
 * @param kf_right - The keyframe ending it.
 * @param time - Evaluation time, in the owning layer's seconds.
 * @param t0 - `kf_left`'s layer time.
 * @param t1 - `kf_right`'s layer time.
 */
export function _single_progress(
  kf_left: Keyframe,
  kf_right: Keyframe,
  time: number,
  t0: number,
  t1: number,
): number {
  // Bound to locals: `in/out_temporal_ease` re-derives its list on every
  // read, and this runs once per interpolated frame.
  const out_ease = kf_left.out_temporal_ease;
  const in_ease = kf_right.in_temporal_ease;
  const easing = _progress_easing(
    out_ease?.length > 0 ? out_ease[0] : null,
    in_ease?.length > 0 ? in_ease[0] : null,
    {
      out_linear: kf_left.out_interpolation_type === KeyframeInterpolationType.LINEAR,
      in_linear: kf_right.in_interpolation_type === KeyframeInterpolationType.LINEAR,
    },
  );
  const x = (time - t0) / (t1 - t0);
  return easing != null ? easing.get(x) : x;
}

/** A rotation of `degrees` about axis 0 (X), 1 (Y) or 2 (Z). */
export function _axis_quaternion(axis: number, degrees: number): [number, number, number, number] {
  const half = radians(degrees) / 2.0;
  const parts = [0.0, 0.0, 0.0, Math.cos(half)];
  parts[axis] = Math.sin(half);
  return [parts[0], parts[1], parts[2], parts[3]];
}

export function _quaternion_multiply(
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
 * `build_local_matrix` applies an Orientation with.
 */
export function euler_to_quaternion(angles: number[]): [number, number, number, number] {
  let q: [number, number, number, number] = [0.0, 0.0, 0.0, 1.0];
  for (const [axis, angle] of angles.slice(0, 3).entries()) {
    q = _quaternion_multiply(q, _axis_quaternion(axis, angle));
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
 * The extraction itself is `_euler_xyz`, which this feeds the quaternion's
 * rotation matrix; only the elements it needs are built.
 */
export function quaternion_to_euler(q: readonly number[]): number[] {
  let [x, y, z, w] = q;
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (norm > 0) {
    x = x / norm;
    y = y / norm;
    z = z / norm;
    w = w / norm;
  }
  return _euler_xyz(
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
export function slerp_orientation(start: number[], end: number[], progress: number): number[] {
  const q0 = euler_to_quaternion(start);
  let q1 = euler_to_quaternion(end);
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
    return quaternion_to_euler(blend);
  }
  // NOTE(port): platform libm — CPython's own math.* results vary by platform libm; V8 (fdlibm) may differ in the last ulp.
  const theta = Math.acos(dot);
  const sin_theta = Math.sin(theta);
  const s0 = Math.sin((1.0 - progress) * theta) / sin_theta;
  const s1 = Math.sin(progress * theta) / sin_theta;
  return quaternion_to_euler(
    q0.map((a, i) => a * s0 + q1[i] * s1),
  );
}

export function _lerp_points(a: number[][], b: number[][], progress: number): number[][] {
  return zip(a, b).map(([p, q]) => [p[0] + (q[0] - p[0]) * progress, p[1] + (q[1] - p[1]) * progress]);
}

export function _lerp_point(a: _Point2, b: _Point2, t: number): _Point2 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// A cubic bezier segment: start, its out handle, the end's in handle, end.
export type _Cubic = [_Point2, _Point2, _Point2, _Point2];

/**
 * De Casteljau: the two halves of `cubic` either side of `t`.
 *
 * `split_spatial_path` above is the same subdivision, but it speaks the
 * TANGENT representation and returns one side. Resampling chains splits
 * and wants both halves as control points, which is what this returns -
 * marshalling between the two costs more than the 6 lerps do.
 */
export function _split_cubic(cubic: _Cubic, t: number): [_Cubic, _Cubic] {
  const [p0, p1, p2, p3] = cubic;
  const a = _lerp_point(p0, p1, t);
  const b = _lerp_point(p1, p2, t);
  const c = _lerp_point(p2, p3, t);
  const d = _lerp_point(a, b, t);
  const e = _lerp_point(b, c, t);
  const f = _lerp_point(d, e, t);
  return [
    [p0, a, d, f],
    [f, e, c, p3],
  ];
}

/**
 * Where AE cuts each segment to reach `target_count` segments.
 *
 * After Effects bisects breadth-first: every segment once in path
 * order, then every half in that same order, and so on, stopping the
 * moment the counts match. Measured on AE 2026 over 22 source/target
 * pairs from 2 to 12 vertices, open and closed - the distribution
 * depends on the counts alone, not on either path's geometry (a target
 * of a completely different shape, and a source with even rather than
 * lopsided segments, both cut identically).
 */
export function _subdivision_cuts(segment_count: number, target_count: number): number[][] {
  const pieces: [number, number, number][] = [];
  for (let index = 0; index < segment_count; index++) pieces.push([index, 0.0, 1.0]);
  while (pieces.length < target_count) {
    const piece = pieces.shift();
    if (piece === undefined) throw new IndexError("pop from an empty deque");
    const [index, start, end] = piece;
    const middle = (start + end) / 2.0;
    pieces.push([index, start, middle]);
    pieces.push([index, middle, end]);
  }
  const cuts: number[][] = Array.from({ length: segment_count }, () => []);
  for (const [index, start] of pieces) {
    if (start > 0.0) cuts[index].push(start);
  }
  for (const per_segment of cuts) {
    per_segment.splice(0, per_segment.length, ...sorted(per_segment));
  }
  return cuts;
}

/**
 * Add vertices to a path until it has `target` of them, shape intact.
 *
 * The new vertices land where a de Casteljau split puts them, so the
 * outline is unchanged - only its parameterisation gains points.
 */
export function _resample_path(
  vertices: number[][],
  in_tangents: number[][],
  out_tangents: number[][],
  closed: boolean,
  target: number,
): [number[][], number[][], number[][]] {
  const count = vertices.length;
  const segment_count = closed ? count : count - 1;
  if (segment_count < 1) {
    // A one-vertex open path: nothing to subdivide, so it cannot be
    // brought up to `target`. The caller checks the resulting length.
    return [vertices, in_tangents, out_tangents];
  }
  const cuts = _subdivision_cuts(segment_count, segment_count + target - count);

  const chain: _Cubic[] = [];
  for (let index = 0; index < segment_count; index++) {
    const tail = (index + 1) % count;
    const start: _Point2 = [vertices[index][0], vertices[index][1]];
    const end: _Point2 = [vertices[tail][0], vertices[tail][1]];
    const out_t = out_tangents[index];
    const in_t = in_tangents[tail];
    if (!out_t.some((x) => x !== 0) && !in_t.some((x) => x !== 0)) {
      // AE keeps a straight segment straight: the new vertices land
      // on the line at the cut parameters and every handle stays
      // zero. Splitting it as the degenerate cubic instead would put
      // them at 0.15625 rather than 0.25 and hand each one a handle
      // a quarter of the segment long (AE 2026).
      const bounds = [0.0, ...cuts[index], 1.0];
      for (const [low, high] of zip(bounds, bounds.slice(1))) {
        const a = _lerp_point(start, end, low);
        const b = _lerp_point(start, end, high);
        chain.push([a, a, b, b]);
      }
      continue;
    }
    let cubic: _Cubic = [
      start,
      [start[0] + out_t[0], start[1] + out_t[1]],
      [end[0] + in_t[0], end[1] + in_t[1]],
      end,
    ];
    let consumed = 0.0;
    for (const cut of cuts[index]) {
      const [left, right] = _split_cubic(cubic, (cut - consumed) / (1.0 - consumed));
      chain.push(left);
      cubic = right;
      consumed = cut;
    }
    chain.push(cubic);
  }

  const new_vertices: number[][] = chain.map((c) => [c[0][0], c[0][1]]);
  const new_out: number[][] = chain.map((c) => [c[1][0] - c[0][0], c[1][1] - c[0][1]]);
  // Each piece's own IN handle, measured at the vertex it arrives at.
  const arriving: number[][] = chain.map((c) => [c[2][0] - c[3][0], c[2][1] - c[3][1]]);
  let new_in: number[][];
  if (closed) {
    // Every vertex starts a piece, so its IN handle comes from the
    // piece before it - the last one wrapping around to vertex 0.
    new_in = [...arriving.slice(-1), ...arriving.slice(0, -1)];
  } else {
    // The open path's final vertex ends the last piece rather than
    // starting one, so it is appended, and the first vertex keeps the
    // original path's own leading handles.
    const last_piece = chain[chain.length - 1];
    new_vertices.push([last_piece[3][0], last_piece[3][1]]);
    new_out.push([...out_tangents[out_tangents.length - 1]]);
    new_in = [[...in_tangents[0]], ...arriving];
  }
  return [new_vertices, new_in, new_out];
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
export function interpolate_shapes(start: Shape, end: Shape, progress: number): Shape | null {
  // The stored handles blend (what a new keyframe stores); a RotoBezier
  // mask's drawn tangents are derived from the result instead.
  let verts_a = start.vertices;
  let in_a = start._stored_tangents(-1);
  let out_a = start._stored_tangents(1);
  let verts_b = end.vertices;
  let in_b = end._stored_tangents(-1);
  let out_b = end._stored_tangents(1);
  if (!verts_a?.length || !verts_b?.length) return null;
  // A RotoBezier mask draws the in-between with the keyframes' tensions
  // blended at the same progress (measured on AE 2026); each key's come
  // from its handles as stored, before any resampling.
  const tensions = start._is_roto_bezier()
    ? [
        keyframe_tensions(start._own_tensions(), in_a, out_a),
        keyframe_tensions(end._own_tensions(), in_b, out_b),
      ]
    : null;
  const target = Math.max(verts_a.length, verts_b.length);
  if (verts_a.length < target) {
    [verts_a, in_a, out_a] = _resample_path(verts_a, in_a, out_a, start.closed, target);
  } else if (verts_b.length < target) {
    [verts_b, in_b, out_b] = _resample_path(verts_b, in_b, out_b, end.closed, target);
  }
  if (verts_a.length !== verts_b.length) {
    // `_resample_path` could not reach the target: a one-vertex open
    // path has no segment to subdivide.
    return null;
  }
  const blended = new Shape(
    _lerp_points(verts_a, verts_b, progress),
    _lerp_points(in_a, in_b, progress),
    _lerp_points(out_a, out_b, progress),
    { closed: start.closed },
  );
  blended._mask_path = start._mask_path;
  if (tensions != null && tensions[0].length === tensions[1].length && tensions[1].length === verts_a.length) {
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
export function color_distance(start: number[], end: number[]): number {
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
export function color_auto_speed(values: number[][], times: number[], index: number): number {
  const low = Math.max(index - 1, 0);
  const high = Math.min(index + 1, values.length - 1);
  const span = times[high] - times[low];
  if (span <= 0) return 0.0;
  let distance = 0.0;
  for (let i = low; i < high; i++) {
    distance += color_distance(values[i], values[i + 1]);
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
export function _interpolate_color(
  kf_left: Keyframe,
  kf_right: Keyframe,
  time: number,
  t0: number,
  t1: number,
  v0: number[],
  v1: number[],
): number[] {
  const duration = t1 - t0;
  const distance = color_distance(v0, v1);
  let cx1: number;
  let cy1: number;
  if (kf_left.out_interpolation_type === KeyframeInterpolationType.LINEAR) {
    cx1 = _DEFAULT_INFLUENCE / 100.0;
    cy1 = cx1;
  } else {
    const out_ease = kf_left.out_temporal_ease[0];
    cx1 = out_ease.influence / 100.0;
    cy1 = distance !== 0 ? (out_ease.speed * cx1 * duration) / distance : cx1;
  }
  let cx2: number;
  let cy2: number;
  if (kf_right.in_interpolation_type === KeyframeInterpolationType.LINEAR) {
    cx2 = 1.0 - _DEFAULT_INFLUENCE / 100.0;
    cy2 = cx2;
  } else {
    const in_ease = kf_right.in_temporal_ease[0];
    const reach = in_ease.influence / 100.0;
    cx2 = 1.0 - reach;
    cy2 = distance !== 0 ? 1.0 - (in_ease.speed * reach * duration) / distance : cx2;
  }
  const progress = _get_bezier_easing(cx1, cy1, cx2, cy2).get((time - t0) / duration);
  return Array.from({ length: v0.length }, (_v, d) => v0[d] + (v1[d] - v0[d]) * progress);
}

/**
 * Compute the interpolated value at `time` from a keyframe list.
 *
 * @param time - Time in the owning LAYER's seconds, not composition seconds. AE evaluates the
 *   temporal bezier in layer time - its ease speeds are per layer second, and a negatively
 *   stretched layer's keyframes only ascend on this axis.
 *   {@link Property.value_at_time | Property.value_at_time} converts before calling.
 * @param keyframes - Keyframes in stored (layer time ascending) order.
 * @param is_spatial - Whether the property is spatial.
 * @param inert_dimensions - Indices the layer ignores, held at the left keyframe's value instead of
 *   interpolated - the Z of a 2-D layer's Scale, which AE never moves.
 * @param value_kind - `SHAPE_KIND` or `ORIENTATION_KIND` for the two kinds AE blends as one eased
 *   quantity rather than per component; `null` for an ordinary numeric property.
 * @param metric - How the property's motion path is measured, from its `tdb4`; only a spatial
 *   property reads it.
 * @param is_color - Whether the value is a colour, which AE blends along one eased progress (see
 *   `_interpolate_color`).
 * @returns Interpolated value, or `null` if no keyframes.
 */
export function interpolate_keyframes(
  time: number,
  keyframes: Keyframe[],
  is_spatial: boolean,
  inert_dimensions: ReadonlySet<number> = new Set<number>(),
  value_kind: ParallelKind | null = null,
  metric: ArcMetric = _DEFAULT_ARC_METRIC,
  is_color = false,
): PropertyValue {
  if (!keyframes?.length) return null;

  const n = keyframes.length;

  // Before first keyframe or single keyframe
  if (n === 1 || time <= keyframes[0]._layer_time) {
    return keyframes[0]._stored_value;
  }

  // After last keyframe
  if (time >= keyframes[keyframes.length - 1]._layer_time) {
    return keyframes[keyframes.length - 1]._stored_value;
  }

  // Find the segment
  let right_idx = 0;
  for (let i = 1; i < n; i++) {
    if (keyframes[i]._layer_time >= time) {
      right_idx = i;
      break;
    }
  }

  const left_idx = right_idx - 1;
  const kf_left = keyframes[left_idx];
  const kf_right = keyframes[right_idx];

  const t0 = kf_left._layer_time;
  const t1 = kf_right._layer_time;

  // At exactly a keyframe time
  if (Math.abs(time - t0) < 1e-12) return kf_left._stored_value;
  if (Math.abs(time - t1) < 1e-12) return kf_right._stored_value;

  const v0 = kf_left._stored_value;
  const v1 = kf_right._stored_value;
  const out_type = kf_left.out_interpolation_type;
  const in_type = kf_right.in_interpolation_type;

  // A motion path is evaluated by distance, through AE's arc-length model.
  // A LINEAR key still follows the cubic its tangents define - only the
  // EASE is linear (AE 2026: a LINEAR/LINEAR segment from (50,50) to
  // (350,50) with tangents (100,200)/(-100,200) passes through (200,200),
  // not the straight line's (200,50)) - and a roving run is eased by its
  // anchors alone, whatever its roving keys' own interpolation says.
  if (is_spatial && value_kind == null && Array.isArray(v0) && Array.isArray(v1)) {
    const [index, u] = spatial_location(time, keyframes, left_idx, metric);
    return _cubic_point(_segment_curve(keyframes, index), u);
  }

  // HOLD
  const holds = [out_type, in_type].includes(KeyframeInterpolationType.HOLD);
  if (out_type === KeyframeInterpolationType.HOLD && value_kind == null) {
    return v0;
  }
  if (in_type === KeyframeInterpolationType.HOLD && value_kind == null) {
    // A scalar or vector jumps to the next key's value straight away,
    // but a colour holds the start, as a motion path does (measured on
    // AE 2026).
    const held = is_color ? v0 : v1;
    return held;
  }

  // A path and an Orientation blend as ONE eased quantity, so they skip
  // the per-dimension machinery below entirely. A HOLD on either side
  // holds the start, but still as the blend at progress 0: AE reports a
  // held Orientation in its canonical angles and a held path resampled to
  // the next key's vertex count (measured on AE 2026).
  if (value_kind != null) {
    const progress = holds ? 0.0 : _single_progress(kf_left, kf_right, time, t0, t1);
    if (value_kind === SHAPE_KIND && v0 instanceof Shape && v1 instanceof Shape) {
      const blended = interpolate_shapes(v0, v1, progress);
      return blended != null ? blended : v0;
    }
    if (value_kind === ORIENTATION_KIND && Array.isArray(v0) && Array.isArray(v1)) {
      return slerp_orientation(v0, v1, progress);
    }
  }

  // AE stores a LINEAR side as a diagonal handle - speed equal to the
  // chord slope, influence 100/6 - so the ordinary bezier path below
  // reproduces it exactly, including the case AE cares about: a LINEAR out
  // side facing an EASED in side still gets that ease (measured on AE
  // 2026: Opacity 0->100 over 2 s with a LINEAR out and a 90 % influence in
  // side reaches 87.5 at t=1, where a lerp gives 50).
  if ((out_type === KeyframeInterpolationType.BEZIER || out_type === KeyframeInterpolationType.LINEAR)) {
    // Non-spatial: per-dimension 1D bezier
    if (is_color && Array.isArray(v0) && Array.isArray(v1)) {
      return _interpolate_color(kf_left, kf_right, time, t0, t1, v0, v1);
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
      if (Math.min(kf_left.out_temporal_ease.length, kf_right.in_temporal_ease.length) === 1) {
        const progress = _get_bezier_easing(
          kf_left.out_temporal_ease[0].influence / 100.0,
          0.0,
          1.0 - kf_right.in_temporal_ease[0].influence / 100.0,
          1.0,
        ).get((time - t0) / (t1 - t0));
        return Array.from({ length: v0.length }, (_v, d) => v0[d] + (v1[d] - v0[d]) * progress);
      }

      const result: number[] = [];
      for (let d = 0; d < v0.length; d++) {
        if (inert_dimensions.has(d)) {
          // AE leaves an inert dimension alone: a 2-D layer's Scale
          // Z reads exactly 100 across a segment whose live X and Y
          // bow. (AE also refuses to STORE any other Z there, so the
          // two keyframes always agree.)
          result.push(v0[d]);
          continue;
        }
        const out_e =
          d < kf_left.out_temporal_ease.length ? kf_left.out_temporal_ease[d] : kf_left.out_temporal_ease[0];
        const in_e =
          d < kf_right.in_temporal_ease.length ? kf_right.in_temporal_ease[d] : kf_right.in_temporal_ease[0];
        result.push(_interpolate_bezier_1d(time, t0, t1, v0[d], v1[d], out_e, in_e));
      }
      return result;
    }

    if (typeof v0 === "number" && typeof v1 === "number") {
      const out_e_1d = kf_left.out_temporal_ease?.length > 0 ? kf_left.out_temporal_ease[0] : null;
      const in_e_1d = kf_right.in_temporal_ease?.length > 0 ? kf_right.in_temporal_ease[0] : null;
      if (out_e_1d != null && in_e_1d != null) {
        return _interpolate_bezier_1d(time, t0, t1, v0, v1, out_e_1d, in_e_1d);
      }
      const ratio = (time - t0) / (t1 - t0);
      return v0 + (v1 - v0) * ratio;
    }
  }

  // Fallback
  return v0;
}
